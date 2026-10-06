import { z } from 'zod';
import { assert, id, integer } from '../core/schema.js';
import type { Module } from '../core/registry.js';
import {prepareCheck,resolveCheck} from '../core/resolution.js';
import {advanceWorldSegment} from '../core/runtime.js';
import { lifecycleActions } from './lifecycle.js';
import { genderValues } from '../shared/gender.js';
import { AGE_MAX, identityAge } from '../shared/age.js';

export const coreModule: Module = {
  id: 'core', version: '0.1.0',
  manifest: {
    api_version: '1', provides: ['core.session', 'core.transaction', 'core.event_bus','core.narrative_foundation'],
    state_ownership: ['game_id', 'state_revision', 'runtime', 'gm_state', 'narrative_state', 'event_state', 'ai', 'last_turn', 'action_facts', 'components.scene_position', 'definition.meta', 'definition.roleplay_config', 'definition.ruleset', 'definition.enabled_modules', 'modules'],
    state_schema_version: 'core.v1', migration_version: 1, supports_enable_disable: false, supports_remove: false,
  },
  components: { scene_position: { schema:z.strictObject({label:z.string().min(1).max(120)}),project:d=>d }, identity: { schema: z.strictObject({ name: z.string().min(1).max(120), description: z.string().max(2000), avatar_id: id.nullable().default(null), gender: z.enum(genderValues).nullable().default(null), age: integer.min(0).max(AGE_MAX).nullable().default(null), age_as_of_day: integer.min(0).nullable().default(null), birth: z.strictObject({ year_offset: z.number().int().min(-1000000).max(1000000), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).nullable().default(null), previous_names: z.array(z.string().min(1).max(120)).max(20).default([]) }), project: (data, _entity, save) => ({ ...data, age: identityAge(data, save) }) } },
  panels: [{ id: 'status', label: '状态', module: 'core', order: 10, mobile_group: 'primary', presentation_type: 'panel' }],
  actions: {
    ...lifecycleActions,
    WAIT: { ui: { label: '等待', visibility: 'text' }, parameters: z.strictObject({ minutes: integer.min(1) }), execute(c) {
      const minutes = c.action.parameters.minutes as number;
      assert(minutes <= c.save.definition.ruleset.max_wait_minutes, '等待时间超过此世界允许的单次上限');
      c.advance(minutes); c.facts.push(`等待了 ${minutes} 分钟。`);
    } },
    HOLD: { ui: { label: '持续行动', visibility: 'internal' }, parameters: z.strictObject({minutes:integer.min(1).max(10000),activity:z.string().min(1).max(500)}), execute(c) {
      assert(!c.save.foreground?.blocker,'眼前还有需要处理的事情，无法继续长期等待');
      const requested=c.action.parameters.minutes as number,activity=c.action.parameters.activity as string;
      const stepLimit=Math.max(1,Math.min(60,c.save.definition.ruleset.max_wait_minutes));
      let elapsed=0;
      while(elapsed<requested){
        const segment=advanceWorldSegment(c,Math.min(requested-elapsed,stepLimit));
        elapsed+=segment.elapsed;
        if(segment.interrupted)break;
      }
      c.facts.push(`在当前位置持续进行「${activity}」，实际经过 ${elapsed} 分钟${elapsed<requested?'，因需要处理的事情而暂停':'。'}`);
    } },
    CHECK: { ui: { label: '检定', visibility: 'internal' }, parameters: z.strictObject({}), execute(c) {
      const spec=prepareCheck(c.save,c.action.id,{type:'SIMPLE_CHECK',domain:'general',band:'normal',stakes:'单次通用检定'});
      const result=resolveCheck(c.save,spec,c.rng);
      c.advance(1);
      c.facts.push(`程序检定 ${result.rolls[0].expression}: [${result.rolls[0].rolls.join(', ')}]，修正 ${result.rolls[0].modifier+spec.actor_modifier}，结果 ${result.rolls[0].total+spec.actor_modifier}；${result.outcome==='success'?'成功':'失败'}。`);
    } },
    INSPECT: { ui: { label: '观察', visibility: 'text', target_component: 'identity' }, parameters: z.strictObject({ focus: z.string().max(500).optional() }), execute(c) {
      const target = c.action.target_id ? c.store.entity(c.action.target_id) : null;
      const actor = (c.store.entity(c.action.actor_id).components.location ?? {});
      if (target?.components.location && actor.location_id) {
        assert(String(target.components.location.location_id) === actor.location_id, '目标不在当前位置');
      }
      c.advance(1);
      const name = target ? c.store.component<{ name: string }>(target.id, 'identity').name : '周围环境';
      const focus = typeof c.action.parameters.focus === 'string' && c.action.parameters.focus ? `，关注：${c.action.parameters.focus}` : '';
      c.facts.push(`观察 ${name}${focus}。`);
    } },
  },
  validate(save) {
    assert(save.entities.some(e => e.id === save.player_state.entity_id && e.components.identity), '玩家必须存在并拥有 identity');
    assert(save.runtime.time.minute < save.definition.ruleset.minutes_per_day, '时间不在当天范围内');
    for (const [id, status] of Object.entries(save.modules)) {
      assert(save.definition.enabled_modules.includes(id) === status.enabled, `模块 ${id} 的启用状态与模块列表不一致`);
      assert(!status.enabled || status.installed, `模块 ${id} 未安装却被启用`);
    }
    for (const id of save.definition.enabled_modules) assert(save.modules[id], `启用模块 ${id} 缺少存档元数据`);
  },
};

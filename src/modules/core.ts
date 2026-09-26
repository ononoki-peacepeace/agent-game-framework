import { z } from 'zod';
import { assert, id, integer } from '../core/schema.js';
import type { Module } from '../core/registry.js';
import { rollDice } from '../core/dice.js';
import { lifecycleActions } from './lifecycle.js';

export const coreModule: Module = {
  id: 'core', version: '0.1.0',
  manifest: {
    api_version: '1', provides: ['core.session', 'core.transaction', 'core.event_bus'],
    state_ownership: ['game_id', 'state_revision', 'runtime', 'gm_state', 'event_state', 'ai', 'last_turn', 'action_facts', 'components.scene_position', 'definition.meta', 'definition.ruleset', 'definition.enabled_modules', 'modules'],
    state_schema_version: 'core.v1', migration_version: 1, supports_enable_disable: false, supports_remove: false,
  },
  components: { scene_position: { schema:z.strictObject({label:z.string().min(1).max(120)}),project:d=>d }, identity: { schema: z.strictObject({ name: z.string().min(1).max(120), description: z.string().max(2000), avatar_id: id.nullable().default(null), previous_names: z.array(z.string().min(1).max(120)).max(20).default([]) }), project: d => d } },
  panels: [{ id: 'status', label: '状态', module: 'core', order: 10, mobile_group: 'primary', presentation_type: 'panel' }],
  actions: {
    ...lifecycleActions,
    WAIT: { ui: { label: '等待', visibility: 'text' }, parameters: z.strictObject({ minutes: integer.min(1) }), execute(c) {
      const minutes = c.action.parameters.minutes as number;
      assert(minutes <= c.save.definition.ruleset.max_wait_minutes, '等待时间超过此世界允许的单次上限');
      c.advance(minutes); c.facts.push(`等待了 ${minutes} 分钟。`);
    } },
    CHECK: { ui: { label: '检定', visibility: 'internal' }, parameters: z.strictObject({}), execute(c) {
      const roll = rollDice(c.save.definition.ruleset.default_check, c.rng);
      c.facts.push(`程序检定 ${roll.expression}: [${roll.rolls.join(', ')}]，修正 ${roll.modifier}，结果 ${roll.total}。`);
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

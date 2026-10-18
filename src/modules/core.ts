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
    state_ownership: ['game_id', 'state_revision', 'runtime', 'gm_state', 'narrative_state', 'event_state', 'ai', 'last_turn', 'action_facts', 'components.scene_position', 'components.interactable', 'components.discovery', 'definition.meta', 'definition.roleplay_config', 'definition.ruleset', 'definition.enabled_modules', 'modules'],
    state_schema_version: 'core.v1', migration_version: 1, supports_enable_disable: false, supports_remove: false,
  },
  components: {
    scene_position: { schema:z.strictObject({label:z.string().min(1).max(120)}),project:d=>d },
    discovery:{schema:z.strictObject({known_to_player:z.boolean()}),project:()=>undefined},
    interactable:{schema:z.strictObject({kind:z.enum(['door','container','fixture']),leads_to:id.nullable(),knockable:z.boolean(),access:z.enum(['public','private','locked'])}),project:d=>d},
    identity: { schema: z.strictObject({ name: z.string().min(1).max(120), description: z.string().max(2000), avatar_id: id.nullable().default(null), gender: z.enum(genderValues).nullable().default(null), age: integer.min(0).max(AGE_MAX).nullable().default(null), age_as_of_day: integer.min(0).nullable().default(null), birth: z.strictObject({ year_offset: z.number().int().min(-1000000).max(1000000), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).nullable().default(null), previous_names: z.array(z.string().min(1).max(120)).max(20).default([]) }), project: (data, _entity, save) => ({ ...data, age: identityAge(data, save) }) },
  },
  panels: [{ id: 'status', label: '状态', module: 'core', order: 10, mobile_group: 'primary', presentation_type: 'panel' }],
  actions: {
    ...lifecycleActions,
    KNOCK:{ui:{label:'敲门',visibility:'text',target_component:'interactable'},
      capability:{intent:'interact',description:'敲当前位置的一扇已登记的门，得到实际回应者',target_role:'interactable',parameter_roles:{},completion_kind:'interaction_performed'},
      parameters:z.strictObject({}),execute(c){
        const door=c.action.target_id?c.store.entity(c.action.target_id):null;
        assert(door?.components.interactable?.kind==='door'&&door.components.interactable.knockable===true,'目标不是可敲的门');
        const actor=c.store.entity(c.action.actor_id),here=actor.components.location?.location_id;
        assert(here&&door.components.location?.location_id===here,'门不在当前位置');
        c.advance(1);
        const room=door.components.interactable.leads_to;
        const responders=c.save.entities.filter(entity=>entity.components.character&&entity.id!==actor.id&&
          entity.components.location?.location_id===room&&entity.components.residence?.home_location_id===room&&
          entity.components.residence?.door_id===door.id&&
          (entity.components.residence?.answer_policy==='always'||
            entity.components.residence?.answer_policy==='chance'&&c.rng()<0.5));
        for(const entity of responders)entity.components.location={location_id:String(here)};
        c.result_entities.responders=responders.map(entity=>entity.id);
        for(const entity of responders)if(entity.components.discovery)entity.components.discovery.known_to_player=true;
        c.facts.push(responders.length?`${responders.map(entity=>String(entity.components.identity?.name??'有人')).join('、')}开门回应了敲门。`:'敲门后无人回应。');
      }},
    WAIT: { ui: { label: '等待', visibility: 'text' }, parameters: z.strictObject({ minutes: integer.min(1).max(10000) }), execute(c) {
      const requested = c.action.parameters.minutes as number;
      const stepLimit=Math.max(1,Math.min(60,c.save.definition.ruleset.max_wait_minutes));
      let elapsed=0;
      while(elapsed<requested){
        const segment=advanceWorldSegment(c,Math.min(requested-elapsed,stepLimit));
        elapsed+=segment.elapsed;
        if(segment.interrupted)break;
      }
      const time=c.save.runtime.time;
      c.facts.push(elapsed<requested?
        `等待被需要玩家回应的事件打断；当前时间是第${time.day}日${String(Math.floor(time.minute/60)).padStart(2,'0')}:${String(time.minute%60).padStart(2,'0')}。`:
        `时间来到第${time.day}日${String(Math.floor(time.minute/60)).padStart(2,'0')}:${String(time.minute%60).padStart(2,'0')}。`);
    } },
    HOLD: { ui: { label: '持续行动', visibility: 'internal' }, parameters: z.strictObject({minutes:integer.min(1).max(10000),activity:z.string().min(1).max(500)}), execute(c) {
      assert(c.shared_world_interval||!c.save.foreground?.blocker,'眼前还有需要处理的事情，无法继续长期等待');
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
      if(target?.components.item)assert(Number((c.store.entity(c.action.actor_id).components.inventory?.items as Record<string,number>|undefined)?.[target.id]??0)>0||
        target.components.location?.location_id===c.store.entity(c.action.actor_id).components.location?.location_id,'物品不在可接触范围');
      const actor = (c.store.entity(c.action.actor_id).components.location ?? {});
      if (target?.components.location && actor.location_id) {
        assert(String(target.components.location.location_id) === actor.location_id, '目标不在当前位置');
      }
      c.advance(1);
      const name = target ? c.store.component<{ name: string }>(target.id, 'identity').name : '周围环境';
      const focus = typeof c.action.parameters.focus === 'string' && c.action.parameters.focus ? `，关注：${c.action.parameters.focus}` : '';
      c.facts.push(`观察 ${name}${focus}。`);
      const check=prepareCheck(c.save,c.action.id,{type:'SIMPLE_CHECK',domain:'perception',band:'normal',
        target_id:target?.id,discover_facts:true,stakes:'检查当前可接触范围的既有证据'},c.action.actor_id);
      resolveCheck(c.save,{...check,resolution_type:check.evidence_ids.length?'SIMPLE_CHECK':'DETERMINISTIC'},c.rng);
      const found=(c.save.gm_state.hidden_truth?.commitments??[]).flatMap(truth=>truth.evidence)
        .filter(evidence=>check.evidence_ids.includes(evidence.id)&&evidence.discovered_by.includes(c.action.actor_id));
      c.facts.push(...found.map(evidence=>`发现已存在的证据：${evidence.description.slice(0,300)}`));
      if(!found.length)c.facts.push('本次检查没有发现新的线索。');
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

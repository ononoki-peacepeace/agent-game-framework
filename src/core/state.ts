import {futureStatus} from '../agent/future.js';
import {activeFocus} from './interaction.js';
import {canUndo} from './turn-history.js';
import {resolvePresentation} from '../shared/display.js';
import {calendarText} from '../routine/calendar.js';
import {defaultCalendar} from '../routine/schema.js';
import {validateRoutineIntegrity} from '../routine/integrity.js';
import { randomUUID } from 'node:crypto';
import { assert, safeParse, saveSchema, worldSchema, VERSION, type SavePackage, type WorldPackage } from './schema.js';
import { capabilityList, createRegistry, moduleStatuses, panelMeta } from '../modules/index.js';
import type { ModuleRegistry } from './registry.js';
import type { PublicView, Entity } from '../shared/contracts.js';
import { parseDice } from './dice.js';
import { currentMap, seedKnownLocations } from './map.js';
import { availableModules } from '../modules/index.js';
import { defaultRoleplayConfig } from '../narrative/policy.js';
import { initialTruthFromNotes } from '../narrative/truth.js';
import { ensureNarrativeState } from '../narrative/runtime.js';
import {ensureBackgroundState} from '../background/runtime.js';
export function availableModuleIds() { return availableModules.map(module => module.id); }


export function newSave(input: unknown): SavePackage {
  const definition = safeParse(worldSchema, input), registry = createRegistry(definition.enabled_modules);
  definition.roleplay_config ??= defaultRoleplayConfig();
  definition.gm_state.hidden_truth ??= initialTruthFromNotes(definition.gm_state.notes);
  const save: SavePackage = {
    schema_version: 1, framework_version: VERSION,
    module_versions: Object.fromEntries(registry.modules.all().map(([id, m]) => [id, m.version])),
    game_id: randomUUID(), state_revision: 0, definition,
    entities: structuredClone(definition.entities), player_state: { entity_id: definition.player.entity_id },
    gm_state: structuredClone(definition.gm_state), event_state: { fired: [], counts: {} },
    runtime: { time: structuredClone(definition.runtime.time), receipts: [] },
    calendar: definition.calendar ? structuredClone(definition.calendar) : defaultCalendar(),
    map_state: { known_location_ids: [], dynamic_locations: [], dynamic_routes: [],dynamic_regions:[] },
    ai: { threads: {} }, last_turn: null,
    modules: {}, behavior_config: [],
  };
  for (const [id, module] of registry.modules.all()) save.modules[id] = { installed: true, enabled: true, version: module.version, state_version: module.manifest?.state_schema_version ?? 'v1' };
  // A brand new world runs the same setup hook an ENABLE_MODULE action would use.
  for (const [, module] of registry.modules.all()) module.manifest?.setup?.(save);
  ensureNarrativeState(save);
  if(definition.background_incidents?.length||definition.world_macro_arcs?.length)ensureBackgroundState(save);
  seedKnownLocations(save);
  return validateSave(save);
}
// Module metadata is derived from the enabled list for older saves, then kept explicit and consistent.
export function ensureModuleMetadata(save: SavePackage, registry = createRegistry(save.definition.enabled_modules)) {
  for (const [id, module] of registry.modules.all()) {
    // A module removed (or disabled) inside this very transaction must not be reinstated by validation.
    if (!save.definition.enabled_modules.includes(id)) continue;
    const existing = save.modules[id];
    if (!existing || existing.enabled !== true || existing.installed !== true) {
      save.modules[id] = { installed: true, enabled: true, version: existing?.version ?? save.module_versions[id] ?? module.version, state_version: existing?.state_version ?? module.manifest?.state_schema_version ?? 'v1' };
    }
  }

  for (const id of Object.keys(save.modules)) {
    if (save.definition.enabled_modules.includes(id)) continue;
    save.modules[id] = { ...save.modules[id], enabled: false };
  }
  return save;
}

export function validateSave(input: unknown, suppliedRegistry?: ModuleRegistry): SavePackage {
  const save = safeParse(saveSchema, input), registry = suppliedRegistry ?? createRegistry(save.definition.enabled_modules);
  ensureModuleMetadata(save, registry);
  seedKnownLocations(save);
  for (const [id, module] of registry.modules.all()) assert(save.module_versions[id] === module.version, `模块 ${id} 版本不兼容，需要迁移`);
  for (const id of Object.keys(save.module_versions)) assert(registry.modules.has(id) || availableModuleIds().includes(id), `存档记录了未知模块: ${id}`);

  assert(save.player_state.entity_id === save.definition.player.entity_id, '玩家 ID 与世界定义不一致');
  const canonicalLocations=new Set(currentMap(save).locations.map(location=>location.id));
  const canonicalEntities=new Map(save.entities.map(entity=>[entity.id,entity]));
  const environmentKeys=new Set<string>(),environmentIds=new Set<string>(),environmentItems=new Set<string>();
  for(const record of save.environment_state?.resolutions??[]){
    assert(canonicalLocations.has(record.location_id)&&!environmentIds.has(record.id),'环境裁决地点无效或标识重复');
    if(record.container_id)assert(canonicalEntities.get(record.container_id)?.components.item?.container===true,
      '环境裁决引用无效容器');
    if(record.known_by){
      assert(new Set(record.known_by).size===record.known_by.length&&record.known_by.every(id=>canonicalEntities.get(id)?.components.character),
        '环境发现者引用未知人物或重复');
    }
    environmentIds.add(record.id);
    for(const name of [record.name,...record.aliases]){
      const key=record.location_id+':'+(record.container_id??'room')+':'+name.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・._-]+/g,'');
      assert(!environmentKeys.has(key),'同一环境对象存在重复裁决');environmentKeys.add(key);
    }
    if(record.entity_id){
      const itemTags=canonicalEntities.get(record.entity_id)?.components.item?.tags as string[]|undefined;
      assert(record.status==='present'&&record.classification==='ordinary_item'&&!environmentItems.has(record.entity_id)&&
        itemTags?.includes('gap_generated')&&itemTags.includes('non_tradeable')&&
        (record.take_allowed||itemTags.includes('shared_fixture')),
        '环境裁决引用了无效或重复的补全物品');
      environmentItems.add(record.entity_id);
    }
  }
  const surveyLocations=new Map<string,number>();
  for(const survey of save.environment_state?.surveys??[]){
    const surveyKey=survey.location_id+':'+(survey.container_id??'room');
    assert(canonicalLocations.has(survey.location_id)&&
      (!survey.container_id||canonicalEntities.get(survey.container_id)?.components.item?.container===true),
      '场景概览地点无效或重复');
    if(surveyLocations.has(surveyKey))assert(Boolean(survey.container_id)&&survey.sequence!==undefined&&
      survey.sequence>surveyLocations.get(surveyKey)!,'同一容器的后续检查缺少有效时间顺序');
    surveyLocations.set(surveyKey,survey.sequence??0);
    if(survey.complete_empty){
      assert(Boolean(survey.container_id)&&survey.record_ids.length===0&&survey.sequence!==undefined,
        '充分检查为空缺少容器范围或时间来源');
      assert(!save.entities.some(entity=>entity.components.item?.container_id===survey.container_id&&
        Number(entity.components.item.placed_sequence??0)<=Number(survey.sequence)),
        '容器空检查与已有内容物矛盾');
    }
    if(survey.complete_contents){
      assert(Boolean(survey.container_id)&&!survey.complete_empty&&survey.record_ids.length>0&&survey.sequence!==undefined,
        '非空容器穷尽检查缺少范围或时间来源');
      assert(!save.entities.some(entity=>entity.components.item?.container_id===survey.container_id&&
        Number(entity.components.item.placed_sequence??0)<=Number(survey.sequence)&&
        !survey.record_ids.some(id=>save.environment_state?.resolutions.find(r=>r.id===id)?.entity_id===entity.id)),
        '非空容器穷尽检查遗漏已有内容物');
    }
    assert(new Set(survey.known_by).size===survey.known_by.length&&
      survey.known_by.every(id=>canonicalEntities.get(id)?.components.character),
      '场景概览发现者无效或重复');
    assert(new Set(survey.record_ids).size===survey.record_ids.length&&survey.record_ids.every(id=>
      save.environment_state?.resolutions.some(r=>r.id===id&&r.location_id===survey.location_id&&
        (r.container_id??null)===(survey.container_id??null)&&r.status==='present')),
      '场景概览引用了无效环境事实');
  }
  assert(environmentItems.size<=24,'普通环境补全物品超出世界预算');
  for(const locationId of canonicalLocations)assert((save.environment_state?.resolutions??[])
    .filter(r=>r.location_id===locationId&&r.entity_id).length<=3,'普通环境补全物品超出地点预算');
  for(const entity of save.entities)if((entity.components.item?.tags as string[]|undefined)?.includes('gap_generated'))
    assert(environmentItems.has(entity.id),'普通补全物品缺少持久裁决来源');
  assert(Object.keys(save.npc_agent_state??{}).length<=500,'NPC Agent 状态数量超出上限');
  for(const [npcId,state] of Object.entries(save.npc_agent_state??{})){
    assert(npcId!==save.player_state.entity_id&&Boolean(canonicalEntities.get(npcId)?.components.character),
      'NPC Agent 状态引用未知人物');
    const goals=new Set(state.goals.map(goal=>goal.id));
    assert(state.plans.every(plan=>goals.has(plan.goal_id)),'NPC 计划引用未知目标');
    assert(state.plans.filter(plan=>plan.status==='active'&&(plan.activity||plan.execution)).length<=1,'NPC 同时存在冲突的可执行计划');
    for(const plan of state.plans)if(plan.execution){
      const execution=plan.execution;
      assert(!plan.activity&&execution.cursor<=execution.steps.length,'NPC 计划游标或执行形式无效');
      assert(!execution.not_before||execution.not_before.minute<save.definition.ruleset.minutes_per_day,'NPC 计划日历时间无效');
      for(const step of execution.steps){
        assert(step.type==='MOVE'?Boolean(step.target_id&&canonicalLocations.has(step.target_id)):
          step.type==='HOLD'?step.target_id===null&&Boolean(step.duration_minutes):
          step.type==='TALK'?Boolean(step.target_id&&canonicalEntities.get(step.target_id)?.components.character&&step.target_id!==npcId&&step.speech):
          step.target_id===null||canonicalEntities.has(step.target_id),'NPC 计划引用无效目标或参数');
        assert((step.type==='HOLD'||step.duration_minutes===null)&&(step.type==='TALK'||step.speech===null),'NPC 计划动作字段不一致');
      }
    }
    for(const entries of [state.knowledge,state.beliefs,state.goals,state.plans,state.private_facts])
      assert(new Set(entries.map(entry=>entry.id)).size===entries.length,'NPC 认知条目 ID 重复');
  }
  for(const entity of save.entities){
    const site=entity.components.interactable;
    if(site){
      assert(!site.leads_to||canonicalLocations.has(String(site.leads_to)),'交互对象引用未知空间');
      assert(!entity.components.location||canonicalLocations.has(String(entity.components.location.location_id)),'交互对象位置无效');
    }
    const residence=entity.components.residence;
    if(residence){
      const door=canonicalEntities.get(String(residence.door_id));
      assert(door?.components.interactable?.kind==='door'&&door.components.interactable.leads_to===residence.home_location_id,
        '住处与房门的权威关联不一致');
      assert(canonicalLocations.has(String(residence.home_location_id)),'住处引用未知空间');
    }
  }
  parseDice(save.definition.ruleset.default_check);
  assert(new Set(save.definition.events.map(e => e.id)).size === save.definition.events.length, '事件 ID 重复');
  const incidents=save.definition.background_incidents??[],background=save.background_state;
  assert(new Set(incidents.map(item=>item.id)).size===incidents.length,'后台案件 ID 重复');
  const macroArcs=save.definition.world_macro_arcs??[];
  assert(new Set(macroArcs.map(item=>item.id)).size===macroArcs.length,'长期主轴 ID 重复');
  assert(!incidents.length||Boolean(save.definition.background_event_policy?.enabled),'后台案件缺少启用策略');
  assert(!save.definition.background_event_policy||
    (background?background.incidents.filter(item=>item.status==='dormant').length:incidents.length)<=save.definition.background_event_policy.max_dormant_incidents,
    '后台待激活案件超出容量');
  if(background){
    assert(background.incidents.length===incidents.length&&background.incidents.every((record,index)=>record.id===incidents[index].id),'后台案件状态与世界定义不一致');
    assert(background.macro_arcs.length===macroArcs.length&&background.macro_arcs.every((record,index)=>record.id===macroArcs[index].id),'长期主轴状态与世界定义不一致');
    const ids=new Set(save.entities.map(entity=>entity.id)),locations=new Set(currentMap(save).locations.map(location=>location.id));
    const truths=new Set(save.gm_state.hidden_truth?.commitments.map(truth=>truth.id)??[]);
    for(const arc of macroArcs){
      assert(arc.actor_motivations.every(item=>ids.has(item.actor_id)),'长期主轴引用未知人物');
      assert(arc.truth_refs.every(id=>truths.has(id)),'长期主轴引用未知真相');
      assert(arc.incident_refs.every(id=>incidents.some(incident=>incident.id===id)),'长期主轴引用未知事件');
    }
    for(const incident of incidents){
      const introduced=new Set(incident.stages.flatMap(stage=>stage.effects.filter(effect=>effect.kind==='spawn_character').map(effect=>effect.entity_id)));
      const plannedLocations=new Set(incident.stages.flatMap(stage=>stage.effects.filter(effect=>effect.kind==='create_location').map(effect=>effect.location_id)));
      const incidentLocations=new Set([...locations,...plannedLocations]);
      assert(incident.participants.every(id=>(ids.has(id)||introduced.has(id))&&id!==save.player_state.entity_id),'后台案件引用未知 NPC');
      assert(!incident.causal_parent_id||incidents.some(parent=>parent.id===incident.causal_parent_id&&parent.id!==incident.id),'后续事件缺少因果来源');
      assert(incident.locations.every(id=>incidentLocations.has(id)),'后台案件引用未知地点');
      for(const stage of incident.stages){
        assert(!stage.actor_id||incident.participants.includes(stage.actor_id),'阶段行动者不是案件参与者');
        for(const effect of stage.effects){
          if('npc_id' in effect)assert(incident.participants.includes(effect.npc_id),'后台效果引用未登记 NPC');
          if('location_id' in effect&&effect.kind!=='create_location')assert(incidentLocations.has(effect.location_id),'后台效果引用未知地点');
          if(effect.kind==='spawn_character'){
            assert(incident.participants.includes(effect.entity_id),'新增人物未列为事件参与者');
            assert(!effect.home_location_id||incidentLocations.has(effect.home_location_id),'新增人物住处无效');
            assert(!effect.relationship_seed_id||incident.participants.includes(effect.relationship_seed_id),
              '新增人物关系来源未列为参与者');
            const prior=save.entities.find(entity=>entity.id===effect.entity_id);
            assert(!prior||prior.components.world_resident?.origin_incident_id===incident.id,'新增人物 ID 与已有实体冲突');
          }
          if(effect.kind==='relationship_seed'){
            assert(incident.participants.includes(effect.from_id)&&incident.participants.includes(effect.to_id),'关系变化引用未登记参与者');
            const dimension=save.definition.ruleset.relationship_dimensions[effect.dimension];
            assert(dimension&&effect.value>=dimension.min&&effect.value<=dimension.max,'关系种子越界');
          }
        }
        for(const exposure of stage.exposures){
          assert(!exposure.location_id||incidentLocations.has(exposure.location_id),'案件曝光引用未知地点');
          assert(!exposure.npc_id||incident.participants.includes(exposure.npc_id),'案件曝光引用未知 NPC');
        }
      }
      const record=background.incidents.find(item=>item.id===incident.id)!;
      assert(record.stage_index<incident.stages.length,'案件阶段索引越界');
    }
  }
  assert(new Set(save.event_state.fired).size === save.event_state.fired.length, '事件完成列表重复');
  for (const key of [...save.event_state.fired, ...Object.keys(save.event_state.counts)]) assert(save.definition.events.some(e => e.id === key), '存档引用未知事件');
  assert(new Set(save.runtime.receipts.map(r => r.id)).size === save.runtime.receipts.length && save.runtime.receipts.every(r => r.revision <= save.state_revision), '请求记录不一致');
  const truthRecords=save.gm_state.hidden_truth?.commitments??[],allEvidence=truthRecords.flatMap(truth=>truth.evidence);
  assert(new Set(truthRecords.map(truth=>truth.id)).size===truthRecords.length,'真相标识重复');
  assert(new Set(allEvidence.map(evidence=>evidence.id)).size===allEvidence.length,'证据标识重复');
  for(const evidence of allEvidence)for(const observer of evidence.discovered_by)
    assert(save.entities.some(entity=>entity.id===observer),'证据发现者引用未知人物');
  const placedEvidence=allEvidence.filter(evidence=>Boolean(evidence.placement));
  if(placedEvidence.length){
  const canonicalLocations=new Set(currentMap(save).locations.map(location=>location.id));
  for(const evidence of placedEvidence){
    const placement=evidence.placement!;
    if(placement.location_id)assert(canonicalLocations.has(placement.location_id),'隐藏事实引用了不存在的地点');
    if(placement.anchor_entity_id)assert(save.entities.some(entity=>entity.id===placement.anchor_entity_id),'隐藏事实引用了不存在的锚点实体');
    assert(Boolean(placement.location_id||placement.anchor_entity_id||placement.scene_scope),'隐藏事实缺少场景定位');
  }
  }
  registry.validate(save);
  if(save.interaction_context&&!activeFocus(save))save.interaction_context.status='ended';
  // Validate the embedded initial world as well; imports must remain self-contained and valid.
  registry.validate({ ...save, entities: save.definition.entities, gm_state: save.definition.gm_state, runtime: { ...save.runtime, time: save.definition.runtime.time }, map_state: { known_location_ids: (save.definition.map?.locations ?? []).filter(l => l.known_by_default !== false).map(l => l.id), dynamic_locations: [], dynamic_routes: [],dynamic_regions:[] } });
  for(const intent of save.future_intents??[])intent.status=futureStatus(intent,save.runtime.time);
  if (save.definition.enabled_modules.includes('routine')) validateRoutineIntegrity(save);
  return save;
}
export function publicView(save: SavePackage, registry = createRegistry(save.definition.enabled_modules)): PublicView {
  const rules = save.definition.ruleset, map = currentMap(save), known = new Set(save.map_state.known_location_ids);
  const truths=new Map((save.gm_state.hidden_truth?.commitments??[]).map(truth=>[truth.id,truth]));
  const arcVisible=(arc:NonNullable<SavePackage['narrative_state']>['arcs'][number])=>arc.truth_refs.every(id=>truths.get(id)?.known_by.includes(save.player_state.entity_id));
  const narrativeArcs=new Map((save.narrative_state?.arcs??[]).map(arc=>[arc.id,arc]));
  const sagaVisible=(arcIds:string[])=>arcIds.every(id=>{const arc=narrativeArcs.get(id);return arc&&arcVisible(arc);});
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const playerLocation=player?.components.location?.location_id;
  const playerInventory=(player?.components.inventory as {items?:Record<string,number>}|undefined)?.items??{};
  const privateEnvironmentItems=new Set((save.environment_state?.resolutions??[])
    .filter(record=>record.entity_id&&record.known_by&&!record.known_by.includes(save.player_state.entity_id)&&
      !(playerInventory[record.entity_id]>0))
    .map(record=>record.entity_id));
  const knownContainerItems=new Set((save.environment_state?.resolutions??[])
    .filter(record=>record.entity_id&&record.status==='present'&&
      (!record.known_by||record.known_by.includes(save.player_state.entity_id)))
    .map(record=>record.entity_id));
  const localStock=new Set(save.entities.filter(entity=>entity.components.shop&&
    entity.components.location?.location_id===playerLocation)
    .flatMap(entity=>Object.entries((entity.components.shop as {stock?:Record<string,number>}).stock??{})
      .filter(([,quantity])=>quantity>0).map(([itemId])=>itemId)));
  const recentMove=[...(save.resolution_receipts??[])].reverse().find(receipt=>receipt.commit_status==='committed'&&receipt.movement_route);
  const entities: Entity[] = save.entities.filter(entity => {
    if(save.background_state?.npc_status[entity.id]?.unavailable)return false;
    if(privateEnvironmentItems.has(entity.id))return false;
    if(entity.components.item?.container_id&&entity.components.discovery?.known_to_player===false)return false;
    if(entity.components.item?.container_id&&!(playerInventory[entity.id]>0)&&
      entity.components.discovery?.known_to_player!==true&&!knownContainerItems.has(entity.id))return false;
    if(entity.components.discovery?.known_to_player===false&&
      (!entity.components.character||entity.components.location?.location_id!==playerLocation))return false;
    if(entity.components.item&&entity.components.location?.location_id!==playerLocation&&
      !(playerInventory[entity.id]>0)&&!localStock.has(entity.id))return false;
    const here=playerLocation;
    if (entity.id === save.player_state.entity_id || !entity.components.location) return true;
    return known.has(String(entity.components.location.location_id));
  }).map(entity => ({
    id: entity.id, type: entity.type,
    components: Object.fromEntries(Object.entries(entity.components).flatMap(([name, data]) => {
      // Components owned by a disabled module stay in the save as dormant data but never reach the UI.
      if (!registry.components.has(name)) return [];
      if(name==='physical_state'&&entity.id!==save.player_state.entity_id){
        if(entity.components.location?.location_id!==playerLocation)return [];
        const physical=data as {awareness:string;restrained_by:string|null};
        return [['physical_state',{awareness:physical.awareness,alert_to_ids:[],restrained_by:physical.restrained_by}]];
      }
      if(name==='location'&&entity.components.character&&entity.id!==save.player_state.entity_id&&
        entity.components.location?.location_id!==playerLocation)return [];
      const projected = registry.components.get(name).project?.(data, entity, save);
      return projected ? [[name, structuredClone(projected)]] : [];
    })),
  }));
  // Contextual extension fields are projected into the canonical host entity only when the
  // installed extension declares a host the client actually implements. Data remains in the
  // extension namespace; this object is presentation-only.
  for (const [extensionId, entry] of Object.entries(save.extensions ?? {})) {
    if (!entry.installed || !entry.enabled || entry.manifest.template !== 'declarative') continue;
    const hosts = new Set(entry.manifest.surfaces.filter(surface => surface.kind === 'contextual_panel').map(surface => surface.host));
    if (!hosts.has('character_detail') && !hosts.has('character_card')) continue;
    const rawState = entry.state as {kind?:string;entity_values?:Record<string,Record<string,number|boolean|string>>};
    if (rawState?.kind !== 'declarative') continue;
    const fields = entry.manifest.fields.filter(field => field.scope === 'entity');
    for (const entity of entities) {
      if (entity.type !== 'character' || !fields.length) continue;
      const stored = rawState.entity_values?.[entity.id] ?? {};
      entity.components.extension_fields = {entries: fields.map(field => ({
        extension_id: extensionId, field_id: field.key, label: field.label ?? field.key,
        type: field.type, value: Object.hasOwn(stored, field.key) ? stored[field.key] : field.initial,
        actions: entry.manifest.declarative_actions.filter(action => action.field === field.key).map(action => ({id: action.id, label: action.label})),
      }))};
    }
  }
  const visibleLocations = map.locations.filter(location => known.has(location.id));
  const publicLocations=visibleLocations.map(({id,name,description,tags,position,parent_id,kind,map_level,known_by_default,lifecycle,spatial})=>({
    id,name,description:[description,...(save.environment_state?.resolutions??[])
      .filter(r=>r.location_id===id&&!r.container_id&&r.status==='present'&&r.classification==='environment_detail'&&
        (!r.known_by||r.known_by.includes(save.player_state.entity_id))).map(r=>r.description)].join('\n'),
    tags,position,parent_id,kind,map_level,known_by_default,spatial,status:lifecycle?.status??'active' as const,
  }));
  const visibleIds = new Set(visibleLocations.map(location => location.id));
  const extensionPanels = Object.entries(save.extensions ?? {}).flatMap(([extensionId, entry]) => {
    if (!entry.installed || !entry.enabled) return [];
    return entry.manifest.surfaces.filter(surface => surface.kind === 'panel').map((surface, index) => ({
      id: `extension:${extensionId}:${surface.id}`,
      label: surface.title,
      module: `extension:${extensionId}`,
      order: 600 + index,
      mobile_group: 'secondary' as const,
      presentation_type: 'panel' as const,
      extension_id: extensionId,
    }));
  });
  const extensionModules = Object.entries(save.extensions ?? {}).map(([extensionId, entry]) => ({
    id: `extension:${extensionId}`,
    version: entry.version,
    installed: entry.installed,
    enabled: entry.enabled,
    state_schema_version: entry.manifest.state_schema,
    provides: [`extension.${extensionId}`],
    requires: entry.manifest.dependencies,
    dependents: [],
    panels: entry.manifest.surfaces.filter(surface => surface.kind === 'panel').map(surface => `extension:${extensionId}:${surface.id}`),
    supports_enable_disable: true,
    supports_remove: true,
  }));
  return resolvePresentation({
    ...(save.active_goal?{active_goal:{plan_id:save.active_goal.plan.plan_id,status:save.active_goal.plan.status,
      original_intent:save.active_goal.plan.contract?.original_intent??'',
      goals:save.active_goal.plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??goal.normalized_goal,status:goal.status})),
      waiting_question:save.active_goal.waiting_question,options:structuredClone(save.active_goal.options)}}:{}),
    interaction_context:structuredClone(activeFocus(save)),can_undo:canUndo(save),
    future_intents:structuredClone(save.future_intents??[]),
    game_id: save.game_id, revision: save.state_revision, title: save.definition.meta.title,
    description: save.definition.meta.description, player_id: save.player_state.entity_id,
    ...(save.definition.provenance?{world_provenance:structuredClone(save.definition.provenance)}:{}),
    routine_activities:(save.definition.routine_rules?.activities??[]).map(activity=>({id:activity.id,label:activity.label,kind:activity.kind,duration:activity.duration,mode:activity.mode})),
    calendar:save.calendar,calendar_issue:save.routine_meta?.calendar_issue??null,scheduled_tasks:save.routine_meta?.scheduled_tasks??[],time_label:calendarText(save),
    time: structuredClone(save.runtime.time), minutes_per_day: rules.minutes_per_day,
    entities, locations: structuredClone(publicLocations),
    regions:map.regions.filter(region=>visibleLocations.some(location=>location.spatial?.region_id===region.id))
      .map(({id,name,scope_location_id,width,height})=>({id,name,scope_location_id,width,height})),
    routes: map.routes.filter(r => visibleIds.has(r.from) && visibleIds.has(r.to) &&
      map.locations.find(loc=>loc.id===r.from)?.lifecycle?.status!=='closed'&&
      map.locations.find(loc=>loc.id===r.to)?.lifecycle?.status!=='closed'&&
      r.conditions.every(c => save.gm_state.flags[c.flag] === c.equals)).map(({ from, to, travel_minutes,gateway }) => ({ from, to, travel_minutes,
        ...(gateway?{gateway:structuredClone(gateway)}:{}) })),
    ...(recentMove?.movement_route&&recentMove.actor_id===save.player_state.entity_id&&
      recentMove.movement_route.location_ids.every(id=>visibleIds.has(id))&&
      recentMove.movement_route.destination_id===save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id?
      {recent_movement_route:{location_ids:[...recentMove.movement_route.location_ids],total_minutes:recentMove.movement_route.total_minutes}}:{}),
    panels: [...panelMeta(registry), ...extensionPanels],
    modules: [...moduleStatuses(save), ...extensionModules],
    capabilities: [...capabilityList(registry), ...extensionModules.filter(module => module.installed && module.enabled).flatMap(module => module.provides)],
    world_history:(save.turn_history??[]).map((entry,index,all)=>({turn_id:entry.turn_id,label:entry.label,time:structuredClone(entry.time),current:index===all.length-1})),
    ...(save.narrative_state?{story:{
      mode:save.definition.roleplay_config?.narrative_mode??'standard',scale:save.definition.roleplay_config?.narrative_scale??'seasonal',life_horizon:structuredClone(save.definition.roleplay_config?.life_horizon??defaultRoleplayConfig().life_horizon),
      current_saga:save.narrative_state.current_saga&&sagaVisible(save.narrative_state.current_saga.arc_refs)?
        {id:save.narrative_state.current_saga.id,title:save.narrative_state.current_saga.title,phase:save.narrative_state.current_saga.phase}:null,
      major_arcs:save.narrative_state.arcs.filter(arc=>arcVisible(arc)&&!['SEED','CLOSED'].includes(arc.status)).map(arc=>({id:arc.id,title:arc.title,status:arc.status,summary:arc.summary})),
      completed_sagas:save.narrative_state.saga_history.filter(saga=>sagaVisible(saga.major_arc_refs)).map(saga=>({id:saga.id,title:saga.title,start_time:saga.start_time,end_time:saga.end_time,outcome:saga.outcome,unresolved_count:saga.unresolved_arc_refs.length})),
    }}:{}),
    actions: registry.actions.all().map(([type, spec]) => ({ type, label: spec.ui?.label ?? type, visibility: spec.ui?.visibility ?? 'internal', target_component: spec.ui?.target_component, requires_text: spec.ui?.requires_text, text_parameter: spec.ui?.text_parameter, module: registry.modules.all().find(([, module]) => Object.hasOwn(module.actions ?? {}, type))?.[0] ?? 'framework' })),
    currencies: structuredClone(rules.currencies),
    known_evidence:(save.gm_state.hidden_truth?.commitments??[]).flatMap(truth=>truth.evidence)
      .filter(evidence=>evidence.discovered_by.includes(save.player_state.entity_id)).map(evidence=>({id:evidence.id,description:evidence.description})),
    last_turn: structuredClone(save.last_turn), notices: (save.future_intents??[]).filter(i=>i.status==='due').map(i=>'你的打算已到期：'+i.goal+'。尚未自动执行；请先处理当前场景，再决定是否尝试。'),
  },entities,publicLocations,{activities:(save.definition.routine_rules?.activities??[]).map(activity=>({id:activity.id,label:activity.label}))});
}
type Migration = (data: unknown) => unknown;
const migrations = new Map<string, Migration>();
export function registerMigration(from: number, to: number, migration: Migration) { const key = `${from}:${to}`; assert(!migrations.has(key), '迁移已注册'); migrations.set(key, migration); }
export function migrate(from: number, to: number, data: unknown): unknown {
  if (from === to) return structuredClone(data);
  const migration = migrations.get(`${from}:${to}`); assert(migration, `不支持存档 schema_version ${from} → ${to}`);
  return migration(structuredClone(data));
}
export function importSave(raw: unknown) {
  assert(raw && typeof raw === 'object' && 'schema_version' in raw && typeof raw.schema_version === 'number', '存档缺少 schema_version');
  const save = validateSave(migrate(raw.schema_version, 1, raw));
  save.ai.threads = {}; save.game_id = randomUUID(); save.runtime.receipts = [];
  return save;
}
export function exportSave(save: SavePackage) { const portable = validateSave(save); portable.ai.threads = {}; return JSON.stringify(portable, null, 2); }
export function worldFromSave(save: SavePackage): WorldPackage { return structuredClone(save.definition); }

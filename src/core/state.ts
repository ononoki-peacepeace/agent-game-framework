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
export function availableModuleIds() { return availableModules.map(module => module.id); }


export function newSave(input: unknown): SavePackage {
  const definition = safeParse(worldSchema, input), registry = createRegistry(definition.enabled_modules);
  const save: SavePackage = {
    schema_version: 1, framework_version: VERSION,
    module_versions: Object.fromEntries(registry.modules.all().map(([id, m]) => [id, m.version])),
    game_id: randomUUID(), state_revision: 0, definition,
    entities: structuredClone(definition.entities), player_state: { entity_id: definition.player.entity_id },
    gm_state: structuredClone(definition.gm_state), event_state: { fired: [], counts: {} },
    runtime: { time: structuredClone(definition.runtime.time), receipts: [] },
    calendar: definition.calendar ? structuredClone(definition.calendar) : defaultCalendar(),
    map_state: { known_location_ids: [], dynamic_locations: [], dynamic_routes: [] },
    ai: { threads: {} }, last_turn: null,
    modules: {}, behavior_config: [],
  };
  for (const [id, module] of registry.modules.all()) save.modules[id] = { installed: true, enabled: true, version: module.version, state_version: module.manifest?.state_schema_version ?? 'v1' };
  // A brand new world runs the same setup hook an ENABLE_MODULE action would use.
  for (const [, module] of registry.modules.all()) module.manifest?.setup?.(save);
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
  parseDice(save.definition.ruleset.default_check);
  assert(new Set(save.definition.events.map(e => e.id)).size === save.definition.events.length, '事件 ID 重复');
  assert(new Set(save.event_state.fired).size === save.event_state.fired.length, '事件完成列表重复');
  for (const key of [...save.event_state.fired, ...Object.keys(save.event_state.counts)]) assert(save.definition.events.some(e => e.id === key), '存档引用未知事件');
  assert(new Set(save.runtime.receipts.map(r => r.id)).size === save.runtime.receipts.length && save.runtime.receipts.every(r => r.revision <= save.state_revision), '请求记录不一致');
  registry.validate(save);
  if(save.interaction_context&&!activeFocus(save))save.interaction_context.status='ended';
  // Validate the embedded initial world as well; imports must remain self-contained and valid.
  registry.validate({ ...save, entities: save.definition.entities, gm_state: save.definition.gm_state, runtime: { ...save.runtime, time: save.definition.runtime.time }, map_state: { known_location_ids: (save.definition.map?.locations ?? []).filter(l => l.known_by_default !== false).map(l => l.id), dynamic_locations: [], dynamic_routes: [] } });
  for(const intent of save.future_intents??[])intent.status=futureStatus(intent,save.runtime.time);
  if (save.definition.enabled_modules.includes('routine')) validateRoutineIntegrity(save);
  return save;
}
export function publicView(save: SavePackage, registry = createRegistry(save.definition.enabled_modules)): PublicView {
  const rules = save.definition.ruleset, map = currentMap(save), known = new Set(save.map_state.known_location_ids);
  const entities: Entity[] = save.entities.filter(entity => {
    if (entity.id === save.player_state.entity_id || !entity.components.location) return true;
    return known.has(String(entity.components.location.location_id));
  }).map(entity => ({
    id: entity.id, type: entity.type,
    components: Object.fromEntries(Object.entries(entity.components).flatMap(([name, data]) => {
      // Components owned by a disabled module stay in the save as dormant data but never reach the UI.
      if (!registry.components.has(name)) return [];
      const projected = registry.components.get(name).project?.(data, entity, save);
      return projected ? [[name, structuredClone(projected)]] : [];
    })),
  }));
  const visibleLocations = map.locations.filter(location => known.has(location.id));
  const visibleIds = new Set(visibleLocations.map(location => location.id));
  return resolvePresentation({
    interaction_context:structuredClone(activeFocus(save)),can_undo:canUndo(save),
    future_intents:structuredClone(save.future_intents??[]),
    game_id: save.game_id, revision: save.state_revision, title: save.definition.meta.title,
    description: save.definition.meta.description, player_id: save.player_state.entity_id,
    routine_activities:(save.definition.routine_rules?.activities??[]).map(activity=>({id:activity.id,label:activity.label,kind:activity.kind,duration:activity.duration,mode:activity.mode})),
    calendar:save.calendar,calendar_issue:save.routine_meta?.calendar_issue??null,scheduled_tasks:save.routine_meta?.scheduled_tasks??[],time_label:calendarText(save),
    time: structuredClone(save.runtime.time), minutes_per_day: rules.minutes_per_day,
    entities, locations: structuredClone(visibleLocations),
    routes: map.routes.filter(r => visibleIds.has(r.from) && visibleIds.has(r.to) && r.conditions.every(c => save.gm_state.flags[c.flag] === c.equals)).map(({ from, to, travel_minutes }) => ({ from, to, travel_minutes })),
    panels: panelMeta(registry),
    modules: moduleStatuses(save),
    capabilities: capabilityList(registry),
    actions: registry.actions.all().map(([type, spec]) => ({ type, label: spec.ui?.label ?? type, visibility: spec.ui?.visibility ?? 'internal', target_component: spec.ui?.target_component, requires_text: spec.ui?.requires_text, text_parameter: spec.ui?.text_parameter, module: registry.modules.all().find(([, module]) => Object.hasOwn(module.actions ?? {}, type))?.[0] ?? 'framework' })),
    currencies: structuredClone(rules.currencies),
    last_turn: structuredClone(save.last_turn), notices: (save.future_intents??[]).filter(i=>i.status==='due').map(i=>'你的打算已到期：'+i.goal+'。尚未自动执行；请先处理当前场景，再决定是否尝试。'),
  },entities,visibleLocations,{activities:(save.definition.routine_rules?.activities??[]).map(activity=>({id:activity.id,label:activity.label}))});
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

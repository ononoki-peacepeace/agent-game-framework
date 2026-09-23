import { randomUUID } from 'node:crypto';
import { assert, safeParse, saveSchema, worldSchema, VERSION, type SavePackage, type WorldPackage } from './schema.js';
import { createRegistry } from '../modules/index.js';
import type { ModuleRegistry } from './registry.js';
import type { PublicView, Entity } from '../shared/contracts.js';
import { parseDice } from './dice.js';
import { currentMap, seedKnownLocations } from './map.js';

export function newSave(input: unknown): SavePackage {
  const definition = safeParse(worldSchema, input), registry = createRegistry(definition.enabled_modules);
  const save: SavePackage = {
    schema_version: 1, framework_version: VERSION,
    module_versions: Object.fromEntries(registry.modules.all().map(([id, m]) => [id, m.version])),
    game_id: randomUUID(), state_revision: 0, definition,
    entities: structuredClone(definition.entities), player_state: { entity_id: definition.player.entity_id },
    gm_state: structuredClone(definition.gm_state), event_state: { fired: [], counts: {} },
    runtime: { time: structuredClone(definition.runtime.time), receipts: [] },
    map_state: { known_location_ids: [], dynamic_locations: [], dynamic_routes: [] },
    ai: { threads: {} }, last_turn: null,
  };
  seedKnownLocations(save);
  return validateSave(save);
}
export function validateSave(input: unknown, suppliedRegistry?: ModuleRegistry): SavePackage {
  const save = safeParse(saveSchema, input), registry = suppliedRegistry ?? createRegistry(save.definition.enabled_modules);
  seedKnownLocations(save);
  for (const [id, module] of registry.modules.all()) assert(save.module_versions[id] === module.version, `模块 ${id} 版本不兼容，需要迁移`);
  assert(Object.keys(save.module_versions).length === registry.modules.all().length, '模块版本列表不匹配');
  assert(save.player_state.entity_id === save.definition.player.entity_id, '玩家 ID 与世界定义不一致');
  parseDice(save.definition.ruleset.default_check);
  assert(new Set(save.definition.events.map(e => e.id)).size === save.definition.events.length, '事件 ID 重复');
  assert(new Set(save.event_state.fired).size === save.event_state.fired.length, '事件完成列表重复');
  for (const key of [...save.event_state.fired, ...Object.keys(save.event_state.counts)]) assert(save.definition.events.some(e => e.id === key), '存档引用未知事件');
  assert(new Set(save.runtime.receipts.map(r => r.id)).size === save.runtime.receipts.length && save.runtime.receipts.every(r => r.revision <= save.state_revision), '请求记录不一致');
  const map = currentMap(save), locationIds = map.locations.map(location => location.id);
  assert(new Set(locationIds).size === locationIds.length, '动态地图与初始地图存在重复地点 ID');
  const routeKeys = map.routes.map(route => `${route.from}:${route.to}`);
  assert(new Set(routeKeys).size === routeKeys.length, '动态地图与初始地图存在重复路线');
  for (const route of map.routes) assert(locationIds.includes(route.from) && locationIds.includes(route.to), '地图路线引用未知地点');
  for (const id of save.map_state.known_location_ids) assert(locationIds.includes(id), `已知地点列表引用未知地点: ${id}`);
  registry.validate(save);
  // Validate the embedded initial world as well; imports must remain self-contained and valid.
  registry.validate({ ...save, entities: save.definition.entities, gm_state: save.definition.gm_state, runtime: { ...save.runtime, time: save.definition.runtime.time }, map_state: { known_location_ids: save.definition.map.locations.filter(l => l.known_by_default !== false).map(l => l.id), dynamic_locations: [], dynamic_routes: [] } });
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
      const projected = registry.components.get(name).project?.(data, entity, save);
      return projected ? [[name, structuredClone(projected)]] : [];
    })),
  }));
  const visibleLocations = map.locations.filter(location => known.has(location.id));
  const visibleIds = new Set(visibleLocations.map(location => location.id));
  return {
    game_id: save.game_id, revision: save.state_revision, title: save.definition.meta.title,
    description: save.definition.meta.description, player_id: save.player_state.entity_id,
    time: structuredClone(save.runtime.time), minutes_per_day: rules.minutes_per_day,
    entities, locations: structuredClone(visibleLocations),
    routes: map.routes.filter(r => visibleIds.has(r.from) && visibleIds.has(r.to) && r.conditions.every(c => save.gm_state.flags[c.flag] === c.equals)).map(({ from, to, travel_minutes }) => ({ from, to, travel_minutes })),
    panels: registry.modules.all().flatMap(([, m]) => m.panels ?? []),
    actions: registry.actions.all().map(([type, spec]) => ({ type, label: spec.ui?.label ?? type, visibility: spec.ui?.visibility ?? 'internal', target_component: spec.ui?.target_component, requires_text: spec.ui?.requires_text, text_parameter: spec.ui?.text_parameter })),
    currencies: structuredClone(rules.currencies),
    last_turn: structuredClone(save.last_turn), notices: [],
  };
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

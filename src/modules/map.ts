import { z } from 'zod';
import { assert, id, locationSchema, routeSchema, type SavePackage } from '../core/schema.js';
import { addDynamicLocation, currentMap, seedKnownLocations } from '../core/map.js';
import type { ActionContext, Module } from '../core/registry.js';

/** Deterministic placeholder used only when a world enables the map capability without map data. */
export const placeholderLocation = { id: 'start', name: '起点', description: '这个世界尚未登记其它地点。', tags: [] };

export const mapModule: Module = {
  id: 'map', version: '0.1.0', requires: ['core'],
  manifest: {
    api_version: '1', provides: ['map.graph', 'location.current'],
    state_ownership: ['definition.map', 'map_state', 'components.location'],
    state_schema_version: 'map.v1', migration_version: 1, supports_enable_disable: true, supports_remove: true,
    setup(save: SavePackage) {
      if (!save.definition.map || !save.definition.map.locations.length) save.definition.map = { locations: [structuredClone(placeholderLocation)], routes: [] };
      const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
      if (player && !player.components.location) player.components.location = { location_id: save.definition.map.locations[0].id };
      const initial = save.definition.entities.find(entity => entity.id === save.player_state.entity_id);
      if (initial && !initial.components.location) initial.components.location = { location_id: save.definition.map.locations[0].id };
      seedKnownLocations(save);
    },
  },
  components: { location: { schema: z.strictObject({ location_id: id }), project: d => d } },
  panels: [{ id: 'map', label: '地图', module: 'map', order: 30, mobile_group: 'primary', presentation_type: 'panel' }],
  actions: {
    MOVE: { ui: { label: '前往', visibility: 'contextual' }, parameters: z.strictObject({}), execute(c) {
      const location = c.store.component<{ location_id: string }>(c.action.actor_id, 'location');
      const route = currentMap(c.save).routes.find(r => r.from === location.location_id && r.to === c.action.target_id);
      assert(route, '没有可用的直达路线');
      assert(route.conditions.every(x => c.save.gm_state.flags[x.flag] === x.equals), '这条路线目前不可通行');
      c.emit({ type: 'on_location_leave', location_id: location.location_id });
      c.advance(route.travel_minutes);
      c.store.update(c.action.actor_id, 'location', { location_id: route.to });
      delete c.store.entity(c.action.actor_id).components.scene_position;
      c.emit({ type: 'on_entity_changed', entity_id: c.action.actor_id });
      c.emit({ type: 'on_travel_complete', location_id: route.to });
      c.emit({ type: 'on_location_enter', location_id: route.to });
      c.facts.push(`移动至 ${currentMap(c.save).locations.find(l => l.id === route.to)!.name}，用时 ${route.travel_minutes} 分钟。`);
    } },
    REGISTER_LOCATION: { ui: { label: '登记新地点', visibility: 'internal' }, parameters: z.strictObject({ location: locationSchema, routes: z.array(routeSchema).max(8).default([]) }), execute(c) {
      addDynamicLocation(c.save, c.action.parameters.location, (c.action.parameters.routes ?? []) as unknown[], true);
      c.facts.push('已登记新地点。');
    } },
  },
  validate(save) {
    const map = currentMap(save), locations = map.locations.map(location => location.id);
    assert(locations.length > 0, '启用 map 模块的世界必须至少有一个地点');
    assert(new Set(locations).size === locations.length, '地点 ID 重复');
    for (const location of map.locations) if (location.parent_id) {
      assert(location.parent_id !== location.id && locations.includes(location.parent_id), `地点 ${location.id} 的 parent_id 无效`);
      let cursor: string | null | undefined = location.parent_id; const seen = new Set([location.id]);
      while (cursor) { assert(!seen.has(cursor), '地图层级存在循环'); seen.add(cursor); cursor = map.locations.find(l => l.id === cursor)?.parent_id; }
    }
    for (const route of map.routes) assert(locations.includes(route.from) && locations.includes(route.to), '路线引用未知地点');
    const routeKeys = map.routes.map(r => `${r.from}:${r.to}`);
    assert(new Set(routeKeys).size === routeKeys.length, '路线重复');
    const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
    assert(player?.components.location, '启用 map 模块时玩家必须有 location');
    for (const entity of save.entities) if (entity.components.location) assert(locations.includes(String(entity.components.location.location_id)), `实体 ${entity.id} 的地点不存在`);
    for (const id of save.map_state.known_location_ids) assert(locations.includes(id), `已知地点列表引用未知地点: ${id}`);
    for (const event of save.definition.events) {
      assert(!event.location_id || locations.includes(event.location_id), '事件地点不存在');
      assert(!event.reveal_location_id || locations.includes(event.reveal_location_id), '事件揭示地点不存在');
    }
  },
  prompt: 'map/location 是 canonical 地理事实。MOVE 只能沿已登记的 route；不要凭空移动人物或改写地图。',
};

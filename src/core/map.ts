import { assert, safeParse, locationSchema, routeSchema, type SavePackage } from './schema.js';

export function currentMap(save: SavePackage) {
  const map = save.definition.map ?? { locations: [], routes: [] };
  return {
    locations: [...map.locations, ...save.map_state.dynamic_locations],
    routes: [...map.routes, ...save.map_state.dynamic_routes],
  };
}

export function locationById(save: SavePackage, locationId: string) {
  return currentMap(save).locations.find(location => location.id === locationId);
}

export function ancestorIds(save: SavePackage, locationId: string) {
  const locations = currentMap(save).locations;
  const out: string[] = [];
  let current = locations.find(location => location.id === locationId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id); out.unshift(current.id);
    current = current.parent_id ? locations.find(location => location.id === current!.parent_id) : undefined;
  }
  return out;
}

export function seedKnownLocations(save: SavePackage) {
  const map = currentMap(save);
  if (!map.locations.length) { save.map_state.known_location_ids = []; return; }
  const known = new Set(save.map_state.known_location_ids);
  for (const location of map.locations) if (location.known_by_default !== false) known.add(location.id);

  const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
  const current = String(player?.components.location?.location_id ?? '');
  if (current) for (const id of ancestorIds(save, current)) known.add(id);
  save.map_state.known_location_ids = [...known];
}

export function revealLocation(save: SavePackage, locationId: string) {
  const location = locationById(save, locationId); assert(location, `未知地点: ${locationId}`);
  const known = new Set(save.map_state.known_location_ids);
  for (const id of ancestorIds(save, locationId)) known.add(id);
  save.map_state.known_location_ids = [...known];
  return location;
}

// Extension point for trusted modules. The Core owns validation and canonical storage;
// modules decide when a new place is actually justified by gameplay.
export function addDynamicLocation(save: SavePackage, rawLocation: unknown, rawRoutes: unknown[] = [], reveal = true) {
  const location = safeParse(locationSchema, rawLocation);
  const map = currentMap(save);
  assert(!map.locations.some(x => x.id === location.id), `地点已存在: ${location.id}`);
  if (location.parent_id) assert(map.locations.some(x => x.id === location.parent_id), `父级地点不存在: ${location.parent_id}`);
  const routes = rawRoutes.map(route => safeParse(routeSchema, route));
  for (const route of routes) {
    const ids = new Set([...map.locations.map(x => x.id), location.id]);
    assert(ids.has(route.from) && ids.has(route.to), '新路线引用未知地点');
  }
  save.map_state.dynamic_locations.push(location);
  save.map_state.dynamic_routes.push(...routes);
  if (reveal) revealLocation(save, location.id);
  return location;
}

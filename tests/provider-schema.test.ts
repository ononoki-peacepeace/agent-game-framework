import { it, expect } from 'vitest';
import { z } from 'zod';
import { worldInitializationSchema, intentResultSchema, narrativeResultSchema } from '../src/ai/contracts.js';
import { routinePlanSchema } from '../src/routine/schema.js';
import { routineResultSchema } from '../src/ai/routine.js';
import { normalizeStructuredSchema, schemaViolations } from '../src/ai/provider-schema.js';
import { compileWorld } from '../src/ai/authoring.js';
import { readProfile } from '../src/ai/profiles.js';
import { newSave, publicView } from '../src/core/state.js';

const roleSchemas: [string, z.ZodType][] = [
  ['world_initializer', worldInitializationSchema],
  ['intent_interpreter', intentResultSchema],
  ['narrator', narrativeResultSchema],
  ['routine_compiler', routinePlanSchema],
  ['gm_reasoning', routineResultSchema],
];

it('the canonical world schema has optional keys that strict providers reject, and normalization fixes them', () => {
  const canonical = z.toJSONSchema(worldInitializationSchema);
  const canonicalViolations = schemaViolations(canonical);
  expect(canonicalViolations.length).toBeGreaterThan(0);
  expect(canonicalViolations.some(line => line.includes('shop'))).toBe(true);
  expect(schemaViolations(normalizeStructuredSchema(canonical))).toEqual([]);
});

it('every role schema is strict-provider clean after normalization, including nested objects', () => {
  for (const [role, schema] of roleSchemas) {
    const normalized = normalizeStructuredSchema(z.toJSONSchema(schema));
    expect(schemaViolations(normalized), `${role} schema`).toEqual([]);
  }
});

it('optional properties become nullable and required, so a null answer parses as absent', async () => {
  const normalized = normalizeStructuredSchema(z.toJSONSchema(worldInitializationSchema)) as Record<string, unknown>;
  const properties = normalized.properties as Record<string, unknown>;
  expect((normalized.required as string[]).includes('shop')).toBe(true);
  expect(JSON.stringify(properties.shop)).toContain('"null"');
  const blueprint = worldInitializationSchema.parse({
    id: 'social_school', title: '校园', description: '纯社交世界', modules: ['characters','relationships'],
    currency: { id: 'credit', name: '点' }, player: { id: 'player', name: '学生', description: '新生', location_id: null, cash: 5 },
    locations: null, routes: null, characters: [{ id: 'friend', name: '同学', description: '同班同学', location_id: null, role: '同学' }],
    items: null, shop: null, hidden_notes: '无', opening: '开学第一天。',
  });
  const world = compileWorld(blueprint, await readProfile('content/profiles/default.json'));
  expect(world.enabled_modules).toEqual(['core','characters','relationships']);
  expect(world.map).toBeUndefined();
  const view = publicView(newSave(world));
  expect(view.panels.map(panel => panel.id)).not.toContain('map');
  expect(view.panels.map(panel => panel.id)).not.toContain('commerce');
  expect(view.panels.map(panel => panel.id)).not.toContain('routine');
});

it('a map world still compiles with locations and routes', async () => {
  const blueprint = worldInitializationSchema.parse({
    id: 'open_world', title: '开放世界', description: '开放世界冒险', modules: ['map','characters','inventory','commerce'],
    currency: { id: 'coin', name: '币' }, player: { id: 'player', name: '旅人', description: '在路上', location_id: 'square', cash: 20 },
    locations: [{ id: 'square', name: '广场', description: '中心', parent_id: null, kind: 'poi', map_level: 0 }, { id: 'docks', name: '码头', description: '港口', parent_id: null, kind: 'poi', map_level: 0 }],
    routes: [{ from: 'square', to: 'docks', travel_minutes: 10 }],
    characters: [{ id: 'guide', name: '向导', description: '本地人', location_id: 'square', role: '向导' }],
    items: [{ id: 'rope', name: '绳索', description: '结实', weight: 1, price: 5 }],
    shop: { id: 'store', name: '杂货铺', location_id: 'docks', cash: 200 },
    hidden_notes: '无', opening: '旅途开始。',
  });
  const world = compileWorld(blueprint, await readProfile('content/profiles/default.json'));
  expect(world.enabled_modules).toContain('map');
  expect(world.map?.locations.map(location => location.id)).toEqual(['square','docks']);
  const view = publicView(newSave(world));
  expect(view.panels.map(panel => panel.id)).toEqual(expect.arrayContaining(['map','inventory','commerce']));
  expect(view.locations.map(location => location.id)).toEqual(expect.arrayContaining(['square','docks']));
});

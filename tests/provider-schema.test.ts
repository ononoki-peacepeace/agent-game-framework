import { it, expect } from 'vitest';
import { z } from 'zod';
import { worldInitializationSchema, intentResultSchema, narrativeResultSchema } from '../src/ai/contracts.js';
import { routinePlanSchema } from '../src/routine/schema.js';
import { routineResultSchema } from '../src/ai/routine.js';
import { compileStructuredSchema, normalizeStructuredSchema, normalizeProviderOptionals, schemaViolations } from '../src/ai/provider-schema.js';
import {npcDecisionSchema} from '../src/agent/npc-agent.js';
import {AIRuntime} from '../src/ai/runtime.js';
import { developmentPlanSchema, generationSchema } from '../src/extensions/tasks.js';
import { compileWorld } from '../src/ai/authoring.js';
import { readProfile } from '../src/ai/profiles.js';
import { newSave, publicView } from '../src/core/state.js';
import {semanticDecisionSchema} from '../src/agent/semantic-entry.js';

const roleSchemas: [string, z.ZodType][] = [
  ['npc_decision',npcDecisionSchema],
  ['world_initializer', worldInitializationSchema],
  ['intent_interpreter', intentResultSchema],
  ['narrator', narrativeResultSchema],
  ['routine_compiler', routinePlanSchema],
  ['gm_reasoning', routineResultSchema],
  ['development_plan', developmentPlanSchema],
  ['extension_generation', generationSchema],
];

it.each([null,undefined,[]])('restores NPC optional plan_updates (%s) before the real runtime validator',async(value)=>{
  let calls=0;
  const raw={kind:'no_action',speech:null,vote_target:null,intent:'暂时休息',proposed_action:null,
    evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],
    decision_summary:'保留自己的安排',social_response:null,...(value!==undefined?{plan_updates:value}:{})};
  const ai=new AIRuntime({name:'offline',generate:async()=>{calls++;return {data:raw};}});
  const result=await ai.npcDecision(await readProfile('content/profiles/default.json'),{});
  expect(result.plan_updates).toEqual(value===null?undefined:value);
  expect(result.speech).toBeNull();expect(result.social_response).toBeNull();expect(calls).toBe(1);
  expect(raw.plan_updates).toBe(value);
});

it('recursively restores optional keys, defaults and records without deleting real nullable values',()=>{
  const schema=z.strictObject({optional:z.string().optional(),nullable:z.string().nullable(),
    both:z.string().nullish(),defaulted:z.array(z.string()).default([]),
    nested:z.array(z.strictObject({steps:z.array(z.string()).optional(),flag:z.boolean().nullable()})),
    record:z.record(z.string(),z.strictObject({note:z.string().optional()}))});
  const input={optional:null,nullable:null,both:null,nested:[{steps:null,flag:null}],record:{one:{note:null}}};
  const parsed=schema.parse(normalizeProviderOptionals(input,z.toJSONSchema(schema)));
  expect(parsed).toEqual({nullable:null,both:null,defaulted:[],nested:[{flag:null}],record:{one:{}}});
  expect(input.nested[0].steps).toBeNull();
});

it('handles discriminated and nullable object unions without guessing ambiguous branches',()=>{
  const schema=z.strictObject({value:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('a'),note:z.string().optional()}),
    z.strictObject({kind:z.literal('b'),note:z.string().nullable()})]).nullable(),
    ambiguous:z.union([z.strictObject({note:z.string().optional()}),z.strictObject({note:z.string().nullable()})])});
  const a=schema.parse(normalizeProviderOptionals({value:{kind:'a',note:null},ambiguous:{note:null}},z.toJSONSchema(schema)));
  expect(a.value).toEqual({kind:'a'});expect(a.ambiguous).toEqual({note:null});
  const b=schema.parse(normalizeProviderOptionals({value:{kind:'b',note:null},ambiguous:{note:null}},z.toJSONSchema(schema)));
  expect(b.value).toEqual({kind:'b',note:null});
});

it.each([7,'wrong',{}])('does not repair invalid NPC array types (%s)',async(value)=>{
  const schema=z.strictObject({plan_updates:z.array(z.string()).optional()});
  const normalized=normalizeProviderOptionals({plan_updates:value},z.toJSONSchema(schema));
  expect(normalized).toEqual({plan_updates:value});expect(schema.safeParse(normalized).success).toBe(false);
});

it('does not remove required non-nullable nulls',()=>{
  const schema=z.strictObject({needed:z.string()});
  expect(schema.safeParse(normalizeProviderOptionals({needed:null},z.toJSONSchema(schema))).success).toBe(false);
});

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

it('the semantic output schema avoids recursive dynamic keys rejected by Codex',()=>{
  const compiled=compileStructuredSchema(z.toJSONSchema(semanticDecisionSchema));
  const json=JSON.stringify(compiled);
  expect(json).not.toContain('propertyNames');
  expect(json).not.toContain('"$ref"');
  expect(schemaViolations(compiled)).toEqual([]);
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
it('extension generation fields satisfy strict required/properties rules before provider dispatch', () => {
  const compiled = compileStructuredSchema(z.toJSONSchema(generationSchema)) as any;
  expect(schemaViolations(compiled)).toEqual([]);
  const spec = compiled.properties.spec.anyOf.find((entry:any)=>entry.type!=='null');
  const fields = spec.anyOf?.[0]?.properties?.fields ?? spec.properties.fields;
  const item = fields.items;
  expect(item.required).toEqual(expect.arrayContaining(Object.keys(item.properties)));
  expect(item.required).toContain('label');
  expect(JSON.stringify(item.properties.label)).toContain('null');
});

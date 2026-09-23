import { z } from 'zod';

export const VERSION = '0.1.0';
export const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(x => !['constructor','prototype','__proto__'].includes(x));
export const text = z.string().max(100000);
export const integer = z.number().int().min(0).max(1_000_000_000);
export const dictionary = <T extends z.ZodType>(value: T) => z.record(id, value);
export const entitySchema = z.strictObject({ id, type: id, components: dictionary(dictionary(z.json())) });
export const profileSchema = z.strictObject({
  id, version: z.string().max(30), engine_policy: text, world_initializer: text,
  intent_interpreter: text, narrator: text, npc_decision: text, gm_reasoning: text,
});
export const locationSchema = z.strictObject({
  id, name: z.string().min(1).max(120), description: text, tags: z.array(id).max(30),
  position: z.strictObject({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
  parent_id: id.nullable().optional(), kind: id.optional(), map_level: integer.min(0).max(20).optional(),
  // Baseline places are visible as soon as a world/area is initialized. Discoverable places
  // can exist canonically without being exposed to the player until an event reveals them.
  known_by_default: z.boolean().optional(),
});
export const routeSchema = z.strictObject({ from: id, to: id, travel_minutes: integer.min(1).max(1440),
  conditions: z.array(z.strictObject({ flag: id, equals: z.boolean() })).max(10).default([]) });
export const hooks = ['on_action_start','on_action_complete','on_time_advance','on_location_leave','on_location_enter','on_travel_complete','on_day_changed','on_entity_changed','on_interrupt'] as const;
export const worldEventHooks = ['on_action_start','on_action_complete','on_time_advance','on_location_leave','on_location_enter','on_travel_complete','on_day_changed','on_entity_changed'] as const;
export const eventSchema = z.strictObject({
  id, hook: z.enum(worldEventHooks), location_id: id.nullable(), probability: z.number().min(0).max(1),
  once: z.boolean(), public_text: text, set_flag: id.nullable(),
  reveal_location_id: id.nullable().optional(), interrupt_automation: z.boolean().optional(),
});
export const rulesSchema = z.strictObject({
  minutes_per_day: integer.min(60).max(10000), max_wait_minutes: integer.min(1).max(1440),
  talk_minutes: integer.min(1).max(120), trade_minutes: integer.min(1).max(120),
  default_check: z.string().max(30), currencies: dictionary(z.string().min(1).max(80)),
  relationship_dimensions: dictionary(z.strictObject({ min: z.number().int(), max: z.number().int(), initial: z.number().int() })),
});
export const worldSchema = z.strictObject({
  schema_version: z.literal(1), framework_version: z.literal(VERSION),
  meta: z.strictObject({ id, title: z.string().min(1).max(120), description: text }),
  enabled_modules: z.array(id).min(1).max(30), ruleset: rulesSchema, prompt_profile: profileSchema,
  world: z.strictObject({ description: text }), entities: z.array(entitySchema).min(1).max(500),
  map: z.strictObject({ locations: z.array(locationSchema).min(1).max(500), routes: z.array(routeSchema).max(2000) }),
  events: z.array(eventSchema).max(500), player: z.strictObject({ entity_id: id }),
  gm_state: z.strictObject({ notes: text, flags: dictionary(z.boolean()) }),
  runtime: z.strictObject({ time: z.strictObject({ day: integer, minute: integer }) }),
});
export const contextActionSchema = z.strictObject({ target_id: id, label: z.string().min(1).max(80), intent: z.string().min(1).max(500) });
export const narrativeSchema = z.strictObject({ narrative: text, speaker: id.nullable(), dialogue: text.nullable(), choices: z.array(z.string().min(1).max(300)).max(6), context_actions: z.array(contextActionSchema).max(20).optional().default([]) });
export const actionSchema = z.strictObject({ type: id, target_id: id.optional(), parameters: dictionary(z.json()).default({}) });
export const mapStateSchema = z.strictObject({
  known_location_ids: z.array(id).max(500).default([]),
  dynamic_locations: z.array(locationSchema).max(300).default([]),
  dynamic_routes: z.array(routeSchema).max(1200).default([]),
});
export const saveSchema = z.strictObject({
  schema_version: z.literal(1), framework_version: z.literal(VERSION), module_versions: dictionary(z.string().max(30)),
  game_id: z.string().uuid(), state_revision: integer, definition: worldSchema,
  entities: z.array(entitySchema).min(1).max(1000), player_state: z.strictObject({ entity_id: id }),
  gm_state: z.strictObject({ notes: text, flags: dictionary(z.boolean()) }),
  event_state: z.strictObject({ fired: z.array(id).max(500), counts: dictionary(integer) }),
  runtime: z.strictObject({ time: z.strictObject({ day: integer, minute: integer }),
    receipts: z.array(z.strictObject({ id: z.string().uuid(), fingerprint: z.string(), revision: integer })).max(100) }),
  map_state: mapStateSchema.default({ known_location_ids: [], dynamic_locations: [], dynamic_routes: [] }),
  ai: z.strictObject({ threads: dictionary(z.string().max(200)) }),
  last_turn: narrativeSchema.nullable(),
});
export type WorldPackage = z.infer<typeof worldSchema>;
export type SavePackage = z.infer<typeof saveSchema>;
export type Action = z.infer<typeof actionSchema> & { id: string; actor_id: string; source: 'player' | 'ai'; time_cost: number };
export type GameEvent = { type: typeof hooks[number]; entity_id?: string; location_id?: string; minutes?: number; reason?: string; event_id?: string };

export class GameError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new GameError(message); }
export function safeParse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new GameError(result.error.issues.slice(0, 4).map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}

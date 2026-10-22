import {calendarSchema,routineRulesSchema,routineMetaSchema} from '../routine/schema.js';
import {extensionEntriesSchema} from '../extensions/schema.js';
import {agentPlanSnapshotSchema,futureIntentSchema} from '../agent/plan-schema.js';
import {hiddenTruthStateSchema,narrativeStateSchema,roleplayConfigSchema} from '../narrative/schema.js';
import {backgroundIncidentSchema,backgroundPolicySchema,backgroundStateSchema,worldMacroArcSchema} from '../background/schema.js';
import {behaviorPatchSchema} from '../ai/guidance.js';
import {npcAgentStateSchema} from '../agent/npc-state.js';
import {environmentStateSchema,environmentReceiptSchema} from './environment-schema.js';
import { z } from 'zod';
import {consumptionReceiptSchema} from './consumption-contract.js';

export const VERSION = '0.1.0';
export const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(x => !['constructor','prototype','__proto__'].includes(x));
export const text = z.string().max(100000);
/** Provider contracts: omitted/null mean an empty collection only for explicitly chosen arrays. */
export const providerEmptyArray = <T extends z.ZodType>(schema: T) => z.preprocess(value => value == null ? [] : value, schema);
export const providerFalseBoolean = () => z.boolean().optional();
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
  spatial:z.strictObject({region_id:id,x:integer,y:integer}).optional(),
  // Baseline places are visible as soon as a world/area is initialized. Discoverable places
  // can exist canonically without being exposed to the player until an event reveals them.
  known_by_default: z.boolean().optional(),
  // Optional so every existing world and save retains its original meaning.
  lifecycle: z.strictObject({
    status: z.enum(['active','closed']),
    visibility: z.enum(['hidden','locally_known','public']),
    origin: z.enum(['existing_detail','world_event']),
    creation_reason: z.string().min(1).max(500),
    source_ref: z.string().min(1).max(160),
    recorded_at: z.strictObject({day:integer,minute:integer}),
  }).optional(),
});
export const mapRegionSchema=z.strictObject({id,name:z.string().min(1).max(120),
  scope_location_id:id.nullable(),width:integer.min(1).max(100),height:integer.min(1).max(100),
  expansion:z.enum(['closed','allowed']).default('closed')});
export const mapDirectionSchema=z.enum(['north','east','south','west','other']);
export const routeSchema = z.strictObject({ from: id, to: id, travel_minutes: integer.min(1).max(1440),
  conditions: z.array(z.strictObject({ flag: id, equals: z.boolean() })).max(10).default([]),
  gateway:z.strictObject({from_region_id:id,to_region_id:id,
    exit_direction:mapDirectionSchema,entry_direction:mapDirectionSchema}).optional() });
export const movementRouteSchema=z.strictObject({
  origin_id:id,destination_id:id,location_ids:z.array(id).min(2).max(100),
  edges:z.array(z.strictObject({from:id,to:id,travel_minutes:integer.min(1).max(1440),
    kind:z.enum(['registered','hierarchy']),conditions:z.array(z.strictObject({flag:id,equals:z.boolean()})).max(10)})).min(1).max(99),
  total_minutes:integer.min(1),
});
export type MovementRoute=z.infer<typeof movementRouteSchema>;
export const hooks = ['on_action_start','on_action_complete','on_time_advance','on_location_leave','on_location_enter','on_travel_complete','on_day_changed','on_entity_changed','on_interrupt'] as const;
export const worldEventHooks = ['on_action_start','on_action_complete','on_time_advance','on_location_leave','on_location_enter','on_travel_complete','on_day_changed','on_entity_changed'] as const;
export const eventSchema = z.strictObject({
  id, hook: z.enum(worldEventHooks), location_id: id.nullable(), probability: z.number().min(0).max(1),
  once: z.boolean(), public_text: text, set_flag: id.nullable(),
  actor_scope:z.enum(['player','any']).optional(),
  reveal_location_id: id.nullable().optional(), interrupt_automation: z.boolean().optional(),
});
export const physicalIntentSchema=z.strictObject({forms:z.array(z.enum(['strike','push','restrain','other'])).min(1).max(4),source_quote:z.string().min(2).max(1000)});
export const rulesSchema = z.strictObject({
  minutes_per_day: integer.min(60).max(10000), max_wait_minutes: integer.min(1).max(1440),
  ordinary_item_consumption:z.array(z.strictObject({name:z.string().min(2).max(80),minutes:integer.min(1).max(240)})).max(24).optional(),
  talk_minutes: integer.min(1).max(120), trade_minutes: integer.min(1).max(120),
  default_check: z.string().max(30), currencies: dictionary(z.string().min(1).max(80)),
  capability_domains:dictionary(z.strictObject({attribute:id.nullable(),skills:z.array(id).max(8),
    attribute_baseline:z.number().optional(),attribute_step:z.number().positive().optional(),
    condition_sensitive:z.boolean().default(false),exertion_cost:integer.max(10).default(0)})).optional(),
  physical_rules:z.strictObject({minor_damage:integer.min(1).max(100),serious_damage:integer.min(1).max(100)}).optional(),
  resolution_profile:z.strictObject({version:z.literal(1),kind:z.enum(['classic_d20','bell_2d6','percentile_d100'])}).optional(),
  relationship_dimensions: dictionary(z.strictObject({ min: z.number().int(), max: z.number().int(), initial: z.number().int(),
    // Authored semantics, never inferred from a dimension's name or numeric bounds.
    event_deltas:z.strictObject({contact:z.number().int().min(-2).max(2).optional(),
      conflict:z.number().int().min(-2).max(2).optional(),harmed:z.number().int().min(-2).max(2).optional()}).optional() })),
});
export const provenanceSourceSchema = z.enum(['PLAYER_DECLARED','TEMPLATE_DECLARED','AI_GENERATED','CANONICAL_INSTANTIATED','DERIVED','UNKNOWN']);
export const worldCreationProvenanceSchema = z.strictObject({
  version: z.literal(1), original_premise: text.nullable(), declared_themes: z.array(z.string().max(200)).max(30),
  declared_rules: z.array(z.string().max(500)).max(30), player_role: z.string().max(200).nullable(), initial_scope: z.string().max(300).nullable(),
  template_source: z.strictObject({ kind: z.enum(['template','idea','recommended','legacy']), id: z.string().max(80).nullable(), version: integer.nullable() }),
  inspiration_seed: z.number().int().nullable(), preview_signature: z.string().max(500).nullable(),
  explicit_creation_choices: z.array(z.string().max(300)).max(30), explicit_constraints: z.array(z.string().max(500)).max(30),
  requested_traits: z.array(z.string().max(300)).max(30),
  generated_canonical_fact_refs: z.array(z.strictObject({ kind: z.enum(['entity','location','rule','event']), id })).max(1000),
  records: z.array(z.strictObject({ kind: z.enum(['premise','theme','rule','role','scope','constraint','trait','fact']), statement: z.string().min(1).max(1000), source: provenanceSourceSchema, fact_ref: z.strictObject({ kind: z.enum(['entity','location','rule','event']), id }).nullable() })).max(200),
});
export const worldSchema = z.strictObject({
  schema_version: z.literal(1), framework_version: z.literal(VERSION),
  meta: z.strictObject({ id, title: z.string().min(1).max(120), description: text }),
  provenance: worldCreationProvenanceSchema.optional(),
  routine_rules: routineRulesSchema.optional(),
  task_rules:z.array(z.strictObject({task_id:id,book:z.enum(['quests','opportunities']),location_id:id,start_at:integer,end_at:integer,steps:z.array(z.strictObject({action:id,target_id:id.nullable(),minimum_minutes:integer})).min(1).max(20)})).max(100).optional(),
  calendar: calendarSchema.optional(),
  enabled_modules: z.array(id).min(1).max(30), ruleset: rulesSchema, prompt_profile: profileSchema,
  world: z.strictObject({ description: text }), entities: z.array(entitySchema).min(1).max(500),
  // The map capability is optional: a world without map data is a legal world.
  map: z.strictObject({ locations: z.array(locationSchema).min(1).max(500), routes: z.array(routeSchema).max(2000),
    regions:z.array(mapRegionSchema).max(100).optional() }).optional(),
  events: z.array(eventSchema).max(500), player: z.strictObject({ entity_id: id }),
  roleplay_config: roleplayConfigSchema.optional(),
  background_event_policy:backgroundPolicySchema.optional(),
  background_incidents:z.array(backgroundIncidentSchema).max(100).optional(),
  world_macro_arcs:z.array(worldMacroArcSchema).max(2).optional(),
  gm_state: z.strictObject({ notes: text, flags: dictionary(z.boolean()), hidden_truth:hiddenTruthStateSchema.optional() }),
  runtime: z.strictObject({ time: z.strictObject({ day: integer, minute: integer }) }),
});
export const contextActionSchema = z.strictObject({ target_id: id, label: z.string().min(1).max(80), intent: z.string().min(1).max(500), family:z.enum(['communicate','observe','approach','interact','help','use_item','follow','steal','intercept','attack']).optional(), category:z.string().min(1).max(40).nullable().optional() });
export const choiceOfferSchema=z.strictObject({
  id:z.string().uuid(),text:z.string().min(1).max(300),source_revision:integer,
  intent_key:z.string().min(1).max(80),consequence_key:z.string().min(1).max(80),
  action_kind:z.enum(['WORLD_ACTION','WORLD_SPEECH']),target_mentions:z.array(z.string().min(1).max(120)).max(3),
  step_hints:z.array(z.string().min(1).max(300)).max(4),
  availability_at_generation:z.enum(['EXECUTABLE','CONDITIONALLY_EXECUTABLE','UNSUPPORTED']),
  goal_contract:agentPlanSnapshotSchema.optional(),
});
export const sceneBeatSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('narration'),text:z.string().min(1).max(1200)}),
  z.strictObject({kind:z.literal('speech'),speaker_id:id,utterance:z.string().min(1).max(1000)}),
]);
export const scenePresenceClaimSchema=z.strictObject({entity_id:id,location_id:id});
export const narrativeSchema = z.strictObject({ narrative: text, speaker: id.nullable(), dialogue: text.nullable(), scene_beats:z.array(sceneBeatSchema).max(96).optional(), choices: z.array(z.string().min(1).max(300)).max(6), choice_offers:z.array(choiceOfferSchema).max(6).optional(), context_actions: z.array(contextActionSchema).max(20).optional().default([]),
  // Framework-owned presentation provenance; absent on legacy turns.
  presentation:z.strictObject({status:z.enum(['normal','degraded']),reasons:z.array(z.string().min(1).max(500)).max(8)}).optional() });
export const actionSchema = z.strictObject({ type: id, target_id: id.optional(), parameters: dictionary(z.json()).default({}) });
export const mapStateSchema = z.strictObject({
  known_location_ids: z.array(id).max(500).default([]),
  dynamic_locations: z.array(locationSchema).max(300).default([]),
  dynamic_routes: z.array(routeSchema).max(1200).default([]),
  dynamic_regions:z.array(mapRegionSchema).max(100).default([]),
});
const turnHistoryEntrySchema=z.strictObject({turn_id:z.string().uuid(),parent_turn_id:z.string().uuid().nullable(),before:z.record(z.string(),z.json()),after_hash:z.string(),label:z.string().min(1).max(160),time:z.strictObject({day:integer,minute:integer})});
/** One bounded attempt sequence; not a recurring job or a promise of success. */
export const repetitionSchema=z.strictObject({source_quote:z.string().min(2).max(1000),
  duration_seconds:z.number().int().min(1).max(300).nullable(),
  interval_seconds:z.number().int().min(1).max(60),
  termination_mode:z.enum(['while_executable','until_unsuccessful_result']).default('while_executable')});
export const saveSchema = z.strictObject({
  resolution_receipts:z.array(z.strictObject({
    request_id:z.string().min(1).max(100),action_id:z.string().min(1).max(100),actor_id:id,target_id:id.nullable(),semantic_action:z.string().min(1).max(1000),
    kind:z.enum(['DETERMINISTIC','SIMPLE_CHECK','OPPOSED_CHECK','GRADED_CHECK','EXTENDED_CHECK']),
    prerequisites:z.array(z.strictObject({kind:z.string().max(40),subject_id:z.string().min(1).max(100).nullable(),satisfied:z.literal(true)})).max(20),
    check_id:z.string().max(100),rolls:z.array(z.strictObject({expression:z.string().max(30),rolls:z.array(integer),modifier:z.number().int(),total:z.number().int()})).max(20),
    outcome:z.enum(['critical_failure','failure','partial_success','success','strong_success']),
    time_cost:integer,canonical_facts:z.array(z.string().max(500)).max(12),effects:z.array(z.enum(['time','activity','position','inventory','relationship','evidence','money','injury','death','state','progress'])).max(12),
    activity:z.strictObject({description:z.string().min(1).max(300),location_id:id.nullable(),duration_minutes:integer,occurred:z.literal(true)}).optional(),
    inspection_results:z.array(z.strictObject({item:z.string().min(1).max(120),result:z.enum(['found','nothing','blocked','not_checked']),detail:z.string().max(300)})).max(12).optional(),
    inspection_status:z.enum(['complete','partial','world_blocked','not_executed','objective_failure','technical_failure']).optional(),
    consumption:consumptionReceiptSchema.optional(),
    storage:z.strictObject({item_id:id,container_id:id}).optional(),
    progress_changes:z.array(z.strictObject({key:id,before:integer,after:integer})).max(12).optional(),
    result_entities:z.record(id,z.array(id).max(20)).optional(),
    movement_route:movementRouteSchema.optional(),
    environment:environmentReceiptSchema.optional(),
    repetition:z.strictObject({requested_seconds:z.number().int(),elapsed_seconds:z.number().int(),attempt_ids:z.array(z.string()).max(8),
      termination_mode:z.enum(['while_executable','until_unsuccessful_result']).optional(),
      stopped_by:z.enum(['duration','budget','failed_attempt','target_unavailable','actor_unable','interrupted'])}).optional(),
    physical_outcome:z.strictObject({action_forms:z.array(z.enum(['strike','push','restrain','other'])).max(4).optional(),kind:z.enum(['harm','restrain']),target_id:id,contact:z.boolean(),
      harmed:z.boolean(),damage:integer,control_established:z.boolean().optional(),contact_stage_id:id,injury_stage_id:id.nullable(),witness_ids:z.array(id).max(30),
      /** Recorded at settlement: ids that had no sight of this action and therefore cannot claim to have seen it. */
      sight_blocked_ids:z.array(id).max(30).optional()}).optional(),
    at:z.strictObject({day:integer,minute:integer}).optional(),commit_status:z.enum(['pending','committed']),
  })).max(200).optional(),
  resolution_history:z.array(z.strictObject({request_id:z.string().uuid(),check_id:z.string().max(100),spec:z.record(z.string(),z.json()),rolls:z.array(z.strictObject({expression:z.string().max(30),rolls:z.array(integer),modifier:z.number().int(),total:z.number().int()})).max(20),outcome:z.enum(['critical_failure','failure','partial_success','success','strong_success']),
    stage_results:z.array(z.strictObject({id,passed:z.boolean(),margin:z.number().int(),blocked_reason:z.string().min(1).max(300).optional()})).max(8).optional(),hidden:z.boolean()})).max(200).optional(),
  event_roll_history:z.array(z.strictObject({request_id:z.string().min(1).max(100),event_id:id,hook:z.enum(worldEventHooks),sample:z.number().min(0).max(1),probability:z.number().min(0).max(1),fired:z.boolean()})).max(500).optional(),
  interaction_context: z.strictObject({ mode:z.literal('conversation'), target_entity_id:id, started_turn:integer, last_interaction_turn:integer, scene_anchor:z.string().max(500), status:z.enum(['active','ended']) }).optional(),
  narrative_history: z.array(z.strictObject({ request_id:z.string().uuid(), narrative:text, dialogue:text.nullable(), speaker:id.nullable(), facts:z.array(z.string().max(2000)).max(12),
    // Older saves have no player speech record. Absence means unknown, never "the player did not say it".
    player_input:z.string().max(2000).optional(),revision:integer.optional(),time:z.strictObject({day:integer,minute:integer}).optional(),location_id:id.nullable().optional(),
    speech_events:z.array(z.strictObject({speaker_id:id,utterance:z.string().min(1).max(1000),provenance:z.enum(['verbatim_player_input','generated_from_player_intent','npc_response']),source_intent:z.string().max(2000).nullable()})).max(12).optional(),
  })).max(8).optional(),
  // Optional in older saves. Never included in PublicView; the NPC projector grants per-character access.
  npc_agent_state:z.record(id,npcAgentStateSchema).optional(),
  environment_state:environmentStateSchema.optional(),
  npc_autonomy_last_at:z.strictObject({day:integer,minute:integer}).optional(),
  npc_daily_last_at:z.strictObject({day:integer,minute:integer}).optional(),
  // A non-recursive before image travels in the same atomic file as the committed turn.
  turn_checkpoint: z.strictObject({ turn_id:z.string().uuid(), before:z.record(z.string(),z.json()), after_hash:z.string(), parent_turn_id:z.string().uuid().nullable() }).optional(),
  turn_history:z.array(turnHistoryEntrySchema).max(20).optional(),
  turn_audit: z.array(z.strictObject({ turn_id:z.string().uuid(), parent_turn_id:z.string().uuid().nullable(), reverted_at:integer, before:z.record(z.string(),z.json()), after:z.record(z.string(),z.json()) })).optional(),
  active_turn_id:z.string().uuid().nullable().optional(),
  action_facts: z.array(z.strictObject({request_id:z.string().uuid(),actor_id:id,target_id:id.nullable(),input:z.string().max(10000),facts:z.array(z.string().max(300)).max(4),time:z.strictObject({day:integer,minute:integer})})).max(100).optional(),
  pending_world_clarification:z.strictObject({input:z.string().min(1).max(12000),question:z.string().max(600),created_revision:integer,at:z.number().int().nonnegative()}).optional(),
  future_intents:z.array(futureIntentSchema).max(500).optional(),
  active_goal:z.strictObject({plan:agentPlanSnapshotSchema,
    waiting_question:z.string().max(600).nullable(),
    options:z.array(z.strictObject({candidate_id:z.string().min(1).max(200),label:z.string().min(1).max(200)})).max(30)}).optional(),
  paused_goals:z.array(z.strictObject({plan:agentPlanSnapshotSchema,
    waiting_question:z.string().max(600).nullable(),
    options:z.array(z.strictObject({candidate_id:z.string().min(1).max(200),label:z.string().min(1).max(200)})).max(30)})).max(5).optional(),
  extensions:extensionEntriesSchema.optional(),
  task_progress:dictionary(integer).optional(),
  foreground:z.strictObject({blocker:z.enum(['choice','npc_reply','travel','task','danger','interrupt']).nullable(),reason:z.string().max(500)}).optional(),
  calendar: calendarSchema.optional(),
  routine_meta: routineMetaSchema.optional(),
  // Runtime style configuration: structured, bounded, per scope. Never raw system prompt text.
  behavior_config: z.array(z.strictObject({
    scope: z.enum(['narration','dialogue','assistant']),
    op: z.enum(['suffix','prefix','tone','constraint']),
    application: z.enum(['per_sentence','per_paragraph','per_message','final_sentence']).default('per_message'),

    value: z.string().min(1).max(120), raw: z.string().min(1).max(200),
    enabled: z.boolean().default(true), created_at: z.string().max(40),
  })).max(20).default([]),
  behavior_patches:z.array(behaviorPatchSchema).max(100).optional(),
  schema_version: z.literal(1), framework_version: z.literal(VERSION), module_versions: dictionary(z.string().max(30)),
  modules: dictionary(z.strictObject({ installed: z.boolean(), enabled: z.boolean(), version: z.string().max(30), state_version: z.string().max(30) })).default({}),
  game_id: z.string().uuid(), state_revision: integer, definition: worldSchema,
  entities: z.array(entitySchema).min(1).max(1000), player_state: z.strictObject({ entity_id: id }),
  gm_state: z.strictObject({ notes: text, flags: dictionary(z.boolean()), hidden_truth:hiddenTruthStateSchema.optional() }),
  narrative_state:narrativeStateSchema.optional(),
  background_state:backgroundStateSchema.optional(),
  event_state: z.strictObject({ fired: z.array(id).max(500), counts: dictionary(integer) }),
  runtime: z.strictObject({ time: z.strictObject({ day: integer, minute: integer }),
    scene_seconds:z.number().int().min(0).max(59).optional(),
    receipts: z.array(z.strictObject({ id: z.string().uuid(), fingerprint: z.string(), revision: integer,compound_steps:z.array(z.string().min(1).max(2000)).min(2).max(4).optional() })).max(100) }),
  map_state: mapStateSchema.default({ known_location_ids: [], dynamic_locations: [], dynamic_routes: [],dynamic_regions:[] }),
  ai: z.strictObject({ threads: dictionary(z.string().max(200)) }),
  last_turn: narrativeSchema.nullable(),
});
export type WorldPackage = z.infer<typeof worldSchema>;
export type WorldCreationProvenance = z.infer<typeof worldCreationProvenanceSchema>;
export type SavePackage = z.infer<typeof saveSchema>;
export type ChoiceOffer = z.infer<typeof choiceOfferSchema>;
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

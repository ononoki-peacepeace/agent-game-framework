import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(x => !['constructor','prototype','__proto__'].includes(x));
const integer = z.number().int().min(0).max(1_000_000_000);
const text = z.string().max(100000);

export const deathPolicySchema = z.enum(['protected','narrative_standard','hardcore','immortal']);
export const narrativeModeSchema = z.enum(['minimal','standard','story_focused']);
export const narrativeScaleSchema = z.enum(['short','seasonal','life_chapter','life_epic','open_ended']);
export const lifeHorizonSchema = z.strictObject({
  kind: z.enum(['species_normal','custom','ai_suggested','open_ended','immortal']),
  target_age_min: integer.min(1).max(1_000_000).nullable(),
  target_age_max: integer.min(1).max(1_000_000).nullable(),
  basis: z.string().max(500),
}).superRefine((value,ctx)=>{
  const open=value.kind==='open_ended'||value.kind==='immortal';
  if(open&&(value.target_age_min!==null||value.target_age_max!==null))ctx.addIssue({code:'custom',message:'开放式人生不能设置固定年龄'});
  if(!open&&(value.target_age_min===null||value.target_age_max===null||value.target_age_min>value.target_age_max!))ctx.addIssue({code:'custom',message:'人生长度参考需要有效范围'});
});
export const roleplayConfigSchema = z.strictObject({
  version: z.literal(1), constitution_version: z.literal(1),
  death_policy: deathPolicySchema.default('narrative_standard'),
  narrative_mode: narrativeModeSchema.default('standard'),
  narrative_scale: narrativeScaleSchema.default('seasonal'),
  major_arc_soft_cap: integer.min(1).max(8).default(3),
  major_open_loop_soft_cap: integer.min(1).max(12).default(5),
  life_horizon: lifeHorizonSchema,
});

export const truthCommitmentSchema = z.strictObject({
  id, commitment: z.enum(['HARD_TRUTH','SEEDED_TRUTH','UNDEFINED']), statement: text,
  seed_constraint: text.nullable(), source: z.enum(['WORLD_CREATION','CANONICAL_EVENT','GM_DECLARED']),
  created_event_ref: z.string().max(100).nullable(),
  evidence: z.array(z.strictObject({
    id, status: z.enum(['EXISTS','CAUSALLY_CREATED','DESTROYED']), description: text,
    event_ref: z.string().max(100).nullable(), discovered_by: z.array(id).max(100),
  })).max(100),
  known_by: z.array(id).max(100),
});
export const hiddenTruthStateSchema = z.strictObject({ version:z.literal(1), commitments:z.array(truthCommitmentSchema).max(200) });

export const arcStatusSchema = z.enum(['SEED','EMERGING','ACTIVE','DORMANT','CONVERGING','CLIMAX','RESOLVED','FAILED','ABANDONED','AFTERMATH','CLOSED']);
export const narrativeArcSchema = z.strictObject({
  id, title:z.string().min(1).max(160), status:arcStatusSchema, summary:z.string().max(1000),
  canonical_event_refs:z.array(z.string().max(100)).max(100), truth_refs:z.array(id).max(50), participant_refs:z.array(id).max(100),
  closure_priority:z.number().min(0).max(1), reveal_step:integer.min(0).max(20),
  accelerated_closure:z.boolean(), last_meaningful_revision:integer,
});
export const sagaRecordSchema = z.strictObject({
  id, title:z.string().min(1).max(160), start_time:z.strictObject({day:integer,minute:integer}), end_time:z.strictObject({day:integer,minute:integer}),
  major_participant_refs:z.array(id).max(100), major_arc_refs:z.array(id).max(100), outcome:z.string().max(1000), failures:z.array(z.string().max(500)).max(50),
  permanent_world_change_refs:z.array(z.string().max(100)).max(100), unresolved_arc_refs:z.array(id).max(100), continuation_hooks:z.array(z.string().max(500)).max(50),
});
export const currentSagaSchema = z.strictObject({
  id, title:z.string().min(1).max(160), start_time:z.strictObject({day:integer,minute:integer}), phase:z.enum(['FORMING','DEVELOPING','ESCALATING','CLIMAX','AFTERMATH']),
  arc_refs:z.array(id).max(100), canonical_event_refs:z.array(z.string().max(100)).max(200),
});
export const openLoopSchema = z.strictObject({
  id, label:z.string().min(1).max(200), importance:z.enum(['major','minor']), status:z.enum(['OPEN','RESOLVED','MERGED','UNKNOWN']),
  source_event_ref:z.string().max(100).nullable(), truth_ref:id.nullable(), arc_ref:id.nullable(),
});
export const setupSchema = z.strictObject({
  id, label:z.string().min(1).max(200), status:z.enum(['UNPAID','PAID_OFF','RESOLVED','MERGED','LEFT_UNKNOWN']),
  source_event_ref:z.string().max(100), payoff_event_ref:z.string().max(100).nullable(), arc_ref:id.nullable(), truth_ref:id.nullable(),
});
export const directorDecisionSchema = z.strictObject({
  revision:integer, trigger:z.enum(['ARC_CHANGE','SAGA_MILESTONE','KEY_NPC_ACTION','IMPORTANT_DISCOVERY','TIME_JUMP','SCENE_CLUSTER_END','MEANINGFUL_TURNS','PLAYER_DIRECTION','MAJOR_WORLD_EVENT']),
  directives:z.array(z.strictObject({kind:z.enum(['FOCUS','REPLAN','REVEAL_OPPORTUNITY','PAYOFF_OPPORTUNITY','CONVERGE','CLOSURE_OPPORTUNITY','DORMANT','MERGE']),arc_ref:id.nullable(),reason:z.string().max(500)})).max(12),
  invalidated_decision_revisions:z.array(integer).max(20),
});
export const narrativeStateSchema = z.strictObject({
  version:z.literal(1), constitution_version:z.literal(1), player_entity_ref:id,
  current_saga:currentSagaSchema.nullable(), saga_history:z.array(sagaRecordSchema).max(100), arcs:z.array(narrativeArcSchema).max(200),
  open_loops:z.array(openLoopSchema).max(300), unpaid_setups:z.array(setupSchema).max(300),
  closure_pressure:z.number().min(0).max(1), director_phase:z.enum(['IDLE','EVALUATING','WAITING_FOR_WORLD','CLOSING']),
  meaningful_turns_since_evaluation:integer, recent_director_decisions:z.array(directorDecisionSchema).max(20),
});

export type RoleplayConfig=z.infer<typeof roleplayConfigSchema>;
export type HiddenTruthState=z.infer<typeof hiddenTruthStateSchema>;
export type NarrativeState=z.infer<typeof narrativeStateSchema>;
export type NarrativeArc=z.infer<typeof narrativeArcSchema>;
export type DirectorDecision=z.infer<typeof directorDecisionSchema>;

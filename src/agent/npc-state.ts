import {z} from 'zod';

const ref=z.string().min(1).max(120);
const statement=z.string().min(1).max(500);
const moment=z.strictObject({day:z.number().int().nonnegative(),minute:z.number().int().nonnegative()});
export const npcKnowledgeSchema=z.strictObject({
  id:ref,proposition:statement,source_type:z.enum(['observed','told_by','public_event','inferred','self_knowledge']),
  source_ref:ref.nullable(),learned_at:moment,confidence:z.number().min(0).max(1),
});
export const npcBeliefSchema=z.strictObject({
  id:ref,proposition:statement,stance:z.enum(['believed','suspected','doubted','rejected','unknown']),
  confidence:z.number().min(0).max(1),evidence_refs:z.array(ref).max(12),updated_at:moment,
});
export const npcMemorySchema=z.strictObject({
  event_ref:ref,kind:z.enum(['heard','observed','participated','decision','public_event']),
  summary:statement,participant_ids:z.array(ref).max(12),at:moment,importance:z.number().int().min(0).max(3),
});
export const npcGoalSchema=z.strictObject({
  id:ref,description:statement,horizon:z.enum(['short','long']),status:z.enum(['active','completed','abandoned']),
  origin:ref,priority:z.number().int().min(0).max(10),
});
/** Small, typed intentions, not arbitrary Core patches or a second action language. */
export const npcPlanStepSchema=z.strictObject({
  type:z.enum(['MOVE','INSPECT','TALK','HOLD']),target_id:ref.nullable(),
  description:statement,duration_minutes:z.number().int().min(1).max(240).nullable(),
  speech:z.string().min(1).max(1000).nullable(),
});
export const npcPlanSchema=z.strictObject({
  id:ref,goal_id:ref,intention:statement,status:z.enum(['active','completed','abandoned']),
  last_failed_request_id:ref.optional(),
  // An NPC's own scene decision may supply a bounded executable step. Older plans omit this.
  activity:z.strictObject({kind:z.literal('move'),origin_location_id:ref,destination_id:ref,
    source_request_id:ref,condition:z.string().max(300).nullable(),
    last_accounted_at:moment,time_credit_minutes:z.number().int().min(0).max(1440),
    blocked_reason:z.enum(['core_rejected','system_error']).optional(),failure_diagnostic:z.string().max(240).optional()}).optional(),
  execution:z.strictObject({steps:z.array(npcPlanStepSchema).min(1).max(6),cursor:z.number().int().min(0).max(6),
    not_before:moment.nullable(),condition:z.string().max(300).nullable().default(null),last_accounted_at:moment,time_credit_minutes:z.number().int().min(0).max(1440),
    last_request_id:ref.nullable(),last_receipt_id:ref.optional(),blocked_reason:z.string().max(300).nullable(),
    failure_diagnostic:z.string().max(240).optional()}).optional(),
});
export const npcPrivateFactSchema=z.strictObject({id:ref,proposition:statement,source_ref:ref.nullable()});
export const npcDecisionRecordSchema=z.strictObject({
  event_ref:ref,kind:z.enum(['speech','vote','no_action','proposed_action']),summary:statement,
  target_id:ref.nullable(),revision:z.number().int().nonnegative(),
  speech:z.string().max(2000).nullable().optional(),
});
/** A scene-authorized, time-bound social intention. Core receipts settle every physical step. */
export const npcSocialTaskSchema=z.strictObject({
  id:ref,kind:z.enum(['relay','invitation','attend']),status:z.enum(['active','completed','blocked','cancelled','missed']),
  message:statement,organizer_id:ref,activity_location_id:ref,
  destination_ids:z.array(ref).max(12),recipient_ids:z.array(ref).max(20),
  notified_ids:z.array(ref).max(20).default([]),declined_ids:z.array(ref).max(20).default([]),
  activity_at:moment,next_at:moment,source_request_id:ref,
  last_accounted_at:moment,time_credit_minutes:z.number().int().min(0).max(240).default(0),
  condition:z.string().max(300).nullable().default(null),
});
/** Private per-character cognition. Relationships retain their existing authoritative component. */
export const npcAgentStateSchema=z.strictObject({
  last_autonomous_at:moment.optional(),
  last_autonomous_request_id:ref.optional(),
  autonomy_retry:z.strictObject({attempts:z.number().int().min(1).max(16),last_attempt_at:moment,
    retry_at:moment,stage:z.enum(['decision','cognition_admission'])}).optional(),
  last_daily_at:moment.optional(),
  last_activity_at:moment.optional(),
  knowledge:z.array(npcKnowledgeSchema).max(80).default([]),
  beliefs:z.array(npcBeliefSchema).max(80).default([]),
  memories:z.array(npcMemorySchema).max(60).default([]),
  goals:z.array(npcGoalSchema).max(24).default([]),
  plans:z.array(npcPlanSchema).max(24).default([]),
  social_tasks:z.array(npcSocialTaskSchema).max(12).default([]),
  private_facts:z.array(npcPrivateFactSchema).max(40).default([]),
  last_decisions:z.array(npcDecisionRecordSchema).max(12).default([]),
  // A scene-authorized departure decision scoped to its origin, not a second location or party state.
  // Revisions alone do not revoke willingness; refusal, solo departure or independent travel can.
  travel_intent:z.strictObject({status:z.enum(['willing','conditional','declined']),origin_location_id:ref,
    source_request_id:ref,recorded_revision:z.number().int().nonnegative()}).optional(),
  // One current player/NPC contact state. This records continuity, not relationship or consent forever.
  contact_state:z.strictObject({status:z.enum(['active','refused','ended']),description:z.string().min(1).max(180),
    location_id:ref,source_request_id:ref,recorded_revision:z.number().int().nonnegative()}).optional(),
});
export type NpcAgentState=z.infer<typeof npcAgentStateSchema>;
export const emptyNpcAgentState=():NpcAgentState=>npcAgentStateSchema.parse({});

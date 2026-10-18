import {z} from 'zod';

const ref=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
/** A query is a player-authorized attempt, never a declaration that an object exists. */
export const environmentQuerySchema=z.strictObject({
  name:z.string().trim().min(2).max(80).regex(/[\p{L}\p{N}]/u),source_quote:z.string().min(2).max(2000),
  intent:z.enum(['observe','take_if_available']),
  container_id:ref.nullable().optional(),
});
export const environmentAssessmentSchema=z.strictObject({
  authorized_intent:z.enum(['observe','take_if_available','invalid']),
  scope_complete:z.boolean(),
  classification:z.enum(['ordinary_item','environment_detail','protected','scarce_resource','valuable','hazardous','consumable','unsupported']),
  existence:z.enum(['present','absent','undetermined']),ownership:z.enum(['unclaimed','shared','private','unknown']),
  world_compatible:z.boolean(),scene_compatible:z.boolean(),contradicts_known:z.boolean(),resource_advantage:z.boolean(),
  weight:z.number().min(0).max(1),description:z.string().min(1).max(180),
  basis:z.array(z.strictObject({source:z.enum(['world','scene']),quote:z.string().min(2).max(200)})).min(1).max(2),
  same_as:ref.nullable(),
});
export const environmentResolutionSchema=z.strictObject({
  id:ref,location_id:ref,name:z.string().min(2).max(80),aliases:z.array(z.string().min(2).max(80)).max(8),
  container_id:ref.nullable().optional(),
  status:z.enum(['present','absent','unresolved']),classification:z.enum(['ordinary_item','environment_detail','restricted']),
  sequence:z.number().int().nonnegative().optional(),
  entity_id:ref.nullable(),description:z.string().min(1).max(180),take_allowed:z.boolean(),
  source_request_id:z.string().uuid(),at:z.strictObject({day:z.number().int().nonnegative(),minute:z.number().int().nonnegative()}),
  // Legacy records predate actor-scoped discovery and were all player observations.
  known_by:z.array(ref).max(30).optional(),
});
export const environmentSurveySchema=z.strictObject({location_id:ref,container_id:ref.nullable().optional(),source_request_id:z.string().uuid(),
  at:z.strictObject({day:z.number().int().nonnegative(),minute:z.number().int().nonnegative()}),
  record_ids:z.array(ref).max(3),known_by:z.array(ref).max(30),complete_empty:z.boolean().optional(),
  complete_contents:z.boolean().optional(),
  sequence:z.number().int().nonnegative().optional()});
export const environmentSurveyProposalSchema=z.strictObject({complete_empty:z.boolean().optional(),
  empty_assessment:environmentAssessmentSchema.optional(),complete_contents:z.boolean().optional(),
  contents_assessment:environmentAssessmentSchema.optional(),features:z.array(z.strictObject({
  name:z.string().trim().min(2).max(80).regex(/[\p{L}\p{N}]/u),assessment:environmentAssessmentSchema,
})).max(3)});
/** Optional for legacy saves; records are never evicted to make room for more resources. */
export const environmentStateSchema=z.strictObject({resolutions:z.array(environmentResolutionSchema).max(128),
  surveys:z.array(environmentSurveySchema).max(128).optional(),sequence:z.number().int().nonnegative().optional()});
export const environmentReceiptSchema=z.strictObject({
  resolution_id:ref.nullable(),status:z.enum(['present','absent','unresolved']),
  entity_id:ref.nullable(),taken:z.boolean(),reason:z.enum(['observed','not_found','restricted','not_accessible','permission_required','budget','taken','already_held']),
});
export type EnvironmentQuery=z.infer<typeof environmentQuerySchema>;
export type EnvironmentAssessment=z.infer<typeof environmentAssessmentSchema>;
export type EnvironmentResolution=z.infer<typeof environmentResolutionSchema>;
export type EnvironmentReceipt=z.infer<typeof environmentReceiptSchema>;
export type EnvironmentSurveyProposal=z.infer<typeof environmentSurveyProposalSchema>;

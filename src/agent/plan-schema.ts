import {z} from 'zod';
const ref=z.string().min(1).max(100);
export const conditionSchema=z.strictObject({kind:z.enum(['familiar','present','observed_event','public_fact','unknown']),entity_id:ref,description:z.string().max(500)});
export const temporalSchema=z.strictObject({scope:z.enum(['now','future','scheduled']),day_offset:z.number().int().min(0).max(3650),window:z.enum(['any','morning','afternoon','evening','after_school'])});
export const goalSchema=z.strictObject({
 goal_id:ref,type:z.enum(['WORLD_QUERY','WORLD_LOOKUP','UI_NAVIGATION','WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL','CONTINUE_ROUTINE','FUTURE_INTENT','SCHEDULED_INTENT','CONDITIONAL_INTENT','LIST_FUTURE','CANCEL_FUTURE','EXECUTE_FUTURE']),
 normalized_goal:z.string().min(1).max(2000),depends_on:z.array(ref).max(12),condition:conditionSchema.nullable(),branch:z.enum(['then','else']).nullable(),
 temporal_scope:temporalSchema,target_entities:z.array(ref).max(10),
  // Suggestions only. The compiler binds public entities and assigns authoritative evidence requirements.
  operation_hint:z.enum(['move','purchase','presence_query','activity','talk','item_move','other']).optional(),referent:z.string().min(1).max(120).nullable().optional(),
  item_destination:z.enum(['held','scene','container']).nullable().optional(),
  quantity:z.number().int().min(1).max(100).nullable().optional(),
});
export const blueprintSchema=z.strictObject({goals:z.array(goalSchema).min(1).max(12)});
export type GoalInput=z.infer<typeof goalSchema>;
export const goalStatusSchema=z.enum(['pending','ready','running','completed','skipped','failed','unresolved','blocked','waiting_for_player']);
export type GoalStatus=z.infer<typeof goalStatusSchema>;
export const bindingSchema=z.strictObject({role:z.enum(['destination','shop','item','person']),mention:z.string().min(1).max(120),entity_id:ref.nullable(),status:z.enum(['unresolved','bound','ambiguous','unavailable'])});
export const completionRequirementSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('location_at'),destination_id:ref.nullable()}),
  z.strictObject({kind:z.literal('purchase'),shop_id:ref.nullable(),item_id:ref.nullable(),quantity:z.number().int().min(1).max(100).nullable().optional()}),
  z.strictObject({kind:z.literal('presence_observed'),person_id:ref.nullable(),location_id:ref.nullable()}),
  z.strictObject({kind:z.literal('conversation_attempted'),person_id:ref.nullable()}),
  z.strictObject({kind:z.literal('activity_occurred')}),
  z.strictObject({kind:z.literal('item_location'),item_id:ref.nullable(),to:z.enum(['held','scene'])}),
  z.strictObject({kind:z.literal('unsupported')}),
]);
export const stepContractSchema=z.strictObject({bindings:z.array(bindingSchema).max(10),required_capabilities:z.array(ref).max(10),completion:completionRequirementSchema,
  availability:z.enum(['ready','needs_binding','capability_gap','runtime_gap']),
  evidence_refs:z.array(z.strictObject({request_id:z.string().uuid().nullable(),observed_revision:z.number().int().nonnegative().nullable()})).max(12)});
export const planContractSchema=z.strictObject({source:z.enum(['manual','choice']),original_intent:z.string().min(1).max(12000),offer_id:z.string().uuid().nullable(),
  execution_mode:z.enum(['atomic_local','staged']),source_revision:z.number().int().nonnegative(),last_observed_revision:z.number().int().nonnegative(),
  execution_availability:z.enum(['ready','needs_binding','capability_gap','runtime_gap'])});
export type StepContract=z.infer<typeof stepContractSchema>;
export type PlanContract=z.infer<typeof planContractSchema>;
export interface AtomicGoal extends GoalInput {side_effect_level:'none'|'player_plan'|'world';requires_confirmation:boolean;status:GoalStatus;result?:{
  summary:string;condition?:boolean|null;observation?:{value:'present'|'absent'|'unknown';source:'public_location'|'insufficient_public_state';revision:number}};contract?:StepContract}
export interface AgentPlan {plan_id:string;goals:AtomicGoal[];dependencies:{from:string;to:string}[];execution_order:string[];ui_policy:'one_primary_panel';status:'pending'|'running'|'completed'|'partial'|'failed'|'blocked'|'waiting_for_player';local_compound?:{steps:string[]};contract?:PlanContract}
export const agentPlanSnapshotSchema=z.strictObject({plan_id:z.string().uuid(),goals:z.array(z.strictObject({...goalSchema.shape,
  side_effect_level:z.enum(['none','player_plan','world']),requires_confirmation:z.boolean(),status:goalStatusSchema,
  result:z.strictObject({summary:z.string(),condition:z.boolean().nullable().optional(),observation:z.strictObject({
    value:z.enum(['present','absent','unknown']),source:z.enum(['public_location','insufficient_public_state']),
    revision:z.number().int().nonnegative()}).optional()}).optional(),contract:stepContractSchema.optional()})).min(1).max(12),
  dependencies:z.array(z.strictObject({from:ref,to:ref})).max(144),execution_order:z.array(ref).max(12),ui_policy:z.literal('one_primary_panel'),
  status:z.enum(['pending','running','completed','partial','failed','blocked','waiting_for_player']),local_compound:z.strictObject({steps:z.array(z.string()).min(2).max(4)}).optional(),contract:planContractSchema.optional()});
export const futureIntentSchema=z.strictObject({
 id:z.string().uuid(),plan_id:z.string().uuid(),goal_id:ref,created_at:z.strictObject({day:z.number().int(),minute:z.number().int()}),
 source_text:z.string().max(4000),target_date:z.number().int().min(0).nullable(),time_window:temporalSchema.shape.window,
 target_entities:z.array(ref).max(10),goal:z.string().max(2000),condition:conditionSchema.nullable(),
 condition_expected:z.boolean().default(true),
 status:z.enum(['planned','due','cancelled','completed','expired','superseded']),completed_by_request:z.string().uuid().nullable(),
});
export type FutureIntent=z.infer<typeof futureIntentSchema>;

import {z} from 'zod';
const ref=z.string().min(1).max(100);
export const conditionSchema=z.strictObject({kind:z.enum(['familiar','present','unknown']),entity_id:ref,description:z.string().max(500)});
export const temporalSchema=z.strictObject({scope:z.enum(['now','future','scheduled']),day_offset:z.number().int().min(0).max(3650),window:z.enum(['any','morning','afternoon','evening','after_school'])});
export const goalSchema=z.strictObject({
 goal_id:ref,type:z.enum(['WORLD_QUERY','WORLD_LOOKUP','UI_NAVIGATION','WORLD_ACTION','WORLD_SPEECH','CONTINUE_ROUTINE','FUTURE_INTENT','SCHEDULED_INTENT','CONDITIONAL_INTENT','LIST_FUTURE','CANCEL_FUTURE','EXECUTE_FUTURE']),
 normalized_goal:z.string().min(1).max(2000),depends_on:z.array(ref).max(12),condition:conditionSchema.nullable(),branch:z.enum(['then','else']).nullable(),
 temporal_scope:temporalSchema,target_entities:z.array(ref).max(10),
});
export const blueprintSchema=z.strictObject({goals:z.array(goalSchema).min(1).max(12)});
export type GoalInput=z.infer<typeof goalSchema>;
export type GoalStatus='pending'|'ready'|'running'|'completed'|'skipped'|'failed'|'unresolved';
export interface AtomicGoal extends GoalInput {side_effect_level:'none'|'player_plan'|'world';requires_confirmation:boolean;status:GoalStatus;result?:{summary:string;condition?:boolean|null}}
export interface AgentPlan {plan_id:string;goals:AtomicGoal[];dependencies:{from:string;to:string}[];execution_order:string[];ui_policy:'one_primary_panel';status:'pending'|'running'|'completed'|'partial'|'failed'}
export const futureIntentSchema=z.strictObject({
 id:z.string().uuid(),plan_id:z.string().uuid(),goal_id:ref,created_at:z.strictObject({day:z.number().int(),minute:z.number().int()}),
 source_text:z.string().max(4000),target_date:z.number().int().min(0).nullable(),time_window:temporalSchema.shape.window,
 target_entities:z.array(ref).max(10),goal:z.string().max(2000),condition:conditionSchema.nullable(),
 condition_expected:z.boolean().default(true),
 status:z.enum(['planned','due','cancelled','completed','expired','superseded']),completed_by_request:z.string().uuid().nullable(),
});
export type FutureIntent=z.infer<typeof futureIntentSchema>;

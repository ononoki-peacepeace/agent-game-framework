import {z} from 'zod';
import {personaAuthoringSchema} from '../characters/authoring.js';

const id=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const backgroundTimeSchema=z.strictObject({day:z.number().int().min(0),minute:z.number().int().min(0)});
const effectSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('set_flag'),flag:id}),
  z.strictObject({kind:z.literal('clear_flag'),flag:id}),
  z.strictObject({kind:z.literal('move_npc'),npc_id:id,location_id:id}),
  z.strictObject({kind:z.literal('npc_unavailable'),npc_id:id,value:z.boolean()}),
  z.strictObject({kind:z.literal('add_marker'),npc_id:id,marker:id}),
  z.strictObject({kind:z.literal('remove_marker'),npc_id:id,marker:id}),
  z.strictObject({kind:z.literal('reveal_location'),location_id:id}),
  z.strictObject({kind:z.literal('create_location'),location_id:id,
    name:z.string().min(1).max(120),category:id,description:z.string().min(1).max(1000),
    parent_id:id,anchor_id:id,travel_minutes:z.number().int().min(1).max(240),
    visibility:z.enum(['hidden','locally_known','public']),creation_reason:z.string().min(15).max(500),source_ref:id}),
  z.strictObject({kind:z.literal('set_location_status'),location_id:id,status:z.enum(['active','closed']),
    reason:z.string().min(1).max(300)}),
  z.strictObject({kind:z.literal('spawn_character'),entity_id:id,name:z.string().min(1).max(120),
    public_description:z.string().max(1000),role:z.string().min(1).max(200),
    age:z.number().int().min(0).max(10000).nullable(),gender:z.enum(['male','female','nonbinary']).nullable(),
    location_id:id,home_location_id:id.nullable(),entrance_reason:z.string().min(1).max(300),
    population_need:z.enum(['vacancy','migration','family','institution','organization','case']),
    motivation:z.string().max(300),importance:z.enum(['minor','recurring','major']),persona:personaAuthoringSchema.partial().optional(),
    relationship_seed_id:id.nullable(),
  }),
  z.strictObject({kind:z.literal('depart_character'),npc_id:id,reason:z.string().min(1).max(300)}),
  z.strictObject({kind:z.literal('relationship_seed'),from_id:id,to_id:id,dimension:id,value:z.number().int()}),
]);
export const exposureSchema=z.strictObject({
  id,channel:z.enum(['same_location','related_npc','public_notice','rumor','direct_contact','scheduled_environment_change']),
  location_id:id.nullable(),npc_id:id.nullable(),text:z.string().min(1).max(500),
  delivery_scope:z.enum(['anchor','parent_area']).optional(),
  interrupt:z.boolean(),open_loop_label:z.string().min(1).max(160).nullable(),
});
export const causalBasisSchema=z.strictObject({
  underlying_pressure:z.string().min(1).max(300),actor_motivation:z.string().min(1).max(300),
  resource_constraint:z.string().min(1).max(300),historical_cause:z.string().min(1).max(300),
  social_relationship:z.string().min(1).max(300),trigger:z.string().min(1).max(300),
  unintended_consequence:z.string().min(1).max(300),
});
export const backgroundStageSchema=z.strictObject({
  id,earliest_after_minutes:z.number().int().min(0).max(1_000_000),latest_after_minutes:z.number().int().min(0).max(1_000_000).nullable(),
  required_flags:z.array(id).max(12),actor_id:id.nullable(),effects:z.array(effectSchema).max(12),
  exposures:z.array(exposureSchema).max(8),terminal:z.enum(['none','resolved','expired']),
});
export const backgroundIncidentSchema=z.strictObject({
  id,title:z.string().min(1).max(160),summary:z.string().max(1000),source:z.enum(['WORLD_CREATION','WORLD_PACKAGE','WORLD_RUNTIME']),
  causal_parent_id:id.nullable().optional(),
  /** Verified existing NPC goals/actions/relationships, not a prose claim of causality. */
  causal_source_refs:z.array(z.string().min(1).max(240)).max(12).optional(),
  created_at:backgroundTimeSchema,earliest_activation:backgroundTimeSchema,latest_activation:backgroundTimeSchema.nullable(),
  activation_flags:z.array(id).max(12),activation_chance:z.number().min(0).max(1),
  participants:z.array(id).max(12),locations:z.array(id).max(12),
  causal_basis:causalBasisSchema.optional(),
  stages:z.array(backgroundStageSchema).min(1).max(8),
}).superRefine((incident,ctx)=>{
  if(incident.stages[0]?.earliest_after_minutes!==0)ctx.addIssue({code:'custom',message:'首阶段必须从激活时开始'});
  for(let i=1;i<incident.stages.length;i++)if(incident.stages[i].earliest_after_minutes<incident.stages[i-1].earliest_after_minutes)
    ctx.addIssue({code:'custom',message:'阶段时间必须递增'});
  if(new Set(incident.stages.map(stage=>stage.id)).size!==incident.stages.length)ctx.addIssue({code:'custom',message:'阶段 ID 重复'});
  if(incident.stages.at(-1)?.terminal==='none')ctx.addIssue({code:'custom',message:'末阶段必须结束案件'});
});
export const backgroundPolicySchema=z.strictObject({
  enabled:z.boolean(),target_active_incidents:z.number().int().min(0).max(3),
  max_dormant_incidents:z.number().int().min(0).max(10),minimum_gap_minutes:z.number().int().min(0).max(100000),
  replenishment:z.boolean(),
});
/** A long-running causal pressure, not a scripted quest or a guaranteed final enemy. */
export const worldMacroArcSchema=z.strictObject({
  id,title:z.string().min(1).max(160),summary:z.string().max(1000),
  underlying_pressure:z.string().min(1).max(500),
  actor_motivations:z.array(z.strictObject({actor_id:id,motivation:z.string().min(1).max(300)})).max(8),
  resource_constraint:z.string().min(1).max(300),historical_cause:z.string().min(1).max(300),
  social_relationship:z.string().min(1).max(300),trigger:z.string().min(1).max(300),
  unintended_consequence:z.string().min(1).max(300),
  truth_refs:z.array(id).max(12),incident_refs:z.array(id).max(100),
  horizon:z.enum(['seasonal','long','open_ended']),
});
export const backgroundStateSchema=z.strictObject({
  version:z.literal(1),
  incidents:z.array(z.strictObject({
    id,status:z.enum(['dormant','active','resolved','expired','cancelled']),stage_index:z.number().int().min(-1).max(7),
    activated_at:backgroundTimeSchema.nullable(),ended_at:backgroundTimeSchema.nullable(),missed:z.boolean(),
    player_exposed:z.boolean(),activation_roll:z.strictObject({sample:z.number().min(0).max(1),probability:z.number().min(0).max(1),passed:z.boolean()}).nullable(),
    delivered_exposure_ids:z.array(z.string().max(160)).max(100),
  })).max(100),
  macro_arcs:z.array(z.strictObject({id,status:z.enum(['latent','developing','resolved']),last_event_ref:z.string().max(160).nullable()})).max(2).default([]),
  npc_status:z.record(id,z.strictObject({unavailable:z.boolean(),markers:z.array(id).max(20)})),
  event_log:z.array(z.strictObject({
    id:z.string().max(160),incident_id:id,from_stage:id.nullable(),to_stage:id.nullable(),
    at:backgroundTimeSchema,trigger:z.enum(['time_advance','location_enter']),actor_id:id.nullable(),
    kind:z.enum(['activated','stage_advanced','resolved','expired','cancelled','exposed']),player_exposed:z.boolean(),
  })).max(300),
  exposure_log:z.array(z.strictObject({id:z.string().max(160),incident_id:id,text:z.string().max(500),channel:exposureSchema.shape.channel,at:backgroundTimeSchema})).max(100),
  pending_display_ids:z.array(z.string().max(160)).max(100),
  last_evaluation:backgroundTimeSchema.nullable(),needs_generation:z.boolean(),
  last_terminal_at:backgroundTimeSchema.nullable(),last_activation_at:backgroundTimeSchema.nullable(),
  last_generation_at:backgroundTimeSchema.nullable().optional(),last_spawn_at:backgroundTimeSchema.nullable().optional(),
});
export type BackgroundIncident=z.infer<typeof backgroundIncidentSchema>;
export type BackgroundState=z.infer<typeof backgroundStateSchema>;
export type BackgroundTime=z.infer<typeof backgroundTimeSchema>;
export type WorldMacroArc=z.infer<typeof worldMacroArcSchema>;

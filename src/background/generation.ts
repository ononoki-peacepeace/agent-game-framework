import {z} from 'zod';
import {assert,GameError,type SavePackage} from '../core/schema.js';
import {validateSave} from '../core/state.js';
import {backgroundIncidentSchema,type BackgroundIncident} from './schema.js';
import {ensureBackgroundState} from './runtime.js';
import {commitProposedLocation,setLocationStatus} from '../core/location-lifecycle.js';
import {observe} from '../observability/index.js';

/** Sources are GM-only projections of already stored facts, never new facts. */
export function backgroundCausalSources(save:SavePackage){
  const sources:{ref:string;actor_ids:string[];fact:unknown}[]=[];
  for(const entity of save.entities.filter(entity=>entity.components.character&&entity.id!==save.player_state.entity_id)){
    for(const goal of save.npc_agent_state?.[entity.id]?.goals??[])if(goal.status==='active')sources.push({
      ref:`npc_goal:${entity.id}:${goal.id}`,actor_ids:[entity.id],fact:{goal:goal.description,location_id:entity.components.location?.location_id}});
    const entries=entity.components.relationships?.entries as Record<string,Record<string,number>>|undefined;
    for(const [other,values] of Object.entries(entries??{}))if(save.entities.some(item=>item.id===other&&item.components.character))
      for(const [dimension,value] of Object.entries(values))sources.push({ref:`relationship:${entity.id}:${other}:${dimension}`,
        actor_ids:[entity.id,other],fact:{dimension,value}});
  }
  for(const receipt of (save.resolution_receipts??[]).slice(-24))if(receipt.commit_status==='committed'&&
    receipt.actor_id&&receipt.actor_id!==save.player_state.entity_id)sources.push({ref:`receipt:${receipt.request_id}`,
      actor_ids:[receipt.actor_id],fact:{action:receipt.semantic_action,facts:receipt.canonical_facts}});
  return sources.slice(-80);
}

export const backgroundProposalSchema=z.strictObject({decision:z.enum(['quiet','propose']),
  incident:backgroundIncidentSchema.nullable(),reason:z.string().min(1).max(400)});
export type BackgroundProposal=z.infer<typeof backgroundProposalSchema>;
const absolute=(save:SavePackage,time:{day:number;minute:number})=>time.day*save.definition.ruleset.minutes_per_day+time.minute;
/** Validate the Director's proposal before it can enter the existing world transaction. */
export function applyBackgroundProposal(input:SavePackage,raw:BackgroundProposal):SavePackage{
  const proposal=backgroundProposalSchema.parse(raw),save=structuredClone(input),state=ensureBackgroundState(save);
  assert(state.needs_generation,'世界尚未请求后续事件');
  const now=structuredClone(save.runtime.time);
  state.needs_generation=false;state.last_generation_at=now;
  if(proposal.decision==='quiet'){
    assert(proposal.incident===null,'安静决策不能携带事件');
    // Quiet is a valid bounded decision, even with a latent arc. The evaluator
    // reopens candidate generation after cooldown; forcing a proposal here
    // creates unjustified events instead of preserving autonomous causality.
    return validateSave(save);
  }
  const incident=proposal.incident;
  assert(incident&&incident.source==='WORLD_RUNTIME'&&incident.causal_basis,'后续事件必须包含权威因果提案');
  assert(save.definition.background_event_policy?.enabled&&save.definition.background_event_policy.replenishment,'后台事件生成未启用');
  assert((save.definition.background_incidents??[]).length<100,'后台事件历史已达容量上限');
  assert(!(save.definition.background_incidents??[]).some(item=>item.id===incident.id),'后台事件 ID 重复');
  const parent=save.definition.background_incidents?.find(item=>item.id===incident.causal_parent_id);
  const parentState=state.incidents.find(item=>item.id===parent?.id);
  // A cancelled seed never happened and cannot be cited as an in-world cause. Restart from
  // an existing macro pressure instead, without reviving or rewriting the cancelled event.
  const actorArcs=(save.definition.world_macro_arcs??[]).filter(arc=>
    arc.actor_motivations.some(actor=>incident.participants.includes(actor.actor_id)));
  const sources=backgroundCausalSources(save);
  for(const ref of incident.causal_source_refs??[])assert(sources.some(source=>source.ref===ref&&
    source.actor_ids.some(actor=>incident.participants.includes(actor))),'事件因果引用不存在或与参与者不一致');
  if(incident.causal_parent_id){
    assert(parent&&parentState&&['resolved','expired'].includes(parentState.status),
      '后续事件必须引用真实发生且已结束的事件');
  }else assert(actorArcs.length>0||Boolean(incident.causal_source_refs?.length),
    '独立事件须引用既有 NPC 目标、关系、已提交行动或主轴压力');
  assert(absolute(save,incident.created_at)===absolute(save,now),'后续事件创建时间与当前世界时间不一致');
  assert(absolute(save,incident.earliest_activation)>=absolute(save,now),'后续事件不得在创建前激活');
  const spawned=incident.stages.flatMap(stage=>stage.effects.filter(effect=>effect.kind==='spawn_character'));
  assert(spawned.length<=1,'单个事件最多新增一位正式人物');
  if(spawned.length){
    assert(save.definition.enabled_modules.includes('characters'),'当前世界没有人物能力');
    assert(spawned[0].relationship_seed_id||incident.participants.some(id=>save.entities.some(entity=>entity.id===id&&entity.components.character)),
      '新增人物需要与已有世界人物或关系产生因果连接');
  }
  // Preview each location effect in stage order. A future stage may close a place opened earlier,
  // but no effect may reference an invented parent, duplicate a place, or leave it disconnected.
  const locationPreview=structuredClone(save);
  for(const stage of incident.stages)for(const effect of stage.effects){
    if(effect.kind==='create_location')commitProposedLocation(locationPreview,effect,'world_event',
      `${incident.id}:${stage.id}`,effect.location_id);
    else if(effect.kind==='set_location_status')setLocationStatus(locationPreview,effect.location_id,effect.status,
      `${incident.id}:${stage.id}`);
  }
  save.definition.background_incidents=[...(save.definition.background_incidents??[]),incident as BackgroundIncident];
  for(const arc of save.definition.world_macro_arcs??[])if(parent&&arc.incident_refs.includes(parent.id)||
    !parent&&!incident.causal_source_refs?.length&&actorArcs.some(candidate=>candidate.id===arc.id)){
      arc.incident_refs.push(incident.id);
      const record=state.macro_arcs.find(item=>item.id===arc.id);
      if(record?.status==='resolved')record.status='developing';
    }
  state.incidents.push({id:incident.id,status:'dormant',stage_index:-1,activated_at:null,ended_at:null,missed:false,
    player_exposed:false,activation_roll:null,delivered_exposure_ids:[]});
  return validateSave(save);
}

/** A bounded repair loop lets the Director correct invalid structured proposals; only validation may commit them. */
export async function proposeValidatedBackground(input:SavePackage,
  propose:(repair?:{reason:string;previous:BackgroundProposal})=>Promise<BackgroundProposal>):Promise<SavePackage>{
  let repair:{reason:string;previous:BackgroundProposal}|undefined;
  for(let attempt=0;attempt<3;attempt++){
    const proposal=await propose(repair);
    try{return applyBackgroundProposal(input,proposal);}
    catch(error){
      // Only candidate validation is repairable. Network/file/program failures
      // leave this loop immediately and are handled by the existing caller.
      if(!(error instanceof z.ZodError)&&!(error instanceof GameError))throw error;
      repair={reason:error instanceof z.ZodError?error.issues.map(issue=>`${issue.path.join('.')}: ${issue.code}: ${issue.message}`).join('; '):error.message,
        previous:proposal};
      observe('warn','background.proposal_validation_failed',{module:'background_event',revision:input.state_revision,
        metadata:{attempt:attempt+1,reason:repair.reason.slice(0,500)}});
    }
  }
  throw Error(`后台事件提案三次未通过程序校验：${repair?.reason??'未知原因'}`);
}

import {z} from 'zod';
import {CandidateValidationError,generationRepair,generationBudget,takeGeneration,schemaIssues,type GenerationBudget,type GenerationRepair} from '../ai/failures.js';
import {createHash} from 'node:crypto';
import type {SavePackage} from '../core/schema.js';
import {GameError,actionSchema} from '../core/schema.js';
import {executeAction} from '../core/runtime.js';
import {environmentQuerySchema} from '../core/environment-schema.js';
import {executeEnvironmentQuery,validateEnvironmentQuery} from '../core/environment.js';
import type {GameService} from '../server/service.js';
import {observe} from '../observability/index.js';
import {WorldBlockedError} from './outcome.js';
import {identityAge} from '../shared/age.js';
import {composePersonaContext} from '../characters/persona.js';
import {emptyNpcAgentState,npcPlanStepSchema,npcAgentStateSchema,type NpcAgentState} from './npc-state.js';
import {npcExperienceContext} from './npc-experience.js';
import {currentMap,routePath} from '../core/map.js';
import {recentSettledActions} from '../ai/action-context.js';
import type {ActionContext} from '../core/registry.js';
import {establishTransient,physicalStateSummary,readPhysicalState,visionBlocked,visualClaimIssues} from '../core/perception-state.js';

const ref=z.string().min(1).max(120);
export const npcDecisionSchema=z.strictObject({
  kind:z.enum(['speech','vote','no_action','proposed_action']),
  speech:z.string().min(1).max(600).nullable(),
  vote_target:ref.nullable(),
  intent:z.string().min(1).max(300),
  proposed_action:z.strictObject({type:ref,target_id:ref.nullable(),reason:z.string().min(1).max(300),
    duration_minutes:z.number().int().min(1).max(240).nullish(),
    environment_query:environmentQuerySchema.nullish().optional()}).nullable(),
  evidence_refs:z.array(ref).max(12),
  belief_updates:z.array(z.strictObject({id:ref,proposition:z.string().min(1).max(500),
    stance:z.enum(['believed','suspected','doubted','rejected','unknown']),confidence:z.number().min(0).max(1),
    evidence_refs:z.array(ref).max(12)})).max(6),
  goal_updates:z.array(z.strictObject({goal_id:ref,status:z.enum(['active','completed','abandoned'])})).max(4),
  plan_updates:z.array(z.strictObject({plan_id:ref,status:z.literal('abandoned')})).max(3).optional(),
  goal_proposals:z.array(z.strictObject({id:ref,description:z.string().min(1).max(500),
    horizon:z.enum(['short','long']),priority:z.number().int().min(0).max(10)})).max(3).default([]),
  plan_proposals:z.array(z.strictObject({id:ref,goal_id:ref,intention:z.string().min(1).max(500),
    steps:z.array(npcPlanStepSchema).min(1).max(6).optional(),
    not_before:z.strictObject({day:z.number().int().nonnegative(),minute:z.number().int().nonnegative()}).nullable().optional(),
    condition:z.string().min(1).max(300).nullable().optional(),
  })).max(3).default([]),
  decision_summary:z.string().min(1).max(500),
  social_response:z.enum(['accept','decline','conditional']).nullable().default(null),
  /** The NPC's own bodily change. This — not Narrator prose — is the authoritative
   * source for posture and sight, so the next turn's adjudication can read it. */
  self_state:z.strictObject({
    posture:z.enum(['standing','sitting','lying','kneeling']).nullish(),
    eyes:z.enum(['open','closed']).nullish(),
    statement:z.string().min(1).max(200),
    duration_minutes:z.number().int().min(1).max(240).nullish(),
    release_condition:z.string().min(1).max(200).nullish(),
  }).nullish(),
});
export type NpcDecision=z.infer<typeof npcDecisionSchema>;
export const MAX_NPC_AGENT_CALLS_PER_TURN=8;

const own=(save:SavePackage,npcId:string)=>save.npc_agent_state?.[npcId]??emptyNpcAgentState();
const locationOf=(entity:SavePackage['entities'][number])=>String(entity.components.location?.location_id??'');

/** Deliberate allowlist: no gm_state, other NPC cognition, or whole-save spread crosses this boundary. */
export type NpcAgentEvent={kind:string;description:string;candidate_ids?:string[];public_speech?:string|null;
  /** Recorded at settlement: this NPC had no sight of the event being reacted to. */
  sight_blocked?:boolean};
export function buildNpcAgentContext(save:SavePackage,npcId:string,event:NpcAgentEvent){
  const npc=save.entities.find(entity=>entity.id===npcId&&entity.components.character);
  if(!npc||npcId===save.player_state.entity_id)throw new Error('NPC context requires an existing non-player character');
  const state=own(save,npcId),locationId=locationOf(npc);
  const location=[...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations].find(item=>item.id===locationId);
  const map=currentMap(save);
  const reachable_locations=(map?.routes??[]).filter(route=>route.from===locationId&&
    route.conditions.every(condition=>save.gm_state.flags[condition.flag]===condition.equals)&&
    (map?.locations.find(item=>item.id===route.to)?.known_by_default!==false)).map(route=>({
      id:route.to,name:map?.locations.find(item=>item.id===route.to)?.name??route.to,
      travel_minutes:route.travel_minutes})).slice(0,12);
  const visible=save.entities.filter(entity=>locationOf(entity)===locationId&&
    !(save.environment_state?.resolutions??[]).some(record=>record.entity_id===entity.id&&
      record.known_by&&!record.known_by.includes(npcId))).map(entity=>({
    id:entity.id,name:String(entity.components.identity?.name??''),role:entity.components.character?.role??null,
  })).slice(0,40);
  const events=new Map((save.narrative_history??[]).map(entry=>[`scene:${entry.request_id}`,entry]));
  const selected=npcExperienceContext(save,npcId,event.public_speech??event.description,12);
  const memories=selected.memories.map(memory=>({
    ...memory,
    speech_events:events.get(memory.event_ref)?.speech_events?.filter(speech=>
      memory.participant_ids.includes(speech.speaker_id)).map(speech=>({speaker_id:speech.speaker_id,utterance:speech.utterance.slice(0,500)}))??[],
  }));
  const evidence_ids=[...state.knowledge.map(item=>item.id),...state.private_facts.map(item=>item.id),...state.memories.map(item=>item.event_ref)];
  const context={
    npc_id:npcId,revision:save.state_revision,time:structuredClone(save.runtime.time),minutes_per_day:save.definition.ruleset.minutes_per_day,
    profile:{id:npcId,name:String(npc.components.identity?.name??''),age:identityAge(npc.components.identity,save),
      gender:npc.components.identity?.gender??null,description:String(npc.components.identity?.description??'').slice(0,1500),
      persona:composePersonaContext(save,npcId,1300,false),
      resident_motivation:npc.components.world_resident?.motivation??null,
      home_location_id:npc.components.world_resident?.home_location_id??npc.components.residence?.home_location_id??null},
    own_story_motivations:(save.definition.world_macro_arcs??[]).flatMap(arc=>arc.actor_motivations)
      .filter(actor=>actor.actor_id===npcId).map(actor=>actor.motivation).slice(0,8),
    scene:{location_id:locationId,location_name:location?.name??null,visible_entities:visible,
      reachable_locations,public_locations:map.locations.filter(place=>place.known_by_default!==false)
        .map(place=>({id:place.id,name:place.name})).slice(0,100),
      known_contact_ids:[...new Set([...state.memories.flatMap(memory=>memory.participant_ids),
        ...Object.keys(npc.components.relationships?.entries??{})])].filter(id=>id!==npcId).slice(0,40),
      event:{kind:event.kind,description:event.description,public_speech:event.public_speech??null,
        candidate_ids:(event.candidate_ids??[]).filter(id=>visible.some(entity=>entity.id===id)),
        sight_blocked:Boolean(event.sight_blocked),
        ...(event.sight_blocked?{perception_limit:
          '本人在该事件发生时没有视觉信息，只能依靠触觉、听觉与此前已知的情况。不得声称看见、看清或目睹了动作过程。'}:{})}},
    own_body:{condition:npc.components.condition??null,physical_state:npc.components.physical_state??null,
      ...(physicalStateSummary(npc)?{physical_state_summary:physicalStateSummary(npc)}:{}),
      sight_blocked:visionBlocked(npc).blocked,
      // A transient this NPC itself established with a release condition is the NPC's own
      // promise. Only its owner can judge that the condition occurred, so the condition is
      // surfaced as data and the decision stays with the character (REV427/428).
      pending_release_conditions:readPhysicalState(npc).transients
        .filter(item=>item.release_condition).map(item=>({kind:item.kind,value:item.value,
          statement:item.statement,release_condition:item.release_condition})).slice(0,6),
      self_state_instruction:'若本次决定改变了自己的姿态或是否闭眼，必须填写 self_state；只写在台词里不会被世界记录。'+
        '若 pending_release_conditions 中的条件此刻已经发生，就在 self_state 里写出恢复后的姿态或睁眼，否则该状态会继续有效。'},
    own_possessions:save.entities.filter(entity=>Number((npc.components.inventory?.items as Record<string,number>|undefined)?.[entity.id]??0)>0)
      .map(entity=>({id:entity.id,name:entity.components.identity?.name??null,condition:entity.components.item?.condition??'intact'})).slice(0,30),
    knowledge:state.knowledge.slice(-40),beliefs:state.beliefs.slice(-40),memories,
    historical_presence:selected.historical_presence,
    own_recent_settled_actions:recentSettledActions(save,npcId),
    witnessed_relevant_exchanges:selected.witnessed_exchanges,
    active_goals:state.goals.filter(goal=>goal.status==='active').slice(0,12),
    active_plans:state.plans.filter(plan=>plan.status==='active').slice(0,12),
    plan_recovery:state.plans.filter(plan=>plan.status==='active'&&plan.execution&&
      ['core_rejected','route_unavailable','listener_not_present'].includes(plan.execution.blocked_reason??''))
      .slice(0,2).map(plan=>({plan_id:plan.id,goal_id:plan.goal_id,intention:plan.intention,
        failed_step:plan.execution!.steps[plan.execution!.cursor]??null,cursor:plan.execution!.cursor,
        last_receipt_id:plan.execution!.last_receipt_id??null,blocked_reason:plan.execution!.blocked_reason,
        diagnostic:plan.execution!.failure_diagnostic??null,
        instruction:'原计划已完成的步骤有权威凭据，不得重做；若当前世界允许修正，明确放弃旧计划并用新 ID 提出可执行替代步骤。'})),
    objective_ids:{goals:state.goals.map(goal=>goal.id),plans:state.plans.map(plan=>plan.id)},
    private_facts:state.private_facts.slice(-20),
    relationships:npc.components.relationships?.entries??{},
    evidence_ids,
  };
  observe('debug','npc_agent.context_built',{module:'agent',revision:save.state_revision,metadata:{npc_id:npcId,
    trigger:event.kind,visible_evidence_ids:evidence_ids.slice(0,40),memory_refs:selected.memories.map(item=>item.event_ref),
    active_goal_refs:context.active_goals.map(item=>item.id)}});
  return context;
}

/** Only relevant, decision-bearing characters use a dedicated model call. */
export function admitNpcDecision(save:SavePackage,npcId:string,trigger:'direct_scene'|'vote'|'world_event'){
  const entity=save.entities.find(item=>item.id===npcId&&item.components.character);
  const residentImportance=entity?.components.world_resident?.importance;
  const state=save.npc_agent_state?.[npcId];
  const admitted=Boolean(entity&&npcId!==save.player_state.entity_id&&
    (trigger==='vote'||trigger==='world_event'||residentImportance==='major'||residentImportance==='recurring'||
      state&&(state.goals.some(goal=>goal.status==='active')||
        // Overhearing a remark is not a stake. First-hand knowledge is; hearsay alone
        // must not make every bystander pay for a dedicated decision call each turn.
        state.knowledge.some(item=>item.source_type!=='told_by')||state.private_facts.length>0)));
  observe('debug',admitted?'npc_agent.admitted':'npc_agent.skipped',{module:'agent',revision:save.state_revision,
    metadata:{npc_id:npcId,trigger,reason:admitted?'meaningful_decision':'lightweight_or_not_present'}});
  return admitted;
}

class NpcContractError extends Error {constructor(readonly field:string,message:string){super(message);}}
export function validateNpcPlanSteps(context:ReturnType<typeof buildNpcAgentContext>,steps:z.infer<typeof npcPlanStepSchema>[],
  notBefore?:{day:number;minute:number}|null){
  if(notBefore&&notBefore.minute>=context.minutes_per_day)throw new NpcContractError('plan_proposals.not_before.minute','NPC schedule uses an invalid calendar minute');
  for(const step of steps){
    if(step.type==='MOVE'&&(!step.target_id||!context.scene.public_locations.some(place=>place.id===step.target_id))||
      step.type==='HOLD'&&(step.target_id!==null||!step.duration_minutes)||
      step.type!=='HOLD'&&step.duration_minutes!==null||
      step.type==='TALK'&&(!step.speech||!step.target_id||step.target_id===context.npc_id||
        !context.scene.visible_entities.some(entity=>entity.id===step.target_id)&&!context.scene.known_contact_ids.includes(step.target_id))||
      step.type!=='TALK'&&step.speech!==null||
      step.type==='INSPECT'&&step.target_id!==null&&!context.scene.visible_entities.some(entity=>entity.id===step.target_id))
      throw new NpcContractError('plan_proposals.steps','NPC plan step exceeds its known action context');
  }
}
/** A duplicated proposal is one operation, not authorization for two attempts.
 * Only the background executor currently has a receipt/cursor handoff. Other
 * decision lanes retain their previous rejection until they support that handoff.
 */
export function immediateNpcPlanLink(context:ReturnType<typeof buildNpcAgentContext>,decision:NpcDecision):string|null{
  const proposal=decision.proposed_action,plan=decision.plan_proposals.find(p=>p.steps?.length);
  if(!proposal||!plan)return null;
  const first=plan.steps![0],now=context.time.day*context.minutes_per_day+context.time.minute;
  const scheduled=plan.not_before?plan.not_before.day*context.minutes_per_day+plan.not_before.minute:now;
  const conflict=(field:string):never=>{throw new NpcContractError('plan_proposals.steps.0.'+field,`NPC_IMMEDIATE_PLAN_CONFLICT: ${field}`);};
  if(context.scene.event.kind!=='world_event'||decision.kind!=='proposed_action')return conflict('execution_lane');
  if(proposal.type!==first.type||!['MOVE','INSPECT','TALK','HOLD'].includes(proposal.type))return conflict('action_type');
  if(proposal.target_id!==first.target_id)return conflict('target_id');
  if(scheduled>now)return conflict('not_before');
  if(plan.condition)return conflict('condition_pending');
  if((proposal.type==='HOLD'?proposal.duration_minutes??30:proposal.duration_minutes??null)!==first.duration_minutes)return conflict('duration_minutes');
  if(proposal.type==='MOVE'&&!context.scene.reachable_locations.some(p=>p.id===proposal.target_id))return conflict('immediate_route');
  if(['HOLD','INSPECT'].includes(proposal.type)&&proposal.reason.trim()!==first.description.trim())return conflict('activity_or_focus');
  if(proposal.type==='TALK'&&(decision.speech??proposal.reason)!==first.speech)return conflict('speech');
  return plan.id;
}

function validateDecision(context:ReturnType<typeof buildNpcAgentContext>,decision:NpcDecision){
  const refs=new Set(context.evidence_ids),candidates=new Set(context.scene.event.candidate_ids);
  if(context.scene.event.kind==='social_invitation'&&!decision.social_response)
    throw new NpcContractError('social_response','邀请回应缺少独立意愿；允许接受、拒绝或附条件，不强制接受');
  if(context.scene.event.kind==='vote'&&decision.kind!=='vote')throw new NpcContractError('kind','NPC vote event returned a non-vote decision');
  if([...decision.evidence_refs,...decision.belief_updates.flatMap(update=>update.evidence_refs)].some(id=>!refs.has(id)))
    throw new Error('NPC decision cited evidence outside its own context');
  if(decision.goal_updates.some(update=>!context.active_goals.some(goal=>goal.id===update.goal_id)))
    throw new Error('NPC decision changed a goal outside its own context');
  const goalIds=new Set([...context.active_goals.map(goal=>goal.id),...decision.goal_proposals.map(goal=>goal.id)]);
  if(decision.plan_proposals.some(plan=>!goalIds.has(plan.goal_id)))throw new NpcContractError('plan_proposals.goal_id','NPC plan lacks an owned goal');
  if(decision.plan_proposals.filter(plan=>plan.steps?.length).length>1)throw new NpcContractError('plan_proposals','NPC may propose one executable plan at a time');
  if((decision.plan_updates??[]).some(update=>!context.active_plans.some(plan=>plan.id===update.plan_id)))throw new Error('NPC changed a plan outside its own context');
  if(new Set(decision.plan_proposals.map(plan=>plan.id)).size!==decision.plan_proposals.length||
    decision.plan_proposals.some(plan=>context.objective_ids.plans.includes(plan.id)))throw new NpcContractError('plan_proposals.id','NPC plan proposal reuses an existing ID');
  immediateNpcPlanLink(context,decision);
  for(const plan of decision.plan_proposals){
    if(decision.goal_updates.some(update=>update.goal_id===plan.goal_id&&update.status!=='active'))
      throw new NpcContractError('plan_proposals.goal_id','NPC executable plan cannot revive an ended goal');
    if((plan.not_before||plan.condition)&&!plan.steps?.length)throw new NpcContractError('plan_proposals.steps','Scheduled or conditional NPC plan has no executable steps');
    if(plan.steps?.length&&context.active_plans.some(prior=>(prior.activity||prior.execution)&&prior.id!==plan.id&&
      !(decision.plan_updates??[]).some(update=>update.plan_id===prior.id)&&
      !decision.goal_updates.some(update=>update.goal_id===prior.goal_id&&update.status!=='active')))
      throw new NpcContractError('plan_proposals','NPC must explicitly end its existing activity before replacing it');
    validateNpcPlanSteps(context,plan.steps??[],plan.not_before);
  }
  if(new Set(decision.goal_proposals.map(goal=>goal.id)).size!==decision.goal_proposals.length||
    decision.goal_proposals.some(goal=>context.objective_ids.goals.includes(goal.id)))
    throw new NpcContractError('goal_proposals.id','NPC goal proposal reuses an existing ID');
  if(decision.kind==='speech'&&!decision.speech||decision.kind==='vote'&&(!decision.vote_target||!candidates.has(decision.vote_target))||
    decision.kind==='proposed_action'&&!decision.proposed_action||decision.kind!=='vote'&&decision.vote_target)
    throw new NpcContractError('kind','NPC decision kind and payload disagree');
  if(decision.kind==='no_action'&&(decision.speech||decision.proposed_action))throw new NpcContractError('proposed_action','No-action decision has an action');
  // NPC speech is written *into* canonical_facts, so a perception claim in it becomes
  // authoritative world fact without passing the narrative firewall. REV435 minted
  // "刚才那一记，我看得很清楚" from an NPC who had no sight at settlement. Rejecting here
  // lets decideNpc's repair loop ask the model to correct itself instead of losing the reaction.
  if(decision.speech){
    const opening=decision.self_state?.eyes==='open';
    const blind=context.scene.event.sight_blocked
      ?{blocked:true,reason:'结算时本人没有视觉信息',transient:null}
      :!opening&&context.own_body.sight_blocked
        ?{blocked:true,reason:'本人当前没有视觉信息',transient:null}:null;
    const issues=blind?visualClaimIssues(decision.speech,blind):[];
    if(issues.length)throw new NpcContractError('speech',
      `NPC_PERCEPTION_UNGROUNDED: ${blind!.reason}，不能声称「${issues.map(item=>item.match).join('、')}」`);
  }
  const query=decision.proposed_action?.environment_query;
  if(query){
    if(decision.kind!=='proposed_action'||decision.proposed_action?.type!=='INSPECT'||decision.proposed_action.target_id||
      query.intent!=='observe')throw new NpcContractError('proposed_action.environment_query',
      'Only a scene INSPECT may propose an ordinary environment observation; taking needs a later Core action');
    try{validateEnvironmentQuery(decision.proposed_action.reason,query);}
    catch{throw new NpcContractError('proposed_action.environment_query.source_quote',
      'Environment query must quote this exact INSPECT reason and its named object');}
  }
}

export async function decideNpc(service:GameService,save:SavePackage,npcId:string,event:NpcAgentEvent,budget:GenerationBudget=generationBudget(),signal?:AbortSignal){
  const context=buildNpcAgentContext(save,npcId,event);let repair:GenerationRepair|null=null;
  for(let attempt=0;attempt<2;attempt++){
    const callSignal=takeGeneration(budget,signal);let decision:NpcDecision|undefined;
    observe('debug','npc_agent.request',{module:'agent',revision:save.state_revision,metadata:{npc_id:npcId,trigger:event.kind,attempt:attempt+1}});
    try{
      decision=await service.ai.npcDecision(save.definition.prompt_profile,context,repair??undefined,callSignal);
      // Test doubles and third-party adapters still pass the same full domain boundary.
      const checked=npcDecisionSchema.safeParse(decision);
      if(!checked.success)throw new CandidateValidationError('npc_decision',checked.error.issues.map(i=>({path:i.path.join('.'),code:i.code,expected:'NPC decision schema',message:i.message})),decision);
      decision=checked.data;
      validateDecision(context,decision);
       // Admission belongs to this uncommitted candidate. Feed capacity and
       // resulting-state failures back to the NPC decision that produced them.
       stageNpcDecision(save,npcId,'candidate-preflight',decision,false,event.kind==='physical_event');
      observe('info','npc_agent.decision_validated',{module:'agent',revision:save.state_revision,metadata:{npc_id:npcId,kind:decision.kind,evidence_refs:decision.evidence_refs,attempt:attempt+1}});
      return decision;
    }catch(cause){
      const error=cause instanceof NpcContractError?new CandidateValidationError('npc_decision',[{path:cause.field,code:'npc_contract',expected:'与当前NPC自身上下文和同一决策契约一致',message:cause.message}],decision):cause;
      repair=generationRepair(error);
      const recoverable=Boolean(repair&&attempt===0&&budget.remaining>0&&Date.now()<budget.deadline&&!signal?.aborted);
      observe('warn','npc_agent.decision_rejected',{module:'agent',revision:save.state_revision,metadata:{npc_id:npcId,stage:'provider_or_validation',attempt:attempt+1,recoverable,
        issue_paths:repair?.issues.map(i=>i.path)??[],reason:error instanceof Error?error.message:String(error)}});
      if(!recoverable)throw error;
    }
  }
  throw new Error('Unreachable NPC decision budget');
}

const bounded=<T>(items:T[],max:number)=>items.slice(-max);
function boundedMemories(items:NpcAgentState['memories']){
  const result=[...items];
  while(result.length>60){
    const least=Math.min(...result.map(item=>item.importance));
    result.splice(result.findIndex(item=>item.importance===least),1);
  }
  return result;
}
const knowledgeWeight=(item:NpcAgentState['knowledge'][number])=>
  (item.source_type==='told_by'?0:item.source_type==='inferred'?1:2)*10+Math.round(item.confidence*9);
/** Hearsay is forgotten first; first-hand and confident knowledge outlives it. */
function boundedKnowledge(items:NpcAgentState['knowledge']){
  const result=[...items];
  while(result.length>80){
    const least=Math.min(...result.map(knowledgeWeight));
    result.splice(result.findIndex(item=>knowledgeWeight(item)===least),1);
  }
  return result;
}
function boundedObjectives<T extends {status:'active'|'completed'|'abandoned'}>(items:T[],max:number){
  const result=[...items];
  while(result.length>max){
    const archived=result.findIndex(item=>item.status!=='active');
    if(archived<0)throw new Error('NPC active objective capacity reached');
    result.splice(archived,1);
  }
  return result;
}
/** Called only inside an authoritative agentTransaction after a validated decision. */
export function applyNpcDecision(save:SavePackage,npcId:string,eventRef:string,decision:NpcDecision,recordObservations=true){
  const state=own(save,npcId),at=structuredClone(save.runtime.time);
  state.last_decisions=bounded([...state.last_decisions,{event_ref:eventRef,kind:decision.kind,
    summary:decision.decision_summary,speech:decision.speech,target_id:decision.vote_target??decision.proposed_action?.target_id??null,
    revision:save.state_revision+1}],12);
  state.memories=boundedMemories([...state.memories,{event_ref:eventRef,kind:'decision' as const,summary:decision.decision_summary,
    participant_ids:[npcId],at,importance:2}]);
  for(const update of decision.belief_updates){
    state.beliefs=bounded([...state.beliefs.filter(item=>item.id!==update.id),{...update,updated_at:at}],80);
    if(recordObservations)observe('debug','npc_agent.belief_updated',{module:'agent',revision:save.state_revision+1,metadata:{npc_id:npcId,belief_id:update.id}});
  }
  for(const update of decision.goal_updates){
    state.goals=state.goals.map(goal=>goal.id===update.goal_id?{...goal,status:update.status}:goal);
    if(recordObservations)observe('debug','npc_agent.goal_updated',{module:'agent',revision:save.state_revision+1,metadata:{npc_id:npcId,goal_id:update.goal_id,status:update.status}});
  }
  for(const goal of decision.goal_proposals){
    state.goals=boundedObjectives([...state.goals,{...goal,status:'active' as const,origin:eventRef}],24);
    if(recordObservations)observe('debug','npc_agent.goal_updated',{module:'agent',revision:save.state_revision+1,metadata:{npc_id:npcId,goal_id:goal.id,status:'active'}});
  }
  state.plans=state.plans.filter(plan=>state.goals.some(goal=>goal.id===plan.goal_id));
  for(const update of decision.plan_updates??[]){const plan=state.plans.find(plan=>plan.id===update.plan_id);if(plan)plan.status=update.status;}
  for(const plan of state.plans)if(plan.status==='active'&&!state.goals.some(goal=>goal.id===plan.goal_id&&goal.status==='active'))plan.status='abandoned';
  for(const {steps,not_before,condition,...plan} of decision.plan_proposals)state.plans=boundedObjectives([...state.plans.filter(item=>item.id!==plan.id),
    {...plan,status:'active' as const,...(steps?{execution:{steps,cursor:0,not_before:not_before??null,condition:condition??null,last_accounted_at:at,
      time_credit_minutes:0,last_request_id:null,blocked_reason:null}}:{})}],24);
  save.npc_agent_state??={};save.npc_agent_state[npcId]=state;
  applySelfState(save,npcId,eventRef,decision);
  if(recordObservations)observe('debug','npc_agent.memory_updated',{module:'agent',revision:save.state_revision+1,metadata:{npc_id:npcId,event_ref:eventRef}});
}

/** Commit an NPC's declared bodily change as a provenance-carrying transient.
 * REV427/428 and REV434/435 lost exactly this step: the change existed only in
 * prose, so adjudication and the NPC's own later reaction never saw it. */
export function applySelfState(save:SavePackage,npcId:string,eventRef:string,decision:NpcDecision){
  const self=decision.self_state;if(!self)return [] as string[];
  const established:string[]=[];
  for(const [kind,value] of [['posture',self.posture],['eyes',self.eyes]] as const){
    if(!value)continue;
    const record=establishTransient(save,npcId,{kind,value,statement:self.statement,
      source:'npc_decision',source_ref:eventRef,
      duration_minutes:self.duration_minutes??null,release_condition:self.release_condition??null});
    if(record)established.push(`${kind}=${value}`);
  }
  if(established.length)observe('info','npc_agent.self_state_committed',{module:'agent',revision:save.state_revision+1,
    metadata:{npc_id:npcId,event_ref:eventRef,changes:established,
      release_condition:self.release_condition??null,duration_minutes:self.duration_minutes??null}});
  return established;
}

/** A physical reaction may continue an existing departure, but may not silently
 * replace an owned executable plan or reset its earned time/cursor. This runs
 * both in candidate admission and in the actual isolated reaction state. */
function admitPhysicalDeparture(save:SavePackage,npcId:string,eventRef:string,decision:NpcDecision){
  const move=decision.proposed_action;
  if(move?.type!=='MOVE'||!move.target_id)return;
  const context=buildNpcAgentContext(save,npcId,{kind:'physical_event',description:'核对离场计划'});
  if(!context.scene.reachable_locations.some(place=>place.id===move.target_id))
    throw new NpcContractError('proposed_action.target_id','NPC departure requires a currently reachable canonical destination');
  const state=own(save,npcId),actor=save.entities.find(e=>e.id===npcId)!;
  const active=state.plans.filter(plan=>plan.status==='active'&&(plan.activity||plan.execution));
  if(active.length){
    const now=save.runtime.time.day*context.minutes_per_day+save.runtime.time.minute;
    const sameRoute=(plan:typeof active[number])=>{
      const execution=plan.execution;
      const scheduled=execution?.not_before;
      const ready=!scheduled||scheduled.day*context.minutes_per_day+scheduled.minute<=now;
      return plan.activity?
        plan.activity.origin_location_id===locationOf(actor)&&plan.activity.destination_id===move.target_id&&!plan.activity.condition:
        Boolean(execution&&!execution.condition&&ready&&execution.steps[execution.cursor]?.type==='MOVE'&&
          execution.steps[execution.cursor]?.target_id===move.target_id);
    };
    const compatible=active.filter(sameRoute);
    if(compatible.length){
      // applyNpcDecision may have materialized a second plan before this
      // boundary is checked. Preserve the oldest compatible plan (including
      // its cursor and earned time credit) and discard only duplicate plans
      // created by this reaction candidate; a different route remains a real
      // NPC conflict and is sent back through the repair loop.
      const keep=compatible.find(plan=>!plan.id.startsWith(`${eventRef}:`))??compatible[0];
      const removed=compatible.filter(plan=>plan.id!==keep.id);
      if(removed.length){
        const removedGoals=new Set(removed.map(plan=>plan.goal_id));
        state.plans=state.plans.filter(plan=>!removed.some(item=>item.id===plan.id));
        state.goals=state.goals.filter(goal=>!removedGoals.has(goal.id)||goal.id===keep.goal_id);
      }
      if(active.filter(plan=>plan.status==='active'&&(plan.activity||plan.execution)).length===1)return;
    }
    throw new NpcContractError('proposed_action.target_id',
      'NPC departure conflicts with its existing executable plan; explicitly end a superseded plan or preserve it without a competing immediate action');
  }
  const planId=`${eventRef}:${npcId}`,at=structuredClone(save.runtime.time);
  state.goals=boundedObjectives([...state.goals,{id:planId,description:decision.intent,horizon:'short',
    status:'active',origin:eventRef.replace(/^reaction:/,'physical:'),priority:10}],24);
  state.plans=boundedObjectives([...state.plans,{id:planId,goal_id:planId,intention:decision.intent,status:'active',
    activity:{kind:'move',origin_location_id:locationOf(actor),destination_id:move.target_id,
      source_request_id:eventRef.replace(/^reaction:/,''),condition:null,last_accounted_at:at,time_credit_minutes:0}}],24);
  save.npc_agent_state![npcId]=state;
}

function stageNpcDecision(save:SavePackage,npcId:string,eventRef:string,decision:NpcDecision,recordObservations:boolean,physicalReaction=false){
  // Admission must leave no trace. The decided entity is isolated as well as its
  // cognition, so a rejected candidate cannot write its posture/sight into the world.
  const staged={...save,entities:save.entities.map(entity=>entity.id===npcId?structuredClone(entity):entity),
    npc_agent_state:{...save.npc_agent_state,[npcId]:structuredClone(own(save,npcId))}};
  try{
    applyNpcDecision(staged,npcId,eventRef,decision,recordObservations);
    if(physicalReaction)admitPhysicalDeparture(staged,npcId,eventRef,decision);
    const state=npcAgentStateSchema.parse(staged.npc_agent_state[npcId]);
    if(new Set(state.goals.map(g=>g.id)).size!==state.goals.length||new Set(state.plans.map(p=>p.id)).size!==state.plans.length||
      state.plans.filter(p=>p.status==='active'&&(p.activity||p.execution)).length>1)
      throw new NpcContractError('plan_proposals','NPC objective state is inconsistent');
    return state;
  }catch(cause){
    if(cause instanceof z.ZodError)throw new CandidateValidationError('npc_cognition_admission',schemaIssues(cause),decision);
    if(cause instanceof Error&&cause.message==='NPC active objective capacity reached')
      throw new NpcContractError('goal_proposals','NPC active objective capacity reached; end an existing objective before proposing another');
    throw cause;
  }
}

/** Hearsay needs an assertion. Questions, greetings and fragments teach a listener nothing. */
function assertedContent(utterance:string){
  const declarative=utterance.trim().split(/(?<=[。！!？?；;\n])/).map(part=>part.trim())
    .filter(part=>part.length>=5&&!/[？?]\s*$/.test(part));
  const joined=declarative.join('');
  return joined.length>=5?joined:'';
}
function hearsayProposition(save:SavePackage,speakerId:string,content:string){
  const name=String(save.entities.find(entity=>entity.id===speakerId)?.components.identity?.name??speakerId).slice(0,40);
  const prefix=name+'当场说过：“',suffix='”（听来的转述，自己未核实）',room=500-prefix.length-suffix.length;
  return prefix+(content.length<=room?content:content.slice(0,room-1)+'…')+suffix;
}

/** Speech is evidence that words were spoken, never automatic proof of the proposition they contain. */
export function recordSceneObservation(save:SavePackage,requestId:string,
  speechEvents:readonly {speaker_id:string;utterance:string}[],audienceIds?:readonly string[]){
  if(!speechEvents.length)return;
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id),here=player?locationOf(player):'';
  const audience=new Set(audienceIds??save.entities.filter(entity=>entity.id!==save.player_state.entity_id&&
    entity.components.character&&locationOf(entity)===here).map(entity=>entity.id));
  const eventRef=`scene:${requestId}`,at=structuredClone(save.runtime.time);
  for(const npcId of audience){
    const npc=save.entities.find(entity=>entity.id===npcId&&entity.components.character&&
      (audienceIds?true:locationOf(entity)===here));
    if(!npc)continue;
    const state=own(save,npcId),participants=[...new Set(speechEvents.map(event=>event.speaker_id))];
    if(state.memories.some(memory=>memory.event_ref===eventRef))continue;
    // Keep every turn in order: a final question must not erase the answer
    // preceding it. Excerpts remain speech evidence, never believed world facts.
    const events=speechEvents.slice(0,12),prefix='现场原话摘录（…表示省略，不证明内容属实）：';
    const labels=events.map(event=>event.speaker_id===npcId?'自己':event.speaker_id.slice(0,24));
    const overhead=prefix.length+labels.reduce((sum,label)=>sum+label.length+4,0)+events.length-1;
    const limit=Math.max(1,Math.floor((500-overhead)/events.length));
    const quote=(text:string)=>text.length<=limit?text:
      text.slice(0,Math.ceil((limit-1)/2))+'…'+text.slice(-Math.floor((limit-1)/2));
    const summary=prefix+events.map((event,index)=>labels[index]+'说：“'+quote(event.utterance)+'”').join('；');
    state.memories=boundedMemories([...state.memories,{event_ref:eventRef,kind:'heard' as const,summary,
      participant_ids:participants,at,importance:1}]);
    // Sourced hearsay: only someone who was actually in this audience learns it, the
    // source is the speaker who said it, and the content stays that speaker's claim.
    // Repeating it later is how a report spreads; nothing is synced to absent characters.
    for(const speakerId of participants){
      if(speakerId===npcId)continue;
      const content=assertedContent(events.filter(event=>event.speaker_id===speakerId)
        .map(event=>event.utterance).join('\n'));
      const id=`heard:${requestId}:${speakerId}`;
      if(!content||state.knowledge.some(item=>item.id===id))continue;
      state.knowledge=boundedKnowledge([...state.knowledge,{id,
        proposition:hearsayProposition(save,speakerId,content),source_type:'told_by' as const,
        source_ref:speakerId,learned_at:at,confidence:0.4}]);
      observe('debug','npc_agent.knowledge_updated',{module:'agent',revision:save.state_revision+1,
        metadata:{npc_id:npcId,knowledge_id:id,source_type:'told_by',source_ref:speakerId}});
    }
    save.npc_agent_state??={};save.npc_agent_state[npcId]=state;
    observe('debug','npc_agent.memory_updated',{module:'agent',revision:save.state_revision+1,metadata:{npc_id:npcId,event_ref:eventRef}});
  }
}

/** Small actor-aware adapter for an already registered action; no model receives write access. */
export function applyNpcProposedAction(save:SavePackage,actionId:string,npcId:string,
  proposal:NpcDecision['proposed_action']){
  if(!proposal)return {settled:false,gap:null,receipt_id:null};
  if(proposal.type!=='MOVE'||!proposal.target_id)return {settled:false,gap:'人物提出的持久行动当前没有可用的权威结算方式',receipt_id:null};
  try{
    const result=executeAction(save,{type:'MOVE',target_id:proposal.target_id,parameters:{}},actionId,'ai',
      undefined,undefined,true,npcId);
    Object.assign(save,result.save);
    const receipt=save.resolution_receipts?.find(item=>item.request_id===actionId);
    if(!receipt)throw new Error('NPC Core action did not produce a receipt');
    receipt.commit_status='committed';
  }catch(error){
    if(error instanceof WorldBlockedError||error instanceof GameError&&error.status===400)
      return {settled:false,gap:'人物尝试行动，但当前世界条件没有允许完成',receipt_id:null};
    throw error;
  }
  return {settled:true,gap:null,receipt_id:actionId};
}

const autonomousCadenceMinutes=180;
// A long Routine advance contains many independent cadence windows. A Routine
// step admits one NPC candidate, retaining a second call for that candidate's
// schema repair. Ordinary turns may admit two candidates.
const autonomousCallsPerTurn=2;
const environmentCallsPerTurn=2;
const autonomousCandidatesPerTurn=2;
const dailyCadenceMinutes=60;
const dailyActionsPerTurn=2;
const socialActionsPerTurn=8;
const socialDecisionsPerTurn=2;
const activityActionsPerTurn=3;
function autonomousId(requestId:string,npcId:string,index:number){
  const hex=createHash('sha256').update(`${requestId}:npc-autonomy:${npcId}:${index}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function minuteOf(save:SavePackage,time:SavePackage['runtime']['time']){
  return time.day*save.definition.ruleset.minutes_per_day+time.minute;
}
function completeNpcPlan(state:NpcAgentState,plan:NpcAgentState['plans'][number]){
  if(!plan.execution||plan.execution.cursor!==plan.execution.steps.length)return;
  plan.status='completed';
  const goal=state.goals.find(g=>g.id===plan.goal_id);
  if(goal?.horizon==='short'&&!state.plans.some(p=>p.goal_id===goal.id&&p.status==='active'))goal.status='completed';
}
// Global batch cursors are not evidence that every resident was serviced. In old
// saves a missing personal cursor means no decision yet, not "the last batch did it".
function residentStart(save:SavePackage,npc:SavePackage['entities'][number]){
  const at=npc.components.world_resident?.entered_world_at;
  return at&&typeof at==='object'&&!Array.isArray(at)&&typeof at.day==='number'&&typeof at.minute==='number'
    ?{day:at.day,minute:at.minute}:save.definition.runtime.time;
}
function socialObligationActive(save:SavePackage,state:NpcAgentState){
  const now=minuteOf(save,save.runtime.time);
  return state.social_tasks.some(task=>task.status==='active'&&
    (task.kind!=='attend'||now+30>=minuteOf(save,task.activity_at)));
}
/** At most the victim and one present witness decide how to react. Outcomes are never delegated to narration. */
export async function settlePhysicalNpcReactions(service:GameService,input:SavePackage,requestId:string){
  const source=input.resolution_receipts?.find(receipt=>receipt.request_id===requestId&&receipt.physical_outcome);
  if(!source?.physical_outcome)return {save:input,visibleFacts:[] as string[]};
  const save=structuredClone(input);
  let receipt=save.resolution_receipts!.find(item=>item.request_id===requestId)!;
  const outcome=receipt.physical_outcome!,visibleFacts:string[]=[];
  const targets=[outcome.target_id,...outcome.witness_ids.filter(id=>id!==outcome.target_id)].slice(0,2);
  receipt.result_entities??={};let attempted=receipt.result_entities.physical_reactions_attempted??=[];
  const reactionBudget=generationBudget(2);
  for(const id of targets){
    if(reactionBudget.remaining<=0)break;
    if(attempted.includes(id))continue;
    attempted.push(id);receipt.result_entities??={};receipt.result_entities.physical_reactions_attempted=attempted;
    const actor=save.entities.find(entity=>entity.id===id&&entity.components.character);
    if(!actor||Number(actor.components.condition?.hp??100)<=0)continue;
    try{
      // Sight is read from the receipt, not from live state: a forced physical event
      // ends a voluntary eyes-closed state at settlement, so only sight_blocked_ids
      // still records what was true while the action happened. validateDecision turns
      // this into a rejection the repair loop can correct (REV435).
      const blocked=(outcome.sight_blocked_ids??[]).includes(id);
      const decision=await decideNpc(service,save,id,{kind:'physical_event',sight_blocked:blocked,
        description:`本人${id===outcome.target_id?'遭遇':'在场目击'}了一次已结算的强制身体行动。${
          blocked?'本人在该动作发生时没有视觉信息，只能凭触觉、听觉和之前已知的情况判断，没有看见动作过程。':''
        }本次原始行为：${receipt.semantic_action}。本次手段：${outcome.action_forms?.join('/')??outcome.kind}；既有控制状态不是本次新抓握成功。${receipt.canonical_facts.join(' ')}`},reactionBudget);
      save.npc_agent_state![id]=stageNpcDecision(save,id,`reaction:${requestId}`,decision,true,true);
      // Only an admitted decision changes the body; staging ran on an isolated copy.
      applySelfState(save,id,`reaction:${requestId}`,decision);
      if(decision.speech){
        const fact=`${String(actor.components.identity?.name??id)}说：“${decision.speech}”`;
        visibleFacts.push(fact);
        recordSceneObservation(save,`reaction:${requestId}:${id}`,[{speaker_id:id,utterance:decision.speech}],outcome.witness_ids);
      }
      if(decision.proposed_action?.type==='BREAK_FREE'){
        const holder=actor.components.physical_state?.restrained_by;
        if(!holder||decision.proposed_action.target_id!==holder)continue;
        // One reaction inside the elapsed physical action, not another world-time tick.
        const result=executeAction(save,{type:'BREAK_FREE',target_id:holder,parameters:{}},
          autonomousId(requestId,id,-1),'ai',undefined,undefined,false,id,true);
        Object.assign(save,result.save);
        receipt=save.resolution_receipts!.find(item=>item.request_id===requestId)!;
        attempted=receipt.result_entities!.physical_reactions_attempted;
        visibleFacts.push(...result.facts);
      }
      if(decision.proposed_action?.type==='MOVE'&&decision.proposed_action.target_id){
        visibleFacts.push(`${String(actor.components.identity?.name??id)}决定尝试离开；尚未结算离场。`);
      }
    }catch(error){observe('warn','npc_agent.physical_reaction_unavailable',{module:'agent',request_id:requestId,
      revision:save.state_revision,metadata:{npc_id:id,reason:error instanceof Error?error.message:String(error)}});}
  }
  receipt.canonical_facts=[...receipt.canonical_facts,...visibleFacts].slice(0,12).map(fact=>fact.slice(0,500));
  return {save,visibleFacts};
}
/** Execute accepted short-term intentions during time already advanced by the player.
 * Movement and delivery use registered Core actions and never charge world time again. */
async function settleSocialNpcTurn(service:GameService,input:SavePackage,
  beforeTime:SavePackage['runtime']['time'],requestId:string,signal?:AbortSignal){
  const elapsed=minuteOf(input,input.runtime.time)-minuteOf(input,beforeTime);
  if(elapsed<=0||!Object.values(input.npc_agent_state??{}).some(state=>
    state.social_tasks.some(task=>task.status==='active'||task.status==='blocked')))
    return {save:input,visibleFacts:[] as string[]};
  let save=structuredClone(input);
  const visibleFacts:string[]=[],attempted=new Set<string>();
  const now=minuteOf(save,save.runtime.time);
  let actions=0,decisions=0,skipped=0;const socialBudget=generationBudget(socialDecisionsPerTurn);
  for(const state of Object.values(save.npc_agent_state??{}))for(const task of state.social_tasks){
    if(task.status==='blocked'&&now>minuteOf(save,task.activity_at)+30){task.status='missed';continue;}
    if(task.status!=='active')continue;
    const delta=Math.max(0,now-minuteOf(save,task.last_accounted_at));
    task.time_credit_minutes=Math.min(240,task.time_credit_minutes+delta);
    task.last_accounted_at=structuredClone(save.runtime.time);
  }
  const playerLocation=()=>save.entities.find(entity=>entity.id===save.player_state.entity_id)
    ?.components.location?.location_id;
  const taskOf=(npcId:string,id:string)=>save.npc_agent_state?.[npcId]?.social_tasks.find(task=>task.id===id);
  const settle=(npcId:string,taskId:string,action:{type:'MOVE'|'TALK';target_id:string;parameters:Record<string,string>},
    actionIndex:number)=>{
    const actionId=autonomousId(requestId,npcId,200+actionIndex);
    const origin=save.entities.find(entity=>entity.id===npcId)?.components.location?.location_id;
    const result=executeAction(save,action,actionId,'ai',undefined,undefined,false,npcId,true);
    const receipt=result.save.resolution_receipts?.find(item=>item.request_id===actionId);
    if(!receipt)throw new Error('社会行动没有 Core receipt');
    const credit=taskOf(npcId,taskId)?.time_credit_minutes??0;
    if(receipt.time_cost>credit)throw new Error('社会行动超过已积累的世界时间');
    save=result.save;receipt.commit_status='committed';
    taskOf(npcId,taskId)!.time_credit_minutes-=receipt.time_cost;
    const destination=save.entities.find(entity=>entity.id===npcId)?.components.location?.location_id;
    if(playerLocation()===origin||playerLocation()===destination){
      const name=save.entities.find(entity=>entity.id===npcId)?.components.identity?.name??npcId;
      visibleFacts.push(action.type==='MOVE'?`${name}沿实际路线前往了另一处。`:
        `${name}与现场的人传达了一项约定。`);
    }
    observe('info','npc_agent.social_action',{module:'agent',request_id:requestId,revision:save.state_revision,
      metadata:{npc_id:npcId,task_id:taskId,action_type:action.type,receipt_id:actionId,time_cost:receipt.time_cost}});
    return actionId;
  };
  for(let step=0;step<socialActionsPerTurn;step++){
    signal?.throwIfAborted();
    const pending=Object.entries(save.npc_agent_state??{}).flatMap(([npcId,state])=>
      state.social_tasks.filter(task=>task.status==='active'&&
        minuteOf(save,task.next_at)<=now&&!attempted.has(task.id))
        .map(task=>({npcId,id:task.id,due:minuteOf(save,task.next_at)})))
      .sort((a,b)=>a.due-b.due||a.id.localeCompare(b.id));
    if(!pending.length)break;
    const {npcId,id}=pending[0];attempted.add(id);
    const task=taskOf(npcId,id)!;
    if(now>minuteOf(save,task.activity_at)+30){task.status='missed';skipped++;continue;}
    const actor=save.entities.find(entity=>entity.id===npcId&&entity.components.character);
    const here=String(actor?.components.location?.location_id??'');
    if(!here||Number(actor?.components.condition?.hp??100)<=0||save.background_state?.npc_status[npcId]?.unavailable){task.status='blocked';skipped++;continue;}
    if(task.kind==='invitation'){
      if(decisions>=socialDecisionsPerTurn||socialBudget.remaining<=0){skipped++;continue;}
      decisions++;
      try{
        const decision=await decideNpc(service,save,npcId,{kind:'social_invitation',
          description:task.message,public_speech:task.message},socialBudget,signal);
        if(!decision.social_response)throw new Error('邀请回应缺少独立意愿');
        applyNpcDecision(save,npcId,`social:${id}`,decision);
        const updated=taskOf(npcId,id)!;
        if(decision.social_response==='accept'){updated.kind='attend';updated.status='active';
          updated.next_at=structuredClone(save.runtime.time);attempted.delete(id);}
        else {updated.status=decision.social_response==='decline'?'cancelled':'blocked';
          updated.condition=decision.social_response==='conditional'?decision.decision_summary:null;}
        observe('info','npc_agent.social_response',{module:'agent',request_id:requestId,revision:save.state_revision,
          metadata:{npc_id:npcId,task_id:id,response:decision.social_response}});
      }catch(error){skipped++;
        const retryAt=now+10,minutes=save.definition.ruleset.minutes_per_day;
        taskOf(npcId,id)!.next_at={day:Math.floor(retryAt/minutes),minute:retryAt%minutes};
        observe('warn','npc_agent.social_skipped',{module:'agent',request_id:requestId,
        metadata:{npc_id:npcId,task_id:id,reason:error instanceof Error?error.message:String(error)}});}
      continue;
    }
    if(task.kind==='attend'){
      if(here===task.activity_location_id){task.status='completed';continue;}
      if(now+30<minuteOf(save,task.activity_at)){skipped++;continue;}
      if(now>minuteOf(save,task.activity_at)+30){task.status='missed';skipped++;continue;}
    }
    if(task.kind==='relay'&&!task.destination_ids.length){
      task.status=task.notified_ids.length&&task.recipient_ids.every(id=>task.notified_ids.includes(id))?
        'completed':'blocked';continue;}
    const destination=task.kind==='attend'?task.activity_location_id:task.destination_ids[0];
    if(here!==destination){
      const publicPlaces=new Set(currentMap(save).locations.filter(location=>
        location.known_by_default!==false).map(location=>location.id));
      for(const id of save.map_state.known_location_ids)publicPlaces.add(id);
      publicPlaces.add(here);publicPlaces.add(destination);
      const routes=currentMap(save).routes.filter(route=>route.conditions.every(condition=>
        save.gm_state.flags[condition.flag]===condition.equals)&&
        publicPlaces.has(route.from)&&publicPlaces.has(route.to));
      const path=routePath(routes,here,destination);
      if(!path?.length){task.status='blocked';skipped++;continue;}
      const next=path[0],remaining=task.time_credit_minutes;
      if(next.travel_minutes>remaining){skipped++;continue;}
      try{settle(npcId,id,{type:'MOVE',target_id:next.to,parameters:{companions:'none'}},step);actions++;}
      catch(error){taskOf(npcId,id)!.status='blocked';skipped++;
        observe('warn','npc_agent.social_skipped',{module:'agent',request_id:requestId,
          metadata:{npc_id:npcId,task_id:id,reason:error instanceof Error?error.message:String(error)}});}
      if(taskOf(npcId,id)?.status==='active')attempted.delete(id);
      continue;
    }
    if(task.kind==='attend'){task.status='completed';continue;}
    const target=save.entities.find(entity=>entity.id!==npcId&&entity.id!==save.player_state.entity_id&&
      entity.components.character&&entity.components.location?.location_id===here&&
      (!task.recipient_ids.length||task.recipient_ids.includes(entity.id))&&
      !task.notified_ids.includes(entity.id));
    if(!target){task.destination_ids.shift();if(!task.destination_ids.length)
      task.status=task.notified_ids.length&&task.recipient_ids.every(id=>task.notified_ids.includes(id))?
        'completed':'blocked';
      else attempted.delete(id);continue;}
    if(save.definition.ruleset.talk_minutes>task.time_credit_minutes){skipped++;continue;}
    try{
      const actionId=settle(npcId,id,{type:'TALK',target_id:target.id,
        parameters:{topic:task.message}},step);actions++;
      const updated=taskOf(npcId,id)!;updated.notified_ids.push(target.id);
      recordSceneObservation(save,actionId,[{speaker_id:npcId,utterance:updated.message}],[target.id]);
      const mind=save.npc_agent_state?.[target.id]??emptyNpcAgentState();
      const inviteId=`social:${createHash('sha256').update(`${updated.id}:${target.id}`).digest('hex').slice(0,32)}`;
      if(!mind.social_tasks.some(item=>item.id===inviteId))mind.social_tasks.push({
        id:inviteId,kind:'invitation',status:'active',message:updated.message,
        organizer_id:updated.organizer_id,activity_location_id:updated.activity_location_id,
        destination_ids:[],recipient_ids:[],notified_ids:[],declined_ids:[],
        activity_at:updated.activity_at,next_at:structuredClone(save.runtime.time),
        last_accounted_at:structuredClone(save.runtime.time),time_credit_minutes:updated.time_credit_minutes,
        source_request_id:updated.source_request_id,condition:null});
      save.npc_agent_state??={};save.npc_agent_state[target.id]=mind;
      attempted.delete(id);
    }catch(error){taskOf(npcId,id)!.status='blocked';skipped++;
      observe('warn','npc_agent.social_skipped',{module:'agent',request_id:requestId,
        metadata:{npc_id:npcId,task_id:id,reason:error instanceof Error?error.message:String(error)}});}
  }
  observe('info','npc_agent.social_batch',{module:'agent',request_id:requestId,revision:save.state_revision,
    metadata:{elapsed_world_minutes:elapsed,actions,decisions,skipped,model_calls:socialDecisionsPerTurn-socialBudget.remaining}});
  return {save,visibleFacts};
}
/** Execute a scene-recorded NPC decision using time that has actually passed.
 * The scene output only authorizes a plan; this Core receipt is the movement evidence. */
function settleExecutableNpcPlans(input:SavePackage,beforeTime:SavePackage['runtime']['time'],requestId:string,
  signal?:AbortSignal,limit=activityActionsPerTurn,onlyNpc?:string,reservedMinutes=0){
  let save=input,actions=0,attempts=0;
  const turnId=requestId.split(':window:')[0];
  const visibleFacts:string[]=[],now=minuteOf(save,save.runtime.time);
  if(now<=minuteOf(save,beforeTime))return {save,visibleFacts,actions,attempts};
  const ordered=Object.keys(save.npc_agent_state??{}).filter(id=>(!onlyNpc||id===onlyNpc)&&own(save,id).plans.some(plan=>plan.status==='active'&&plan.execution))
    .sort((a,b)=>Math.min(...own(save,a).plans.filter(p=>p.execution).map(p=>minuteOf(save,p.execution!.last_accounted_at)))-
      Math.min(...own(save,b).plans.filter(p=>p.execution).map(p=>minuteOf(save,p.execution!.last_accounted_at)))||a.localeCompare(b));
  if(!ordered.length)return {save,visibleFacts,actions,attempts};
  save=structuredClone(save);
  for(const npcId of ordered)for(const original of own(save,npcId).plans.filter(p=>p.status==='active'&&p.execution)){
    signal?.throwIfAborted();
    let plan=own(save,npcId).plans.find(p=>p.id===original.id)!,execution=plan.execution!;
    if(plan.last_failed_request_id===turnId){
      execution.last_accounted_at=structuredClone(save.runtime.time);execution.time_credit_minutes=0;continue;
    }
    if(execution.last_request_id===requestId||minuteOf(save,execution.last_accounted_at)>=now)continue;
    const since=Math.max(minuteOf(save,execution.last_accounted_at),execution.not_before?minuteOf(save,execution.not_before):0);
    execution.last_accounted_at=structuredClone(save.runtime.time);execution.last_request_id=requestId;
    const actor=save.entities.find(e=>e.id===npcId&&e.components.character);
    let reason:string|null=null;
    if(execution.condition)reason='condition_pending';
    else if(!actor||!actor.components.location||Number(actor.components.condition?.hp??100)<=0||save.background_state?.npc_status[npcId]?.unavailable)
      reason='actor_unavailable';
    else if(socialObligationActive(save,own(save,npcId)))reason='social_obligation';
    else if(now<since)reason='not_due';
    if(!reason)execution.time_credit_minutes=Math.min(240,execution.time_credit_minutes+Math.max(0,now-since-reservedMinutes));
    while(!reason&&execution.cursor<execution.steps.length&&attempts<limit){
      const step=execution.steps[execution.cursor],here=String(save.entities.find(e=>e.id===npcId)?.components.location?.location_id??'');
      let cost=step.type==='HOLD'?step.duration_minutes!:step.type==='TALK'?save.definition.ruleset.talk_minutes:1;
      let action:z.infer<typeof actionSchema>;
      if(step.type==='MOVE'){
        if(here===step.target_id){execution.cursor++;continue;}
        const map=currentMap(save),publicIds=new Set(map.locations.filter(p=>p.known_by_default!==false).map(p=>p.id));publicIds.add(here);
        const path=routePath(map.routes.filter(edge=>publicIds.has(edge.from)&&publicIds.has(edge.to)&&
          edge.conditions.every(c=>save.gm_state.flags[c.flag]===c.equals)),here,step.target_id!);
        if(!path?.length){reason='route_unavailable';break;}
        cost=path.reduce((sum,edge)=>sum+edge.travel_minutes,0);
        action={type:'MOVE',target_id:step.target_id!,parameters:{companions:'none'}};
      }else if(step.type==='HOLD')action={type:'HOLD',parameters:{minutes:cost,activity:step.description}};
      else if(step.type==='TALK'){
        if(!save.entities.some(e=>e.id===step.target_id&&e.components.character&&e.components.location?.location_id===here)){
          reason='listener_not_present';break;}
        action={type:'TALK',target_id:step.target_id!,parameters:{topic:step.speech!}};
      }else action={type:'INSPECT',...(step.target_id?{target_id:step.target_id}:{}),parameters:{focus:step.description}};
      if(cost>execution.time_credit_minutes){reason='insufficient_time_credit';break;}
      const actionId=autonomousId(requestId,npcId,500+attempts);attempts++;
      try{
        const result=executeAction(save,action,actionId,'ai',undefined,undefined,false,npcId,true);
        const receipt=result.save.resolution_receipts?.find(r=>r.request_id===actionId);
        if(!receipt||receipt.time_cost>execution.time_credit_minutes)throw Error('NPC planned action lacks a valid bounded receipt');
        save=result.save;receipt.commit_status='committed';actions++;
        plan=own(save,npcId).plans.find(p=>p.id===original.id)!;execution=plan.execution!;
        delete execution.failure_diagnostic;
        execution.time_credit_minutes-=receipt.time_cost;execution.cursor++;execution.last_receipt_id=receipt.request_id;
        if(step.type==='TALK')recordSceneObservation(save,actionId,[{speaker_id:npcId,utterance:step.speech!}],[step.target_id!]);
        const playerHere=save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id;
        const destination=save.entities.find(e=>e.id===npcId)?.components.location?.location_id;
        if(playerHere===here||playerHere===destination){
          if(step.type==='INSPECT')visibleFacts.push(`${String(actor!.components.identity?.name??npcId)}查看了周围环境。`);
          else if(step.type==='HOLD')visibleFacts.push(`${String(actor!.components.identity?.name??npcId)}在这里进行了一段持续活动。`);
          else visibleFacts.push(...receipt.canonical_facts.map(fact=>`${String(actor!.components.identity?.name??npcId)}：${fact}`));
          if(step.type==='TALK')visibleFacts.push(`${String(actor!.components.identity?.name??npcId)}说：“${step.speech}”`);
        }
        observe('info','npc_agent.planned_action',{module:'agent',request_id:requestId,revision:save.state_revision,
          metadata:{npc_id:npcId,plan_id:plan.id,step:execution.cursor-1,action_type:step.type,receipt_id:actionId,time_cost:receipt.time_cost}});
      }catch(error){reason=error instanceof GameError||error instanceof WorldBlockedError?'core_rejected':'system_error';
        execution.failure_diagnostic=(error instanceof Error?error.message:String(error)).slice(0,240);
        plan.last_failed_request_id=turnId;observe('warn','npc_agent.planned_action_rejected',{module:'agent',request_id:requestId,
        revision:save.state_revision,metadata:{npc_id:npcId,plan_id:plan.id,reason:error instanceof Error?error.message:String(error)}});}
    }
    if(reason&&['core_rejected','route_unavailable','listener_not_present','system_error'].includes(reason))execution.time_credit_minutes=0;
    if(reason==='route_unavailable')execution.failure_diagnostic='当前地点到计划目的地没有符合权威地图条件的公开可达路线';
    if(reason==='listener_not_present')execution.failure_diagnostic='计划中的交谈对象目前不在行动者所在场景';
    execution.blocked_reason=reason??(execution.cursor<execution.steps.length?'action_budget':null);
    completeNpcPlan(own(save,npcId),plan);
    observe('info','npc_agent.plan_evaluated',{module:'agent',request_id:requestId,revision:save.state_revision,
      metadata:{npc_id:npcId,plan_id:plan.id,status:plan.status,cursor:execution.cursor,time_credit_minutes:execution.time_credit_minutes,
        reason:execution.blocked_reason,model_calls:0}});
  }
  return {save,visibleFacts,actions,attempts};
}
function settleNpcActivityPlans(input:SavePackage,beforeTime:SavePackage['runtime']['time'],requestId:string,signal?:AbortSignal,
  reserved=new Map<string,number>(),limit=activityActionsPerTurn){
  let save=input,actions=0,attempts=0;const visibleFacts:string[]=[];
  const actors=Object.keys(input.npc_agent_state??{}).filter(id=>own(input,id).plans.some(p=>p.status==='active'&&(p.activity||p.execution)))
    .sort((a,b)=>(own(input,a).last_activity_at?minuteOf(input,own(input,a).last_activity_at!):-1)-
      (own(input,b).last_activity_at?minuteOf(input,own(input,b).last_activity_at!):-1)||a.localeCompare(b));
  for(const id of actors){
    const planned=settleExecutableNpcPlans(save,beforeTime,requestId,signal,limit-attempts,id,reserved.get(id)??0);
    const legacy=settleLegacyNpcActivityPlans(planned.save,beforeTime,requestId,signal,limit-attempts-planned.attempts,id,reserved.get(id)??0);
    save=legacy.save;visibleFacts.push(...planned.visibleFacts,...legacy.visibleFacts);
    if(planned.attempts+legacy.attempts){own(save,id).last_activity_at=structuredClone(save.runtime.time);}
    actions+=planned.actions+legacy.actions;
    attempts+=planned.attempts+legacy.attempts;
  }
  return {save,visibleFacts,actions,attempts};
}
function settleLegacyNpcActivityPlans(input:SavePackage,beforeTime:SavePackage['runtime']['time'],requestId:string,
  signal?:AbortSignal,limit=activityActionsPerTurn,onlyNpc?:string,reservedMinutes=0){
  if(minuteOf(input,input.runtime.time)<=minuteOf(input,beforeTime))
    return {save:input,visibleFacts:[] as string[],actions:0,attempts:0};
  const states=input.npc_agent_state??{};
  if(!Object.values(states).some(state=>state.plans.some(plan=>plan.status==='active'&&plan.activity)))
    return {save:input,visibleFacts:[] as string[],actions:0,attempts:0};
  let save=structuredClone(input),actions=0,attempts=0,skipped=0;
  const visibleFacts:string[]=[];
  const now=minuteOf(save,save.runtime.time);
  for(const npcId of Object.keys(save.npc_agent_state??{}).filter(id=>!onlyNpc||id===onlyNpc).sort()){
    signal?.throwIfAborted();
    const state=save.npc_agent_state![npcId];
    for(const plan of state.plans.filter(plan=>plan.status==='active'&&plan.activity)){
      if(plan.last_failed_request_id===requestId.split(':window:')[0]){
        plan.activity!.last_accounted_at=structuredClone(save.runtime.time);plan.activity!.time_credit_minutes=0;continue;
      }
      const activity=plan.activity!;
      const delta=Math.max(0,now-minuteOf(save,activity.last_accounted_at));
      const available=save.entities.find(e=>e.id===npcId)?.components.condition?.hp!==0&&
        !save.background_state?.npc_status[npcId]?.unavailable&&!socialObligationActive(save,state);
      if(!activity.condition&&available)activity.time_credit_minutes=Math.min(240,activity.time_credit_minutes+Math.max(0,delta-reservedMinutes));
      activity.last_accounted_at=structuredClone(save.runtime.time);
      if(delta<=0||activity.condition||!available||attempts>=limit){skipped++;continue;}
      const actor=save.entities.find(entity=>entity.id===npcId&&entity.components.character);
      const here=actor?.components.location?.location_id;
      if(!here||Number(actor?.components.condition?.hp??100)<=0||save.background_state?.npc_status[npcId]?.unavailable){skipped++;continue;}
      if(here===activity.destination_id){plan.status='completed';
        const goal=state.goals.find(goal=>goal.id===plan.goal_id);if(goal)goal.status='completed';continue;}
      // A separate authoritative move or an active social obligation can supersede this local plan.
      if(here!==activity.origin_location_id||socialObligationActive(save,state)){
        skipped++;if(here!==activity.origin_location_id)plan.status='abandoned';continue;
      }
      while(attempts<limit){
      const currentPlan=save.npc_agent_state![npcId].plans.find(item=>item.id===plan.id)!;
      const currentActivity=currentPlan.activity!;
      const currentHere=String(save.entities.find(entity=>entity.id===npcId)?.components.location?.location_id??'');
      const map=currentMap(save),publicIds=new Set(map.locations.filter(location=>
        location.known_by_default!==false).map(location=>location.id));
      for(const id of save.map_state.known_location_ids)publicIds.add(id);
      publicIds.add(currentHere);
      const path=routePath(map.routes.filter(route=>route.conditions.every(condition=>
        save.gm_state.flags[condition.flag]===condition.equals)&&publicIds.has(route.from)&&
        publicIds.has(route.to)),currentHere,currentActivity.destination_id);
      const next=path?.[0];
      if(!next||next.travel_minutes>currentActivity.time_credit_minutes){if(!next)currentActivity.time_credit_minutes=0;skipped++;break;}
      const actionId=autonomousId(requestId,npcId,300+attempts);attempts++;
      try{
        const result=executeAction(save,{type:'MOVE',target_id:next.to,parameters:{companions:'none'}},
          actionId,'ai',undefined,undefined,false,npcId,true);
        const receipt=result.save.resolution_receipts?.find(item=>item.request_id===actionId);
        if(!receipt||receipt.time_cost>currentActivity.time_credit_minutes)throw Error('短期行动缺少有效 MOVE 凭据');
        save=result.save;receipt.commit_status='committed';
        const updated=save.npc_agent_state![npcId].plans.find(item=>item.id===plan.id)!;
        updated.activity!.time_credit_minutes-=receipt.time_cost;
        updated.activity!.origin_location_id=next.to;
        if(next.to===activity.destination_id){updated.status='completed';
          const goal=save.npc_agent_state![npcId].goals.find(item=>item.id===updated.goal_id);
          if(goal)goal.status='completed';}
        const playerHere=save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id;
        if(playerHere===currentHere||playerHere===next.to)
          visibleFacts.push(`${String(actor.components.identity?.name??'附近的人')}沿实际路线离开了这里。`);
        actions++;
        observe('info','npc_agent.activity_action',{module:'agent',request_id:requestId,revision:save.state_revision,
          metadata:{npc_id:npcId,plan_id:plan.id,receipt_id:actionId,from:currentHere,to:next.to,time_cost:receipt.time_cost}});
        if(updated.status==='completed')break;
      }catch(error){skipped++;currentActivity.time_credit_minutes=0;currentPlan.last_failed_request_id=requestId.split(':window:')[0];observe('warn','npc_agent.activity_skipped',{module:'agent',request_id:requestId,
        revision:save.state_revision,metadata:{npc_id:npcId,plan_id:plan.id,reason:error instanceof Error?error.message:String(error)}});break;}
      }
    }
  }
  observe('info','npc_agent.activity_batch',{module:'agent',request_id:requestId,revision:save.state_revision,
    metadata:{actions,attempts,skipped,model_calls:0}});
  return {save,visibleFacts,actions,attempts};
}
/** Ordinary activity is grounded in presence and registered routes. It never chooses a
 * new objective, reveals hidden evidence, or adds a model call to the player turn. */
function settleDailyNpcTurn(input:SavePackage,beforeTime:SavePackage['runtime']['time'],requestId:string,signal?:AbortSignal,
  reserved=new Map<string,number>(),limit=dailyActionsPerTurn){
  const anchor=input.npc_daily_last_at??beforeTime;
  const elapsed=minuteOf(input,input.runtime.time)-minuteOf(input,anchor);
  if(minuteOf(input,input.runtime.time)<=minuteOf(input,beforeTime))return {save:input,visibleFacts:[] as string[]};
  const candidates=input.entities.filter(entity=>entity.id!==input.player_state.entity_id&&
    entity.components.character&&entity.components.location&&Number(entity.components.condition?.hp??100)>0&&
    !input.background_state?.npc_status[entity.id]?.unavailable).sort((a,b)=>a.id.localeCompare(b.id));
  const hour=Math.floor(input.runtime.time.minute/60);
  const eligibility:Record<string,string>={};
  const eligible=candidates.filter(npc=>{
    const here=String(npc.components.location?.location_id??''),state=own(input,npc.id);
    const reason=(reserved.get(npc.id)??0)>=minuteOf(input,input.runtime.time)-minuteOf(input,beforeTime)?'interval_spent':
      minuteOf(input,input.runtime.time)-minuteOf(input,state.last_daily_at??residentStart(input,npc))<dailyCadenceMinutes?'not_due':
      !here?'not_present':state.plans.some(plan=>plan.status==='active'&&(plan.activity||plan.execution))?'active_plan':
      socialObligationActive(input,state)?'social_obligation':
      state.memories.some(item=>item.event_ref===`daily:${input.runtime.time.day}:${here}`)?'already_observed_here':
      state.travel_intent?.status==='willing'&&state.travel_intent.origin_location_id===here?'companion_commitment':null;
    if(reason){eligibility[npc.id]=reason;return false;}
    if(hour>=6&&hour<20){eligibility[npc.id]='due';return true;}
    const home=npc.components.world_resident?.home_location_id??npc.components.residence?.home_location_id;
    const hasRoute=Boolean(home&&[...(input.definition.map?.routes??[]),...input.map_state.dynamic_routes]
      .some(edge=>edge.from===here&&edge.to===home&&edge.conditions.every(condition=>
        input.gm_state.flags[condition.flag]===condition.equals)&&edge.travel_minutes<=dailyCadenceMinutes));
    eligibility[npc.id]=hasRoute?'due':'no_registered_home_route';return hasRoute;
  });
  if(!eligible.length){
    observe('debug','npc_agent.daily_batch',{module:'agent',request_id:requestId,revision:input.state_revision,
      metadata:{elapsed_world_minutes:elapsed,executed:0,skipped:candidates.length,reasons:eligibility,model_calls:0,output_tokens:0}});
    return {save:input,visibleFacts:[] as string[]};
  }
  const save=structuredClone(input),visibleFacts:string[]=[];
  save.npc_daily_last_at=structuredClone(save.runtime.time);
  let executed=0,skipped=candidates.length-eligible.length;
  eligible.sort((a,b)=>(own(save,a.id).last_daily_at?minuteOf(save,own(save,a.id).last_daily_at!):-1)-
    (own(save,b.id).last_daily_at?minuteOf(save,own(save,b.id).last_daily_at!):-1)||a.id.localeCompare(b.id));
  for(let offset=0;offset<eligible.length&&executed<limit;offset++){
    signal?.throwIfAborted();
    const npc=eligible[offset],here=String(npc.components.location?.location_id??'');
    const ownState=own(save,npc.id),dailyRef=`daily:${save.runtime.time.day}:${here}`;
    if(!here||ownState.memories.some(item=>item.event_ref===dailyRef)||
      ownState.travel_intent?.status==='willing'&&ownState.travel_intent.origin_location_id===here){skipped++;continue;}
    const home=npc.components.world_resident?.home_location_id??npc.components.residence?.home_location_id;
    const route=hour>=20||hour<6?[...(save.definition.map?.routes??[]),...save.map_state.dynamic_routes]
      .find(edge=>edge.from===here&&edge.to===home&&edge.conditions.every(condition=>
        save.gm_state.flags[condition.flag]===condition.equals)&&edge.travel_minutes<=dailyCadenceMinutes):undefined;
    const action=route?{type:'MOVE',target_id:route.to,parameters:{companions:'none'}}:
      {type:'INSPECT',parameters:{}};
    const actionId=autonomousId(requestId,npc.id,100+offset);
    try{
      const result=executeAction(save,action,actionId,'ai',undefined,undefined,false,npc.id,true);
      const receipt=result.save.resolution_receipts?.find(item=>item.request_id===actionId);
      if(!receipt||receipt.time_cost>dailyCadenceMinutes)throw new Error('日常活动缺少有效结算凭据');
      Object.assign(save,result.save);
      receipt.commit_status='committed';
      const state=own(save,npc.id),at=structuredClone(save.runtime.time);
      state.last_daily_at=at;
      state.memories=boundedMemories([...state.memories,{event_ref:dailyRef,kind:'participated',
        summary:route?`从当前位置前往已登记的住处 ${route.to}`:`在 ${here} 观察周围环境`,
        participant_ids:[npc.id],at,importance:0}]);
      save.npc_agent_state??={};save.npc_agent_state[npc.id]=state;
      const playerHere=save.entities.find(item=>item.id===save.player_state.entity_id)?.components.location?.location_id;
      if(playerHere===here||playerHere===save.entities.find(item=>item.id===npc.id)?.components.location?.location_id){
        const name=String(npc.components.identity?.name??'附近的人');
        visibleFacts.push(route?`${name}沿已登记路线离开了这里。`:`${name}查看着周围的环境。`);
      }
      executed++;
      observe('info','npc_agent.daily_action',{module:'agent',request_id:requestId,revision:save.state_revision,
        metadata:{npc_id:npc.id,action_type:action.type,receipt_id:actionId,model_calls:0}});
    }catch(error){skipped++;observe('warn','npc_agent.daily_skipped',{module:'agent',request_id:requestId,
      revision:save.state_revision,metadata:{npc_id:npc.id,reason:error instanceof Error?error.message:String(error)}});}
  }
  observe('info','npc_agent.daily_batch',{module:'agent',request_id:requestId,revision:save.state_revision,
    metadata:{elapsed_world_minutes:elapsed,executed,skipped,deferred:Math.max(0,eligible.length-executed),reasons:eligibility,model_calls:0,output_tokens:0}});
  return {save,visibleFacts};
}
/** The Core clock can service existing deterministic plans between long-action
 * windows. This hook never asks a model, advances the clock, or writes storage. */
export function nextNpcPlanBoundary(save:SavePackage,ctx:ActionContext):number|null{
  if(ctx.action.actor_id!==save.player_state.entity_id||(ctx.npc_time_budget?.plan_actions??0)>=activityActionsPerTurn)return null;
  const now=minuteOf(save,save.runtime.time),boundaries:number[]=[];
  for(const [npcId,state] of Object.entries(save.npc_agent_state??{})){
    const actor=save.entities.find(e=>e.id===npcId),here=String(actor?.components.location?.location_id??'');
    if(!here||Number(actor?.components.condition?.hp??100)<=0||save.background_state?.npc_status[npcId]?.unavailable||
      state.social_tasks&&socialObligationActive(save,state))continue;
    for(const plan of (state.plans??[]).filter(p=>p.status==='active'&&(p.activity||p.execution))){
      if(plan.last_failed_request_id===(ctx.npc_time_budget?.scope_id??ctx.action.id))continue;
      const execution=plan.execution,activity=plan.activity;
      if(activity?.condition||execution?.condition)continue;
      if(execution?.not_before&&minuteOf(save,execution.not_before)>now){boundaries.push(minuteOf(save,execution.not_before)-now);continue;}
      const step=execution?.steps[execution.cursor];
      if(step?.type==='TALK'&&!save.entities.some(e=>e.id===step.target_id&&e.components.location?.location_id===here))continue;
      const destination=activity?.destination_id??(step?.type==='MOVE'?step.target_id:null);
      let cost=step?.type==='HOLD'?step.duration_minutes!:step?.type==='TALK'?save.definition.ruleset.talk_minutes:1;
      if(destination){
        const map=currentMap(save),path=routePath(map.routes.filter(route=>route.conditions.every(c=>save.gm_state.flags[c.flag]===c.equals)),here,destination);
        if(!path?.length)continue;
        cost=activity?path[0].travel_minutes:path.reduce((sum,route)=>sum+route.travel_minutes,0);
      }
      const credit=execution?.time_credit_minutes??activity?.time_credit_minutes??0;
      boundaries.push(Math.max(1,cost-credit));
    }
  }
  return boundaries.length?Math.min(...boundaries):null;
}
export function settleNpcPlanWindow(ctx:ActionContext,from:SavePackage['runtime']['time']):boolean{
  if(ctx.action.actor_id!==ctx.save.player_state.entity_id)return false;
  if(!Object.values(ctx.save.npc_agent_state??{}).some(state=>state.plans?.some(p=>p.status==='active'&&(p.activity||p.execution))))return false;
  const used=ctx.npc_time_budget?.plan_actions??0;
  const id=`${ctx.npc_time_budget?.scope_id??ctx.action.id}:window:${ctx.save.runtime.time.day}:${ctx.save.runtime.time.minute}`;
  const result=settleNpcActivityPlans(ctx.save,from,id,undefined,undefined,Math.max(0,activityActionsPerTurn-used));
  Object.assign(ctx.save,result.save);ctx.facts.push(...result.visibleFacts);
  ctx.npc_time_budget??={plan_actions:0,scope_id:ctx.action.id};ctx.npc_time_budget.plan_actions+=result.attempts;
  return result.actions>0;
}
function rememberPublicWorldEvents(save:SavePackage,npcId:string){
  const here=save.entities.find(item=>item.id===npcId)?.components.location?.location_id;
  if(!here)return;
  const at=structuredClone(save.runtime.time),state=own(save,npcId);
  for(const event of (save.background_state?.event_log??[]).slice(-20)){
    if(event.kind!=='stage_advanced')continue;
    const incident=save.definition.background_incidents?.find(item=>item.id===event.incident_id);
    const stage=incident?.stages.find(item=>item.id===event.to_stage);
    for(const exposure of stage?.exposures??[]){
      const place=exposure.location_id??incident?.locations[0];
      const parent=save.definition.map?.locations.find(item=>item.id===place)?.parent_id;
      const visible=exposure.channel==='public_notice'&&(place===here||
        exposure.delivery_scope==='parent_area'&&Boolean(parent&&
          parent===save.definition.map?.locations.find(item=>item.id===here)?.parent_id))||
        exposure.channel==='rumor'&&exposure.npc_id===npcId||
        exposure.channel==='same_location'&&place===here&&minuteOf(save,event.at)===minuteOf(save,at);
      if(!visible)continue;
      const eventRef=`public:${createHash('sha256').update(`${event.id}:${exposure.id}`).digest('hex').slice(0,32)}`;
      if(state.memories.some(item=>item.event_ref===eventRef))continue;
      state.memories=boundedMemories([...state.memories,{event_ref:eventRef,kind:'public_event',
        summary:exposure.text,participant_ids:event.actor_id?[event.actor_id]:[],at,importance:2}]);
    }
  }
  save.npc_agent_state??={};save.npc_agent_state[npcId]=state;
}
/** One bounded NPC batch inside time already advanced by a player or Routine action.
 * Decisions and Core receipts live in the same uncommitted candidate and Undo checkpoint. */
export async function settleAutonomousNpcTurn(service:GameService,input:SavePackage,
  beforeTime:SavePackage['runtime']['time'],requestId:string,signal?:AbortSignal,candidateLimit=autonomousCandidatesPerTurn){
  const admittedCandidates=Math.max(1,Math.min(autonomousCandidatesPerTurn,Math.trunc(candidateLimit)));
  const initialReceipts=new Set((input.resolution_receipts??[]).map(receipt=>receipt.request_id));
  const spentInInterval=(candidate:SavePackage)=>{
    const result=new Map<string,number>();
    for(const receipt of candidate.resolution_receipts??[])if(receipt.actor_id!==candidate.player_state.entity_id&&
      (!initialReceipts.has(receipt.request_id)||receipt.at&&minuteOf(candidate,receipt.at)>minuteOf(candidate,beforeTime)&&
        minuteOf(candidate,receipt.at)<=minuteOf(candidate,candidate.runtime.time)))
      result.set(receipt.actor_id,(result.get(receipt.actor_id)??0)+receipt.time_cost);
    return result;
  };
  const social=await settleSocialNpcTurn(service,input,beforeTime,requestId,signal);
  const activity=settleNpcActivityPlans(social.save,beforeTime,requestId,signal,spentInInterval(social.save));
  const daily=settleDailyNpcTurn(activity.save,beforeTime,requestId,signal,spentInInterval(activity.save));
  daily.visibleFacts.unshift(...social.visibleFacts,...activity.visibleFacts);
  if(minuteOf(input,input.runtime.time)<=minuteOf(input,beforeTime))return daily;
  if(Object.values(daily.save.npc_agent_state??{}).some(state=>state.last_autonomous_request_id===requestId))return daily;
  const now=minuteOf(daily.save,daily.save.runtime.time);
  const candidates=daily.save.entities.filter(entity=>entity.id!==daily.save.player_state.entity_id&&
    entity.components.character&&entity.components.location&&Number(entity.components.condition?.hp??100)>0&&
    !daily.save.background_state?.npc_status[entity.id]?.unavailable).sort((a,b)=>a.id.localeCompare(b.id));
  const due=candidates.filter(npc=>{const state=own(daily.save,npc.id);
    return state.autonomy_retry?now>=minuteOf(daily.save,state.autonomy_retry.retry_at):
      now-minuteOf(daily.save,state.last_autonomous_at??residentStart(daily.save,npc))>=autonomousCadenceMinutes;});
  const elapsed=due.length?Math.max(...due.map(npc=>now-minuteOf(daily.save,own(daily.save,npc.id).last_autonomous_at??residentStart(daily.save,npc)))):0;
  observe('info','npc_agent.autonomy_batch',{module:'agent',request_id:requestId,revision:daily.save.state_revision,
    metadata:{interval_start:beforeTime,interval_end:daily.save.runtime.time,candidates:candidates.length,due:due.length,
      budget:autonomousCallsPerTurn,deferred:Math.max(0,due.length-Math.min(admittedCandidates,Math.floor(elapsed/autonomousCadenceMinutes))),
      oldest_wait_minutes:elapsed,model_call_limit:autonomousCallsPerTurn+environmentCallsPerTurn,
      retry_due:due.filter(npc=>own(daily.save,npc.id).autonomy_retry).length,
      backoff:candidates.filter(npc=>{const retry=own(daily.save,npc.id).autonomy_retry;return retry&&now<minuteOf(daily.save,retry.retry_at);}).length}});
  if(!due.length)return daily;
  let save=structuredClone(daily.save);
  save.npc_autonomy_last_at=structuredClone(save.runtime.time);
  const visibleFacts:string[]=[...daily.visibleFacts];
  const count=Math.min(admittedCandidates,Math.floor(elapsed/autonomousCadenceMinutes),due.length);
  const servicedAt=(id:string)=>{const state=own(save,id);return state.autonomy_retry?.last_attempt_at??state.last_autonomous_at;};
  due.sort((a,b)=>minuteOf(save,servicedAt(a.id)??residentStart(save,a))-
    minuteOf(save,servicedAt(b.id)??residentStart(save,b))||a.id.localeCompare(b.id));
  const deferFailedDecision=(npcId:string,stage:'decision'|'cognition_admission')=>{
    const state=own(save,npcId),attempts=Math.min(16,(state.autonomy_retry?.attempts??0)+1);
    const delay=Math.min(180,15*2**(attempts-1)),retryAt=minuteOf(save,save.runtime.time)+delay;
    const dayMinutes=save.definition.ruleset.minutes_per_day;
    state.autonomy_retry={attempts,last_attempt_at:structuredClone(save.runtime.time),
      retry_at:{day:Math.floor(retryAt/dayMinutes),minute:retryAt%dayMinutes},stage};
    save.npc_agent_state![npcId]=state;
    observe('info','npc_agent.decision_backoff',{module:'agent',request_id:requestId,revision:save.state_revision,
      metadata:{npc_id:npcId,stage,attempts,retry_after_minutes:delay,retry_at:state.autonomy_retry.retry_at}});
  };
  const decisionBudget=generationBudget(autonomousCallsPerTurn);
  const environmentBudget=generationBudget(environmentCallsPerTurn);
  for(let index=0;index<count&&decisionBudget.remaining>0;index++){
    signal?.throwIfAborted();
    const npc=due[index];
    const here=String(npc.components.location?.location_id??'');
    if(!here)continue;
    const listeners=save.entities.filter(entity=>entity.id!==npc.id&&entity.components.character&&
      entity.components.location?.location_id===here).sort((a,b)=>
        Number(a.id===save.player_state.entity_id)-Number(b.id===save.player_state.entity_id));
    const actionId=autonomousId(requestId,npc.id,index);
    if(save.npc_agent_state?.[npc.id]?.last_decisions.some(item=>item.event_ref===`autonomy:${actionId}`))continue;
    // Schedule opportunities fairly across save/reload and cadence-sized time jumps.
    // An attempt uses this request's budget; only an admitted decision completes
    // the normal cadence. Failure has a separate persisted, bounded backoff.
    save.npc_agent_state??={};const scheduled=own(save,npc.id);
    scheduled.last_autonomous_request_id=requestId;
    save.npc_agent_state[npc.id]=scheduled;
    rememberPublicWorldEvents(save,npc.id);
    const witnessed=(save.background_state?.event_log??[]).slice(-8).filter(event=>{
      const incident=save.definition.background_incidents?.find(item=>item.id===event.incident_id);
      const stage=incident?.stages.find(item=>item.id===event.to_stage);
      return event.actor_id===npc.id||Boolean(stage?.exposures.some(exposure=>
        exposure.location_id===here&&['same_location','public_notice','scheduled_environment_change'].includes(exposure.channel)));
    }).map(event=>({event_ref:event.id,kind:event.kind}));
    let decision:NpcDecision;
    try{decision=await decideNpc(service,save,npc.id,{kind:'world_event',
      description:`世界时间经过 ${elapsed} 分钟。只依据自己的既有目标、当前位置与亲历事件决定是否行动。亲历事件：${JSON.stringify(witnessed)}`,
      candidate_ids:listeners.map(item=>item.id)},decisionBudget,signal);}
    catch(error){observe('warn','npc_agent.background_failed',{module:'agent',request_id:requestId,
      revision:save.state_revision,metadata:{npc_id:npc.id,stage:'decision',reason:error instanceof Error?error.message:String(error)}});
      deferFailedDecision(npc.id,'decision');continue;}
    const linkedPlanId=immediateNpcPlanLink(buildNpcAgentContext(save,npc.id,{kind:'world_event',description:'核对首步执行关联'}),decision);
    const proposal=decision.proposed_action;
    let targetId=proposal?.target_id??null;
    let type=proposal?.type??null;
    if(decision.kind==='speech'&&decision.speech){type='TALK';targetId=listeners[0]?.id??null;}
    const spent=spentInInterval(save).get(npc.id)??0;
    const actionBudget=Math.max(0,Math.min(minuteOf(save,save.runtime.time)-minuteOf(save,beforeTime)-spent,autonomousCadenceMinutes));
    let action:z.infer<typeof actionSchema>|null=null;
    if(type==='MOVE'&&targetId){
      const reachable=buildNpcAgentContext(save,npc.id,{kind:'world_event',description:'自主移动'}).scene.reachable_locations;
      if(reachable.some(item=>item.id===targetId))
        action={type:'MOVE',target_id:targetId,parameters:{companions:'none'}};
    }else if(type==='INSPECT'&&(!targetId||save.entities.some(item=>item.id===targetId&&item.components.location?.location_id===here))){
      action={type:'INSPECT',...(targetId?{target_id:targetId}:{}),parameters:{focus:proposal?.reason.slice(0,500)??''}};
    }else if(type==='TALK'&&targetId&&listeners.some(item=>item.id===targetId)){
      action={type:'TALK',target_id:targetId,parameters:{topic:(decision.speech??proposal?.reason??'近况').slice(0,2000)}};
    }else if(type==='HOLD'&&proposal){
      action={type:'HOLD',parameters:{minutes:proposal.duration_minutes??30,activity:proposal.reason}};
    }else if(type==='TAKE'&&targetId&&save.entities.some(item=>item.id===targetId&&item.components.item&&item.components.location?.location_id===here)){
      action={type:'MOVE_ITEM',parameters:{item_id:targetId,to:'held'}};
    }else if(type==='DROP'&&targetId&&Number((npc.components.inventory?.items as Record<string,number>|undefined)?.[targetId]??0)>0){
      action={type:'MOVE_ITEM',parameters:{item_id:targetId,to:'scene'}};
    }
    const activePlan=own(save,npc.id).plans.some(plan=>plan.status==='active'&&(plan.activity||plan.execution)&&
      !(decision.plan_updates??[]).some(update=>update.plan_id===plan.id)&&
      !decision.goal_updates.some(update=>update.goal_id===plan.goal_id&&update.status!=='active'));
    const expectedCost=action?.type==='MOVE'?buildNpcAgentContext(save,npc.id,{kind:'world_event',description:'核对行动时间'})
      .scene.reachable_locations.find(place=>place.id===targetId)?.travel_minutes??Infinity:
      action?.type==='HOLD'?Number(action.parameters.minutes):action?.type==='TALK'?save.definition.ruleset.talk_minutes:1;
    if(action&&(activePlan||expectedCost>actionBudget)){
      if(!activePlan&&['MOVE','INSPECT','TALK','HOLD'].includes(action.type)&&!decision.plan_proposals.some(plan=>plan.steps?.length)){
        const id=`deferred:${actionId}`;
        decision={...decision,proposed_action:null,goal_proposals:[...decision.goal_proposals,{id,description:decision.intent,horizon:'short',priority:5}],
          plan_proposals:[...decision.plan_proposals,{id,goal_id:id,intention:decision.intent,steps:[{type:action.type as 'MOVE'|'INSPECT'|'TALK'|'HOLD',
            target_id:action.target_id??null,description:proposal?.reason??decision.intent,
            duration_minutes:action.type==='HOLD'?Number(action.parameters.minutes):null,
            speech:action.type==='TALK'?String(action.parameters.topic):null}],not_before:null}]};
      }
      observe('info','npc_agent.action_deferred',{module:'agent',request_id:requestId,revision:save.state_revision,
        metadata:{npc_id:npc.id,action_type:action.type,reason:activePlan?'active_plan':'insufficient_elapsed_time',available_minutes:actionBudget}});
      action=null;
    }
    if(!action)observe('info','npc_agent.decision_without_action',{module:'agent',request_id:requestId,revision:save.state_revision,
      metadata:{npc_id:npc.id,kind:decision.kind,reason:decision.kind==='no_action'?'no_action':decision.plan_proposals.some(plan=>plan.steps?.length)?'persistent_plan':'no_admissible_proposal'}});
    try{
      // Only cognition is staged here. Invalid/over-capacity NPC plans must not
      // discard the player's valid action or begin a physical step first.
      const state=stageNpcDecision(save,npc.id,`autonomy:${actionId}`,decision,true);
      state.last_autonomous_at=structuredClone(save.runtime.time);delete state.autonomy_retry;
      save.npc_agent_state![npc.id]=state;
      // Only an admitted decision changes the body; staging ran on an isolated copy.
      applySelfState(save,npc.id,`autonomy:${actionId}`,decision);
    }catch(error){observe('warn','npc_agent.background_failed',{module:'agent',request_id:requestId,revision:save.state_revision,
      metadata:{npc_id:npc.id,stage:'cognition_admission',reason:error instanceof Error?error.message:String(error)}});
      deferFailedDecision(npc.id,'cognition_admission');continue;}
    const origin=here;
    if(action)try{
      const query=type==='INSPECT'?proposal?.environment_query:null;
      const assessment=query?await service.ai.assessEnvironment(save,proposal!.reason,query,false,npc.id,environmentBudget,signal):undefined;
      const result=query?executeEnvironmentQuery(save,proposal!.reason,query,1,assessment,actionId,npc.id):
        executeAction(save,action,actionId,'ai',undefined,undefined,false,npc.id,true);
      if(result.action.time_cost>actionBudget)throw new Error('NPC 行动超过本次已结算时间窗口');
      const receipt=result.save.resolution_receipts?.find(item=>item.request_id===actionId);
      if(!receipt)throw new Error('NPC 行动缺少 Core receipt');
      if(linkedPlanId){
        const state=own(result.save,npc.id),plan=state.plans.find(p=>p.id===linkedPlanId),execution=plan?.execution;
        if(!plan||!execution||execution.cursor!==0||receipt.actor_id!==npc.id||receipt.semantic_action!==type||
          receipt.target_id!==(action.target_id??null)||type!=='MOVE'&&receipt.time_cost!==expectedCost||
          type==='MOVE'&&result.save.entities.find(e=>e.id===npc.id)?.components.location?.location_id!==targetId)
          throw Error('NPC_IMMEDIATE_PLAN_RECEIPT_MISMATCH');
        execution.cursor=1;execution.last_receipt_id=receipt.request_id;execution.last_request_id=requestId;
        execution.blocked_reason=null;completeNpcPlan(state,plan);
      }
      save=result.save;
      receipt.commit_status='committed';
      if(query&&receipt.environment?.resolution_id&&receipt.environment.status!=='unresolved'){
        const record=save.environment_state?.resolutions.find(item=>item.id===receipt.environment!.resolution_id);
        const mind=save.npc_agent_state?.[npc.id];
        if(record&&mind&&!mind.knowledge.some(item=>item.id===`environment:${record.id}`)){
          mind.knowledge=[...mind.knowledge,{id:`environment:${record.id}`,
            proposition:record.status==='present'?`在${here}观察到${record.name}。`:
              `在${here}检查${record.name}，本次范围内未找到。`,
            source_type:'observed' as const,source_ref:record.id,learned_at:structuredClone(save.runtime.time),confidence:1}].slice(-80);
        }
      }
      if(linkedPlanId)observe('info','npc_agent.immediate_plan_settled',{module:'agent',request_id:requestId,revision:save.state_revision,
        metadata:{npc_id:npc.id,plan_id:linkedPlanId,step:0,receipt_id:actionId,time_cost:receipt.time_cost}});
      if(type==='TALK'&&targetId&&decision.speech&&targetId!==save.player_state.entity_id)
        recordSceneObservation(save,actionId,[{speaker_id:npc.id,utterance:decision.speech}],[targetId]);
      const playerHere=save.entities.find(item=>item.id===save.player_state.entity_id)?.components.location?.location_id;
      if(playerHere===origin||playerHere===save.entities.find(item=>item.id===npc.id)?.components.location?.location_id){
        // Seeing somebody search is not automatic access to their private discovery.
        if(type==='INSPECT')visibleFacts.push(`${String(npc.components.identity?.name??npc.id)}查看了周围环境。`);
        else if(type==='HOLD')visibleFacts.push(`${String(npc.components.identity?.name??npc.id)}在这里进行了一段持续活动。`);
        else visibleFacts.push(...result.facts.map(fact=>`${String(npc.components.identity?.name??npc.id)}：${fact}`));
        if(type==='TALK'&&decision.speech){
          const speaker=save.entities.find(item=>item.id===npc.id)?.components.identity?.name??npc.id;
          visibleFacts.push(`${speaker}说：“${decision.speech}”`);
        }
      }
      observe('info','npc_agent.background_action',{module:'agent',request_id:requestId,revision:save.state_revision,
        metadata:{npc_id:npc.id,action_type:type,receipt_id:actionId,elapsed_world_minutes:elapsed}});
    }catch(error){if(linkedPlanId){const plan=own(save,npc.id).plans.find(p=>p.id===linkedPlanId);
      if(plan?.execution){plan.last_failed_request_id=requestId.split(':window:')[0];plan.execution.blocked_reason='core_rejected';plan.execution.time_credit_minutes=0;}}
      observe('warn','npc_agent.background_failed',{module:'agent',request_id:requestId,
      revision:save.state_revision,metadata:{npc_id:npc.id,stage:'execution',reason:error instanceof Error?error.message:String(error)}});}
  }
  return {save,visibleFacts};
}

/** Simultaneous decisions share one immutable revision; one Core transaction records validated results. */
export async function decideNpcVoteBatch(service:GameService,requestId:string,npcIds:string[],candidateIds:string[],question:string){
  const save=await service.current();
  if(npcIds.length>MAX_NPC_AGENT_CALLS_PER_TURN)return {status:'paused' as const,reason:'NPC decision budget reached',decisions:[],revision:save.state_revision};
  if(new Set(npcIds).size!==npcIds.length)throw new Error('Duplicate NPC voter');
  const event={kind:'vote',description:question,candidate_ids:candidateIds};
  const voteBudget=generationBudget(MAX_NPC_AGENT_CALLS_PER_TURN);
  const decisions=await Promise.all(npcIds.map(async npcId=>{
    if(!admitNpcDecision(save,npcId,'vote'))throw new Error('Invalid NPC voter');
    const decision=await decideNpc(service,save,npcId,event,voteBudget);
    if(decision.kind!=='vote')throw new Error('NPC vote event returned a non-vote decision');
    return {npc_id:npcId,decision};
  }));
  await service.agentTransaction({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId},
    {npc_vote:true,voters:npcIds,event:question},next=>{
      for(const {npc_id,decision} of decisions)applyNpcDecision(next,npc_id,`vote:${requestId}`,decision);
    });
  const after=await service.current();
  observe('info','npc_agent.action_committed',{module:'agent',request_id:requestId,revision:after.state_revision,
    metadata:{trigger:'vote',npc_ids:npcIds,receipt_ids:[requestId],outcome:'votes_recorded'}});
  return {status:'committed' as const,decisions,revision:after.state_revision};
}

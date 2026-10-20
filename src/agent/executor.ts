import {CandidateValidationError,generationRepair} from '../ai/failures.js';
import {openGoalControlSchema,type OpenGoalControl} from './plan-schema.js';
import {displayText} from '../shared/display.js';
import {npcPresentInView} from '../shared/interaction-context.js';
import {createHash} from 'node:crypto';
import type {GameService} from '../server/service.js';
import {publicView} from '../core/state.js';
import {assert,GameError} from '../core/schema.js';
import {agentResult,recoveryContext,type AgentResult,type UIAction} from './contracts.js';
import {createAgentPlan,fastPlan,hasUserCondition,PlanConversionError,assertConditionalOwnership} from './planner.js';
import {checkChoiceOffer} from '../core/choice-offer.js';
import {classifyChoiceExecution} from '../core/choice-availability.js';
import type {AgentPlan,AtomicGoal,FutureIntent} from './plan-schema.js';
import {planGameRequest} from './game.js';
import type {TruthQueryResult} from './truth-query.js';
import {applyAssistantStyle} from '../ai/behavior.js';
import {relationshipCondition} from '../shared/relationship.js';
import {dueAssessment,futureConditionGuards,futureConditionsHold} from './future.js';
import {recentReferent} from '../core/recent-referent.js';
import {sceneAnchor} from '../core/interaction.js';
import {executeOpenWorldGoal,runContractPlan,canExecuteContractPlan,discoverContractCandidates,executeContractStep} from './affordances.js';
import {compileGoalContract,hasMultipleClauses,recoverablePlanAdmission} from './goal-contract.js';
import {scenePartner,sceneMessage,orderedSceneBeats,sceneSpeechSeconds,planOpenGoalStep,MAX_OPEN_GOAL_STEPS,sceneFailureInfo,sceneRepairFeedback,
  SceneInteractionError,recordSoftContacts,recordSocialCommitments,recordNpcActivityPlans,type SceneRepair,type runSceneInteraction} from './scene-interaction.js';
import {z} from 'zod';
import type {SavePackage} from '../core/schema.js';
import {currentTrace} from '../observability/trace.js';
import {interpretSemanticEntry,type SemanticDecision} from './semantic-entry.js';
import {verifyGoalAlignment} from './goal-alignment.js';
import {failureReason,SceneSchemaError} from '../ai/failures.js';
import {agentSkills} from './skills/index.js';
import type {exploreLocation} from './location-exploration.js';
import {engineOutcome,gameOutcome,gameNarrative,engineMessage,safeEngineMessage,WorldBlockedError} from './outcome.js';
import {resolveTemporalWait} from './temporal-wait.js';
import {applyNpcDecision,applyNpcProposedAction,recordSceneObservation} from './npc-agent.js';
import {isActivePerception} from './perception.js';
import {resolveEntities} from './entities.js';
import {expandMapFrontier} from './region-expansion.js';
import {regionFrontier} from '../core/region-expansion.js';
import {routePath} from '../core/map.js';
import {executeAction} from '../core/runtime.js';
import {withRequestBudget} from '../ai/request-budget.js';

const observedConditionSchema=z.strictObject({value:z.boolean().nullable(),evidence:z.string().max(300).nullable()});

function childId(request:string,goal:string){const hex=createHash('sha256').update(request+':'+goal).digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);}
function committedSince(before:SavePackage,after:SavePackage){
 const seen=new Set((before.resolution_receipts??[]).map(receipt=>receipt.request_id));
 return (after.resolution_receipts??[]).filter(receipt=>receipt.commit_status==='committed'&&!seen.has(receipt.request_id)).map(receipt=>receipt.request_id);
}
function executionFailure(error:unknown,stage:string,save:SavePackage,before?:SavePackage,committedSteps:string[]=[]){
 const code=failureReason(error)!=='unknown'?'provider_failure':'transaction_failure';
 return engineOutcome(code,stage,save.state_revision,!before||save.state_revision===before.state_revision,
   committedSteps,before?committedSince(before,save):[]);
}
/** One optional, read-only scene continuation after a committed MOVE into newly met company. */
async function continueArrivalScene(service:GameService,body:PlanRequest,beforeMove:SavePackage,
  afterMove:SavePackage,moveRequestId:string):Promise<{kind:'not_needed'|'committed'|'unavailable';text:string}>{
  const view=service.project(afterMove);
  const destination=view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id;
  const origin=beforeMove.entities.find(entity=>entity.id===beforeMove.player_state.entity_id)?.components.location?.location_id;
  if(!destination||destination===origin)return {kind:'not_needed',text:''};
  const residents=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character&&
    entity.components.location?.location_id===destination&&
    beforeMove.entities.find(previous=>previous.id===entity.id)?.components.location?.location_id===destination);
  if(!residents.length)return {kind:'not_needed',text:''};
  let proposal:Awaited<ReturnType<typeof runSceneInteraction>>=null;
  let repair:SceneRepair|undefined;
  for(let attempt=1;attempt<=2;attempt++){
    try{proposal=await agentSkills(afterMove).invoke<{
      view:typeof view;input:string;partner:{id:string};speechMode:'none';phase:'arrival';repair?:typeof repair
    },Awaited<ReturnType<typeof runSceneInteraction>>>('natural_scene',{
      view,input:body.input,partner:{id:residents[0].id},speechMode:'none',phase:'arrival',repair,
    },{service,save:afterMove,request_id:body.request_id});
      if(proposal)break;
    }catch(error){const failure=sceneFailureInfo(error);
      service.logger.warn('agent.arrival_scene.failed',{module:'agent',metadata:{
        attempt,reason:failureReason(error),stage:failure.stage}});
      if(['PROVIDER_REFUSAL','PROVIDER_CONTENT_FILTER','SCENE_PROVIDER_FAILURE'].includes(failure.code))break;
      repair=sceneRepairFeedback(error,afterMove.state_revision);
    }
    repair??={failure_code:'arrival_scene_invalid',failure_stage:'arrival_scene',revision:afterMove.state_revision};
  }
  if(!proposal)return {kind:'unavailable',text:''};
  const arrivalText=sceneMessage(proposal,view);
  const ordered=orderedSceneBeats(proposal.result)??[
    {kind:'narration' as const,text:proposal.result.narrative},
    ...proposal.result.speech_events.map(event=>({kind:'speech' as const,
      speaker_id:event.speaker_id,utterance:event.utterance})),
  ];
  const previous=afterMove.last_turn?.scene_beats??[];
  const movementText=String(afterMove.last_turn?.narrative??'');
  const movementBeats=previous.length?previous:Array.from({length:Math.ceil(movementText.length/1200)},(_,index)=>({
    kind:'narration' as const,text:movementText.slice(index*1200,(index+1)*1200)}));
  if(movementBeats.length+ordered.length>96)return {kind:'unavailable',text:''};
  const arrivalId=childId(body.request_id,`arrival-scene:${moveRequestId}`);
  try{await service.agentTransaction({game_id:afterMove.game_id,expected_revision:afterMove.state_revision,
    request_id:arrivalId},{arrival_scene_for:moveRequestId},next=>{
    next.last_turn={narrative:[afterMove.last_turn?.narrative,arrivalText].filter(Boolean).join('\n'),
      speaker:null,dialogue:null,scene_beats:[...movementBeats,...ordered],choices:[],context_actions:[]};
    next.narrative_history=[...(next.narrative_history??[]),{request_id:arrivalId,
      narrative:proposal.result.narrative,dialogue:proposal.result.dialogue,
      speaker:[...proposal.result.speech_events].reverse().find(event=>event.provenance==='npc_response')?.speaker_id??null,
      facts:[],player_input:body.input,speech_events:proposal.result.speech_events.map(event=>({...event,
        source_intent:event.provenance==='generated_from_player_intent'?body.input:null})),
      revision:next.state_revision+1,time:structuredClone(next.runtime.time),location_id:String(destination)}].slice(-8);
    recordSceneObservation(next,arrivalId,proposal.result.speech_events,
      view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character&&
        entity.components.location?.location_id===destination).map(entity=>entity.id));
  });}catch(error){service.logger.warn('agent.arrival_scene.commit_failed',{module:'agent',metadata:{
    reason:failureReason(error),revision:afterMove.state_revision}});return {kind:'unavailable',text:''};}
  service.logger.info('agent.arrival_scene.committed',{module:'agent',request_id:body.request_id,
    revision:afterMove.state_revision+1,metadata:{location_id:destination,move_request_id:moveRequestId,
      speech_event_count:proposal.result.speech_events.length}});
  return {kind:'committed',text:arrivalText};
}
export function oneNavigation(actions:UIAction[]):UIAction[]{
 const primary=actions.find(a=>a.kind==='open_panel'&&a.panel==='relationships')??actions.find(a=>['open_panel','open_character_detail'].includes(a.kind));
 if(!primary)return [];
 if(primary.kind==='open_character_detail')return [primary];
 if(primary.kind!=='open_panel')return [];
 const focus=actions.find(a=>a.kind==='focus_entity'&&a.panel===primary.panel);
 return [primary,...(focus?[focus,...actions.filter(a=>(a.kind==='scroll_to_entity'||a.kind==='highlight_entity')&&a.entity_id===(focus as any).entity_id)]:[])];
}
/** Goals that only read state. A plan made of these can be replayed safely after a revision conflict. */
const readOnlyGoalTypes=new Set(['WORLD_QUERY','WORLD_LOOKUP','UI_NAVIGATION','LIST_FUTURE']);
export function readOnlyPlan(goals:{type:string}[]){return goals.length>0&&goals.every(goal=>readOnlyGoalTypes.has(goal.type));}
export interface PlanRequest {request_id:string;game_id:string;expected_revision:number;input:string;original_input?:string;choice_offer_id?:string;end_conversation?:boolean;interaction?:import('../shared/interaction-context.js').NpcConversationContext}
function activeGoalResult(service:GameService,save:SavePackage,message:string):AgentResult{
 const plan=save.active_goal!.plan,question=save.active_goal!.waiting_question;
 return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',message,{presentation:plan.status==='waiting_for_player'?'handoff':'story',
   outcome:gameOutcome(plan.status==='completed'?'completed':'unresolved_goal','active_goal',save.state_revision),plan_id:plan.plan_id,plan,
   results:plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??'',related_entity:goal.target_entities[0]??null,status:goal.status})),
   clarification:plan.status==='waiting_for_player'?question:null,view:service.project(save)});
}
function contractFinalMessage(plan:AgentPlan,reason:string,question:string|null,
 options:{label:string}[]):string{
 const completed=plan.goals.filter(goal=>goal.status==='completed').map(goal=>{
  const presence=goal.result?.observation?.value;
  return goal.normalized_goal+(presence==='present'?'（在场）':presence==='absent'?'（不在场）':'')+
    (goal.result?.summary&&!goal.result.summary.includes('程序结算与完成证据')?`：${goal.result.summary}`:'');
 });
 if(plan.status==='completed')return `已完成：${completed.join('；')}。`;
 const unfinished=plan.goals.filter(goal=>goal.status!=='completed');
 const failures=unfinished.filter(goal=>goal.status==='blocked'&&goal.result?.summary)
   .map(goal=>`${goal.normalized_goal}：${goal.result!.summary}`);
 return [completed.length?`已完成：${completed.join('；')}。`:null,
   unfinished.length?`尚未完成：${unfinished.map(goal=>goal.normalized_goal).join('；')}。`:null,
   failures.length?`未完成原因：${failures.join('；')}。`:plan.status!=='waiting_for_player'?`未完成原因：${reason}`:null,
   plan.status==='waiting_for_player'&&question?`需要你决定：${question}`:null,
   options.length?`可选择：${options.map(option=>option.label).join('、')}`:null].filter(Boolean).join('\n');
}
async function continueActiveGoal(service:GameService,save:SavePackage,plan:AgentPlan,
 selection:Record<string,{candidate_id:string;source:'player'|'model'}>={},endConversation=false,
 resumeRequestId?:string,originalInput?:string):Promise<AgentResult>{
 const start=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
 const outcome=await runContractPlan(service,save,plan,selection,true,endConversation,resumeRequestId);
 const end=outcome.save.runtime.time.day*outcome.save.definition.ruleset.minutes_per_day+outcome.save.runtime.time.minute;
 const question=outcome.save.active_goal?.waiting_question;
 const options=outcome.save.active_goal?.options??[];
 const message=contractFinalMessage(outcome.plan,outcome.reason,question??null,options);
 // Plan-progress saves are not completed world actions and cannot make an old
 // story (or a child failure message) look like this request's new narration.
 const oldScenes=new Set(save.narrative_history?.map(entry=>entry.request_id)??[]);
 const newScene=outcome.save.narrative_history?.some(entry=>!oldScenes.has(entry.request_id)&&entry.speech_events?.length);
 const narrated=committedSince(save,outcome.save).length||newScene?
   outcome.save.last_turn?.narrative?.trim():null;
 const shown=outcome.outcome.type==='engine_failure'?engineMessage(outcome.outcome):
   outcome.plan.status==='waiting_for_player'?message:outcome.plan.status!=='completed'?outcome.reason:narrated??
   (outcome.plan.status==='completed'?message:outcome.reason);
 return {...activeGoalResult(service,outcome.save,shown),outcome:outcome.outcome,
   ...(outcome.outcome.type==='engine_failure'?{recovery:recoveryContext(originalInput??plan.contract?.original_intent??'',outcome.outcome,{plan_id:plan.plan_id})}:{}),
   ...(narrated?{story:narrated}:{}),
   presentation:outcome.outcome.type==='engine_failure'?'failure':outcome.plan.status==='waiting_for_player'?'handoff':
     outcome.plan.status!=='completed'?'assistant':narrated?'story':'assistant',time_advanced:end-start,
   canonical_changes:outcome.plan.goals.filter(goal=>goal.status==='completed').map(goal=>`goal:${goal.goal_id}`),
   clarification:outcome.plan.status==='waiting_for_player'?question:null};
}
function pendingChoice(save:SavePackage,input:string){
 const active=save.active_goal;if(!active?.options.length)return null;
 const key=input.trim().normalize('NFKC').toLocaleLowerCase(),matches=active.options.filter(option=>{
   if(option.candidate_id.normalize('NFKC').toLocaleLowerCase()===key||option.label.normalize('NFKC').toLocaleLowerCase()===key)return true;
   const itemId=option.candidate_id.startsWith('BUY:')?option.candidate_id.split(':').at(-1):null;
   const name=save.entities.find(entity=>entity.id===itemId)?.components.identity?.name;
   return Boolean(itemId&&typeof name==='string'&&name.normalize('NFKC').toLocaleLowerCase()===key);
 });
 return matches.length===1?matches[0]:null;
}
type GoalControl=OpenGoalControl;
function goalControl(input:string):GoalControl|null{
 const text=input.trim().replace(/[。！!]$/u,'');
 if(/^(?:查询|查看)(?:当前)?目标(?:状态)?$/u.test(text))return {kind:'query',target:'current'};
 if(/^(?:取消|放弃)当前目标$/u.test(text))return {kind:'cancel',target:'current'};
 if(/^(?:继续|恢复)(?:当前)?目标$/u.test(text))return {kind:'resume',target:'current'};
 if(/^(?:继续|恢复)(?:之前|上一个|暂停的)目标$/u.test(text))return {kind:'resume',target:'paused'};
 const named=text.match(/^(查询|查看|取消|放弃|继续|恢复)目标\s*[:：]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu);
 return named?{kind:/查询|查看/.test(named[1])?'query':/取消|放弃/.test(named[1])?'cancel':'resume',target:named[2]}:null;
}
export function isActiveGoalControlInput(save:SavePackage,input:string){
 return Boolean(goalControl(input)||save.active_goal&&pendingChoice(save,input));
}
/** Controls read the same persistent plans as execution; they never ask a model
 * whether a stored blocked goal exists. Only an explicit resume executes it. */
export async function executeGoalControl(service:GameService,body:PlanRequest,raw:OpenGoalControl):Promise<AgentResult>{
 const control=openGoalControlSchema.parse(raw),save=await service.current();
 assert(save.game_id===body.game_id,'游戏已切换，请刷新');
 assert(save.state_revision===body.expected_revision,'状态已更新，请刷新');
 return handleGoalControl(service,save,body,control);
}
async function handleGoalControl(service:GameService,save:SavePackage,body:PlanRequest,control:GoalControl):Promise<AgentResult>{
 const result=(current:SavePackage,message:string,status:NonNullable<AgentResult['goal_control']>['status'],id:string|null,receipts:string[]=[]):AgentResult=>({
   ...activeGoalResult(service,current,message),presentation:'assistant',
   outcome:gameOutcome(status==='not_found'?'unavailable':status==='cancelled'?'completed':'feedback','goal_control',current.state_revision,[],receipts),
   goal_control:{...control,goal_id:id,status,revision:current.state_revision,receipt_ids:receipts}});
 const active=save.active_goal,paused=save.paused_goals??[];
 const target=control.target==='current'?active:control.target==='paused'?paused.at(-1):
   [active,...paused].find(item=>item?.plan.plan_id.toLowerCase()===control.target.toLowerCase());
 if(control.kind==='query'){
  const plans=control.target==='current'?[...(active?[active]:[]),...paused]:target?[target]:[];
  const message=plans.length?plans.map(item=>`${item===active?'当前':'暂停'}目标 ${item.plan.plan_id} [${item.plan.status}]：`+
    item.plan.goals.map(goal=>`${goal.normalized_goal} [${goal.status}]`).join('；')).join('\n'):'没有符合条件的已保存目标。';
  return result(save,message,plans.length?'queried':'not_found',target?.plan.plan_id??null);
 }
 if(!target||['completed','failed'].includes(target.plan.status))return result(save,target?'该目标已经结束；没有重复执行操作。':'没有符合条件的未完成目标；没有执行行动。可输入“查询目标状态”查看当前与暂停目标。',
   target?'already_terminal':'not_found',target?.plan.plan_id??null);
 if(control.kind==='cancel'){
  const previous=save.runtime.receipts.find(receipt=>receipt.id===body.request_id);
  if(previous){
    const fingerprint=createHash('sha256').update(JSON.stringify({agent_operation:{cancel_goal:target.plan.plan_id}})).digest('hex');
    assert(previous.fingerprint===fingerprint,'请求 ID 已用于另一操作');
    return result(save,'原取消操作已有提交记录，但当前目标状态已发生后续变更；没有重复执行。','blocked',target.plan.plan_id,[body.request_id]);
  }
  await service.agentTransaction(body,{cancel_goal:target.plan.plan_id},next=>{
   const prior=next.active_goal?.plan.plan_id===target.plan.plan_id?next.active_goal:
     next.paused_goals?.find(item=>item.plan.plan_id===target.plan.plan_id);
   assert(prior,'目标状态已更新');prior.plan.status='failed';prior.waiting_question=null;prior.options=[];
   for(const goal of prior.plan.goals)if(goal.status!=='completed')goal.status='blocked';
   next.paused_goals=next.paused_goals?.filter(item=>item.plan.plan_id!==prior.plan.plan_id);
  });
  const committed=await service.current();
  assert(committed.runtime.receipts.some(receipt=>receipt.id===body.request_id),'取消目标缺少提交凭据');
  return result(committed,'已终止剩余目标；此前已提交的世界行动保持有效。','cancelled',target.plan.plan_id,[body.request_id]);
 }
 // Claim this explicit resume using the existing transaction receipt before
 // running any stage. Replayed HTTP/System requests (including after Undo or a
 // crash between claim and execution) may query progress, never execute again.
 const resumeOperation={resume_goal:target.plan.plan_id};
 const priorResume=save.runtime.receipts.find(receipt=>receipt.id===body.request_id);
 if(priorResume){
  const fingerprint=createHash('sha256').update(JSON.stringify({agent_operation:resumeOperation})).digest('hex');
  assert(priorResume.fingerprint===fingerprint,'请求 ID 已用于另一操作');
  return result(save,'原恢复请求已有提交记录；没有重复执行。请查询目标当前进度，确认后可用新请求继续。',
    'blocked',target.plan.plan_id,[body.request_id]);
 }
 if(save.active_goal?.plan.plan_id!==target.plan.plan_id)await service.agentTransaction(body,resumeOperation,next=>{
  const prior=next.paused_goals?.find(item=>item.plan.plan_id===target.plan.plan_id);
  assert(prior,'目标状态已更新');
  next.paused_goals=next.paused_goals!.filter(item=>item.plan.plan_id!==prior.plan.plan_id);
  if(next.active_goal&&!['completed','failed'].includes(next.active_goal.plan.status))next.paused_goals.push(next.active_goal);
  next.active_goal=prior;
 });
 const current=await service.current(),continued=await continueActiveGoal(service,current,current.active_goal!.plan,
   {},false,body.request_id,body.original_input??body.input);
 const after=await service.current(),priorReceipts=new Set(save.runtime.receipts.map(receipt=>receipt.id));
 return {...continued,goal_control:{...control,goal_id:target.plan.plan_id,status:continued.outcome.type==='engine_failure'||continued.plan?.status==='blocked'?'blocked':'resumed',
   revision:continued.view!.revision,receipt_ids:[...new Set([...continued.outcome.receipt_ids,
     ...after.runtime.receipts.filter(receipt=>!priorReceipts.has(receipt.id)).map(receipt=>receipt.id)])]}};
}
/** Structured choices bypass a second free-text plan while retaining the normal candidate/runtime path. */
export async function handleChoiceInput(service:GameService,body:PlanRequest,offerId:string|null,legacy=false):Promise<AgentResult>{
 const save=await service.current();
 if(save.active_goal?.plan.plan_id===body.request_id&&save.active_goal.plan.contract?.original_intent===body.input)
  return activeGoalResult(service,save,contractFinalMessage(save.active_goal.plan,
    '原选项目标已记录；这是当前真实进度。',save.active_goal.waiting_question,save.active_goal.options));
 assert(save.game_id===body.game_id&&save.state_revision===body.expected_revision,'状态已更新，请刷新后重试');
 if(offerId){
  const offer=save.last_turn?.choice_offers?.find(item=>item.id===offerId);
  if(!offer)throw new GameError('这个选项已失效，请查看当前场景的新选项。',409);
  const presented=service.project(save).last_turn?.choice_offers?.find(item=>item.id===offerId)?.text;
  if(offer.text!==body.input&&presented!==body.input)
   throw new GameError('选项文字与原始选项不一致，请刷新后重试。',409);
  // The offer was already admitted by local checks or compiled at generation time.
  // Rebind it against the latest public scene without a second semantic decision.
  const plan=checkChoiceOffer(save,offer);
  currentTrace()?.info('agent.goal_compiled',{metadata:{source:'choice',offer_id:offer.id,
    goal_kinds:plan.goals.map(goal=>goal.contract?.completion.kind??'unsupported'),
    availability:plan.contract?.execution_availability??null}});
  return executePlan(service,{...body,input:offer.text,choice_offer_id:offer.id},plan);
 }
 if(!legacy||!save.last_turn?.choices.includes(body.input)||save.last_turn.choice_offers?.some(item=>item.text===body.input))
  throw new GameError('旧选项已失效，请查看当前场景。',409);
 if(classifyChoiceExecution(save,body.input)==='NOT_EXECUTABLE')
  throw new GameError('旧选项目前不可执行，世界状态没有改变。',409);
 return handleAgentInput(service,body);
}
/** Conditional trade retains the existing branch evaluator. Only the intentionally
 * deferred post-arrival purchase binding may bypass the up-front admission veto. */
function conditionalTradeContract(plan:AgentPlan){
 if(!plan.contract||plan.local_compound||!plan.goals.some(goal=>goal.type==='CONDITIONAL_INTENT')||
   plan.goals.some(goal=>goal.temporal_scope.scope!=='now'||goal.type!=='CONDITIONAL_INTENT'&&
    (goal.type!=='WORLD_ACTION'||!['location_at','purchase'].includes(goal.contract?.completion.kind??'')||
     ['needs_binding','capability_gap'].includes(goal.contract?.availability??'runtime_gap'))))return false;
 const ancestors=(goal:AtomicGoal,seen=new Set<string>()):AtomicGoal[]=>goal.depends_on.flatMap(id=>{
  if(seen.has(id))return [];seen.add(id);const parent=plan.goals.find(item=>item.goal_id===id);
  return parent?[parent,...ancestors(parent,seen)]:[];
 });
 const purchases=plan.goals.filter(goal=>goal.contract?.completion.kind==='purchase');
 return purchases.length>0&&purchases.every(goal=>ancestors(goal).some(parent=>
  parent.contract?.completion.kind==='location_at'&&parent.contract.availability==='ready'));
}

export async function executePlan(service:GameService,body:PlanRequest,plan:AgentPlan,startRoutine?:(body:any)=>Promise<any>,repetition?:import('../system/goals.js').GoalSpec['repetition'],repeatedPerception=false,physicalIntent?:import('../system/goals.js').GoalSpec['physical_intent'],semanticAction?:import('../system/goals.js').GoalSpec['play_action']):Promise<AgentResult>{
 assertConditionalOwnership(plan.goals);
 let save=await service.current();
 if(save.game_id!==body.game_id||save.state_revision!==body.expected_revision){
  // Nothing was applied yet, so a plan that only reads may be replayed once by the client. A plan that could
  // write stays manual. The classification travels with the error instead of being re-guessed from the text.
  const conflict=new GameError('状态已更新，请重新规划',409) as GameError&{retry_policy?:'safe'|'manual'};
  conflict.retry_policy=readOnlyPlan(plan.goals)?'safe':'manual';throw conflict;
 }
 if(canExecuteContractPlan(plan)){
  plan.plan_id=body.request_id;
  const active=Boolean(save.active_goal&&!['completed','failed'].includes(save.active_goal.plan.status)&&
    save.active_goal.plan.plan_id!==body.request_id);
  if(active&&plan.goals.length!==1){
    if((save.paused_goals??[]).length>=5)return activeGoalResult(service,save,
      '已有五个暂停目标；请先恢复或取消一个目标，新的连续行动尚未执行。');
    await service.agentTransaction({...body,request_id:childId(body.request_id,'pause-previous')},
      {pause_active_goal:save.active_goal!.plan.plan_id},next=>{
        next.paused_goals=[...(next.paused_goals??[]),structuredClone(next.active_goal!)];
        delete next.active_goal;
      });
    save=await service.current();
    if(plan.contract){plan.contract.source_revision=save.state_revision;plan.contract.last_observed_revision=save.state_revision;}
  }
  const candidates=plan.goals.length===1?discoverContractCandidates(save,service.project(save),plan.goals[0],
    plan.contract?.original_intent??null):[];
  const needsSelection=plan.goals.length===1&&plan.goals[0].contract?.completion.kind==='purchase'&&
    (candidates.length!==1||Boolean(candidates[0]?.requires_binding));
  // A fully bound single action needs one world commit, not an extra goal-progress write.
  // Only a genuine player choice needs a persisted single-step goal.
  if(plan.goals.length===1&&(active||!needsSelection)){
   const start=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
   const outcome=await runContractPlan(service,save,plan,{},false,Boolean(body.end_conversation));
   const end=outcome.save.runtime.time.day*outcome.save.definition.ruleset.minutes_per_day+outcome.save.runtime.time.minute;
   const story=committedSince(save,outcome.save).length?outcome.save.last_turn?.narrative?.trim():null;
   const shown=outcome.outcome.type==='engine_failure'?engineMessage(outcome.outcome):story??
     (outcome.plan.status==='waiting_for_player'?contractFinalMessage(outcome.plan,outcome.reason,
       outcome.save.active_goal?.waiting_question??outcome.reason,outcome.save.active_goal?.options??[]):
     gameNarrative(outcome.outcome,{completed:outcome.plan.goals.filter(goal=>goal.status==='completed').map(goal=>goal.result?.summary??goal.normalized_goal)}));
   return agentResult(plan.goals[0].type,shown,{outcome:outcome.outcome,
     ...(outcome.outcome.type==='engine_failure'?{recovery:recoveryContext(body.original_input??body.input,outcome.outcome,{goal_ids:plan.goals.map(goal=>goal.goal_id)})}:{}),
     presentation:outcome.outcome.type==='engine_failure'?'failure':
     outcome.plan.status==='waiting_for_player'?'handoff':story?'story':'assistant',plan_id:plan.plan_id,plan:outcome.plan,
     results:outcome.plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??'',
       related_entity:goal.target_entities[0]??null,status:goal.status})),time_advanced:end-start,
     ...(story?{story}:{}),view:service.project(outcome.save)});
  }
  return continueActiveGoal(service,save,plan,{},Boolean(body.end_conversation),undefined,body.original_input??body.input);
 }
 const conditionalTrade=conditionalTradeContract(plan);
 const unavailable=plan.goals.find(goal=>goal.side_effect_level==='world'&&goal.operation_hint&&goal.operation_hint!=='other'&&
   ['capability_gap','needs_binding','runtime_gap'].includes(goal.contract?.availability??'runtime_gap')&&
   !(conditionalTrade&&goal.contract?.completion.kind==='purchase'&&goal.contract.availability==='runtime_gap'));
 if(unavailable){
  const reason=unavailable.contract?.availability==='capability_gap'?'当前世界没有注册完成这项行动所需的能力。':
    unavailable.contract?.availability==='needs_binding'?'目标对象尚未唯一确认，世界状态没有改变。':
    '这项行动尚无可验证的执行或完成证据，世界状态没有改变。';
  plan.status='blocked';unavailable.status='blocked';unavailable.result={summary:reason};
  return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',
    `未能开始“${unavailable.normalized_goal}”：${reason}后续行动尚未执行。`,{presentation:'story',
    outcome:gameOutcome('unavailable','plan_admission',save.state_revision),
    plan_id:body.request_id,plan,view:service.project(save)});
 }
 if(plan.contract?.execution_mode==='staged'&&plan.contract.execution_availability!=='ready'&&
   plan.goals.length===1&&(hasMultipleClauses(plan.contract.original_intent)||plan.contract.unresolved_compound)){
  plan.status='blocked';
  return agentResult('MULTI_GOAL','完整连续目标尚未得到可验证的步骤契约，世界状态没有改变。',{
    plan_id:body.request_id,plan,view:service.project(save)});
 }
 const initialTime=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
 const initialSave=save;let stateReadable=true;
 plan.plan_id=body.request_id;plan.status='running';let clarification:string|null=null,awarenessStatus:AgentResult['awareness_status'];let stepOutcome:AgentResult['outcome']|null=null;const ui:UIAction[]=[],changes:string[]=[],calls:AgentResult['tool_calls']=[],futures:FutureIntent[]=[];
 for(const id of plan.execution_order){const goal=plan.goals.find(g=>g.goal_id===id)!;
  const compoundWorldGoals=plan.goals.filter(goal=>goal.side_effect_level==='world');
  if(plan.contract?.execution_mode==='staged'&&
     (compoundWorldGoals.length>1||plan.goals.some(goal=>goal.operation_hint&&['move','purchase','presence_query'].includes(goal.operation_hint)))&&
     !plan.goals.some(goal=>goal.condition||goal.branch||goal.temporal_scope.scope!=='now')&&
     plan.contract.execution_availability!=='ready'){
    const blocked=plan.goals.find(goal=>goal.contract?.availability!=='ready');
    if(blocked)blocked.status='blocked';
    plan.status='blocked';
    const reason=blocked?.contract?.availability==='capability_gap'?'所需世界能力未启用':
      blocked?.contract?.availability==='needs_binding'?'目标对象未能唯一确认':
      '缺少可验证的执行或完成方式';
    return agentResult('MULTI_GOAL',`计划中的“${blocked?.normalized_goal??plan.contract.original_intent}”目前${reason}，因此没有执行准备步骤；世界状态没有改变。`,{
      plan_id:plan.plan_id,plan,results:plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.status==='blocked'?`当前步骤${reason}。`:'尚未执行。',related_entity:null,status:goal.status})),
      view:publicView(save)});
  }
  const dependencies=goal.depends_on.map(id=>plan.goals.find(g=>g.goal_id===id)!);
  if(dependencies.some(g=>g.status!=='completed')){goal.status='skipped';goal.result={summary:'前置目标未成功，未执行。'};continue;}
  if(goal.branch){const parent=dependencies.find(g=>g.type==='CONDITIONAL_INTENT');if(!parent||parent.result?.condition===null||parent.result?.condition===undefined){goal.status='unresolved';goal.result={summary:'条件未知，未执行任何分支。'};continue;}if(parent.result.condition!==(goal.branch==='then')){goal.status='skipped';goal.result={summary:'条件不匹配，跳过此分支。'};continue;}}
  goal.status='ready';goal.status='running';
  let stepStage='plan_step';
  try {
   if(changes.length&&goal.side_effect_level==='world'){
    stepStage='plan_handoff';
    if(await service.handoffBlocker()){
     clarification='眼前出现需要你决定的情况，后续行动已暂停。';goal.status='unresolved';goal.result={summary:clarification};break;
    }
    stepStage='plan_step';
   }
   const view=publicView(save);let message='';
   if(plan.local_compound){
    assert(id===plan.execution_order[0]&&plan.goals.every(item=>item.type==='WORLD_ACTION'),
      '局部复合行动必须由同一次输入中的当前世界行动组成');
    const result=await service.turn({game_id:body.game_id,expected_revision:body.expected_revision,request_id:childId(body.request_id,'local_compound'),input:body.input},
      undefined,undefined,undefined,false,undefined,plan.local_compound.steps);
    save=await service.current();message=result.last_turn?.narrative??'行动已处理。';
    for(const item of plan.goals){item.status='completed';item.result={summary:message};calls.push({tool_id:item.type,ok:true});}
    changes.push('world_action:local_compound');
    break;
   }
   if(goal.type==='CONDITIONAL_INTENT'){
    const c=goal.condition!,target=view.entities.find(e=>e.id===c.entity_id);
    const observation=c.kind==='observed_event'&&dependencies.some(dependency=>dependency.side_effect_level==='world'&&dependency.status==='completed')
      ?await service.ai.systemAgent(observedConditionSchema,save.definition.prompt_profile,{instruction:'只依据刚提交的玩家可见场景描写，判定玩家事先声明的可观察事件是否明确发生。发生为 true，明确没有发生为 false；正文没有足够证据为 null。不得推断隐藏想法，不执行行动，不改状态。',condition:c.description,recent_observation:view.last_turn?.narrative??'',target:target?{id:target.id,name:target.components.identity?.name??null}:null},save):null;
    const publicFact=c.kind==='public_fact'?await service.ai.systemAgent(observedConditionSchema,save.definition.prompt_profile,{instruction:'只依据当前玩家可见的 canonical 状态与已提交的场景事实判断条件。明确成立为 true，明确不成立为 false，缺少事实为 null。不得访问隐藏真相、猜测或修改状态。',condition:c.description,public_state:view,recent_facts:(save.action_facts??[]).slice(-3).map(entry=>entry.facts)},save):null;
    const value=c.kind==='observed_event'?observation?.value??null:c.kind==='public_fact'?publicFact?.value??null:!target?null:c.kind==='familiar'?relationshipCondition(view,target):c.kind==='present'?(target.components.location&&view.entities.find(e=>e.id===view.player_id)?.components.location?target.components.location.location_id===view.entities.find(e=>e.id===view.player_id)!.components.location.location_id:null):null;
    goal.result={condition:value,summary:value===null?'目前无法确定你等待的条件；后续行动暂未执行。':value?'你等待的条件已经出现。':'你等待的条件目前没有出现。'};
   }else if(goal.type==='WORLD_GOAL'){
    const outcome=await executeOpenWorldGoal(service,save,goal.normalized_goal,childId(body.request_id,id));
    if(!outcome.ok){clarification=outcome.clarification??clarification;throw Error(outcome.message);}
    save=await service.current();message=outcome.message;changes.push('world_goal:'+id);
   }else if(['WORLD_QUERY','WORLD_LOOKUP','UI_NAVIGATION'].includes(goal.type)){
    const result=planGameRequest(view,goal.normalized_goal);
    const derived=['WORLD_QUERY','WORLD_LOOKUP'].includes(goal.type)&&(!result||result.query_pending||result.clarification==='unspecified_subject'||/(确认|判断).{0,40}(是否|是不是|有没有|吗)/.test(goal.normalized_goal));
    if(derived){const answer=await agentSkills(save).invoke<{view:typeof view;question:string},TruthQueryResult>(
      'public_world_query',{view,question:goal.normalized_goal},{service,save,request_id:body.request_id,goal_id:id});
      message=answer.message;awarenessStatus=answer.status;}
    else{if(result?.clarification)clarification=result.clarification;if(!result||result.clarification)throw Error(result?.message??'无法确认查询目标');message=result.message;ui.push(...result.ui_actions);awarenessStatus=result.awareness_status??awarenessStatus;}
   }else if(['FUTURE_INTENT','SCHEDULED_INTENT'].includes(goal.type)){
    assert(goal.target_entities.every(id=>view.entities.some(e=>e.id===id)),'目标不在玩家可知范围');
    const condition=dependencies.find(g=>g.type==='CONDITIONAL_INTENT')?.condition??null;
    const guards=futureConditionGuards(plan,goal);
    const intent:FutureIntent={id:childId(body.request_id,id),plan_id:plan.plan_id,goal_id:id,created_at:{...view.time},source_text:body.input,target_date:goal.temporal_scope.day_offset>0?view.time.day+goal.temporal_scope.day_offset:goal.temporal_scope.scope==='scheduled'?view.time.day:null,time_window:goal.temporal_scope.window,target_entities:goal.target_entities,goal:goal.normalized_goal,condition,condition_expected:goal.branch!=='else',...(guards.length?{condition_guards:guards}:{}),status:'planned',completed_by_request:null};
    await service.agentTransaction({...body,request_id:childId(body.request_id,'write:'+id),expected_revision:save.state_revision},{input:body.input,goal},next=>{next.future_intents??=[];assert(next.future_intents.length<500,'未来计划数量已达上限');next.future_intents.push(intent);});
    save=await service.current();futures.push(intent);changes.push('future_intent:'+intent.id);message='已记下你的打算：'+intent.goal+'。这不是已经发生的事实，也未获得对方同意。';
   }else if(goal.type==='LIST_FUTURE'){
    const entries=save.future_intents??[];futures.push(...entries);message=entries.length?entries.map(i=>i.status==='due'?dueAssessment(view,i):i.goal+'（'+i.status+'）').join('\n'):'目前没有登记的未来打算。';
   }else if(goal.type==='CANCEL_FUTURE'){
    const matches=(save.future_intents??[]).filter(i=>['planned','due'].includes(i.status)&&(!goal.target_entities.length||goal.target_entities.every(id=>i.target_entities.includes(id)))&&(!goal.temporal_scope.day_offset||i.target_date===view.time.day+goal.temporal_scope.day_offset)&&
     (goal.temporal_scope.window==='any'||i.time_window===goal.temporal_scope.window));
    assert(matches.length===1,matches.length?'有多个打算符合，请补充目标、日期或具体活动。':'没有找到对应的未完成打算。');
    await service.agentTransaction({...body,request_id:childId(body.request_id,'cancel:'+id),expected_revision:save.state_revision},{cancel:matches[0].id},next=>{next.future_intents!.find(i=>i.id===matches[0].id)!.status='cancelled';});save=await service.current();changes.push('cancel_future:'+matches[0].id);message='已取消：'+matches[0].goal;
   }else if(goal.type==='EXECUTE_FUTURE'){
    const candidates=(save.future_intents??[]).filter(i=>i.status==='due'&&(!goal.target_entities.length||goal.target_entities.every(id=>i.target_entities.includes(id)))&&
      (!goal.temporal_scope.day_offset||i.target_date===view.time.day+goal.temporal_scope.day_offset)&&
      (goal.temporal_scope.window==='any'||i.time_window===goal.temporal_scope.window));
    assert(candidates.length===1,'请明确一个已到期的打算；未到期计划不会提前执行');const intent=candidates[0];
    assert(!await service.handoffBlocker(),'当前前台事务或事件需要先处理');
    const player=view.entities.find(e=>e.id===view.player_id)!;assert(Number(player.components.condition?.hp??100)>0,'玩家当前状态不适合执行');
    assert(intent.target_entities.length===1,'此版本只执行目标明确的单人物社交尝试');
    const target=view.entities.find(e=>e.id===intent.target_entities[0]);assert(target&&target.components.location&&player.components.location&&target.components.location.location_id===player.components.location.location_id,'目标当前不在可确认的同一地点，请先处理位置或可用性');
    assert(futureConditionsHold(view,intent),'当前已知条件不再满足，计划保留但未执行');
    const action=await service.ai.interpret(save,intent.goal) as import('../shared/contracts.js').ActionInput;
    assert(['TALK','SOCIAL_INTERACT'].includes(action.type)&&action.target_id===target.id,'实际行动尚不能确认为对该人物的社交尝试，计划保留');
    const attempt=childId(body.request_id,'attempt:'+id);
    await service.turn({game_id:body.game_id,expected_revision:save.state_revision,request_id:attempt,action},undefined,undefined,undefined,false,intent.id);save=await service.current();
    assert(save.runtime.receipts.some(r=>r.id===attempt),'行动尚未提交');
    save=await service.current();changes.push('future_attempt:'+intent.id);message='已完成这项打算的实际社交尝试；对方的回应以当前回合为准，不代表约会或共同活动成功。';
   }else if(goal.type==='CONTINUE_ROUTINE'){
    assert(startRoutine,'此执行入口未配置后台生活任务');assert(!plan.execution_order.slice(plan.execution_order.indexOf(id)+1).some(other=>plan.goals.find(g=>g.goal_id===other)!.side_effect_level!=='none'),'后台生活任务之后不能继续执行写入目标');
    const job=await startRoutine({...body,request_id:childId(body.request_id,id),expected_revision:save.state_revision,action:{type:'CONTINUE_ROUTINE',parameters:{}}});message='已提交后台生活请求；任务状态：'+job.status;
   }else if(conditionalTrade&&goal.type==='WORLD_ACTION'){
    assert(!goal.branch||!await service.handoffBlocker(),'当前前台事项尚未处理，条件行动不能抢占');
    // Rebind against the actual arrived scene, preserving the original source's
    // quantity/intent authority. Conditions and dependencies were checked above.
    const rebound=compileGoalContract(view,plan,{kind:'manual',text:plan.contract!.original_intent});
    const currentGoal=rebound.goals.find(item=>item.goal_id===id)!;
    stepStage='contract_step';
    const result=await executeContractStep(service,save,currentGoal,childId(body.request_id,id),
      undefined,undefined,plan.contract!.original_intent,false,plan.plan_id);
    save=result.candidate;goal.contract=currentGoal.contract;goal.target_entities=currentGoal.target_entities;
    if(result.status!=='completed'){
     goal.status=result.status==='waiting_for_player'?'unresolved':'blocked';goal.result={summary:result.reason};
     stepOutcome=result.outcome??gameOutcome('unavailable','contract_step',save.state_revision,changes);
     calls.push({tool_id:goal.type,ok:false});break;
    }
    message=save.narrative_history?.find(entry=>entry.request_id===result.evidence_request_id)?.narrative??result.reason;
    changes.push('world_action:'+id);
   }else {
    assert(!goal.branch||!await service.handoffBlocker(),'当前前台事项尚未处理，条件行动不能抢占');
    const choiceSpeech=Boolean(body.choice_offer_id&&goal.type==='WORLD_SPEECH');
    const result=await service.turn({game_id:body.game_id,request_id:childId(body.request_id,id),expected_revision:save.state_revision,
      ...(body.end_conversation&&goal.type==='WORLD_SPEECH'?{end_conversation:true}:{}),
      ...(choiceSpeech?{action:{type:'TALK',target_id:goal.target_entities[0],parameters:{topic:goal.normalized_goal}}}:{input:goal.normalized_goal})},
      undefined,undefined,undefined,false,undefined,undefined,Boolean(semanticAction||repetition||body.choice_offer_id&&goal.type==='WORLD_ACTION'),undefined,repeatedPerception,repetition,{target_ids:goal.target_entities,physical_intent:physicalIntent});
    save=await service.current();message=result.last_turn?.narrative??'行动已处理。';changes.push('world_action:'+id);
    const sequence=save.resolution_receipts?.find(receipt=>receipt.request_id===childId(body.request_id,id))?.repetition;
    if(sequence&&['budget','interrupted'].includes(sequence.stopped_by)&&sequence.elapsed_seconds<sequence.requested_seconds){
      goal.status='unresolved';goal.result={summary:message};calls.push({tool_id:goal.type,ok:true});
      stepOutcome=gameOutcome('partial_progress','plan_step',save.state_revision,changes);break;
    }
   }
   goal.result??={summary:message};goal.status='completed';calls.push({tool_id:goal.type,ok:true});
  }catch(error){const detail=(error as Error).message;service.logger.warn('agent.goal.failed',{module:'agent',metadata:{detail,goal:goal.goal_id,reason:failureReason(error)}});
   if(error instanceof WorldBlockedError){goal.status='blocked';goal.result={summary:error.message};stepOutcome=gameOutcome('blocked_by_world','plan_step',save.state_revision,changes);
     calls.push({tool_id:goal.type,ok:false});break;}
   let refreshed:SavePackage|undefined;
   try{refreshed=await service.current();}catch{
    stateReadable=false;service.logger.warn('agent.plan.refresh_unavailable',{module:'agent',metadata:{stage:stepStage}});
   }
   stepOutcome=refreshed?executionFailure(error,stepStage,refreshed,save):engineOutcome(
    failureReason(error)!=='unknown'?'provider_failure':'transaction_failure',stepStage,
    save.state_revision,false,changes,committedSince(initialSave,save));
   if(refreshed)save=refreshed;
   goal.status='failed';goal.result={summary:!stateReadable?
    '当前世界状态暂时无法读取，不能确认这一步的提交情况；请先恢复状态读取。':
    stepOutcome.type==='engine_failure'&&!stepOutcome.state_certain?
    '世界状态已更新，但这一步的后续处理未能可靠完成；请先核对当前状态与已提交记录，再决定下一步。':failureReason(error)!=='unknown'?
    '这次行动的模型响应未完整生成，当前目标尚未完成。请稍后从当前状态重试。':
    /未注册|parameters|schema|Invalid|FREEFORM_ACTION|relationship_delta|ConditionNode|条件必须由独立条件节点|框架校验|状态校验|canonical delta|contract/i.test(detail)?
      '这次行动没有正常完成，世界状态没有改变，可以安全重试。':displayText(detail,publicView(save).entities,publicView(save).locations)};calls.push({tool_id:goal.type,ok:false});if(!stateReadable||goal.side_effect_level==='world'||clarification||plan.local_compound)break;}
 }
 for(const goal of plan.goals)if(goal.status==='pending')goal.status='skipped';
 try{save=await service.current();stateReadable=true;}catch{
  stateReadable=false;service.logger.warn('agent.plan.refresh_unavailable',{module:'agent',metadata:{stage:'plan_finalize'}});
  stepOutcome=stepOutcome?.type==='engine_failure'?{...stepOutcome,state_certain:false}:engineOutcome(
   'transaction_failure','plan_finalize',save.state_revision,false,changes,committedSince(initialSave,save));
 }
 const delta=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute-initialTime;
 plan.status=plan.goals.some(g=>g.status==='failed'||g.status==='unresolved'||g.status==='blocked')?(plan.local_compound?'blocked':'partial'):'completed';
 const results=plan.goals.map(g=>({goal_id:g.goal_id,summary:g.result?.summary??'',related_entity:g.target_entities[0]??null,status:g.status}));
 const summaries=[...new Set(results.filter(r=>r.status!=='skipped').map(r=>r.summary).filter(Boolean))];
 const message=summaries.join('\n')+(delta===0&&!readOnlyPlan(plan.goals)?'\n当前世界时间没有推进。':'');
 const storyOnly=plan.status==='completed'&&plan.goals.every(g=>['WORLD_ACTION','WORLD_SPEECH'].includes(g.type));
 const incremental=summaries.filter(summary=>summary!==save.last_turn?.narrative&&
   !plan.goals.some(goal=>goal.result?.summary===summary&&goal.status==='completed'&&['WORLD_ACTION','WORLD_SPEECH'].includes(goal.type))).join('\n');
 const assistantMessage=incremental+(delta===0&&!readOnlyPlan(plan.goals)?'\n当前世界时间没有推进。':'');
 const conditionFalse=plan.goals.some(goal=>goal.type==='CONDITIONAL_INTENT'&&goal.result?.condition===false);
 const finalOutcome=stepOutcome?.type==='engine_failure'?engineOutcome(stepOutcome.code,stepOutcome.stage,
   save.state_revision,stepOutcome.state_certain,[...new Set([...stepOutcome.committed_steps,...changes])],
   [...new Set([...stepOutcome.receipt_ids,...committedSince(initialSave,save)])]):gameOutcome(
   conditionFalse?'condition_false':stepOutcome?.type==='game'?stepOutcome.kind:
     plan.status==='completed'?'completed':changes.length?'partial_progress':'unresolved_goal',
   'plan_execution',save.state_revision,changes,committedSince(initialSave,save),
   plan.status==='completed'?'completed':changes.length?'partial':'unresolved');
 const narratedSteps=plan.goals.filter(goal=>goal.status==='completed'&&
   ['WORLD_ACTION','WORLD_SPEECH'].includes(goal.type)).map(goal=>goal.result?.summary?.trim()).filter((text):text is string=>Boolean(text));
 const committedNarrative=committedSince(initialSave,save).length?
   [...new Set(narratedSteps.length?narratedSteps:[save.last_turn?.narrative?.trim()].filter((text):text is string=>Boolean(text)))].join('\n'):'';
 const stopped=plan.goals.filter(goal=>['blocked','unresolved','failed','waiting_for_player'].includes(goal.status))
   .map(goal=>`“${goal.normalized_goal}”尚未完成${goal.result?.summary?`：${goal.result.summary}`:'。'}`);
 const skipped=plan.goals.filter(goal=>goal.status==='skipped').map(goal=>goal.normalized_goal);
 const partialFeedback=[...stopped,skipped.length?`尚未执行：${skipped.join('；')}。`:null].filter(Boolean).join('\n');
 const finalMessage=finalOutcome.type==='engine_failure'?engineMessage(finalOutcome):
   committedNarrative&&plan.status==='completed'?committedNarrative:
   applyAssistantStyle(save,committedNarrative&&partialFeedback?partialFeedback:
     assistantMessage||gameNarrative(finalOutcome,{completed:changes}));
 return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',finalMessage,{outcome:finalOutcome,
   ...(finalOutcome.type==='engine_failure'?{recovery:recoveryContext(body.original_input??body.input,finalOutcome,{goal_ids:plan.goals.map(goal=>goal.goal_id),failed_goals:plan.goals.filter(goal=>goal.status==='failed').map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??''}))})}:{}),
   presentation:finalOutcome.type==='engine_failure'?'failure':committedNarrative?'story':'assistant',clarification,
   ...(committedNarrative?{story:committedNarrative}:{}),
   ...(awarenessStatus?{awareness_status:awarenessStatus}:{}),plan_id:plan.plan_id,plan,results,future_intents:futures,
   ui_actions:storyOnly?[]:oneNavigation(ui),canonical_changes:changes,tool_calls:calls,time_advanced:delta,
   ...(stateReadable?{view:publicView(save)}:{})});
}
const requests=new WeakMap<GameService,Map<string,{input:string;result:Promise<AgentResult>}>>();
export async function handleAgentInput(service:GameService,body:PlanRequest,startRoutine?:(body:any)=>Promise<any>,
 speechTargetId:string|null=null,confirmedSpeech=false,semantic?:SemanticDecision,deferSceneEffects=false,
 sceneCommit?:(before:SavePackage,next:SavePackage)=>void):Promise<AgentResult>{
 const cache=requests.get(service)??new Map();requests.set(service,cache);const key=body.game_id+':'+body.request_id,old=cache.get(key);
 if(old){assert(old.input===body.input,'请求 ID 已用于不同输入');return structuredClone(await old.result);}
  const promise=withRequestBudget(async()=>{const view=await service.view();assert(view&&view.game_id===body.game_id,'游戏已切换');const save=await service.current();
    if(save.active_goal?.plan.plan_id===body.request_id&&save.active_goal.plan.contract?.original_intent===body.input)
      return activeGoalResult(service,save,contractFinalMessage(save.active_goal.plan,
        '原请求已记录；这是当前真实进度。',save.active_goal.waiting_question,save.active_goal.options));
    if(save.state_revision!==body.expected_revision){const quick=fastPlan(view,body.input),conflict=new GameError('状态已更新，请重新规划',409) as GameError&{retry_policy?:'safe'|'manual'};conflict.retry_policy=quick&&readOnlyPlan(quick.goals)?'safe':'manual';throw conflict;}
    const control=goalControl(body.input);
    if(control)return handleGoalControl(service,save,body,control);
    const active=save.active_goal;
    if(active&&!['completed','failed'].includes(active.plan.status)){
      const selection=pendingChoice(save,body.input);
      if(selection){
        const goal=active.plan.goals.find(entry=>entry.status==='waiting_for_player');
        if(goal)return continueActiveGoal(service,save,active.plan,{[goal.goal_id]:{candidate_id:selection.candidate_id,source:'player'}},false,undefined,body.original_input??body.input);
      }
    }
    // An explicit wait is one foreground action. World simulation may tick internally;
    // neither the open-goal step budget nor an older unresolved goal owns this request.
    const temporalWait=semantic?.kind==='world_action'||!semantic
      ?resolveTemporalWait(body.input,save.runtime.time,save.definition.ruleset.minutes_per_day,
        semantic?.temporal_wait):null;
    currentTrace()?.info('agent.temporal_wait.admission',{module:'agent',metadata:{
      semantic_kind:semantic?.kind??null,interaction_lane:semantic?.interaction_lane??null,
      source:temporalWait?.source??null,target:temporalWait?.target??null,
      minutes:temporalWait?.minutes??null}});
    if(temporalWait){
      return agentSkills(save).invoke<{game_id:string;expected_revision:number;wait:typeof temporalWait},AgentResult>('temporal_wait',
        {game_id:body.game_id,expected_revision:body.expected_revision,wait:temporalWait},
        {service,save,request_id:body.request_id});
    }
    if(semantic?.temporal_wait?.standalone)return agentResult('CLARIFICATION',
      '你指定了等待目标，但目标时间未能可靠确定；请说明要等到的时刻，世界没有改变。',
      {outcome:gameOutcome('unresolved_goal','temporal_wait_admission',save.state_revision,[],[],'unresolved'),
        presentation:'assistant',view});
    // A single authorized perception goal needs a canonical check even when a prior
    // conversation is active. The GoalSpec, not sentence wording or the scene lane,
    // owns this handoff; the existing Freeform transaction settles time and evidence.
    if(semantic?.kind==='world_action'&&semantic.goal_spec?.play_action==='perceive'&&!semantic.goal_spec.repetition&&
      !semantic.goal_spec.multi_step&&!semantic.goal_spec.dependencies.length&&
      !hasMultipleClauses(body.input)){
      const result=await service.turn({game_id:body.game_id,expected_revision:body.expected_revision,
        request_id:body.request_id,input:body.input},undefined,undefined,undefined,false,
        undefined,undefined,true,undefined,true);
      const after=await service.current();
      const committed=committedSince(save,after);
      const narrative=result.last_turn?.narrative??'';
      return agentResult('WORLD_ACTION',narrative,{presentation:'story',story:narrative,
        outcome:gameOutcome('completed','perception',after.state_revision,['perception_check'],committed,'completed'),
        time_advanced:after.runtime.time.day*after.definition.ruleset.minutes_per_day+after.runtime.time.minute-
          (save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute),
        view:service.project(after)});
    }
    // A route is a strategy, not authorization. If the semantic lane chose an open goal
    // for one already bound atomic action, hand that exact original action to its
    // receipt-checked runner before asking the open-goal planner for another step.
    if(semantic?.kind==='world_action'&&semantic.interaction_lane==='open_goal'&&
      !semantic.open_goal_context?.destination&&!semantic.open_goal_context?.search_query&&
      semantic.open_goal_context?.continuation!=='natural_interaction_if_available'&&
      !hasUserCondition(body.input)&&!hasMultipleClauses(body.input)){
      const direct=fastPlan(view,body.input);
      if(direct?.goals.length===1&&direct.goals[0].type==='WORLD_ACTION'){
        const contract=compileGoalContract(view,direct,{kind:'manual',text:body.input,semanticGoal:semantic?.goal_spec});
        if(canExecuteContractPlan(contract)){
          const alignment=await verifyGoalAlignment(service,body.input,contract);
          if(alignment?.verdict==='aligned'){
            currentTrace()?.info('agent.route_handoff',{metadata:{from:'open_goal',to:'contract_step',
              completion:contract.goals[0].contract?.completion.kind,revision:save.state_revision}});
            return executePlan(service,body,contract,startRoutine);
          }
          currentTrace()?.warn('agent.route_handoff.rejected',{metadata:{from:'open_goal',
            verdict:alignment?.verdict??'unavailable',revision:save.state_revision}});
        }
      }
    }
    // Ordinary conversation and immediate observation run as one scene beat: no Action Type, no TALK
    // transaction per sentence, no time cost. Only the effects the program can settle are committed.
    // DISABLED this round: the gate below still intercepted deterministic read-only questions, which must keep
    // costing zero model calls (tests/multi-goal.test.ts). The scene lane ships dormant until its gate is precise
    // enough to leave those queries on the deterministic path.
    // An open goal is never compiled up front: one necessary world transaction at a time, then the model reads
    // the *new* canonical state and decides again — which may be an ordinary scene interaction.
    const discretionaryRoute=semantic?.kind==='world_action'&&
      (semantic.interaction_lane==='world_transaction'||semantic.open_goal_context?.route_choice===true)&&
      !hasMultipleClauses(body.input)&&
      semantic.goal_spec?.play_action==='move'&&!semantic.goal_spec.ambiguity&&
      !semantic.open_goal_context?.destination&&
      !semantic.goal_spec.targets.some(target=>target.kind!=='location'||Boolean(target.entity_id))&&
      !semantic.goal_spec.desired_state.length&&
      !view.locations.some(location=>location.id!==view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id&&
        body.input.includes(location.name));
    // The semantic owner may label a multi-leg journey as a world transaction.
    // Its bound GoalSpec still authorizes the existing open-goal route runner to
    // traverse the registered map; a later planner cannot cancel that journey
    // merely because it lacks a separate tool for describing the destination.
    const travelTargets=semantic?.goal_spec?.targets??[];
    const lastTravelTarget=travelTargets.at(-1);
    const compositeTravel=semantic?.kind==='world_action'&&
      semantic.interaction_lane==='world_transaction'&&semantic.goal_spec?.play_action==='move'&&
      semantic.goal_spec.multi_step&&travelTargets.length>0&&
      travelTargets.every(target=>target.kind==='location'&&Boolean(target.entity_id))&&
      semantic.goal_spec.desired_state.every(change=>change.path==='entity:player.location.location_id')&&
      semantic.goal_spec.desired_outputs.every(output=>output.kind==='state_change')&&
      Boolean(view.locations.find(location=>location.id===lastTravelTarget?.entity_id));
    if(semantic?.interaction_lane==='open_goal'||discretionaryRoute||compositeTravel){
      const baseContext=compositeTravel?{destination:view.locations.find(location=>location.id===lastTravelTarget?.entity_id)!.name,
        continuation:'none' as const,search_query:null,travel_after_discovery:true,route_choice:false}:discretionaryRoute?
        {...semantic?.open_goal_context,destination:null,search_query:null,continuation:'none' as const}:
        semantic?.open_goal_context??null;
      const spatialScope=semantic.open_goal_context?.spatial_scope;
      // An unresolved part of a place is not the place itself. Keep the semantic
      // owner's original scope all the way through discovery and every MOVE.
      const context=spatialScope?{...baseContext,destination:null,
        continuation:baseContext?.continuation??'none',
        search_query:[spatialScope.reference,spatialScope.source_quote,...(semantic.goal_spec?.constraints??[])].join('\n'),
        travel_after_discovery:baseContext?.travel_after_discovery??true}:baseContext;
      const excludedDestinations=new Set(spatialScope?.excluded_destination_ids??[]);
      if(spatialScope&&!body.input.includes(spatialScope.source_quote))return agentResult('CLARIFICATION',
        '尚未确认本次探索的空间范围，没有执行移动。',{presentation:'assistant',view});
      const scopeAllowsMove=(state:ReturnType<GameService['project']>,from:string,to:string)=>
        !excludedDestinations.has(to)&&!(routePath(state.routes,from,to)??[])
          .some(edge=>excludedDestinations.has(edge.to));
      const boundDestination=semantic.goal_spec?.targets.filter(target=>target.kind==='location'&&target.entity_id).at(-1)?.entity_id;
      if(!spatialScope&&context?.destination&&boundDestination&&
        view.locations.find(location=>location.name===context.destination)?.id!==boundDestination)
        return agentResult('CLARIFICATION','计划目的地与已确认目标不一致，没有执行移动。',{presentation:'assistant',view});
      if(compositeTravel)currentTrace()?.info('agent.route_handoff',{metadata:{from:'world_transaction',
        to:'open_goal',reason:'bound_multi_leg_travel',destination_id:lastTravelTarget?.entity_id,
        revision:save.state_revision}});
      if(discretionaryRoute)currentTrace()?.info('agent.low_stakes_route',{metadata:{
        source:'validated_goal_spec',revision:save.state_revision,
        reachable_routes:view.routes.filter(route=>route.from===view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id).length}});
      const trail:string[]=[];const executedMarkers=new Set<string>(),searchedLocations=new Set<string>();
      const arrivalResidentIds=new Set<string>();
      const storyLines:string[]=[];let lastMessage='',searched=false,routeStillIntermediate=false;
      const eventSequence=context?.event_sequence??null;
      if(!eventSequence?.length&&context?.destination&&semantic?.player_speech_mode==='verbatim'){
        const outcome=gameOutcome('unresolved_goal','open_goal_event_order',save.state_revision,[],[],'unresolved');
        return agentResult('CLARIFICATION','这句话包含要说的话和前往地点，但发言先后尚未确定；请说明是在出发前说，还是抵达后说。',{
          outcome,presentation:'assistant',view});
      }
      const orderedMove=eventSequence?.findIndex(event=>event.kind==='move')??-1;
      const departureSpeech=eventSequence?.find((event,index)=>event.kind==='speech'&&
        (orderedMove<0||index<orderedMove)&&event.timing==='before_move')??null;
      const arrivalSpeech=eventSequence?.find((event,index)=>event.kind==='speech'&&
        index>orderedMove&&event.timing==='after_move')??null;
      const travelSpeech=eventSequence?.find(event=>event.kind==='speech'&&event.timing==='during_move')??null;
      let departureSceneDone=false,travelSceneDone=false;
      const partialFailure=(outcome:ReturnType<typeof engineOutcome>,after:SavePackage)=>{
        const receipts=committedSince(save,after);
        const story=receipts.length||storyLines.length?
          [...new Set(storyLines.length?storyLines:[after.last_turn?.narrative?.trim()].filter((line):line is string=>Boolean(line)))].join('\n'):'';
        return agentResult('WORLD_GOAL',engineMessage(outcome),{outcome,
          recovery:recoveryContext(body.original_input??body.input,outcome,{completed_steps:trail}),presentation:'failure',
          ...(story?{story}:{}),plan_id:body.request_id,
          canonical_changes:trail.map(entry=>'goal_step:'+entry),view:service.project(after)});
      };
      let resolvedDestination=context?.destination??null;
      if(context?.search_query&&!resolvedDestination){
        for(let searchIndex=0;searchIndex<3;searchIndex++){
          const current=await service.current();
          try{
            const found=await agentSkills(current).invoke<{query:string;request_id:string;scope?:typeof spatialScope},
              Awaited<ReturnType<typeof exploreLocation>>>('location_exploration',
              {query:context.search_query,request_id:childId(body.request_id,'location-search-'+searchIndex),scope:spatialScope??undefined},
              {service,save:current,request_id:body.request_id});
            // A normal active search still happens when the location proposal is
            // incompatible with the canonical world. The rejection only blocks
            // materialization; it does not cancel the player's attempt to look.
            if(!found.location&&(found.kind==='none'||found.kind==='incompatible')){
              // A location lookup cannot settle a player's physical search.
              // The bounded step loop below searches the current canonical area.
              break;
            }
            if(found.kind==='approach'){
              const searchView=service.project(current);
              const origin=String(searchView.entities.find(entity=>entity.id===searchView.player_id)?.components.location?.location_id??'');
              if(!scopeAllowsMove(searchView,origin,found.location.id))break;
              if(context.travel_after_discovery===false)return agentResult('WORLD_GOAL',
                `需要先到${found.location.name}附近实地寻找；目前还没有确认目的地。`,
                {presentation:'assistant',plan_id:body.request_id,canonical_changes:trail,view:service.project(current)});
              await service.turn({game_id:current.game_id,expected_revision:current.state_revision,
                request_id:childId(body.request_id,'location-approach-'+searchIndex),
                action:{type:'MOVE',target_id:found.location.id,parameters:{}},
                player_input:body.input,player_request_id:body.request_id});
              trail.push(`到达 ${found.location.name}`);
              continue; // Re-read canonical location, people and event state before searching again.
            }
            resolvedDestination=found.location.name;
            lastMessage=found.kind==='known'?`已知地点：${found.location.name}。`:
              `找到了${found.location.name}；它现在已记在你的地图上。`;
            if(found.kind!=='known')trail.push(`发现 ${found.location.name}`);
            if(context.travel_after_discovery===false)return agentResult('WORLD_GOAL',lastMessage,
              {presentation:'assistant',plan_id:body.request_id,canonical_changes:trail,view:service.project(await service.current())});
            break;
          }catch(error){
            service.logger.warn('agent.location_search.failed',{module:'agent',metadata:{reason:failureReason(error)}});
            const after=await service.current();
            const outcome=executionFailure(error,'location_exploration',after,save,trail);
            return partialFailure(outcome,after);
          }
        }
      }
      const sceneStep=async(current:SavePackage,partnerId:string,mode=semantic.player_speech_mode??null,
        sceneInput=body.input,phase='scene')=>{
        try{
          const seen=await handleAgentInput(service,{...body,input:sceneInput,expected_revision:current.state_revision,
            request_id:childId(body.request_id,phase)},
            undefined,partnerId,false,{...semantic,kind:'world_action',interaction_lane:'natural_scene',
              // The parent runner owns the whole GoalSpec. This child realizes
              // only the already ordered speech at this route stop.
              open_goal_context:null,goal_spec:null,player_speech_mode:mode},phase==='scene-before-move');
          const after=await service.current();
          if(phase!=='scene-before-move'&&context?.search_query&&!resolvedDestination&&seen.outcome.type==='game'){
            const outcome=gameOutcome('partial_progress','open_goal_search_inquiry',after.state_revision,
              [...trail,'scene_interaction'],committedSince(save,after),'unresolved');
            return {...seen,outcome,presentation:'story' as const,plan_id:body.request_id,
              message:[...storyLines,seen.message].filter(Boolean).join('\n'),
              canonical_changes:[...trail.map(entry=>'goal_step:'+entry),...(seen.canonical_changes??[])]};
          }
          return {...seen,plan_id:body.request_id,canonical_changes:[...trail.map(entry=>'goal_step:'+entry),...(seen.canonical_changes??[])]};
        }catch(error){
          const latest=await service.current();
          const beforeReceipts=new Set((current.resolution_receipts??[]).map(receipt=>receipt.request_id));
          const newReceipt=latest.resolution_receipts?.some(receipt=>receipt.commit_status==='committed'&&!beforeReceipts.has(receipt.request_id))??false;
          const revisionProgress=latest.state_revision>current.state_revision;
          const failure=sceneFailureInfo(error);
          service.logger.warn('agent.open_goal.scene_failed',{module:'agent',metadata:{
            reason:failureReason(error),failure_code:failure.code,failure_stage:failure.stage,
            completed_steps:trail.length,receipt_progress:newReceipt,revision_progress:revisionProgress}});
          const receipts=committedSince(save,latest);
          const engine=engineOutcome(failureReason(error)!=='unknown'?'provider_failure':'schema_failure',
            'natural_scene',latest.state_revision,!newReceipt&&!revisionProgress,trail,receipts);
          return partialFailure(engine,latest);
        }
      };
      for(let stepIndex=0;stepIndex<MAX_OPEN_GOAL_STEPS;stepIndex+=1){
        const current=await service.current(),currentView=service.project(current);
        const here=String(currentView.entities.find(entity=>entity.id===currentView.player_id)?.components.location?.location_id??'');
        if(departureSpeech&&!departureSceneDone){
          const originPartner=scenePartner(currentView,current,speechTargetId);
          if(!originPartner)return agentResult('CLARIFICATION','当前地点没有能听到这句话的人；请确认要向谁说。',{
            outcome:gameOutcome('unresolved_goal','open_goal_speech_target',current.state_revision,
              trail,committedSince(save,current),'unresolved'),presentation:'assistant',view:currentView});
          const result=await sceneStep(current,originPartner.id,semantic.player_speech_mode??'verbatim',
            departureSpeech.text!, 'scene-before-move');
          if(result.outcome.type==='engine_failure'||
            (result.outcome.type==='game'&&result.outcome.kind!=='completed'))return result;
          const after=await service.current();
          if(after.state_revision<=current.state_revision)return result;
          departureSceneDone=true;trail.push('在出发地交流');
          if(result.message)storyLines.push(result.message);
          currentTrace()?.info('agent.compound_event',{metadata:{kind:'speech',phase:'before_move',
            location_id:here,revision:after.state_revision,request_id:childId(body.request_id,'scene-before-move')}});
          if(orderedMove<0)return {...result,plan_id:body.request_id,story:result.message};
          continue;
        }
        if(context?.search_query&&!resolvedDestination&&!searchedLocations.has(here)){
          const place=currentView.locations.find(location=>location.id===here)?.name??'当前区域';
          const searchText=`在当前区域自行巡视并寻找${spatialScope?.source_quote??context.search_query}的可见线索，不与未指定的人交谈`;
          try{
            await service.turn({game_id:current.game_id,expected_revision:current.state_revision,
              request_id:childId(body.request_id,'location-exploration-'+stepIndex),input:searchText},
              undefined,undefined,undefined,false,undefined,undefined,true);
          }catch(error){const latest=await service.current();
            service.logger.warn('agent.location_search.failed',{module:'agent',metadata:{reason:failureReason(error)}});
            const outcome=executionFailure(error,'location_exploration',latest,save,trail);
            return partialFailure(outcome,latest);}
          const after=await service.current();
          if(after.state_revision===current.state_revision)break;
          searchedLocations.add(here);
          trail.push(`在${place}寻找${context.search_query}`);
          lastMessage=after.last_turn?.narrative??'';
          if(lastMessage)storyLines.push(lastMessage);
          continue; // Refresh canonical scene before choosing another search step.
        }
        if(spatialScope&&!resolvedDestination&&searchedLocations.has(here)){
          // A negative local search is a complete, bounded attempt. Do not let
          // the step planner substitute a nearby building or append a return leg.
          const story=[...new Set(storyLines)].join('\n')||'这次没有确认符合探索范围的新地点。';
          return agentResult('WORLD_GOAL',story,{story,presentation:'story',plan_id:body.request_id,
            outcome:gameOutcome('completed_no_result','location_exploration',current.state_revision,
              trail,committedSince(save,current),'completed'),view:currentView});
        }
        const destinationId=resolvedDestination?currentView.locations.find(location=>location.name===resolvedDestination)?.id??null:null;
        const pendingDeparture=semantic?.goal_spec?.play_action==='move'&&!resolvedDestination&&
          !trail.some(entry=>entry.startsWith('到达 '));
        const atDestination=(!destinationId||destinationId===here)&&!pendingDeparture;
        const partner=atDestination?arrivalSpeech?
          (semantic?.speech_target_id?scenePartner(currentView,current,semantic.speech_target_id):
            currentView.entities.find(entity=>arrivalResidentIds.has(entity.id)&&entity.components.character&&
              entity.components.location?.location_id===here)??
            scenePartner(currentView,{...current,interaction_context:undefined},null)):
          scenePartner(currentView,current,speechTargetId):null;
        // A completed movement goal must not replay the original travel instruction
        // as a fresh utterance to somebody encountered at the destination. A later
        // conversation needs its own authorized social target or search purpose.
        const movementOnlyGoal=semantic?.goal_spec?.play_action==='move'&&
          !semantic.goal_spec.targets.some(target=>target.kind==='entity'||target.kind==='entity_query')&&
          !context?.search_query&&!arrivalSpeech&&!travelSpeech;
        if(movementOnlyGoal&&atDestination&&!routeStillIntermediate&&
          trail.some(entry=>entry.startsWith('到达 '))){
          const narrative=[...new Set(storyLines)].join('\n')||lastMessage;
          const outcome=gameOutcome('completed','open_goal_continuation',current.state_revision,
            trail,committedSince(save,current),'completed');
          return agentResult('WORLD_GOAL',narrative||gameNarrative(outcome,{}),{
            outcome,presentation:narrative?'story':'assistant',...(narrative?{story:narrative}:{}),
            plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:currentView});
        }
        if(eventSequence&&orderedMove>=0&&(departureSceneDone||travelSceneDone)&&!arrivalSpeech&&
          atDestination&&trail.some(entry=>entry.startsWith('到达 '))){
          const story=[...new Set(storyLines)].join('\n');
          const outcome=gameOutcome('completed','open_goal_continuation',current.state_revision,
            trail,committedSince(save,current),'completed');
          return agentResult('WORLD_GOAL',story||gameNarrative(outcome,{}),{
            outcome,presentation:story?'story':'assistant',...(story?{story}:{}),
            plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:currentView});
        }
        // A location search has not reached its requested place while the
        // destination is unresolved. A bystander at the origin is not an
        // authorized post-arrival scene partner.
        const wantsScene=(eventSequence?Boolean(arrivalSpeech):
          context?.continuation==='natural_interaction_if_available')&&
          (!context?.search_query||Boolean(resolvedDestination));
        if(atDestination&&resolvedDestination&&context?.search_query&&!context.destination&&
          context.travel_after_discovery&&context.continuation==='none'){
          const outcome=gameOutcome('completed','location_exploration',current.state_revision,trail,
            committedSince(save,current),'completed');
          return agentResult('WORLD_GOAL',[trail.at(-1),lastMessage].filter(Boolean).join('\n')||`你已到达${resolvedDestination}。`,{
            outcome,presentation:'story',plan_id:body.request_id,
            canonical_changes:trail.map(entry=>'goal_step:'+entry),view:currentView});
        }
        if(destinationId&&!atDestination){
          if(!scopeAllowsMove(currentView,here,destinationId))return agentResult('WORLD_GOAL',
            '当前已知路线会离开本次授权的探索范围，因此没有继续移动。',{
              presentation:'assistant',view:currentView,story:storyLines.join('\n')||undefined,
              outcome:gameOutcome('unresolved_goal','open_goal_spatial_scope',current.state_revision,
                trail,committedSince(save,current),'unresolved')});
          try{
            if(arrivalSpeech)for(const entity of current.entities)if(entity.id!==currentView.player_id&&
              entity.components.character&&entity.components.location?.location_id===destinationId)
              arrivalResidentIds.add(entity.id);
            const route=travelSpeech&&!travelSceneDone?routePath(currentView.routes,here,destinationId):null;
            if(travelSpeech&&!travelSceneDone&&(!route||route.length<2)){
              const outcome=gameOutcome('unresolved_goal','open_goal_travel_speech',current.state_revision,
                trail,committedSince(save,current),'unresolved');
              return agentResult('CLARIFICATION',
                '这段路没有可结算的中途场景，无法准确安排边走边说；请确认是在出发前交谈，还是到达后交谈。',
                {outcome,presentation:'assistant',view:currentView});
            }
            const nextDestination=route&&route.length>1?route[0].to:destinationId;
            const moveRequestId=childId(body.request_id,nextDestination===destinationId?'destination':'destination-first-leg');
            const precedingSceneId=childId(body.request_id,'scene-before-move');
            const followsScene=departureSceneDone&&current.narrative_history?.at(-1)?.request_id===precedingSceneId;
            const arrivalPending=Boolean(followsScene&&!arrivalSpeech&&nextDestination===destinationId&&
              current.entities.some(entity=>entity.id!==current.player_state.entity_id&&entity.components.character&&
                entity.components.location?.location_id===nextDestination));
            await service.turn({game_id:current.game_id,expected_revision:current.state_revision,
              request_id:moveRequestId,
              action:{type:'MOVE',target_id:nextDestination,
                parameters:context?.travel_party==='solo'?{companions:'none'}:{}},
              player_input:body.input,player_request_id:body.request_id,
              ...(followsScene?{preceding_scene_request_id:precedingSceneId}:{}),
              ...(arrivalPending?{arrival_scene_pending:true}:{}),
              });
            trail.push(`到达 ${currentView.locations.find(location=>location.id===nextDestination)?.name??resolvedDestination}`);
            executedMarkers.add('move:'+resolvedDestination);
            const moved=await service.current();
            lastMessage=moved.last_turn?.narrative??'';
            if(lastMessage){if(followsScene)storyLines.splice(0,storyLines.length,lastMessage);
              else storyLines.push(lastMessage);}
            if(arrivalPending){
              const arrival=await continueArrivalScene(service,body,current,moved,moveRequestId);
              if(arrival.kind==='unavailable'){
                const latest=await service.current();
                return partialFailure(engineOutcome('provider_failure','arrival_scene',latest.state_revision,
                  false,trail,committedSince(save,latest)),latest);
              }
              if(arrival.kind==='committed'){
                lastMessage=(await service.current()).last_turn?.narrative??lastMessage;
                storyLines.splice(0,storyLines.length,lastMessage);
              }
            }
            if(travelSpeech&&!travelSceneDone){
              const mid=await service.current(),midView=service.project(mid);
              const companion=scenePartner(midView,mid,speechTargetId);
              if(!companion){
                const outcome=gameOutcome('partial_progress','open_goal_travel_speech',mid.state_revision,
                  trail,committedSince(save,mid),'unresolved');
                return agentResult('WORLD_GOAL','你已经动身，但身边没有可以听到这句话的同行者。',{
                  outcome,presentation:'assistant',story:storyLines.join('\n'),view:midView});
              }
              const spoken=await sceneStep(mid,companion.id,semantic.player_speech_mode??'verbatim',
                travelSpeech.text!,'scene-during-move');
              if(spoken.outcome.type==='engine_failure'||
                (spoken.outcome.type==='game'&&spoken.outcome.kind!=='completed'))return spoken;
              travelSceneDone=true;
              const afterScene=await service.current();
              if(spoken.message)storyLines.push(spoken.message);
              currentTrace()?.info('agent.compound_event',{metadata:{kind:'speech',phase:'during_move',
                location_id:nextDestination,revision:afterScene.state_revision}});
            }
            continue;
          }catch(error){const latest=await service.current();
            if(error instanceof WorldBlockedError){const outcome=gameOutcome('blocked_by_world','open_goal_destination',latest.state_revision,
              trail,committedSince(save,latest),'unresolved');
              return agentResult('WORLD_GOAL',gameNarrative(outcome,{completed:trail}),{outcome,presentation:'story',
                plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:service.project(latest)});}
            const outcome=executionFailure(error,'open_goal_destination',latest,save,trail);
            return partialFailure(outcome,latest);
          }
        }
        if(atDestination&&context?.search_query&&context.destination&&!searched){
          const searchText=`寻找${context.search_query}`;
          try{
            await service.turn({game_id:current.game_id,expected_revision:current.state_revision,
              request_id:childId(body.request_id,'target-search'),input:searchText},
              undefined,undefined,undefined,false,undefined,undefined,true);
            searched=true;trail.push(`寻找 ${context.search_query}`);
            lastMessage=(await service.current()).last_turn?.narrative??'';
            if(lastMessage)storyLines.push(lastMessage);
            continue;
          }catch(error){const latest=await service.current();
            if(error instanceof WorldBlockedError){const outcome=gameOutcome('blocked_by_world','open_goal_search',latest.state_revision,
              trail,committedSince(save,latest),'unresolved');
              return agentResult('WORLD_GOAL',gameNarrative(outcome,{completed:trail}),{outcome,presentation:'story',
                plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:service.project(latest)});}
            const outcome=executionFailure(error,'open_goal_search',latest,save,trail);
            return partialFailure(outcome,latest);
          }
        }
        // The canonical scene decides: at the goal's destination, an unresolved "meet and interact" continuation
        // is satisfied by the scene lane itself — never by a WAIT or by narrating that nobody is here.
        if(wantsScene&&atDestination&&partner){
          const spoken=await sceneStep(current,partner.id,semantic.player_speech_mode??null,
            arrivalSpeech?.text??body.input,arrivalSpeech?'scene-after-move':'scene');
          if(!storyLines.length||spoken.outcome.type==='engine_failure')return spoken;
          const story=[...storyLines,spoken.message].filter(Boolean).join('\n');
          return {...spoken,message:story,story,plan_id:body.request_id};
        }
        if(wantsScene&&resolvedDestination&&atDestination&&!partner){
          const after=await service.current(),outcome=gameOutcome(trail.length?'partial_progress':'completed_no_result',
            'open_goal_scene_availability',after.state_revision,trail,committedSince(save,after),'unresolved');
          return agentResult('WORLD_GOAL',[lastMessage,'你到了这里，但眼前没有可以交谈的人。'].filter(Boolean).join('\n'),
            {outcome,presentation:'story',plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),
              view:service.project(after)});
        }
        let decision:Awaited<ReturnType<typeof planOpenGoalStep>>=null;
        let planningError:unknown=null;
        let repair:SceneRepair|undefined;
        for(let attempt=1;attempt<=2;attempt++){
          try{decision=await planOpenGoalStep(service,current,currentView,body.input,trail,
            context?{...context,destination:resolvedDestination}:null,wantsScene&&atDestination&&Boolean(partner),
            context?.search_query?{query:context.search_query,searched_location_ids:[...searchedLocations]}:null,repair);
            if(decision)break;
            planningError=new Error('open goal planner unavailable');
          }catch(error){planningError=error;}
          const latest=await service.current(),safe=latest.game_id===current.game_id&&
            latest.state_revision===current.state_revision;
          const code=planningError?failureReason(planningError):'planning_unavailable';
          const feedback=generationRepair(planningError);
          currentTrace()?.warn('agent.recovery.decision',{metadata:{attempt,failure_code:code,
            failure_stage:'open_goal_planning',recoverable:safe&&attempt<2&&Boolean(feedback),
            strategy:safe&&attempt<2&&feedback?'repair_step':'stop',revision:latest.state_revision,
            completed_steps:trail.length}});
          if(!safe||attempt===2||!feedback)break;
          repair={failure_code:code,failure_stage:'open_goal_planning',revision:latest.state_revision,generation_repair:feedback};
        }
        if(!decision&&planningError)service.logger.warn('agent.open_goal.planning_failed',{
          module:'agent',metadata:{reason:failureReason(planningError),revision:current.state_revision}});
        if(!decision){const latest=await service.current();return partialFailure(
          engineOutcome('provider_failure','open_goal_planning',latest.state_revision,
            latest.state_revision===current.state_revision,trail,committedSince(save,latest)),latest);}
        if(decision.decision==='clarify')return agentResult(trail.length?'WORLD_GOAL':'CLARIFICATION',
          [trail.length?`已完成准备步骤：${trail.join('；')}。`:null,decision.question??'我需要更多信息才能继续。'].filter(Boolean).join('\n'),
          {clarification:decision.question??null,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:currentView});
        if(decision.decision==='scene'&&atDestination&&partner&&(wantsScene||Boolean(context?.search_query))){
          return sceneStep(current,partner.id,context?.search_query&&!resolvedDestination?'intent':undefined);
        }
        if(decision.decision==='done'){
          lastMessage=context?.search_query&&resolvedDestination&&destinationId===here?
            `你已经找到并到达${resolvedDestination}。`:
            wantsScene&&atDestination&&!partner?'你到了这里，但眼前没有可以交谈的人。':lastMessage;
          break;
        }
        const step=decision.transaction;
        const marker=step?step.kind+':'+String(step.kind==='move'?step.destination:
          step.kind==='expand'?step.direction:step.minutes):'';
        if(decision.decision!=='transaction'||!step||!marker||executedMarkers.has(marker))break;
        if(discretionaryRoute&&step.kind!=='move'&&
          !(step.kind==='expand'&&step.direction&&regionFrontier(current,here,step.direction))){
          lastMessage='这一步不是已授权的相邻地点探索，尚未执行。';break;
        }
        const beforeRevision=current.state_revision;
        let expandedEntryName='';
        try{
          if(step.kind==='move'){
            const target=step.destination?currentView.locations.find(location=>location.name===step.destination):undefined;
            if(!target){lastMessage='这个世界里没有叫“'+String(step.destination)+'”的已知地点。';break;}
            if(!scopeAllowsMove(currentView,here,target.id)){
              lastMessage='下一步路线超出本次空间授权，没有执行。';break;
            }
            if(discretionaryRoute&&!currentView.routes.some(route=>route.from===here&&route.to===target.id)){
              lastMessage='当前公开路线无法直接到达这个地点，这一步没有执行。';break;
            }
            if(context?.search_query&&!resolvedDestination&&searchedLocations.has(target.id))break;
            if(resolvedDestination&&target.name!==resolvedDestination){
              lastMessage='下一步移动地点与原目标不一致，尚未执行这一步。';break;
            }
            await service.turn({game_id:current.game_id,expected_revision:current.state_revision,request_id:childId(body.request_id,'goal'+stepIndex),action:{type:'MOVE',target_id:target.id,parameters:{}},
              player_input:body.input,player_request_id:body.request_id});
          }else if(step.kind==='expand'){
            if(resolvedDestination||!step.direction){lastMessage='已有明确目的地或缺少合法方向，尚未扩展地图。';break;}
            const expanded=await expandMapFrontier(service,current,here,step.direction,
              childId(body.request_id,'region-'+stepIndex));
            if(expanded.kind==='blocked'){
              const latest=await service.current(),outcome=gameOutcome('blocked_by_world','map_region_frontier',
                latest.state_revision,trail,committedSince(save,latest),'unresolved');
              return agentResult('WORLD_GOAL',[lastMessage,expanded.reason].filter(Boolean).join('\n'),{
                outcome,presentation:'assistant',plan_id:body.request_id,
                canonical_changes:trail.map(entry=>'goal_step:'+entry),view:service.project(latest)});
            }
            const expandedSave=await service.current();
            expandedEntryName=service.project(expandedSave).locations.find(location=>location.id===expanded.entry_id)?.name??'';
            await service.turn({game_id:expandedSave.game_id,expected_revision:expandedSave.state_revision,
              request_id:childId(body.request_id,'region-entry-'+stepIndex),
              action:{type:'MOVE',target_id:expanded.entry_id,parameters:{}},
              player_input:body.input,player_request_id:body.request_id});
          }else{
            await service.turn({game_id:current.game_id,expected_revision:current.state_revision,request_id:childId(body.request_id,'goal'+stepIndex),action:{type:'WAIT',parameters:{minutes:Number(step.minutes??5)}}});
          }
          lastMessage=(await service.current()).last_turn?.narrative??'';
          if(lastMessage)storyLines.push(lastMessage);
        }catch(error){const latest=await service.current();service.logger.warn('agent.open_goal.transaction_failed',{
          module:'agent',metadata:{reason:failureReason(error),detail:(error as Error).message,revision:latest.state_revision}});
          if(error instanceof WorldBlockedError){const outcome=gameOutcome('blocked_by_world','open_goal_step',latest.state_revision,trail,committedSince(save,latest),'unresolved');
            return agentResult('WORLD_GOAL',gameNarrative(outcome,{completed:trail}),{outcome,presentation:'story',
              plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:service.project(latest)});}
          const outcome=executionFailure(error,'open_goal_step',latest,save,trail);
          return partialFailure(outcome,latest);}
        if((await service.current()).state_revision===beforeRevision)break;
        executedMarkers.add(marker);
        trail.push(step.kind==='move'?`到达 ${String(step.destination)}`:
          step.kind==='expand'?`到达 ${expandedEntryName}`:`等待 ${Number(step.minutes??5)} 分钟`);
        routeStillIntermediate=step.kind==='move'&&step.intermediate;
        // Continue a validated transit step, but stop after the first reached goal location.
        // The global step budget still prevents an unbounded exploration tour.
        if(discretionaryRoute&&step.kind!=='expand'&&
          (!routeStillIntermediate||semantic?.interaction_lane==='world_transaction'))break;
      }
      // The Narrator owns player-facing prose. Search steps and outcome labels
      // remain structured metadata and must not be appended as story text.
      const narratedStory=[...new Set(storyLines)].join('\n');
      const summary=narratedStory||lastMessage;
      const after=await service.current();
      // A single authorized nearby move can satisfy the whole request when the semantic goal
      // did not retain any dependent action. A separately stated post-arrival step stays open.
      const nearbyGoalDone=discretionaryRoute&&!routeStillIntermediate&&trail.some(entry=>entry.startsWith('到达 '))&&
        !semantic?.goal_spec?.dependencies.length;
      const outcome=gameOutcome(nearbyGoalDone?'completed':trail.length?'partial_progress':'unresolved_goal',
        'open_goal_continuation',after.state_revision,trail,committedSince(save,after),
        nearbyGoalDone?'completed':'unresolved');
      return agentResult('WORLD_GOAL',summary||gameNarrative(outcome,{}),
        {outcome,presentation:narratedStory?'story':'assistant',...(narratedStory?{story:narratedStory}:{}),
          plan_id:body.request_id,canonical_changes:trail.map(entry=>'goal_step:'+entry),view:service.project(after)});
    }
    const ambientPerception=!body.interaction&&isActivePerception(body.input)&&!/(?:他|她|他们|她们|对方|那个人)/.test(body.input)&&
      !resolveEntities(view,body.input).matches.some(entity=>entity.id!==view.player_id&&Boolean(entity.components.character));
    // The lane is a presentation preference, not permission to swallow later
    // actions in a composite GoalSpec. The existing ordered contract owns them.
    const stagedScene=!deferSceneEffects&&semantic?.interaction_lane==='natural_scene'&&
      Boolean(semantic.goal_spec?.multi_step||semantic.goal_spec?.dependencies.length);
    if(stagedScene)currentTrace()?.info('agent.route_handoff',{metadata:{from:'natural_scene',to:'contract_plan',
      reason:'composite_goal',multi_step:semantic?.goal_spec?.multi_step??null,
      dependency_count:semantic?.goal_spec?.dependencies.length??0,revision:save.state_revision}});
    const partner=semantic?.interaction_lane==='natural_scene'&&!ambientPerception&&!stagedScene?scenePartner(view,save,speechTargetId):null;
    if(body.interaction&&!npcPresentInView(view,body.interaction.target_id)){
      const latest=await service.current();
      return agentResult('WORLD_ACTION','交谈对象已不在当前场景，请重新选择。',{
        outcome:gameOutcome('blocked_by_world','natural_scene_target',latest.state_revision),
        presentation:'assistant',view:service.project(latest)});
    }
    if(partner){
      let outcome:Awaited<ReturnType<typeof runSceneInteraction>>=null;
      let sceneError:unknown=null;
      let sceneNeedsPlan=false;
      let repair:SceneRepair|undefined;
      let previousCode:string|null=null;
      let sceneAttempts=0;
      for(let attempt=1;attempt<=3;attempt++){
        sceneAttempts=attempt;
        try{outcome=await agentSkills(save).invoke<{view:typeof view;input:string;partner:{id:string};
          speechMode:'none'|'verbatim'|'intent'|null;repair?:typeof repair;speechOnly?:boolean;audienceIds?:string[]},Awaited<ReturnType<typeof runSceneInteraction>>>(
          'natural_scene',{view,input:body.input,partner,speechMode:semantic?.player_speech_mode??null,repair,speechOnly:deferSceneEffects,
            audienceIds:semantic?.goal_spec?.targets.filter(target=>target.role==='audience').flatMap(target=>target.entity_id?[target.entity_id]:[])},
          {service,save,request_id:body.request_id});
          if(outcome)break;
          sceneError=new SceneInteractionError('PROVIDER_SCHEMA_INVALID','provider_response','场景提案没有通过结构校验');
        }catch(error){sceneError=error;}
        const latest=await service.current(),failure=sceneFailureInfo(sceneError);
        const safe=latest.game_id===save.game_id&&latest.state_revision===save.state_revision&&
          !committedSince(save,latest).length;
        // No action was committed. A scene which invents departures may have
        // absorbed a later action. Compile the original request once instead
        // of regenerating that whole scene. The contract's speech phase cannot
        // recurse into this handoff, and normal plan/alignment checks still apply.
        if(safe&&!deferSceneEffects&&semantic?.kind==='world_action'&&failure.stage==='scene_presence_validation'&&
          sceneError instanceof SceneInteractionError&&sceneError.proposedEffects.some(kind=>kind!=='unsupported')){
          sceneNeedsPlan=true;
          currentTrace()?.warn('agent.route_handoff',{metadata:{from:'natural_scene',to:'contract_plan',
            reason:'uncommitted_presence_conflict',failure_code:failure.code,failure_stage:failure.stage,
            effects:sceneError.proposedEffects,attempt,revision:latest.state_revision}});
          break;
        }
        // A bounded cross-stage recovery: each attempt may surface a different
        // repairable category, but repeating the same rejected category is not
        // retried, so the loop cannot amplify or loop on one invariant failure.
        const repairable=!['PROVIDER_REFUSAL','PROVIDER_CONTENT_FILTER','SCENE_PROVIDER_FAILURE'].includes(failure.code);
        const recoverable=safe&&attempt<3&&repairable&&(attempt===1||failure.code!==previousCode);
        currentTrace()?.warn('agent.recovery.decision',{metadata:{attempt,failure_code:failure.code,
          failure_stage:failure.stage,recoverable,strategy:recoverable?'repair_scene':'stop',
          revision:latest.state_revision}});
        if(!recoverable)break;
        previousCode=failure.code;
        repair=sceneRepairFeedback(sceneError,latest.state_revision);
      }
      if(!outcome&&!sceneNeedsPlan){const latest=await service.current(),failure=sceneFailureInfo(sceneError);
        (currentTrace()??service.logger).warn('agent.scene.failed',{module:'agent',metadata:{code:failure.code,stage:failure.stage,
          revision:latest.state_revision,
          detail:sceneError instanceof Error?sceneError.message.slice(0,300):String(sceneError).slice(0,300)}});
        const failureOutcome=engineOutcome(
          failure.code==='SCENE_PROVIDER_FAILURE'||failure.code==='PROVIDER_REFUSAL'||failure.code==='PROVIDER_CONTENT_FILTER'?
            'provider_failure':'schema_failure','natural_scene',
          latest.state_revision,latest.state_revision===save.state_revision,[],committedSince(save,latest));
        const preciseMessage=failureOutcome.state_certain&&!failureOutcome.receipt_ids.length&&
          failure.code==='SCENE_BEATS_INVALID'?
          '这次交流的对白顺序未能正确整理，交流尚未提交；后续行动尚未执行。':
          failureOutcome.state_certain&&!failureOutcome.receipt_ids.length&&failure.stage==='speech_alignment'?
          '生成的玩家发言偏离了原意，自动修正未完成；交流尚未提交，后续行动尚未执行。':
          engineMessage(failureOutcome);
        return agentResult('WORLD_ACTION',preciseMessage,{outcome:failureOutcome,
          recovery:recoveryContext(body.original_input??body.input,failureOutcome,{attempts:sceneAttempts,failed_category:failure.code}),
          presentation:'failure',view:service.project(latest)});}
      if(outcome){
        if(deferSceneEffects){
          // This is only the speech phase of an existing ordered Open Goal.
          // That runner owns the subsequent scope-checked authoritative actions.
          currentTrace()?.info('agent.scene.effects_deferred',{metadata:{count:outcome.authorizedEffects.length,
            deferred_gaps:outcome.gaps.length}});
          outcome.authorizedEffects=[];
          outcome.gaps=[];
        }
        const startScene=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
        const sceneRevision=save.state_revision;
        const sceneLocationId=save.entities.find(entity=>entity.id===save.player_state.entity_id)
          ?.components.location?.location_id;
        try{await service.agentTransaction({...body,expected_revision:sceneRevision,request_id:childId(body.request_id,'scene')},{scene_interaction:true},next=>{
          if(outcome.npcDecision?.proposed_action){
            const action=applyNpcProposedAction(next,childId(body.request_id,'npc-action'),partner.id,outcome.npcDecision.proposed_action);
            if(action.settled)outcome.settled.push('人物行动已经世界结算');
            if(action.gap)outcome.gaps.push(action.gap);
          }
          const playerEntity=next.entities.find(entity=>entity.id===next.player_state.entity_id);
          const locationId=sceneLocationId==null?null:String(sceneLocationId);
          const anchor=sceneAnchor(playerEntity);
          const events=outcome.result.speech_events.map(event=>({...event,
            source_intent:event.provenance==='generated_from_player_intent'?body.input:null}));
          const finalNpc=[...events].reverse().find(event=>event.provenance==='npc_response');
          const lastEvent=events.at(-1),speaker=lastEvent?.provenance==='npc_response'?lastEvent.speaker_id:null;
          const ordered=orderedSceneBeats(outcome.result);
          const visibleEvents=speaker?events.slice(0,-1):events;
          const eventLines=visibleEvents.map(event=>{
            const name=String(next.entities.find(entity=>entity.id===event.speaker_id)?.components.identity?.name??event.speaker_id);
            return `${name}：“${event.utterance}”`;
          });
          const orderedText=ordered?.map(beat=>beat.kind==='narration'?beat.text:
            `${String(next.entities.find(entity=>entity.id===beat.speaker_id)?.components.identity?.name??beat.speaker_id)}：“${beat.utterance}”`).join('\n');
          next.last_turn={narrative:orderedText??[outcome.result.narrative,...eventLines].filter(Boolean).join('\n'),
            dialogue:ordered?null:speaker?lastEvent!.utterance:null,speaker:ordered?null:speaker,
            ...(ordered?{scene_beats:ordered}:{}),choices:[],context_actions:[]};
          next.narrative_history=[...(next.narrative_history??[]),{request_id:body.request_id,narrative:ordered?.filter(beat=>beat.kind==='narration').map(beat=>beat.text).join('\n')??outcome.result.narrative,
            dialogue:finalNpc?.utterance??null,speaker:finalNpc?.speaker_id??null,facts:[],player_input:body.input,
            speech_events:events,revision:next.state_revision+1,time:structuredClone(save.runtime.time),location_id:locationId}].slice(-8);
          recordSceneObservation(next,body.request_id,events,
            view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character&&
              entity.components.location?.location_id===view.entities.find(item=>item.id===view.player_id)?.components.location?.location_id)
              .map(entity=>entity.id));
          if(locationId)recordSoftContacts(next,outcome.result,body.request_id,locationId);
          if(locationId)recordSocialCommitments(next,outcome.result,body.request_id,locationId);
          if(locationId)recordNpcActivityPlans(next,outcome.result,body.request_id,locationId);
          if(outcome.npcDecision)applyNpcDecision(next,partner.id,`decision:${body.request_id}`,outcome.npcDecision);
          if(locationId)for(const intent of outcome.result.travel_intents){
            const state=next.npc_agent_state?.[intent.npc_id];
            if(!state)continue;
            state.travel_intent={status:intent.status,origin_location_id:locationId,
              source_request_id:body.request_id,recorded_revision:next.state_revision+1};
          }
          const continuing=next.interaction_context?.status==='active'&&next.interaction_context.target_entity_id===partner.id;
          next.interaction_context={mode:'conversation',target_entity_id:partner.id,
            started_turn:continuing?next.interaction_context!.started_turn:next.state_revision+1,
            last_interaction_turn:next.state_revision+1,scene_anchor:anchor,status:'active'};
          const seconds=sceneSpeechSeconds(events)+(next.runtime.scene_seconds??0);
          const minutes=Math.floor(seconds/60);
          next.runtime.scene_seconds=seconds%60;
          if(minutes){
            // The existing WAIT action owns the world clock, events and schedules.
            // It is settled inside this scene transaction, so retries cannot charge time twice.
            const timeId=childId(body.request_id,'scene-time');
            const settled=executeAction(next,{type:'WAIT',parameters:{minutes}},timeId);
            Object.assign(next,settled.save);
            const receipt=next.resolution_receipts?.find(entry=>entry.request_id===timeId);
            if(receipt){
              receipt.semantic_action='NATURAL_SCENE_TIME';
              receipt.canonical_facts=[`现场交流经过 ${receipt.time_cost} 分钟。`];
              receipt.commit_status='committed';
            }
            if(settled.action.time_cost<minutes)next.runtime.scene_seconds=0;
          }
          sceneCommit?.(save,next);
        });}catch(error){const latest=await service.current();service.logger.warn('agent.scene.commit_failed',{
          module:'agent',metadata:{detail:(error as Error).message,revision:latest.state_revision}});
          return agentResult('WORLD_ACTION',safeEngineMessage,{outcome:engineOutcome('transaction_failure',
            'natural_scene_commit',latest.state_revision,latest.state_revision===sceneRevision,
            outcome.settled,committedSince(save,latest)),presentation:'failure',view:service.project(latest)});}
        const committedScene=await service.current();
        service.logger.info('scene.response.committed',{module:'agent',request_id:body.request_id,metadata:{
          player_speech_events:outcome.result.speech_events.filter(event=>event.speaker_id===view.player_id).length,
          npc_speech_events:outcome.result.speech_events.filter(event=>event.speaker_id!==view.player_id).length,
          response_dialogue_in_events:outcome.result.dialogue===null||outcome.result.speech_events.some(event=>event.utterance===outcome.result.dialogue),
          history_recorded:true,location_id:sceneLocationId??null,revision:sceneRevision+1,
          time_minutes:(committedScene.runtime.time.day-save.runtime.time.day)*save.definition.ruleset.minutes_per_day+
            committedScene.runtime.time.minute-save.runtime.time.minute,
          scene_seconds_carry:committedScene.runtime.scene_seconds??0}});
        const sceneStory=sceneMessage({...outcome,settled:[]},view);
        const effectStories:string[]=[];
        for(const [index,effect] of outcome.authorizedEffects.entries()){
          const beforeEffect=await service.current();
          const effectRequestId=childId(body.request_id,`scene-effect-${index}`);
          const arrivalPending=effect.kind==='move'&&index===0&&beforeEffect.entities.some(entity=>
            entity.id!==beforeEffect.player_state.entity_id&&entity.components.character&&
            entity.components.location?.location_id===effect.target_id);
          try{
            if(effect.kind==='inspect'){
              await service.turn({game_id:beforeEffect.game_id,expected_revision:beforeEffect.state_revision,
                request_id:effectRequestId,input:effect.source_quote},
                undefined,undefined,undefined,false,undefined,undefined,true,undefined,true);
              const inspected=await service.current();
              if(!inspected.resolution_receipts?.some(receipt=>receipt.request_id===effectRequestId&&
                receipt.commit_status==='committed')){
                outcome.gaps.push('本次调查没有完成权威结算');continue;
              }
              outcome.settled.push('完成现场检查');
            }else{
              await service.turn({game_id:beforeEffect.game_id,expected_revision:beforeEffect.state_revision,
                request_id:effectRequestId,
                action:effect.kind==='move'?{type:'MOVE',target_id:effect.target_id,parameters:{}}:
                  {type:'WAIT',parameters:{minutes:effect.minutes}},
                player_input:body.input,player_request_id:body.request_id,
                ...(index===0&&effect.kind==='move'?{preceding_scene_request_id:body.request_id}:{}),
                ...(arrivalPending?{arrival_scene_pending:true}:{})});
              outcome.settled.push(effect.kind==='move'?`移动到${effect.destination}`:`等待${effect.minutes}分钟`);
            }
            const completed=await service.current();
            if(completed.last_turn?.narrative)effectStories.push(completed.last_turn.narrative);
            if(arrivalPending){
              const arrival=await continueArrivalScene(service,body,beforeEffect,completed,effectRequestId);
              if(arrival.kind==='unavailable'){
                const latest=await service.current();
                const failure=engineOutcome('provider_failure','arrival_scene',latest.state_revision,false,
                  ['scene_interaction',...outcome.settled],committedSince(save,latest));
                return agentResult('WORLD_ACTION',engineMessage(failure),{outcome:failure,
                  presentation:'failure',story:latest.last_turn?.narrative??sceneStory,
                  view:service.project(latest)});
              }
              if(arrival.kind==='committed')effectStories[effectStories.length-1]=
                (await service.current()).last_turn?.narrative??effectStories.at(-1)??'';
            }
          }catch(error){
            if(error instanceof WorldBlockedError){outcome.gaps.push(error.message);break;}
            const latest=await service.current();
            service.logger.warn('agent.scene.effect_failed',{module:'agent',metadata:{
              detail:(error as Error).message,revision:latest.state_revision,effect_index:index}});
            const failure=engineOutcome('transaction_failure','natural_scene_effect',latest.state_revision,
              latest.state_revision===beforeEffect.state_revision, ['scene_interaction',...outcome.settled],
              committedSince(save,latest));
            return agentResult('WORLD_ACTION',engineMessage(failure),{outcome:failure,
              presentation:'failure',story:[sceneStory,...effectStories].filter(Boolean).join('\n'),
              view:service.project(latest)});
          }
        }
        const after=await service.current();
        if(outcome.npcDecision)service.logger.info('npc_agent.action_committed',{module:'agent',request_id:body.request_id,
          revision:after.state_revision,metadata:{npc_id:partner.id,trigger:'direct_scene',kind:outcome.npcDecision.kind,
            receipt_ids:[childId(body.request_id,'scene'),
              ...(after.resolution_receipts?.some(receipt=>receipt.request_id===childId(body.request_id,'npc-action'))
                ?[childId(body.request_id,'npc-action')]:[])],outcome:'scene_recorded'}});
        const delta=after.runtime.time.day*after.definition.ruleset.minutes_per_day+after.runtime.time.minute-startScene;
        const sceneOutcome=gameOutcome(outcome.gaps.length?'partial_progress':'completed','natural_scene',
          after.state_revision,['scene_interaction',...outcome.settled],committedSince(save,after),
          outcome.gaps.length?'partial':'completed');
        return agentResult(outcome.result.speech_events.some(event=>event.provenance==='npc_response')?'WORLD_SPEECH':'WORLD_ACTION',sceneMessage(outcome,view),
          {outcome:sceneOutcome,presentation:'story',time_advanced:delta,view:service.project(after),
            ...(outcome.authorizedEffects.length?{story:[sceneStory,...effectStories].filter(Boolean).join('\n')}:{}),
          });
      }
    }
    const recentForPlan={semantic_goal:semantic?.goal_spec??null,recent_referent:recentReferent(save),recent_turns:(save.narrative_history??[]).slice(-2).map(entry=>({narrative:String(entry.narrative??'').slice(0,240),dialogue:entry.dialogue??null,speaker:entry.speaker??null})),recent_actions:(save.action_facts??[]).slice(-3).map(entry=>({input:String(entry.input??'').slice(0,160),facts:entry.facts,target_id:entry.target_id}))};
    const forceSemantic=confirmedSpeech||semantic?.kind==='world_action';
    // All plan correction happens before the first world write. Each retry receives the original
    // authorization and a bounded diagnostic, never an invented replacement objective.
    let revisedSemantic:SemanticDecision|undefined;
    let proposed:Awaited<ReturnType<typeof createAgentPlan>>|null=null;
    let plan:AgentPlan|null=null;
    let alignment:Awaited<ReturnType<typeof verifyGoalAlignment>>=null;
    let admissionFailure:ReturnType<typeof recoverablePlanAdmission>=null;
    let recovery:Record<string,unknown>|null=null;
    let previousFailure='';
    let previousConversionFailure='';
    for(let attempt=1;attempt<=3;attempt++){
      currentTrace()?.info('agent.plan_attempt',{metadata:{attempt,revision:save.state_revision,
        recovery_code:recovery?.failure_code??null}});
      try{proposed=await createAgentPlan(service.ai,view,body.input,
        recovery?{...recentForPlan,recovery}:recentForPlan,forceSemantic,save);}
      catch(error){
        if(!(error instanceof PlanConversionError))throw error;
        const reason=error.reason.slice(0,240);
        const repeated=previousConversionFailure===reason;
        previousConversionFailure=reason;
        const recoverable=attempt<3&&!repeated;
        service.logger.warn('agent.plan_conversion.failed',{module:'agent',metadata:{reason,attempt}});
        currentTrace()?.warn('agent.recovery.decision',{metadata:{attempt,failure_code:'plan_contract_invalid',
          failure_stage:'plan_conversion',recoverable,strategy:recoverable?'replan':'stop',revision:save.state_revision}});
        if(!recoverable)return agentResult('WORLD_ACTION','这次行动方案连续未通过校验，世界没有改变。请稍后重试原请求。',
          {presentation:'failure',outcome:engineOutcome('schema_failure','plan_conversion',save.state_revision,true),view});
        recovery={original_request:body.input,failure_code:'plan_contract_invalid',failure_stage:'plan_conversion',
          failure_reason:reason,completed_steps:[],revision:save.state_revision,
          generation_repair:generationRepair(new CandidateValidationError('planner',error.issues.length?error.issues:[{path:'goals',code:'plan_contract',expected:'合法完整的有序目标及依赖图',message:reason}],error.proposedGoals)),
          instruction:'重新规划同一目标；不要保留无效步骤或编造世界事实。'};
        continue;
      }
      if(speechTargetId&&proposed.goals.length===1&&proposed.goals[0].type==='WORLD_SPEECH'&&
        !proposed.goals[0].referent&&!proposed.goals[0].target_entities.length){
        const listener=view.entities.find(entity=>entity.id===speechTargetId&&entity.components.character);
        if(listener?.components.identity?.name)proposed.goals[0].referent=String(listener.components.identity.name);
      }
      plan=compileGoalContract(view,proposed,{kind:'manual',text:body.input,semanticGoal:(revisedSemantic??semantic)?.goal_spec});
      if(semantic?.kind!=='world_action')break;
      try{alignment=readOnlyPlan(proposed.goals)
        ?{verdict:'incomplete',explanation:'只读计划不能完成已经授权的世界行动。'}
        :await verifyGoalAlignment(service,body.input,plan,(revisedSemantic??semantic)?.goal_spec?.repetition);}catch(error){
        service.logger.warn('agent.goal_alignment.failed',{module:'agent',metadata:{reason:failureReason(error),attempt}});
      }
      admissionFailure=alignment?.verdict==='aligned'&&!canExecuteContractPlan(plan)
        ?recoverablePlanAdmission(plan):null;
      if(alignment?.verdict==='aligned'&&!admissionFailure)break;
      const failureCode=admissionFailure?.code??alignment?.verdict??'alignment_unavailable';
      const failureStage=admissionFailure?'plan_admission':'goal_alignment';
      const shape=JSON.stringify(plan.goals.map(goal=>({type:goal.type,text:goal.normalized_goal,
        operation:goal.operation_hint??null,depends_on:goal.depends_on})));
      const repeated=previousFailure===failureCode+':'+shape;
      previousFailure=failureCode+':'+shape;
      const recoverable=attempt<3&&!repeated;
      currentTrace()?.warn('agent.recovery.decision',{metadata:{attempt,failure_code:failureCode,
        failure_stage:failureStage,recoverable,strategy:recoverable?'replan':'stop',
        repeated,revision:save.state_revision}});
      if(!recoverable)break;
      if(attempt===1&&alignment?.semantic_revision&&alignment.semantic_revision!=='none'&&
        (await service.current()).state_revision===save.state_revision){
        const corrected=await interpretSemanticEntry(service,view,body.input,'WORLD',null,undefined,
          {failure_code:alignment.semantic_revision,failure_stage:'goal_alignment',detail:alignment.explanation,max_attempts:1},body.interaction);
        if(corrected?.kind==='world_action'&&(!corrected.operation_plane||corrected.operation_plane==='play')){
          revisedSemantic=corrected;recentForPlan.semantic_goal=corrected.goal_spec??null;
          currentTrace()?.info('semantic.revision.accepted',{metadata:{source:'goal_alignment',revision:save.state_revision}});
        }else break;
      }
      recovery={original_request:body.input,failure_code:failureCode,failure_stage:failureStage,
        ...(admissionFailure?{generation_repair:generationRepair(new CandidateValidationError('plan_admission',
          [admissionFailure.issue],proposed)),
          failed_contract:admissionFailure.goal.contract,
          instruction:'前一候选尚未执行。保留原始目标和最终动作；核对操作类型与目标类别。地图 MOVE 只用于已登记地点，同场景物件不得冒充地图目的地。可将本地行动交给现有活动与 Core 校验；不要凭空选择物件实例、权限或结果。'}:{}),
        previous_steps:plan.execution_order.map(id=>{const goal=plan!.goals.find(entry=>entry.goal_id===id)!;
          return {type:goal.type,objective:goal.normalized_goal,operation:goal.operation_hint??null};}),
        completed_steps:[],revision:save.state_revision,
        ...(!admissionFailure?{instruction:'前一计划未获准执行；保持玩家原始目标，补全真正的最终尝试，不把准备步骤当成完成。'}:{})};
    }
    assert(proposed&&plan,'行动方案未能建立');
    if(semantic?.kind==='world_action'&&!proposed.goals.some(goal=>['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(goal.type)))
      return agentResult('CLARIFICATION','我理解你想让角色实际行动，但这次没有形成可验证的行动方案。世界没有改变；请补充你想尝试的具体做法。',{view});
    if(semantic?.kind==='world_action'){
      if(alignment?.verdict!=='aligned')return agentResult('WORLD_ACTION',
        alignment?.verdict==='substituted'?'拟执行的行动与你的请求不同，世界没有改变。':
        alignment?.verdict==='incomplete'?'目前只规划出准备步骤，尚未规划你要求的最终尝试；世界没有改变。':
        '目前无法确认计划符合你的请求，世界没有改变。',{presentation:'failure',view});
    }
    if(admissionFailure){const failure=engineOutcome('schema_failure','plan_admission',save.state_revision,true);
      return agentResult('WORLD_ACTION',engineMessage(failure),{presentation:'failure',outcome:failure,
        recovery:recoveryContext(body.original_input??body.input,failure,{failed_contract:admissionFailure.goal.contract,code:admissionFailure.code}),
        plan_id:body.request_id,plan,view});}
    currentTrace()?.info('agent.goal_compiled',{metadata:{source:'manual',
      goal_kinds:plan.goals.map(goal=>goal.contract?.completion.kind??'unsupported'),
      availability:plan.contract?.execution_availability??null,goal_count:plan.goals.length,
      steps:plan.goals.map(goal=>({goal_id:goal.goal_id,type:goal.type,operation:goal.operation_hint??null,
        depends_on:goal.depends_on,availability:goal.contract?.availability??null,
        bound_entity_ids:goal.contract?.bindings.filter(binding=>binding.status==='bound').map(binding=>binding.entity_id)??[]}))}});
    // A staged plan may have a real first step even when a later world effect has no completion capability.
    // Advance only from the current canonical scene; the unsupported target remains explicitly unfinished.
    const unsupported=plan.goals.find(goal=>goal.side_effect_level==='world'&&goal.contract?.completion.kind==='unsupported');
    const readyPreparation=plan.goals.find(goal=>goal.contract?.availability==='ready'&&
      ['location_at','conversation_attempted','presence_observed'].includes(goal.contract.completion.kind));
    if(unsupported&&readyPreparation&&plan.contract?.execution_mode==='staged'&&
      !plan.goals.some(goal=>goal.condition||goal.branch||goal.temporal_scope.scope!=='now')){
      const destinationId=readyPreparation.contract?.completion.kind==='location_at'
        ?readyPreparation.contract.completion.destination_id:null;
      const destination=destinationId?view.locations.find(place=>place.id===destinationId)?.name??null:null;
      const progressId=childId(body.request_id,'partial-open-goal');
      const progressed=await handleAgentInput(service,{...body,request_id:progressId},undefined,speechTargetId,false,
        {...semantic,kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination,
          continuation:'natural_interaction_if_available'}} as SemanticDecision);
      const after=await service.current(),afterView=service.project(after);
      const sceneHappened=(after.interaction_context?.last_interaction_turn??-1)>
        (save.interaction_context?.last_interaction_turn??-1);
      const newReceipts=(after.resolution_receipts??[]).filter(receipt=>receipt.commit_status==='committed'&&
        !(save.resolution_receipts??[]).some(previous=>previous.request_id===receipt.request_id));
      const completed=newReceipts.map(receipt=>receipt.semantic_action==='MOVE'
        ?`移动到${afterView.locations.find(place=>place.id===receipt.target_id)?.name??'已登记地点'}`
        :`结算了${receipt.semantic_action}`).concat(sceneHappened?['进行了场景交互']:[]);
      const finalReason='这一步目前还没有在世界中发生。';
      for(const goal of plan.goals){
        if(goal.goal_id===unsupported.goal_id){goal.status='blocked';goal.result={summary:finalReason};}
        else if(goal.goal_id===readyPreparation.goal_id&&completed.length){goal.status='completed';goal.result={summary:completed.join('；')};}
        else if(goal.status==='pending')goal.status='skipped';
      }
      plan.status=completed.length?'partial':'blocked';
      const outcome=gameOutcome(completed.length?'partial_progress':'unavailable','final_effect',after.state_revision,
        completed,newReceipts.map(receipt=>receipt.request_id),completed.length?'partial':'unresolved');
      const message=progressed.outcome.type==='engine_failure'?safeEngineMessage:
        [progressed.message,gameNarrative(outcome,{completed})].filter(Boolean).join('\n');
      service.logger.info('agent.final_effect_unavailable',{module:'agent',metadata:{
        goal_id:unsupported.goal_id,revision:after.state_revision,receipt_ids:outcome.receipt_ids}});
      return agentResult('MULTI_GOAL',message,{outcome:progressed.outcome.type==='engine_failure'?progressed.outcome:outcome,
        presentation:progressed.outcome.type==='engine_failure'?'failure':'story',
        plan_id:body.request_id,plan,results:plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??'',
          related_entity:goal.target_entities[0]??null,status:goal.status})),
        canonical_changes:progressed.canonical_changes??[],
        time_advanced:(after.runtime.time.day-save.runtime.time.day)*save.definition.ruleset.minutes_per_day+
          after.runtime.time.minute-save.runtime.time.minute,view:afterView});
    }
    const result=await executePlan(service,body,plan,startRoutine,plan.goals.length===1?(revisedSemantic??semantic)?.goal_spec?.repetition:undefined,
      Boolean(plan.goals.length===1&&(revisedSemantic??semantic)?.goal_spec?.repetition&&(revisedSemantic??semantic)?.goal_spec?.play_action==='perceive'),(revisedSemantic??semantic)?.goal_spec?.physical_intent,
      (revisedSemantic??semantic)?.goal_spec?.play_action);
    return result;});
 cache.set(key,{input:body.input,result:promise});if(cache.size>100)cache.delete(cache.keys().next().value!);try{return structuredClone(await promise);}catch(e){cache.delete(key);throw e;}
}

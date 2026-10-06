import {displayText} from '../shared/display.js';
import {createHash} from 'node:crypto';
import type {GameService} from '../server/service.js';
import {publicView} from '../core/state.js';
import {assert,GameError} from '../core/schema.js';
import {agentResult,type AgentResult,type UIAction} from './contracts.js';
import {createAgentPlan,fastPlan,PlanConversionError} from './planner.js';
import {checkChoiceOffer} from '../core/choice-offer.js';
import {classifyChoiceExecution} from '../core/choice-availability.js';
import type {AgentPlan,AtomicGoal,FutureIntent} from './plan-schema.js';
import {planGameRequest} from './game.js';
import {deriveWorldQuery} from './truth-query.js';
import {applyAssistantStyle} from '../ai/behavior.js';
import {relationshipCondition} from '../shared/relationship.js';
import {dueAssessment} from './future.js';
import {recentReferent} from '../core/recent-referent.js';
import {executeOpenWorldGoal,runContractPlan,canExecuteContractPlan,discoverContractCandidates} from './affordances.js';
import {compileGoalContract,hasMultipleClauses} from './goal-contract.js';
import {z} from 'zod';
import type {SavePackage} from '../core/schema.js';
import {currentTrace} from '../observability/trace.js';
import type {SemanticDecision} from './semantic-entry.js';
import {verifyGoalAlignment} from './goal-alignment.js';
import {failureReason} from '../ai/failures.js';

const observedConditionSchema=z.strictObject({value:z.boolean().nullable(),evidence:z.string().max(300).nullable()});

function childId(request:string,goal:string){const hex=createHash('sha256').update(request+':'+goal).digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);}
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
export interface PlanRequest {request_id:string;game_id:string;expected_revision:number;input:string;choice_offer_id?:string;end_conversation?:boolean}
function activeGoalResult(service:GameService,save:SavePackage,message:string):AgentResult{
 const plan=save.active_goal!.plan,question=save.active_goal!.waiting_question;
 return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',message,{presentation:plan.status==='waiting_for_player'?'handoff':
   ['blocked','failed'].includes(plan.status)?'failure':'assistant',plan_id:plan.plan_id,plan,
   results:plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??'',related_entity:goal.target_entities[0]??null,status:goal.status})),
   clarification:plan.status==='waiting_for_player'?question:null,view:service.project(save)});
}
async function continueActiveGoal(service:GameService,save:SavePackage,plan:AgentPlan,
 selection:Record<string,{candidate_id:string;source:'player'|'model'}>={},endConversation=false):Promise<AgentResult>{
 const start=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
 const outcome=await runContractPlan(service,save,plan,selection,true,endConversation);
 const end=outcome.save.runtime.time.day*outcome.save.definition.ruleset.minutes_per_day+outcome.save.runtime.time.minute;
 const question=outcome.save.active_goal?.waiting_question;
 const options=outcome.save.active_goal?.options??[];
 const completed=outcome.plan.goals.filter(goal=>goal.status==='completed').map(goal=>{
  const presence=goal.result?.observation?.value;
  return goal.normalized_goal+(presence==='present'?'（在场）':presence==='absent'?'（不在场）':'');
 });
 const remaining=outcome.plan.goals.filter(goal=>goal.status!=='completed').map(goal=>goal.normalized_goal);
 const message=outcome.plan.status==='waiting_for_player'?
  [completed.length?`已完成：${completed.join('；')}。`:null,
   remaining.length?`尚未完成：${remaining.join('；')}。`:null,
   question?`需要你决定：${question}`:null,
   options.length?`可选择：${options.map(option=>option.label).join('、')}`:null].filter(Boolean).join('\n'):
  outcome.reason+(options.length?'\n可选择：'+options.map(option=>option.label).join('、'):'');
 return {...activeGoalResult(service,outcome.save,message),presentation:outcome.failure?'failure':
   outcome.plan.status==='waiting_for_player'?'handoff':'assistant',time_advanced:end-start,
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
export function isActiveGoalControlInput(save:SavePackage,input:string){
 return Boolean(save.active_goal&&!['completed','failed'].includes(save.active_goal.plan.status)&&
   (pendingChoice(save,input)||/^(?:取消|放弃)当前目标[。！!]?$/u.test(input.trim())||
    /^(?:继续|恢复)(?:当前)?目标[。！!]?$/u.test(input.trim())));
}
/** Structured choices bypass a second free-text plan while retaining the normal candidate/runtime path. */
export async function handleChoiceInput(service:GameService,body:PlanRequest,offerId:string|null,legacy=false):Promise<AgentResult>{
 const save=await service.current();
 if(save.active_goal?.plan.plan_id===body.request_id&&save.active_goal.plan.contract?.original_intent===body.input)
  return activeGoalResult(service,save,'原选项目标已记录；这是当前真实进度。');
 assert(save.game_id===body.game_id&&save.state_revision===body.expected_revision,'状态已更新，请刷新后重试');
 if(offerId){
  const offer=save.last_turn?.choice_offers?.find(item=>item.id===offerId);
  if(!offer)throw new GameError('这个选项已失效，请查看当前场景的新选项。',409);
  const presented=service.project(save).last_turn?.choice_offers?.find(item=>item.id===offerId)?.text;
  if(offer.text!==body.input&&presented!==body.input)
   throw new GameError('选项文字与原始选项不一致，请刷新后重试。',409);
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
export async function executePlan(service:GameService,body:PlanRequest,plan:AgentPlan,startRoutine?:(body:any)=>Promise<any>):Promise<AgentResult>{
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
  if(active&&plan.goals.length!==1)return activeGoalResult(service,save,'已有未完成目标。请继续、取消当前目标，或先完成其他单步行动。');
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
   const story=outcome.plan.status==='completed'&&end>start?outcome.save.last_turn?.narrative:null;
   return agentResult(plan.goals[0].type,story??outcome.reason,{presentation:outcome.failure?'failure':story?'story':
     outcome.plan.status==='waiting_for_player'?'handoff':'assistant',plan_id:plan.plan_id,plan:outcome.plan,
     results:outcome.plan.goals.map(goal=>({goal_id:goal.goal_id,summary:goal.result?.summary??'',
       related_entity:goal.target_entities[0]??null,status:goal.status})),time_advanced:end-start,
     view:service.project(outcome.save)});
  }
  return continueActiveGoal(service,save,plan,{},Boolean(body.end_conversation));
 }
 const unavailable=plan.goals.find(goal=>goal.operation_hint&&goal.operation_hint!=='other'&&
   ['capability_gap','needs_binding','runtime_gap'].includes(goal.contract?.availability??'runtime_gap'));
 if(unavailable){
  const reason=unavailable.contract?.availability==='capability_gap'?'当前世界没有注册完成这项行动所需的能力。':
    unavailable.contract?.availability==='needs_binding'?'目标对象尚未唯一确认，世界状态没有改变。':
    '这项行动尚无可验证的执行或完成证据，世界状态没有改变。';
  plan.status='blocked';unavailable.status='blocked';unavailable.result={summary:reason};
  return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',reason,{presentation:'failure',
    plan_id:body.request_id,plan,view:service.project(save)});
 }
 if(plan.contract?.execution_mode==='staged'&&plan.contract.execution_availability!=='ready'&&
   plan.goals.length===1&&hasMultipleClauses(plan.contract.original_intent)){
  plan.status='blocked';
  return agentResult('MULTI_GOAL','完整连续目标尚未得到可验证的步骤契约，世界状态没有改变。',{
    plan_id:body.request_id,plan,view:service.project(save)});
 }
 const initialTime=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
 plan.plan_id=body.request_id;plan.status='running';let clarification:string|null=null,awarenessStatus:AgentResult['awareness_status'];const ui:UIAction[]=[],changes:string[]=[],calls:AgentResult['tool_calls']=[],futures:FutureIntent[]=[];
 for(const id of plan.execution_order){const goal=plan.goals.find(g=>g.goal_id===id)!;
  if(changes.length&&goal.side_effect_level==='world'&&await service.handoffBlocker()){
    clarification='眼前出现需要你决定的情况，后续行动已暂停。';goal.status='unresolved';goal.result={summary:clarification};break;
  }
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
  try {
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
    if(derived){const answer=await deriveWorldQuery(service,view,goal.normalized_goal);message=answer.message;awarenessStatus=answer.status;}
    else{if(result?.clarification)clarification=result.clarification;if(!result||result.clarification)throw Error(result?.message??'无法确认查询目标');message=result.message;ui.push(...result.ui_actions);awarenessStatus=result.awareness_status??awarenessStatus;}
   }else if(['FUTURE_INTENT','SCHEDULED_INTENT'].includes(goal.type)){
    assert(goal.target_entities.every(id=>view.entities.some(e=>e.id===id)),'目标不在玩家可知范围');
    const condition=dependencies.find(g=>g.type==='CONDITIONAL_INTENT')?.condition??null;
    const intent:FutureIntent={id:childId(body.request_id,id),plan_id:plan.plan_id,goal_id:id,created_at:{...view.time},source_text:body.input,target_date:goal.temporal_scope.day_offset>0?view.time.day+goal.temporal_scope.day_offset:goal.temporal_scope.scope==='scheduled'?view.time.day:null,time_window:goal.temporal_scope.window,target_entities:goal.target_entities,goal:goal.normalized_goal,condition,condition_expected:goal.branch!=='else',status:'planned',completed_by_request:null};
    await service.agentTransaction({...body,request_id:childId(body.request_id,'write:'+id),expected_revision:save.state_revision},{input:body.input,goal},next=>{next.future_intents??=[];assert(next.future_intents.length<500,'未来计划数量已达上限');next.future_intents.push(intent);});
    save=await service.current();futures.push(intent);changes.push('future_intent:'+intent.id);message='已记下你的打算：'+intent.goal+'。这不是已经发生的事实，也未获得对方同意。';
   }else if(goal.type==='LIST_FUTURE'){
    const entries=save.future_intents??[];futures.push(...entries);message=entries.length?entries.map(i=>i.status==='due'?dueAssessment(view,i):i.goal+'（'+i.status+'）').join('\n'):'目前没有登记的未来打算。';
   }else if(goal.type==='CANCEL_FUTURE'){
    const matches=(save.future_intents??[]).filter(i=>['planned','due'].includes(i.status)&&(!goal.target_entities.length||goal.target_entities.every(id=>i.target_entities.includes(id)))&&(!goal.temporal_scope.day_offset||i.target_date===view.time.day+goal.temporal_scope.day_offset));
    assert(matches.length===1,matches.length?'有多个打算符合，请补充目标、日期或具体活动。':'没有找到对应的未完成打算。');
    await service.agentTransaction({...body,request_id:childId(body.request_id,'cancel:'+id),expected_revision:save.state_revision},{cancel:matches[0].id},next=>{next.future_intents!.find(i=>i.id===matches[0].id)!.status='cancelled';});save=await service.current();changes.push('cancel_future:'+matches[0].id);message='已取消：'+matches[0].goal;
   }else if(goal.type==='EXECUTE_FUTURE'){
    const candidates=(save.future_intents??[]).filter(i=>i.status==='due'&&(!goal.target_entities.length||goal.target_entities.every(id=>i.target_entities.includes(id))));
    assert(candidates.length===1,'请明确一个已到期的打算；未到期计划不会提前执行');const intent=candidates[0];
    assert(!await service.handoffBlocker(),'当前前台事务或事件需要先处理');
    const player=view.entities.find(e=>e.id===view.player_id)!;assert(Number(player.components.condition?.hp??100)>0,'玩家当前状态不适合执行');
    assert(intent.target_entities.length===1,'此版本只执行目标明确的单人物社交尝试');
    const target=view.entities.find(e=>e.id===intent.target_entities[0]);assert(target&&target.components.location&&player.components.location&&target.components.location.location_id===player.components.location.location_id,'目标当前不在可确认的同一地点，请先处理位置或可用性');
    if(intent.condition){const truth=intent.condition.kind==='familiar'?relationshipCondition(view,target):intent.condition.kind==='present'?true:null;assert(truth!==null&&truth===intent.condition_expected,'当前已知条件不再满足，计划保留但未执行');}
    const action=await service.ai.interpret(save,intent.goal) as import('../shared/contracts.js').ActionInput;
    assert(['TALK','SOCIAL_INTERACT'].includes(action.type)&&action.target_id===target.id,'实际行动尚不能确认为对该人物的社交尝试，计划保留');
    const attempt=childId(body.request_id,'attempt:'+id);
    await service.turn({game_id:body.game_id,expected_revision:save.state_revision,request_id:attempt,action},undefined,undefined,undefined,false,intent.id);save=await service.current();
    assert(save.runtime.receipts.some(r=>r.id===attempt),'行动尚未提交');
    save=await service.current();changes.push('future_attempt:'+intent.id);message='已完成这项打算的实际社交尝试；对方的回应以当前回合为准，不代表约会或共同活动成功。';
   }else if(goal.type==='CONTINUE_ROUTINE'){
    assert(startRoutine,'此执行入口未配置后台生活任务');assert(!plan.execution_order.slice(plan.execution_order.indexOf(id)+1).some(other=>plan.goals.find(g=>g.goal_id===other)!.side_effect_level!=='none'),'后台生活任务之后不能继续执行写入目标');
    const job=await startRoutine({...body,request_id:childId(body.request_id,id),expected_revision:save.state_revision,action:{type:'CONTINUE_ROUTINE',parameters:{}}});message='已提交后台生活请求；任务状态：'+job.status;
   }else {
    assert(!goal.branch||!await service.handoffBlocker(),'当前前台事项尚未处理，条件行动不能抢占');
    const choiceSpeech=Boolean(body.choice_offer_id&&goal.type==='WORLD_SPEECH');
    const result=await service.turn({game_id:body.game_id,request_id:childId(body.request_id,id),expected_revision:save.state_revision,
      ...(body.end_conversation&&goal.type==='WORLD_SPEECH'?{end_conversation:true}:{}),
      ...(choiceSpeech?{action:{type:'TALK',target_id:goal.target_entities[0],parameters:{topic:goal.normalized_goal}}}:{input:goal.normalized_goal})},
      undefined,undefined,undefined,false,undefined,undefined,Boolean(body.choice_offer_id&&goal.type==='WORLD_ACTION'));
    save=await service.current();message=result.last_turn?.narrative??'行动已处理。';changes.push('world_action:'+id);
   }
   goal.result??={summary:message};goal.status='completed';calls.push({tool_id:goal.type,ok:true});
  }catch(error){const detail=(error as Error).message;service.logger.warn('agent.goal.failed',{module:'agent',metadata:{detail,goal:goal.goal_id,reason:failureReason(error)}});goal.status='failed';goal.result={summary:failureReason(error)!=='unknown'?
    '这次行动的模型响应未完整生成，当前目标尚未完成。请稍后从当前状态重试。':
    /未注册|parameters|schema|Invalid|FREEFORM_ACTION|relationship_delta|ConditionNode|条件必须由独立条件节点|框架校验|状态校验|canonical delta|contract/i.test(detail)?
      '这次行动没有正常完成，世界状态没有改变，可以安全重试。':displayText(detail,publicView(save).entities,publicView(save).locations)};calls.push({tool_id:goal.type,ok:false});if(goal.side_effect_level==='world'||clarification||plan.local_compound)break;}
 }
 for(const goal of plan.goals)if(goal.status==='pending')goal.status='skipped';
 save=await service.current();const delta=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute-initialTime;
 plan.status=plan.goals.some(g=>g.status==='failed'||g.status==='unresolved')?(plan.local_compound?'blocked':'partial'):'completed';
 const results=plan.goals.map(g=>({goal_id:g.goal_id,summary:g.result?.summary??'',related_entity:g.target_entities[0]??null,status:g.status}));
 const summaries=[...new Set(results.filter(r=>r.status!=='skipped').map(r=>r.summary).filter(Boolean))];
 const message=summaries.join('\n')+(delta===0&&!readOnlyPlan(plan.goals)?'\n当前世界时间没有推进。':'');
 const storyOnly=plan.status==='completed'&&plan.goals.every(g=>['WORLD_ACTION','WORLD_SPEECH'].includes(g.type));
 const incremental=summaries.filter(summary=>summary!==save.last_turn?.narrative&&
   !plan.goals.some(goal=>goal.result?.summary===summary&&goal.status==='completed'&&['WORLD_ACTION','WORLD_SPEECH'].includes(goal.type))).join('\n');
 const assistantMessage=incremental+(delta===0&&!readOnlyPlan(plan.goals)?'\n当前世界时间没有推进。':'');
 return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',storyOnly?message:applyAssistantStyle(save,assistantMessage),{presentation:storyOnly?'story':'assistant',clarification,...(awarenessStatus?{awareness_status:awarenessStatus}:{}),plan_id:plan.plan_id,plan,results,future_intents:futures,ui_actions:storyOnly?[]:oneNavigation(ui),canonical_changes:changes,tool_calls:calls,time_advanced:delta,view:publicView(save)});
}
const requests=new WeakMap<GameService,Map<string,{input:string;result:Promise<AgentResult>}>>();
export async function handleAgentInput(service:GameService,body:PlanRequest,startRoutine?:(body:any)=>Promise<any>,
 speechTargetId:string|null=null,confirmedSpeech=false,semantic?:SemanticDecision):Promise<AgentResult>{
 const cache=requests.get(service)??new Map();requests.set(service,cache);const key=body.game_id+':'+body.request_id,old=cache.get(key);
 if(old){assert(old.input===body.input,'请求 ID 已用于不同输入');return structuredClone(await old.result);}
  const promise=(async()=>{const view=await service.view();assert(view&&view.game_id===body.game_id,'游戏已切换');const save=await service.current();
    if(save.active_goal?.plan.plan_id===body.request_id&&save.active_goal.plan.contract?.original_intent===body.input)
      return activeGoalResult(service,save,'原请求已记录；这是当前真实进度。');
    if(save.state_revision!==body.expected_revision){const quick=fastPlan(view,body.input),conflict=new GameError('状态已更新，请重新规划',409) as GameError&{retry_policy?:'safe'|'manual'};conflict.retry_policy=quick&&readOnlyPlan(quick.goals)?'safe':'manual';throw conflict;}
    const active=save.active_goal;
    if(active&&!['completed','failed'].includes(active.plan.status)){
      if(/^(?:取消|放弃)当前目标[。！!]?$/u.test(body.input.trim())){
        await service.agentTransaction(body,{cancel_active_goal:active.plan.plan_id},next=>{
          const prior=next.active_goal!;prior.plan.status='failed';prior.waiting_question=null;prior.options=[];
          for(const goal of prior.plan.goals)if(goal.status!=='completed')goal.status='blocked';
        });
        return activeGoalResult(service,await service.current(),'已终止剩余目标；此前已提交的世界行动保持有效。');
      }
      const selection=pendingChoice(save,body.input);
      if(selection){
        const goal=active.plan.goals.find(entry=>entry.status==='waiting_for_player');
        if(goal)return continueActiveGoal(service,save,active.plan,{[goal.goal_id]:{candidate_id:selection.candidate_id,source:'player'}});
      }
      if(/^(?:继续|恢复)(?:当前)?目标[。！!]?$/u.test(body.input.trim()))
        return continueActiveGoal(service,save,active.plan);
    }
    let proposed:Awaited<ReturnType<typeof createAgentPlan>>;
    try{proposed=await createAgentPlan(service.ai,view,body.input,{recent_referent:recentReferent(save),recent_turns:(save.narrative_history??[]).slice(-2).map(entry=>({narrative:String(entry.narrative??'').slice(0,240),dialogue:entry.dialogue??null,speaker:entry.speaker??null})),recent_actions:(save.action_facts??[]).slice(-3).map(entry=>({input:String(entry.input??'').slice(0,160),facts:entry.facts,target_id:entry.target_id}))},confirmedSpeech||semantic?.kind==='world_action');}
    catch(error){
      if(!(error instanceof PlanConversionError))throw error;
      service.logger.warn('agent.plan_conversion.failed',{module:'agent',metadata:{reason:error.reason,original_input:error.originalInput,proposed_goals:error.proposedGoals}});
      return agentResult('WORLD_ACTION',`原请求“${error.originalInput}”未能转换成完整行动计划：${error.reason.slice(0,160)}。世界状态没有改变。`,{presentation:'failure',view});
    }
    if(semantic?.kind==='world_action'&&readOnlyPlan(proposed.goals)){
      const answer=await deriveWorldQuery(service,view,body.input);
      return agentResult('WORLD_QUERY',answer.message,{presentation:'assistant',awareness_status:answer.status,view});
    }
    if(semantic?.kind==='world_action'&&!proposed.goals.some(goal=>['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(goal.type)))
      return agentResult('CLARIFICATION','我理解你想让角色实际行动，但这次没有形成可验证的行动方案。世界没有改变；请补充你想尝试的具体做法。',{view});
    // Conversation context may fill a missing listener only after the semantic planner has
    // classified this input as speech. It never turns a purchase or movement into TALK.
    if(speechTargetId&&proposed.goals.length===1&&proposed.goals[0].type==='WORLD_SPEECH'&&
      !proposed.goals[0].referent&&!proposed.goals[0].target_entities.length){
      const listener=view.entities.find(entity=>entity.id===speechTargetId&&entity.components.character);
      if(listener?.components.identity?.name)proposed.goals[0].referent=String(listener.components.identity.name);
    }
    const plan=compileGoalContract(view,proposed,{kind:'manual',text:body.input});
    if(semantic?.kind==='world_action'){
      let alignment:Awaited<ReturnType<typeof verifyGoalAlignment>>=null;
      try{alignment=await verifyGoalAlignment(service,body.input,plan);}catch(error){
        service.logger.warn('agent.goal_alignment.failed',{module:'agent',metadata:{reason:failureReason(error)}});
      }
      if(alignment?.verdict!=='aligned')return agentResult('WORLD_ACTION',
        alignment?.verdict==='substituted'?'拟执行的行动与你的请求不同，世界没有改变。':
        alignment?.verdict==='incomplete'?'目前只规划出准备步骤，尚未规划你要求的最终尝试；世界没有改变。':
        '目前无法确认计划符合你的请求，世界没有改变。',{presentation:'failure',view});
    }
    currentTrace()?.info('agent.goal_compiled',{metadata:{source:'manual',
      goal_kinds:plan.goals.map(goal=>goal.contract?.completion.kind??'unsupported'),
      availability:plan.contract?.execution_availability??null,goal_count:plan.goals.length}});
    const result=await executePlan(service,body,plan,startRoutine);
    if(active&&!['completed','failed'].includes(active.plan.status)&&result.plan_id!==active.plan.plan_id&&
      (await service.current()).active_goal?.plan.plan_id===active.plan.plan_id)
      result.message+='\n此前的连续目标仍保持暂停；可以继续目标或取消当前目标。';
    return result;})();
 cache.set(key,{input:body.input,result:promise});if(cache.size>100)cache.delete(cache.keys().next().value!);try{return structuredClone(await promise);}catch(e){cache.delete(key);throw e;}
}

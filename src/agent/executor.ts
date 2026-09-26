import {displayText} from '../shared/display.js';
import {createHash} from 'node:crypto';
import type {GameService} from '../server/service.js';
import {publicView} from '../core/state.js';
import {assert,GameError} from '../core/schema.js';
import {agentResult,type AgentResult,type UIAction} from './contracts.js';
import {createAgentPlan} from './planner.js';
import type {AgentPlan,AtomicGoal,FutureIntent} from './plan-schema.js';
import {planGameRequest} from './game.js';
import {applyAssistantStyle} from '../ai/behavior.js';
import {relationshipCondition} from '../shared/relationship.js';
import {dueAssessment} from './future.js';
import {recentReferent} from '../core/recent-referent.js';

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
export interface PlanRequest {request_id:string;game_id:string;expected_revision:number;input:string}
export async function executePlan(service:GameService,body:PlanRequest,plan:AgentPlan,startRoutine?:(body:any)=>Promise<any>):Promise<AgentResult>{
 let save=await service.current();
 if(save.game_id!==body.game_id||save.state_revision!==body.expected_revision){
  // Nothing was applied yet, so a plan that only reads may be replayed once by the client. A plan that could
  // write stays manual. The classification travels with the error instead of being re-guessed from the text.
  const conflict=new GameError('状态已更新，请重新规划',409) as GameError&{retry_policy?:'safe'|'manual'};
  conflict.retry_policy=readOnlyPlan(plan.goals)?'safe':'manual';throw conflict;
 }
 const initialTime=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
 plan.plan_id=body.request_id;plan.status='running';let clarification:string|null=null,awarenessStatus:AgentResult['awareness_status'];const ui:UIAction[]=[],changes:string[]=[],calls:AgentResult['tool_calls']=[],futures:FutureIntent[]=[];
 for(const id of plan.execution_order){const goal=plan.goals.find(g=>g.goal_id===id)!;
  const dependencies=goal.depends_on.map(id=>plan.goals.find(g=>g.goal_id===id)!);
  if(dependencies.some(g=>g.status!=='completed')){goal.status='skipped';goal.result={summary:'前置目标未成功，未执行。'};continue;}
  if(goal.branch){const parent=dependencies.find(g=>g.type==='CONDITIONAL_INTENT');if(!parent||parent.result?.condition===null||parent.result?.condition===undefined){goal.status='unresolved';goal.result={summary:'条件未知，未执行任何分支。'};continue;}if(parent.result.condition!==(goal.branch==='then')){goal.status='skipped';goal.result={summary:'条件不匹配，跳过此分支。'};continue;}}
  goal.status='ready';goal.status='running';
  try {
   const view=publicView(save);let message='';
   if(goal.type==='CONDITIONAL_INTENT'){
    const c=goal.condition!,target=view.entities.find(e=>e.id===c.entity_id);const value=!target?null:c.kind==='familiar'?relationshipCondition(view,target):c.kind==='present'?(target.components.location&&view.entities.find(e=>e.id===view.player_id)?.components.location?target.components.location.location_id===view.entities.find(e=>e.id===view.player_id)!.components.location.location_id:null):null;
    goal.result={condition:value,summary:value===null?'你目前无法确定这个条件是否成立。':value?'根据你可知的关系或位置，条件成立。':'根据当前可知信息，条件不成立。'};
   }else if(['WORLD_QUERY','WORLD_LOOKUP','UI_NAVIGATION'].includes(goal.type)){
    const result=planGameRequest(view,goal.normalized_goal);if(result?.clarification)clarification=result.clarification;if(!result||result.clarification)throw Error(result?.message??'无法确认查询目标');
    message=result.message;ui.push(...result.ui_actions);awarenessStatus=result.awareness_status??awarenessStatus;
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
    const result=await service.turn({...body,request_id:childId(body.request_id,id),expected_revision:save.state_revision,input:goal.normalized_goal});
    save=await service.current();message=result.last_turn?.narrative??'行动已处理。';changes.push('world_action:'+id);
   }
   goal.result??={summary:message};goal.status='completed';calls.push({tool_id:goal.type,ok:true});
  }catch(error){const detail=(error as Error).message;service.logger.warn('agent.goal.failed',{module:'agent',metadata:{detail,goal:goal.goal_id}});goal.status='failed';goal.result={summary:/未注册|parameters|schema|Invalid|FREEFORM_ACTION|relationship_delta/.test(detail)?'这次行动未能完成，世界状态没有改变。请重试或换一种说法。':displayText(detail,publicView(save).entities,publicView(save).locations)};calls.push({tool_id:goal.type,ok:false});}
 }
 save=await service.current();const delta=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute-initialTime;
 plan.status=plan.goals.some(g=>g.status==='failed'||g.status==='unresolved')?'partial':'completed';
 const results=plan.goals.map(g=>({goal_id:g.goal_id,summary:g.result?.summary??'',related_entity:g.target_entities[0]??null,status:g.status}));
 const message=results.filter(r=>r.status!=='skipped').map(r=>r.summary).filter(Boolean).join('\n')+(delta===0?'\n当前世界时间没有推进。':'');
 const storyOnly=plan.status==='completed'&&plan.goals.every(g=>['WORLD_ACTION','WORLD_SPEECH'].includes(g.type));
 return agentResult(plan.goals.length===1?plan.goals[0].type:'MULTI_GOAL',storyOnly||plan.goals.every(g=>g.type==='WORLD_ACTION')?message:applyAssistantStyle(save,message),{presentation:storyOnly?'story':'assistant',clarification,...(awarenessStatus?{awareness_status:awarenessStatus}:{}),plan_id:plan.plan_id,plan,results,future_intents:futures,ui_actions:storyOnly?[]:oneNavigation(ui),canonical_changes:changes,tool_calls:calls,time_advanced:delta,view:publicView(save)});
}
const requests=new WeakMap<GameService,Map<string,{input:string;result:Promise<AgentResult>}>>();
export async function handleAgentInput(service:GameService,body:PlanRequest,startRoutine?:(body:any)=>Promise<any>):Promise<AgentResult>{
 const cache=requests.get(service)??new Map();requests.set(service,cache);const key=body.game_id+':'+body.request_id,old=cache.get(key);
 if(old){assert(old.input===body.input,'请求 ID 已用于不同输入');return structuredClone(await old.result);}
 const promise=(async()=>{const view=await service.view();assert(view&&view.game_id===body.game_id,'游戏已切换');const save=await service.current();const plan=await createAgentPlan(service.ai,view,body.input,{recent_referent:recentReferent(save),recent_turns:(save.narrative_history??[]).slice(-2).map(entry=>({narrative:String(entry.narrative??'').slice(0,240),dialogue:entry.dialogue??null,speaker:entry.speaker??null})),recent_actions:(save.action_facts??[]).slice(-3).map(entry=>({input:String(entry.input??'').slice(0,160),facts:entry.facts,target_id:entry.target_id}))});return executePlan(service,body,plan,startRoutine);})();
 cache.set(key,{input:body.input,result:promise});if(cache.size>100)cache.delete(cache.keys().next().value!);try{return structuredClone(await promise);}catch(e){cache.delete(key);throw e;}
}

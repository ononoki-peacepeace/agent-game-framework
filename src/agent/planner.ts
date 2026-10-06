import {randomUUID} from 'node:crypto';
import type {PublicView} from '../shared/contracts.js';
import {blueprintSchema,type AgentPlan,type GoalInput} from './plan-schema.js';
import {resolveEntities} from './entities.js';
import {planGameRequest} from './game.js';
import {localDestination,localDurationIntent,isPhysicalAction,requestsItemRelocation} from '../core/freeform.js';
import {isActivePerception} from './perception.js';
import type {AIRuntime} from '../ai/runtime.js';
import {hasMultipleClauses} from './goal-contract.js';

export const hasUserCondition=(text:string)=>/如果|假如|要是|(?:^|[，,。；;])若(?:是)?|只要|当.{1,60}时|除非|满足.{1,40}才|.{1,40}的话(?:就|[，,])|趁.{1,60}(?:时|候|[，,])|等.{1,60}(?:就|[，,])|.{1,40}一.{1,30}就/.test(text);
function conditionalActionText(text:string){
  const comma=text.match(/^[^，,；;]+[，,；;]\s*(?:我就|就|我)?\s*(.+)$/);
  if(comma)return comma[1].trim();
  const timing=text.match(/^(?:趁|当|等|如果|假如|要是|只要).{1,100}?(?:的时候|之时|时|我就|就)\s*(.+)$/);
  if(timing?.[1]?.trim())return timing[1].trim();
  const onset=text.match(/^.{1,50}?一.{1,50}?(?:我)?就\s*(.+)$/);
  return onset?.[1]?.trim()||text;
}
const temporal=(text:string):GoalInput['temporal_scope']=>({scope:/明天|后天|之后|打算|计划|以后/.test(text)?(/上午|下午|晚上|放学后/.test(text)?'scheduled':'future'):'now',day_offset:/后天/.test(text)?2:/明天/.test(text)?1:0,window:/放学后/.test(text)?'after_school':/上午/.test(text)?'morning':/下午/.test(text)?'afternoon':/晚上/.test(text)?'evening':'any'});
export function validatePlan(raw:unknown):AgentPlan {
 const {goals}=blueprintSchema.parse(raw),ids=new Set(goals.map(g=>g.goal_id));if(ids.size!==goals.length)throw Error('重复 goal_id');
 for(const g of goals){if(g.depends_on.some(id=>!ids.has(id)||id===g.goal_id))throw Error('无效依赖');if(g.branch&&!g.depends_on.some(id=>goals.find(x=>x.goal_id===id)?.type==='CONDITIONAL_INTENT'))throw Error('分支缺少条件依赖');if(g.type==='CONDITIONAL_INTENT'&&!g.condition)throw Error('缺少条件');if(g.condition&&g.type!=='CONDITIONAL_INTENT')throw Error('条件必须由独立条件节点判定');if(['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(g.type)&&g.temporal_scope.scope!=='now')throw Error('未来意图不能作为当前行动');}
 const order:string[]=[],remaining=new Set(ids);while(remaining.size){const ready=goals.filter(g=>remaining.has(g.goal_id)&&g.depends_on.every(id=>order.includes(id)));if(!ready.length)throw Error('依赖图存在循环');for(const g of ready){order.push(g.goal_id);remaining.delete(g.goal_id);}}
 return {plan_id:randomUUID(),goals:goals.map(g=>({...g,status:'pending',side_effect_level:['FUTURE_INTENT','SCHEDULED_INTENT','CANCEL_FUTURE'].includes(g.type)?'player_plan':['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(g.type)?'world':'none',requires_confirmation:false})),dependencies:goals.flatMap(g=>g.depends_on.map(from=>({from,to:g.goal_id}))),execution_order:order,ui_policy:'one_primary_panel',status:'pending'};
}
export class PlanConversionError extends Error {
  constructor(readonly originalInput:string,readonly reason:string,readonly proposedGoals:unknown){
    super(`无法转换原始请求的完整计划：${reason}`);
    this.name='PlanConversionError';
  }
}
const conversionReason=(error:unknown)=>error instanceof Error&&error.name==='ZodError'
  ?'步骤结构不符合规划格式':error instanceof Error?error.message:String(error);
/** Only a bounded, same-scene sequence may share one candidate. Unknown travel and branches stay staged. */
export function localCompoundSteps(view:PublicView,text:string,plan:AgentPlan):string[]|null {
 if(hasUserCondition(text)||/明天|后天|放学后|(?:先|再).{0,30}(?:如果|遇到)/.test(text))return null;
 const playerLocation=view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id;
 if(resolveEntities(view,text).matches.some(entity=>entity.id!==view.player_id&&Boolean(entity.components.character)))return null;
 if(view.locations.some(location=>location.id!==playerLocation&&text.includes(location.name)))return null;
 const single=plan.goals.length===1&&plan.goals[0].type==='WORLD_ACTION';
 const explicit=single?text.split(/[，,；;]\s*(?:再|然后|接着)/).map(step=>step.trim()).filter(Boolean):[];
 const base=explicit.length>=2?explicit:plan.execution_order.map(id=>plan.goals.find(goal=>goal.goal_id===id)!.normalized_goal.trim());
 const source=text.replace(/[\s，,。；;！!？?]/g,'');
 if(explicit.length<2&&!base.every(step=>source.includes(step.replace(/[\s，,。；;！!？?]/g,''))))return null;
 const steps=base.flatMap(step=>{
   const destination=localDestination(step),at=destination?step.indexOf(destination):-1;
   if(at<0)return [step];
   const after=step.slice(at+destination!.length).replace(/[。！!？?]+$/,'').trim();
   return /^(?:待|坐|站|歇|休息|伸|整理)/.test(after)?[step.slice(0,at+destination!.length),after]:[step];
 });
 if(steps.length<2||steps.length>4||(!single&&plan.goals.some(goal=>goal.type!=='WORLD_ACTION'))||
    plan.goals.some(goal=>goal.temporal_scope.scope!=='now'||goal.condition||goal.branch))return null;
 for(const step of steps){
   if(!step||hasUserCondition(step)||isPhysicalAction(step))return null;
   if(/买|卖|交易|询问|邀请|打听|寻找|调查|探索|等待.{0,30}(?:回应|回复)/.test(step))return null;
   if(/^(?:我)?(?:去|前往|沿|乘车|坐车|搭车)/.test(step)&&!localDestination(step))return null;
 }
 return steps;
}
// Fast paths recognize semantic slots, not a conjunction split. Uncovered compositions use schema-bound LLM planning.
export function fastPlan(view:PublicView,text:string):AgentPlan|null {
 const goals:GoalInput[]=[],targets=resolveEntities(view,text),target=targets.confident?targets.matches[0]:null;
 const add=(type:GoalInput['type'],goal:string,extra:Partial<GoalInput>={})=>{const g:GoalInput={goal_id:'g'+(goals.length+1),type,normalized_goal:goal,depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:target?[target.id]:[],...extra};goals.push(g);return g;};
 if(isActivePerception(text)&&!hasUserCondition(text)){
   // A named person's presence is a typed observation goal. Defer its meaning
   // to the semantic planner instead of forcing the generic look-around path.
   if(targets.matches.some(entity=>entity.components.character&&entity.id!==view.player_id)&&
     /在不在|是否在|有没有在|在场|在哪里/.test(text))return null;
   add('WORLD_ACTION',text);return validatePlan({goals});
 }
 if(isPhysicalAction(text)&&!hasUserCondition(text)){add('WORLD_ACTION',text);return validatePlan({goals});}
 if(localDurationIntent(text,{day:view.time.day,minute:view.time.minute},view.minutes_per_day)&&!hasUserCondition(text)){add('WORLD_ACTION',text,{target_entities:[]});return validatePlan({goals});}
 if(localDestination(text)&&!hasUserCondition(text)&&
   !view.locations.some(location=>text.includes(location.name))){add('WORLD_ACTION',text,{target_entities:[]});return validatePlan({goals});}
 // Storing an item and preparing the next activity is one local player action. Keep it atomic;
 // a model-split plan could otherwise commit the first microstep before storage fails.
 if(requestsItemRelocation(text)&&!hasUserCondition(text)&&
    !/然后|接着|再去|先.{1,100}再|[；;]/.test(text)&&
    !view.locations.some(location=>location.id!==view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id&&text.includes(location.name))&&
    !resolveEntities(view,text).matches.some(entity=>entity.id!==view.player_id&&Boolean(entity.components.character))){
   add('WORLD_ACTION',text,{target_entities:[]});return validatePlan({goals});
 }
 if(/执行|履行/.test(text)&&/计划|打算/.test(text)){add('EXECUTE_FUTURE',text);return validatePlan({goals});}
 if(/(?:查看|有哪些|有什么|列出).*(?:计划|打算)|(?:未来|明天).*(?:计划|打算).*[?？]/.test(text)){add('LIST_FUTURE',text);return validatePlan({goals});}
 if(/算了|取消|不找|不约|不去了/.test(text)&&/明天|后天|计划|打算|取消/.test(text)){add('CANCEL_FUTURE',text,{temporal_scope:temporal(text)});return validatePlan({goals});}
 if(target&&/^(我)?(现在)?(对|向|跟|和).{1,40}(说|告诉|问)[：:「“]/.test(text)){add('WORLD_SPEECH',text);return validatePlan({goals});}
 const conditional=hasUserCondition(text),future=/明天|后天|之后|打算|以后/.test(text);
 const moneyClause=text.split(/[，,；;]|而且|并且|同时/).find(clause=>/多少钱|余额|资金/.test(clause));
 if(moneyClause&&resolveEntities(view,moneyClause).matches.every(entity=>entity.id===view.player_id))
   add('WORLD_QUERY',moneyClause,{target_entities:[]});
 const relationship=/关系|比较熟|够熟|朋友|熟悉/.test(text);
 let relation:GoalInput|undefined;
 if(relationship&&(conditional||/什么关系|想知道|查询|怎么样/.test(text)))relation=add('WORLD_QUERY',target?'我和'+String(target.components.identity?.name)+'是什么关系？':'我和谁是什么关系？');
 if(conditional){
  if(/除非/.test(text))return null;
  if(!target||!/关系|够熟|比较熟|在这里|在场|在附近|就在这里|喜欢|爱我|暗恋|心里/.test(text))return null;
  const cond=add('CONDITIONAL_INTENT','判断玩家可知条件',{depends_on:relation?[relation.goal_id]:[],condition:{kind:/喜欢|爱我|暗恋|心里/.test(text)?'unknown':/现在在这里|在附近|在场|就在这里|在这里/.test(text)?'present':relationship?'familiar':'unknown',entity_id:target.id,description:text.split(/[，,；;]/)[0]}});
  const split=text.split(/；?\s*如果还不够熟[，,]?|否则[，,]?|不然[，,]?/),thenText=split[0],scope=temporal(thenText);
  add(scope.scope==='now'?'WORLD_ACTION':scope.scope==='scheduled'?'SCHEDULED_INTENT':'FUTURE_INTENT',thenText.replace(/^[\s\S]*?(?:如果|假如|要是|若是|若|只要|除非|当)[^，,；;]*[，,]/,'').replace(/^(就|那么)/,'').replace(/她|他/g,String(target.components.identity?.name)),{depends_on:[cond.goal_id],branch:'then',temporal_scope:scope});
  if(split[1]){const elseScope=temporal(split[1]);add(elseScope.scope==='now'?'WORLD_ACTION':elseScope.scope==='scheduled'?'SCHEDULED_INTENT':'FUTURE_INTENT',split[1].replace(/她|他/g,String(target.components.identity?.name)),{depends_on:[cond.goal_id],branch:'else',temporal_scope:elseScope});}
  // Only the bounded supported invitation/training forms use this path.
  return /[，,]/.test(thenText)?validatePlan({goals}):null;
 }
 if(future){if((text.match(/明天|后天|之后/g)??[]).length>1||/然后|并且|顺便|同时/.test(text))return null;if(targets.matches.length>1)return null;add(temporal(text).scope==='scheduled'?'SCHEDULED_INTENT':'FUTURE_INTENT',text,{temporal_scope:temporal(text)});return validatePlan({goals});}
 if(goals.length&& !/然后|顺便|并且|再去|现在去|任务|物品|技能|背包|在哪/.test(text))return validatePlan({goals});
 const simple=planGameRequest(view,text);
 if(simple&&!/而且|然后|并且|同时|顺便/.test(text)){add(simple.intent as GoalInput['type'],text);return validatePlan({goals});}
 // An exact public destination is an unambiguous registered MOVE request. Other
 // verb phrases still go to semantic planning rather than a prefix classifier.
 const directDestination=view.locations.filter(location=>
   new RegExp(`^(?:我)?(?:现在)?(?:去|前往|移动到|走到)\\s*${location.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[。！!]?$`).test(text.trim()));
 if(directDestination.length===1&&!conditional&&!future){
   add('WORLD_ACTION',text,{operation_hint:'move',referent:directDestination[0].name,target_entities:[]});
   return validatePlan({goals});
 }
 if(target?.components.character&&/^(?:我)?(?:现在)?去找/.test(text)&&!conditional&&!future&&
   !/而且|然后|并且|同时|顺便|[；;]/.test(text)){
   add('WORLD_ACTION',text);return validatePlan({goals});
 }
 if(/^(继续日常|继续生活|继续按.*计划生活)[。！!]?$/u.test(text)){add('CONTINUE_ROUTINE',text);return validatePlan({goals});}
 // A purpose marker after a movement verb means travel is only the first step of a sustained goal, so the turn
 // enters bounded goal execution. A bare destination ("去市场") stays a single move, and no place name is special-cased.
 if(!conditional&&!future&&/^(我)?(现在)?(去|前往|走到|出门|走|移动|往|朝)/.test(text)&&/(看看|看一圈|看一眼|逛逛|逛一逛|转一转|转转|走走|找找|调查|探查|侦查|查看|参观|了解一下|探索|踩点)/.test(text)&&!/(说|问|告诉|邀请)/.test(text)){add('WORLD_GOAL',text);return validatePlan({goals});}
 // An uncovered world action needs semantic planning. A verb prefix cannot decide which
 // registered tool is authorized, or which completion receipt the player's goal requires.
 return null;
}
export async function createAgentPlan(ai:AIRuntime,view:PublicView,text:string,recentScene?:unknown,forceSemantic=false){
 // A discourse connector only opts into semantic planning; it never determines the steps itself.
 const sequential=hasMultipleClauses(text);
 const quick=sequential||forceSemantic?null:fastPlan(view,text);if(quick)return quick;
 const proposal=await ai.planGoals(view,text,blueprintSchema,recentScene);
 let raw:ReturnType<typeof blueprintSchema.parse>;
 try{raw=blueprintSchema.parse(proposal);}catch(error){
   throw new PlanConversionError(text,conversionReason(error),proposal);
 }
 try{
 // Models sometimes attach a condition directly to an action. Compile that proposal into the existing
 // condition/dependency graph before validating it; the player never needs to know the graph format.
 const goals=[...raw.goals] as GoalInput[];
 // Preserve every proposed step. The executor may run eligible local steps in one candidate.
 // A single model goal must retain the full player intent. A shortened first motion is not completion.
 if(!hasUserCondition(text)&&goals.length===1){
   const only=goals[0];
   if(only.type==='WORLD_GOAL'&&!view.locations.some(location=>text.includes(location.name))&&only.normalized_goal.trim()!==text.trim())only.type='WORLD_ACTION';
   if(only.type==='WORLD_ACTION'&&only.normalized_goal.trim()!==text.trim())only.normalized_goal=text.trim();
 }
 if(hasUserCondition(text)&&!goals.some(goal=>goal.type==='CONDITIONAL_INTENT')){
   const action=goals.find(goal=>['WORLD_ACTION','WORLD_SPEECH'].includes(goal.type));
   if(action){
     const candidate=resolveEntities(view,text),target=candidate.confident?candidate.matches[0]?.id:view.player_id;
     const actionText=conditionalActionText(text);
     const condition=action.condition??{kind:'public_fact' as const,entity_id:target??view.player_id,description:(actionText===text?text.split(/[，,；;]/)[0]:text.slice(0,text.lastIndexOf(actionText))).replace(/[，,；;\s]+$/,'').slice(0,500)};
     const id='condition_'+action.goal_id;
     goals.unshift({goal_id:id,type:'CONDITIONAL_INTENT',normalized_goal:'判断当前可知条件',depends_on:[...action.depends_on],condition,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:action.target_entities});
     action.normalized_goal=conditionalActionText(action.normalized_goal);
     action.depends_on=[id];action.condition=null;action.branch='then';
   }
 }
 for(const goal of goals){
   if(['WORLD_ACTION','WORLD_SPEECH'].includes(goal.type)&&goal.branch==='then'&&hasUserCondition(goal.normalized_goal))goal.normalized_goal=conditionalActionText(goal.normalized_goal);
   if(['WORLD_ACTION','WORLD_SPEECH'].includes(goal.type)&&goal.target_entities.length===1){
     const target=view.entities.find(entity=>entity.id===goal.target_entities[0]);
     if(target?.components.identity?.name)goal.normalized_goal=goal.normalized_goal.replace(/她|他|\bta\b|对方/gi,String(target.components.identity.name));
   }
   if(goal.type==='CONDITIONAL_INTENT'&&goal.condition?.kind==='observed_event'&&
      !goal.depends_on.some(id=>goals.some(previous=>previous.goal_id===id&&['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL'].includes(previous.type)))){
     goal.condition={...goal.condition,kind:'public_fact'};
   }
 }
 const plan=validatePlan({goals});
 const compound=localCompoundSteps(view,text,plan);
 if(compound)plan.local_compound={steps:compound};
 if(hasUserCondition(text)&&!plan.goals.some(goal=>goal.type==='CONDITIONAL_INTENT'))throw Error('条件行动未能完整规划；世界状态没有改变，请重试。');
 if(plan.goals.some(goal=>goal.type==='CONDITIONAL_INTENT'&&goal.condition?.kind==='observed_event'&&!goal.depends_on.some(id=>plan.goals.find(previous=>previous.goal_id===id)?.side_effect_level==='world')))throw Error('事件条件必须在前置世界行动之后判断；世界状态没有改变，请重试。');
 if(!hasUserCondition(text)&&plan.goals.some(g=>g.type==='CONDITIONAL_INTENT')){
 const removed=new Set(plan.goals.filter(g=>g.type==='CONDITIONAL_INTENT'||g.branch==='else').map(g=>g.goal_id));
 const goals=plan.goals.filter(g=>!removed.has(g.goal_id)).map(({status,side_effect_level,requires_confirmation,...g})=>({...g,depends_on:g.depends_on.filter(id=>!removed.has(id)),branch:null,condition:null}));
 return validatePlan({goals});
 }
 return plan;
 }catch(error){
   if(error instanceof PlanConversionError)throw error;
   throw new PlanConversionError(text,conversionReason(error),raw.goals);
 }
}

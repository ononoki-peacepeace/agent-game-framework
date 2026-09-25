import {randomUUID} from 'node:crypto';
import type {PublicView} from '../shared/contracts.js';
import {blueprintSchema,type AgentPlan,type GoalInput} from './plan-schema.js';
import {resolveEntities} from './entities.js';
import {planGameRequest} from './game.js';
import type {AIRuntime} from '../ai/runtime.js';

export const hasUserCondition=(text:string)=>/如果|假如|要是|(?:^|[，,。；;])若(?:是)?|只要|当.{1,60}时|除非|满足.{1,60}才/.test(text);
const temporal=(text:string):GoalInput['temporal_scope']=>({scope:/明天|后天|之后|打算|计划|以后/.test(text)?(/上午|下午|晚上|放学后/.test(text)?'scheduled':'future'):'now',day_offset:/后天/.test(text)?2:/明天/.test(text)?1:0,window:/放学后/.test(text)?'after_school':/上午/.test(text)?'morning':/下午/.test(text)?'afternoon':/晚上/.test(text)?'evening':'any'});
export function validatePlan(raw:unknown):AgentPlan {
 const {goals}=blueprintSchema.parse(raw),ids=new Set(goals.map(g=>g.goal_id));if(ids.size!==goals.length)throw Error('重复 goal_id');
 for(const g of goals){if(g.depends_on.some(id=>!ids.has(id)||id===g.goal_id))throw Error('无效依赖');if(g.branch&&!g.depends_on.some(id=>goals.find(x=>x.goal_id===id)?.type==='CONDITIONAL_INTENT'))throw Error('分支缺少条件依赖');if(g.type==='CONDITIONAL_INTENT'&&!g.condition)throw Error('缺少条件');if(g.condition&&g.type!=='CONDITIONAL_INTENT')throw Error('条件必须由独立条件节点判定');if(['WORLD_ACTION','WORLD_SPEECH','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(g.type)&&g.temporal_scope.scope!=='now')throw Error('未来意图不能作为当前行动');}
 const order:string[]=[],remaining=new Set(ids);while(remaining.size){const ready=goals.filter(g=>remaining.has(g.goal_id)&&g.depends_on.every(id=>order.includes(id)));if(!ready.length)throw Error('依赖图存在循环');for(const g of ready){order.push(g.goal_id);remaining.delete(g.goal_id);}}
 return {plan_id:randomUUID(),goals:goals.map(g=>({...g,status:'pending',side_effect_level:['FUTURE_INTENT','SCHEDULED_INTENT','CANCEL_FUTURE'].includes(g.type)?'player_plan':['WORLD_ACTION','WORLD_SPEECH','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(g.type)?'world':'none',requires_confirmation:false})),dependencies:goals.flatMap(g=>g.depends_on.map(from=>({from,to:g.goal_id}))),execution_order:order,ui_policy:'one_primary_panel',status:'pending'};
}
// Fast paths recognize semantic slots, not a conjunction split. Uncovered compositions use schema-bound LLM planning.
export function fastPlan(view:PublicView,text:string):AgentPlan|null {
 const goals:GoalInput[]=[],targets=resolveEntities(view,text),target=targets.confident?targets.matches[0]:null;
 const add=(type:GoalInput['type'],goal:string,extra:Partial<GoalInput>={})=>{const g:GoalInput={goal_id:'g'+(goals.length+1),type,normalized_goal:goal,depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:target?[target.id]:[],...extra};goals.push(g);return g;};
 if(/执行|履行/.test(text)&&/计划|打算/.test(text)){add('EXECUTE_FUTURE',text);return validatePlan({goals});}
 if(/(?:查看|有哪些|有什么|列出).*(?:计划|打算)|(?:未来|明天).*(?:计划|打算).*[?？]/.test(text)){add('LIST_FUTURE',text);return validatePlan({goals});}
 if(/算了|取消|不找|不约|不去了/.test(text)&&/明天|后天|计划|打算|取消/.test(text)){add('CANCEL_FUTURE',text,{temporal_scope:temporal(text)});return validatePlan({goals});}
 if(target&&/^(我)?(现在)?(对|向|跟|和).{1,40}(说|告诉|问)[：:「“]/.test(text)){add('WORLD_SPEECH',text);return validatePlan({goals});}
 const conditional=hasUserCondition(text),future=/明天|后天|之后|打算|以后/.test(text);
 if(/多少钱|余额|资金/.test(text))add('WORLD_QUERY','我现在有多少钱？',{target_entities:[]});
 const relationship=/关系|比较熟|够熟|朋友|熟悉/.test(text);
 let relation:GoalInput|undefined;
 if(relationship&&(conditional||/什么关系|想知道|查询|怎么样/.test(text)))relation=add('WORLD_QUERY',target?'我和'+String(target.components.identity?.name)+'是什么关系？':'我和谁是什么关系？');
 if(conditional){
  if(/除非/.test(text))return null;
  if(!target)return null;
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
 if(/^(继续日常|继续生活|继续按.*计划生活)[。！!]?$/u.test(text)){add('CONTINUE_ROUTINE',text);return validatePlan({goals});}
 if(!conditional&&!future&&!/而且|然后|并且|同时|顺便|[；;]/.test(text)&&/^(我)?(现在)?(狠狠|轻轻|用力|去|找|向|对|和|跟|等待|等|观察|检查|买|卖|邀请|训练|说|揍|打|踢|抱|拥抱|扔|丢|爬|喊|大叫|出门|走|移动|靠近)/.test(text)){add(/说|告诉/.test(text)?'WORLD_SPEECH':'WORLD_ACTION',text);return validatePlan({goals});}
 return null;
}
export async function createAgentPlan(ai:AIRuntime,view:PublicView,text:string){
 const quick=fastPlan(view,text);if(quick)return quick;
 const plan=validatePlan(await ai.planGoals(view,text,blueprintSchema));
 if(!hasUserCondition(text)&&plan.goals.some(g=>g.type==='CONDITIONAL_INTENT')){
 const removed=new Set(plan.goals.filter(g=>g.type==='CONDITIONAL_INTENT'||g.branch==='else').map(g=>g.goal_id));
 const goals=plan.goals.filter(g=>!removed.has(g.goal_id)).map(({status,side_effect_level,requires_confirmation,...g})=>({...g,depends_on:g.depends_on.filter(id=>!removed.has(id)),branch:null,condition:null}));
 return validatePlan({goals});
 }
 return plan;
}

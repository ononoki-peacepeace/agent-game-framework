import type {FutureIntent,AgentPlan,AtomicGoal} from './plan-schema.js';
import type {PublicView} from '../shared/contracts.js';
import {assert} from '../core/schema.js';
import {relationshipCondition} from '../shared/relationship.js';
/** Keep branch guards through intermediate actions and nested conditions. */
export function futureConditionGuards(plan:AgentPlan,goal:AtomicGoal){
 const guards:NonNullable<FutureIntent['condition_guards']>=[],visited=new Set<string>(),owners=new Map<string,boolean>();
 const visit=(node:AtomicGoal)=>{
  if(visited.has(node.goal_id))return;visited.add(node.goal_id);
  const parents=node.depends_on.map(id=>plan.goals.find(parent=>parent.goal_id===id));
  assert(parents.every(Boolean),'未来计划依赖缺失，尚未登记');
  if(node.branch){
   const conditions=parents.filter(parent=>parent!.type==='CONDITIONAL_INTENT');
   assert(conditions.length===1&&conditions[0]!.condition,'未来计划条件归属不明确，尚未登记');
   const owner=conditions[0]!,expected=node.branch==='then';
   assert(!owners.has(owner.goal_id)||owners.get(owner.goal_id)===expected,'未来计划存在冲突条件，尚未登记');
   if(!owners.has(owner.goal_id)){owners.set(owner.goal_id,expected);guards.push({condition:structuredClone(owner.condition!),expected});}
  }
  for(const parent of parents)visit(parent!);
 };
 visit(goal);return guards;
}
/** All conditions refer to their own public entity, independently of the action recipient. */
export function futureConditionsHold(view:PublicView,intent:FutureIntent){
 const guards=[...(intent.condition?[{condition:intent.condition,expected:intent.condition_expected}]:[]),...(intent.condition_guards??[])];
 return guards.every(({condition,expected})=>{
  const entity=view.entities.find(candidate=>candidate.id===condition.entity_id);
  const player=view.entities.find(candidate=>candidate.id===view.player_id);
  const truth=!entity?null:condition.kind==='familiar'?relationshipCondition(view,entity):
   condition.kind==='present'&&entity.components.location&&player?.components.location?
    entity.components.location.location_id===player.components.location.location_id:null;
  return truth!==null&&truth===expected;
 });
}
const ranges={any:[0,1440],morning:[360,720],afternoon:[720,1080],evening:[1080,1440],after_school:[960,1200]};
export function futureStatus(intent:FutureIntent,time:{day:number;minute:number}):FutureIntent['status']{
 if(!['planned','due'].includes(intent.status)||intent.target_date===null)return intent.status;
 const [start,end]=ranges[intent.time_window];
 if(time.day>intent.target_date||time.day===intent.target_date&&time.minute>=end)return 'expired';
 return time.day===intent.target_date&&time.minute>=start?'due':'planned';
}
export function dueAssessment(view:PublicView,intent:FutureIntent){
 const player=view.entities.find(e=>e.id===view.player_id),notes:string[]=[];
 if(Number(player?.components.condition?.hp??100)<=0)notes.push('玩家状态不允许行动');
 for(const id of intent.target_entities){const target=view.entities.find(e=>e.id===id);if(!target)notes.push('目标目前不可见或不可用');else if(!target.components.location||!player?.components.location||target.components.location.location_id!==player.components.location.location_id)notes.push('目标不在已确认的同一地点');}
 return '计划已到期，仅提醒：'+intent.goal+'。'+(notes.length?notes.join('；')+'。':'')+'执行前仍需检查当前事件与前台事务，并由实际行动处理 NPC 是否愿意参与；尚未发生。';
}

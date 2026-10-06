import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import {GameError,type SavePackage} from '../core/schema.js';
import type { PublicView } from '../shared/contracts.js';
import type { GameService } from '../server/service.js';
import type {AtomicGoal,AgentPlan} from './plan-schema.js';
import {hasMultipleClauses} from './goal-contract.js';
import {createRegistry} from '../modules/index.js';
import type {ActionInput} from '../shared/contracts.js';
import {currentTrace} from '../observability/trace.js';

export interface WorldAffordance {
  id: string;
  kind: 'activity' | 'talk' | 'move';
  label: string;
  description: string;
  location_id: string | null;
  target_id: string | null;
}
/**
 * The planner answers one bounded step at a time: act on a discovered affordance, declare the objective
 * already reached, ask the player to decide, or report a canonical block. It never picks two things at once.
 */
export const goalDecisionSchema=z.strictObject({decision:z.enum(['act','done','blocked','clarify']),candidate_id:z.string().nullable(),reason:z.string().max(300),ambiguity:z.string().max(300).nullable()});
export const affordanceChoiceSchema=goalDecisionSchema;
/** Every extra step costs a model call and a world turn, so an open goal walk is always bounded. */
export const MAX_GOAL_STEPS=5;

const effectText=(effect:{op:string;key:string;delta:number})=>`${effect.op}:${effect.key}${effect.delta>=0?'+':''}${effect.delta}`;
export function discoverAffordances(save:SavePackage,view:PublicView):WorldAffordance[]{
  const player=view.entities.find(entity=>entity.id===view.player_id),here=String(player?.components.location?.location_id??'');
  const activities=(save.definition.routine_rules?.activities??[]).map(rule=>({
    id:`activity:${rule.id}`,kind:'activity' as const,label:rule.label,
    description:[`类型 ${rule.kind}`,`耗时 ${rule.duration} 分钟`,rule.effects.length?`已声明效果 ${rule.effects.map(effectText).join('、')}`:'无数值收益'].join('；'),
    location_id:rule.location_id,target_id:null,
  }));
  const talk=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character).map(entity=>({
    id:`talk:${entity.id}`,kind:'talk' as const,label:`与${String(entity.components.identity?.name??entity.id)}交谈`,
    description:`人物身份：${String(entity.components.character?.role??'已知人物')}；当前位置：${String(entity.components.location?.location_id??'未知')}`,
    location_id:typeof entity.components.location?.location_id==='string'?entity.components.location.location_id:null,target_id:entity.id,
  }));
  const moves=view.routes.filter(route=>route.from===here).map(route=>{
    const place=view.locations.find(location=>location.id===route.to);
    return {id:`move:${route.to}`,kind:'move' as const,label:`前往${place?.name??route.to}`,description:`已知路线，耗时 ${route.travel_minutes} 分钟`,location_id:route.to,target_id:null};
  });
  return [...activities,...talk,...moves];
}

function firstRoute(view:PublicView,from:string,to:string){
  const queue=[{id:from,path:[] as PublicView['routes'],cost:0}],seen=new Set<string>();
  while(queue.length){queue.sort((a,b)=>a.cost-b.cost);const next=queue.shift()!;if(next.id===to)return next.path;if(seen.has(next.id))continue;seen.add(next.id);for(const edge of view.routes.filter(route=>route.from===next.id))queue.push({id:edge.to,path:[...next.path,edge],cost:next.cost+edge.travel_minutes});}
  return null;
}

/**
 * One concrete step of an open goal, expressed only through affordances the world already declares.
 * Reaching a remote affordance takes as many steps as the route needs; only the step that actually performed
 * the candidate counts as fulfilled, so a single relocation never consumes the action it was travelling to.
 */
async function performAffordance(service:GameService,view:PublicView,save:SavePackage,selected:WorldAffordance,objective:string,requestId:string):Promise<{summary:string;fulfilled:boolean}|null>{
  const player=view.entities.find(entity=>entity.id===view.player_id)!,here=String(player.components.location?.location_id??'');
  if(selected.location_id&&selected.location_id!==here){
    const path=firstRoute(view,here,selected.location_id);
    if(!path?.length)return null;
    await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,action:{type:'MOVE',target_id:path[0].to,parameters:{}}});
    return {summary:`已开始推进「${objective}」：先沿已知路线前往${view.locations.find(location=>location.id===path[0].to)?.name??'下一地点'}。`,fulfilled:false};
  }
  if(selected.kind==='activity'){
    await service.performDeclaredActivity({activity_id:selected.id.slice('activity:'.length),game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId});
    return {summary:`已开始推进「${objective}」：完成了${selected.label}。`,fulfilled:true};
  }
  if(selected.kind==='talk'&&selected.target_id){
    await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,action:{type:'TALK',target_id:selected.target_id,parameters:{topic:objective}}});
    return {summary:`已开始推进「${objective}」：向${selected.label.replace(/^与|交谈$/g,'')}打听。`,fulfilled:true};
  }
  if(selected.kind==='move'){
    await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,action:{type:'MOVE',target_id:selected.location_id!,parameters:{}}});
    return {summary:`已开始推进「${objective}」：${selected.label}。`,fulfilled:true};
  }
  return null;
}

/**
 * Goal → affordance discovery → plan → execute → observe → re-plan, bounded by MAX_GOAL_STEPS.
 * Every step re-reads canonical state, must actually change it, and stops only on: goal reached, a player
 * decision, missing information, a canonical block, or the step cap. Achieved affordances are never repeated.
 */
export async function executeOpenWorldGoal(service:GameService,save:SavePackage,objective:string,requestId:string){
  let current=save;const attempted=new Set<string>(),steps:{candidate:string;summary:string}[]=[];
  const summarise=()=>steps.map(entry=>entry.summary).join(' ');
  let view=service.project(current);
  for(let step=0;step<MAX_GOAL_STEPS;step++){
    view=service.project(current);
    const candidates=discoverAffordances(current,view).filter(candidate=>!attempted.has(candidate.id));
    if(!candidates.length){
      if(!steps.length)return {ok:false,message:'当前世界没有声明可用于推进这个目标的行动。',view};
      return {ok:false,message:`${summarise()} 这些步骤已经发生，但「${objective}」尚无完成证据；当前没有更多可直接推进的行动。`,view};
    }
    const player=view.entities.find(entity=>entity.id===view.player_id),here=String(player?.components.location?.location_id??'');
    const decision=await service.ai.chooseAffordance(view,objective,candidates,goalDecisionSchema,{
      completed:steps,player_location:here,player_location_name:view.locations.find(location=>location.id===here)?.name??null,
    });
    if(decision.decision==='done'){
      if(!steps.length)return {ok:false,message:decision.reason||'当前世界没有可直接推进这个目标的行动。',view};
      return {ok:true,message:summarise(),view};
    }
    if(decision.decision==='clarify'){const question=decision.ambiguity||decision.reason||'请说明你更偏向哪种做法。';return {ok:false,message:question,view,clarification:question};}
    if(decision.decision==='blocked')return {ok:false,message:decision.reason||'当前世界条件无法继续推进这个目标。',view};
    const selected=candidates.find(candidate=>candidate.id===decision.candidate_id);
    if(!selected)return {ok:false,message:'规划器选择了当前世界不存在的行动，世界状态没有改变。',view};
    const revisionBefore=current.state_revision;
    const outcome=await performAffordance(service,view,current,selected,objective,step===0?requestId:randomUUID());
    if(!outcome)return {ok:false,message:'当前没有通往所选行动地点的已知路线。',view};
    if(outcome.fulfilled)attempted.add(selected.id);
    current=await service.current();
    // A verified outcome is the only thing that lets the walk continue instead of looping on a no-op.
    if(current.state_revision<=revisionBefore)return {ok:false,message:`${outcome.summary} 这一步没有改变世界状态，因此停在这里。`,view:service.project(current)};
    steps.push({candidate:selected.id,summary:outcome.summary});
  }
  return {ok:false,message:`${summarise()} 已达到本轮推进步数上限；「${objective}」尚无完成证据。`,view:service.project(current)};
}

/** Candidate actions for one compiled goal. This is deliberately not a second action registry. */
export interface ContractCandidate {
  id:string;
  operation:'MOVE'|'BUY'|'TALK'|'MOVE_ITEM'|'OBSERVE_PRESENCE'|'GENERIC_ACTIVITY';
  label:string;
  action:ActionInput|null;
  item_id?:string;
  shop_id?:string;
  quantity?:number;
  requires_binding?:boolean;
}
export type ContractStepResult={status:'completed'|'blocked'|'waiting_for_player'|'unknown';reason:string;
  candidate:SavePackage;observed_revision:number;evidence_request_id:string|null;
  pending_failure?:'temporary'|'deterministic';
  selected?:ContractCandidate;
  observation?:{value:'present'|'absent'|'unknown';source:'public_location'|'insufficient_public_state';revision:number}};
/** Stable for a plan step at one revision; a changed world receives a new request ID. */
export function contractStepRequestId(planId:string,goalId:string,revision:number){
  const hex=createHash('sha256').update(`${planId}:${goalId}:${revision}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

const playerLocation=(view:PublicView):string|null=>{
  const location=view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id;
  return typeof location==='string'?location:null;
};
const entityLocation=(save:SavePackage,id:string):string|null=>{
  const location=save.entities.find(entity=>entity.id===id)?.components.location?.location_id;
  return typeof location==='string'?location:null;
};
const quantityAt=(save:SavePackage,entityId:string,component:'inventory'|'shop',itemId:string)=>{
  const data=save.entities.find(entity=>entity.id===entityId)?.components[component] as
    {items?:Record<string,number>;stock?:Record<string,number>}|undefined;
  return (component==='inventory'?data?.items?.[itemId]:data?.stock?.[itemId])??0;
};
const balance=(save:SavePackage,entityId:string,currency:string)=>
  (save.entities.find(entity=>entity.id===entityId)?.components.wallet as {balances?:Record<string,number>}|undefined)?.balances?.[currency]??0;
const labelKey=(name:string)=>name.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・._-]+/g,'');

/** The scene and registered actions, rather than model-created IDs, determine executable arguments. */
export function discoverContractCandidates(save:SavePackage,view:PublicView,goal:AtomicGoal,
  playerIntent:string|null=null):ContractCandidate[]{
  const completion=goal.contract?.completion;
  if(!completion)return [];
  const registry=createRegistry(save.definition.enabled_modules);
  const registered=(intent:'move'|'purchase'|'talk'|'item_move',completionKind:string)=>
    registry.actions.all().find(([name,spec])=>spec.capability?.intent===intent&&
      spec.capability.completion_kind===completionKind&&view.actions.some(action=>action.type===name))?.[0]??null;
  const here=playerLocation(view);
  if(completion.kind==='location_at'){
    const destination=completion.destination_id,actionType=registered('move',completion.kind);
    if(!destination||!here||destination===here||!actionType||!view.locations.some(place=>place.id===destination))return [];
    if(!firstRoute(view,here,destination)?.length)return [];
    return [{id:`MOVE:${destination}`,operation:'MOVE',label:`前往${view.locations.find(place=>place.id===destination)!.name}`,
      action:{type:actionType,target_id:destination,parameters:{}}}];
  }
  if(completion.kind==='purchase'){
    const actionType=registered('purchase',completion.kind);
    if(!here||!actionType)return [];
    const shops=view.entities.filter(entity=>entity.components.shop&&entity.components.location?.location_id===here);
    const mention=goal.contract?.bindings.find(binding=>binding.role==='item')?.mention??'';
    const exact=view.entities.filter(entity=>entity.components.item&&labelKey(String(entity.components.identity?.name??''))===labelKey(mention));
    const matches=exact.length?exact:view.entities.filter(entity=>entity.components.item&&
      ((entity.components.item.tags as string[]|undefined)??[]).some(tag=>labelKey(tag)===labelKey(mention)));
    // A model-suggested referent can narrow an offer, but only a product actually named by
    // the player (or selected later by the player) authorizes spending money on that item.
    const namedByPlayer=playerIntent?view.entities.filter(entity=>entity.components.item&&
      typeof entity.components.identity?.name==='string'&&
      labelKey(playerIntent).includes(labelKey(entity.components.identity.name))):[];
    const items=namedByPlayer.length?namedByPlayer:matches.length?matches:
      view.entities.filter(entity=>entity.components.item);
    return shops.flatMap(shop=>{
      const stock=(shop.components.shop as {stock:Record<string,number>;prices:Record<string,{buy:number}>}).stock;
      return items.filter(item=>Object.hasOwn(stock,item.id)&&stock[item.id]>0).map(item=>({
        id:`BUY:${shop.id}:${item.id}`,operation:'BUY' as const,
        label:`在${String(shop.components.identity?.name??shop.id)}购买${String(item.components.identity?.name??item.id)}`,
        shop_id:shop.id,item_id:item.id,quantity:completion.quantity??1,
        requires_binding:!namedByPlayer.some(named=>named.id===item.id),
        action:{type:actionType,target_id:shop.id,parameters:{item_id:item.id,quantity:completion.quantity??1}},
      }));
    });
  }
  if(completion.kind==='conversation_attempted'){
    const actionType=registered('talk',completion.kind);
    const target=completion.person_id;
    if(!target||!here||!actionType||!view.entities.some(entity=>entity.id===target&&entity.components.location?.location_id===here))return [];
    return [{id:`TALK:${target}`,operation:'TALK',label:'交谈',action:{type:actionType,target_id:target,parameters:{topic:goal.normalized_goal}}}];
  }
  if(completion.kind==='item_location'){
    const actionType=registered('item_move',completion.kind),itemId=completion.item_id;
    const item=itemId?view.entities.find(entity=>entity.id===itemId&&entity.components.item):null;
    const owned=(view.entities.find(entity=>entity.id===view.player_id)?.components.inventory as
      {items?:Record<string,number>}|undefined)?.items??{};
    if(!actionType||!item||!here)return [];
    if(completion.to==='held'&&(owned[item.id]??0)===0&&item.components.location?.location_id===here)
      return [{id:`MOVE_ITEM:${item.id}:held`,operation:'MOVE_ITEM',label:`拿起${String(item.components.identity?.name??'物品')}`,
        action:{type:actionType,parameters:{item_id:item.id,to:'held',container_id:null,position_label:null}}}];
    if(completion.to==='scene'&&(owned[item.id]??0)===1)
      return [{id:`MOVE_ITEM:${item.id}:scene`,operation:'MOVE_ITEM',label:`放下${String(item.components.identity?.name??'物品')}`,
        action:{type:actionType,parameters:{item_id:item.id,to:'scene',container_id:null,position_label:null}}}];
    return [];
  }
  if(completion.kind==='presence_observed'){
    return completion.person_id?[{id:`OBSERVE_PRESENCE:${completion.person_id}`,operation:'OBSERVE_PRESENCE',label:'确认人物是否在场',action:null}]:[];
  }
  if(completion.kind==='activity_occurred')return [{id:'GENERIC_ACTIVITY',operation:'GENERIC_ACTIVITY',label:goal.normalized_goal,action:null}];
  return [];
}

/** A missing projected person is unknown. A publicly located person elsewhere is known absent here. */
export function observePresence(view:PublicView,personId:string){
  const here=playerLocation(view),person=view.entities.find(entity=>entity.id===personId&&entity.components.character);
  const there=person?.components.location?.location_id;
  const value:'present'|'absent'|'unknown'=here&&there?(here===there?'present':'absent'):'unknown';
  return {value,source:value==='unknown'?'insufficient_public_state':'public_location',revision:view.revision} as const;
}

/** Evidence must be a committed registered-action receipt plus the corresponding real state delta. */
export function verifyContractCompletion(before:SavePackage,after:SavePackage,goal:AtomicGoal,
  candidate:ContractCandidate,requestId:string,observation?:ReturnType<typeof observePresence>):boolean{
  const completion=goal.contract?.completion;
  if(!completion)return false;
  if(completion.kind==='presence_observed')return candidate.operation==='OBSERVE_PRESENCE'&&
    completion.person_id===candidate.id.slice('OBSERVE_PRESENCE:'.length)&&
    observation?.revision===before.state_revision&&observation.value!=='unknown';
  const turn=after.runtime.receipts.find(receipt=>receipt.id===requestId&&receipt.revision===after.state_revision);
  const receipt=after.resolution_receipts?.find(receipt=>receipt.request_id===requestId&&receipt.commit_status==='committed');
  if(!turn||!receipt||after.state_revision<=before.state_revision)return false;
  if(completion.kind==='location_at')return candidate.operation==='MOVE'&&receipt.semantic_action==='MOVE'&&
    receipt.effects.includes('position')&&completion.destination_id===entityLocation(after,after.player_state.entity_id)&&
    entityLocation(before,before.player_state.entity_id)!==completion.destination_id;
  if(completion.kind==='purchase'){
    if(candidate.operation!=='BUY'||receipt.semantic_action!=='BUY'||!receipt.effects.includes('inventory')||
      !receipt.effects.includes('money')||receipt.target_id!==candidate.shop_id||
      !candidate.shop_id||!candidate.item_id||!candidate.quantity||
      (completion.item_id&&completion.item_id!==candidate.item_id)||
      (completion.shop_id&&completion.shop_id!==candidate.shop_id)||
      (completion.quantity&&completion.quantity!==candidate.quantity))return false;
    const shopBefore=before.entities.find(entity=>entity.id===candidate.shop_id)?.components.shop as
      {currency_id:string;prices:Record<string,{buy:number}>}|undefined;
    const price=shopBefore?.prices[candidate.item_id]?.buy,currency=shopBefore?.currency_id;
    if(!price||!currency)return false;
    const player=before.player_state.entity_id,total=price*candidate.quantity;
    return quantityAt(after,player,'inventory',candidate.item_id)-quantityAt(before,player,'inventory',candidate.item_id)===candidate.quantity&&
      quantityAt(before,candidate.shop_id,'shop',candidate.item_id)-quantityAt(after,candidate.shop_id,'shop',candidate.item_id)===candidate.quantity&&
      balance(before,player,currency)-balance(after,player,currency)===total&&
      balance(after,candidate.shop_id,currency)-balance(before,candidate.shop_id,currency)===total;
  }
  if(completion.kind==='conversation_attempted')return candidate.operation==='TALK'&&receipt.semantic_action==='TALK'&&
    receipt.target_id===completion.person_id;
  if(completion.kind==='item_location'){
    if(candidate.operation!=='MOVE_ITEM'||receipt.semantic_action!=='MOVE_ITEM'||
      !receipt.effects.includes('inventory')||!completion.item_id)return false;
    const itemId=completion.item_id,player=before.player_state.entity_id;
    const beforeQuantity=quantityAt(before,player,'inventory',itemId);
    const afterQuantity=quantityAt(after,player,'inventory',itemId);
    return completion.to==='held'?beforeQuantity===0&&afterQuantity===1&&
      !after.entities.find(entity=>entity.id===itemId)?.components.location:
      beforeQuantity===1&&afterQuantity===0&&
      entityLocation(after,itemId)===entityLocation(before,player);
  }
  if(completion.kind==='activity_occurred')return candidate.operation==='GENERIC_ACTIVITY'&&
    receipt.activity?.occurred===true&&receipt.effects.includes('activity')&&
    receipt.activity.description===goal.normalized_goal.trim().slice(0,300)&&
    receipt.activity.duration_minutes===receipt.time_cost&&receipt.activity.duration_minutes>0&&
    receipt.activity.location_id===entityLocation(before,before.player_state.entity_id);
  return false;
}

/** Batch 2 isolated step API. The production staged-plan guard remains in executePlan until persistence exists. */
export async function executeContractStep(service:GameService,save:SavePackage,goal:AtomicGoal,requestId:string,
  selection?:{candidate_id:string;source:'player'|'model'},persistPlan?:AgentPlan,
  playerIntent:string|null=null,endConversation=false):Promise<ContractStepResult>{
  const latest=await service.current();
  if(latest.game_id!==save.game_id||latest.state_revision!==save.state_revision)
    return {status:'blocked',reason:'世界状态已变化，请按最新状态重新绑定行动。',candidate:latest,
      observed_revision:latest.state_revision,evidence_request_id:null};
  save=latest;
  const view=service.project(save),candidates=discoverContractCandidates(save,view,goal,playerIntent);
  currentTrace()?.info('agent.tool_candidates',{metadata:{goal_id:goal.goal_id,
    completion_kind:goal.contract?.completion.kind??'unsupported',
    availability:goal.contract?.availability??'runtime_gap',
    tools:[...new Set(candidates.map(candidate=>candidate.operation))],candidate_count:candidates.length}});
  const base={candidate:save,observed_revision:save.state_revision,evidence_request_id:null};
  if(goal.contract?.availability==='needs_binding'||goal.contract?.availability==='capability_gap')
    return {status:'waiting_for_player',reason:'目标参数或能力尚未通过程序绑定。',...base};
  if(!candidates.length)return {status:'blocked',reason:'当前世界没有可用于这个步骤的已注册行动或权威绑定。',...base};
  const selected=candidates.find(candidate=>candidate.id===(selection?.candidate_id??candidates[0].id));
  if(!selected)return {status:'blocked',reason:'所选行动不在当前合法候选中。',...base};
  if(selected.requires_binding&&selection?.source!=='player')
    return {status:'waiting_for_player',reason:'商品尚未唯一绑定，需要玩家选择并确认具体商品。',...base};
  if(candidates.length>1&&selection?.source!=='player')
    return {status:'waiting_for_player',reason:'需要玩家选择具体对象。',...base};
  currentTrace()?.info('agent.tool_selected',{metadata:{goal_id:goal.goal_id,operation:selected.operation,
    candidate_id:selected.id,selection_source:selection?.source??'program',
    target_id:selected.action?.target_id??null,parameter_keys:Object.keys(selected.action?.parameters??{})}});
  if(selected.action){
    const registry=createRegistry(save.definition.enabled_modules),spec=registry.actions.has(selected.action.type)?
      registry.actions.get(selected.action.type):null;
    const parameters=selected.action.parameters??{};
    if(!spec||!spec.parameters.safeParse(parameters).success||
      (spec.capability&&Object.keys(spec.capability.parameter_roles).some(key=>
        !Object.hasOwn(parameters,key))))
      return {status:'blocked',reason:'选中行动的参数未通过已注册 Action 校验。',...base};
    currentTrace()?.info('agent.parameters_bound',{metadata:{goal_id:goal.goal_id,
      action_type:selected.action.type,target_id:selected.action.target_id??null,
      parameter_keys:Object.keys(parameters)}});
  }
  if(selected.operation==='OBSERVE_PRESENCE'){
    const observation=observePresence(view,goal.contract!.completion.kind==='presence_observed'?goal.contract!.completion.person_id!:'');
    const complete=verifyContractCompletion(save,save,goal,selected,requestId,observation);
    const result:ContractStepResult={status:complete?'completed':'unknown',reason:complete?'已依据公开位置确认。':'当前公开场景不足以确认在场情况。',
      ...base,selected,observation};
    if(persistPlan){
      const updated=recordContractStep(persistPlan,goal.goal_id,result);
      await service.agentTransaction({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId},
        {active_goal_step:goal.goal_id,observation:observation.value},next=>{
          updated.contract&&(updated.contract.last_observed_revision=save.state_revision+1);
          next.active_goal={plan:updated,waiting_question:result.status==='unknown'?result.reason:null,options:[]};
        });
      result.candidate=await service.current();result.observed_revision=result.candidate.state_revision;
    }
    return result;
  }
  const goalCommit=persistPlan?(before:SavePackage,next:SavePackage,committedId:string)=>{
    if(!verifyContractCompletion(before,next,goal,selected,committedId))
      throw Error('行动缺少目标所需的程序完成证据，候选未提交。');
    const updated=recordContractStep(persistPlan,goal.goal_id,{status:'completed',reason:'已有程序结算与完成证据。',
      candidate:next,observed_revision:next.state_revision,evidence_request_id:committedId,selected});
    next.active_goal={plan:updated,waiting_question:null,options:[]};
  }:undefined;
  try{
    if(selected.operation==='GENERIC_ACTIVITY')await service.turn({game_id:save.game_id,expected_revision:save.state_revision,
      request_id:requestId,input:goal.normalized_goal},undefined,undefined,undefined,false,undefined,undefined,true,goalCommit);
    else await service.turn({game_id:save.game_id,expected_revision:save.state_revision,
      request_id:requestId,action:selected.action!,
      ...(endConversation&&selected.operation==='TALK'?{end_conversation:true}:{})},undefined,undefined,undefined,false,undefined,undefined,false,goalCommit);
  }catch(error){
    const recovered=await service.current();
    if(persistPlan&&recovered.active_goal?.plan.plan_id===persistPlan.plan_id&&
      recovered.active_goal.plan.goals.find(entry=>entry.goal_id===goal.goal_id)?.status==='completed'&&
      recovered.resolution_receipts?.some(receipt=>receipt.request_id===requestId&&receipt.commit_status==='committed'))
      return {status:'completed',reason:'已从持久提交恢复步骤结果。',candidate:recovered,
        observed_revision:recovered.state_revision,evidence_request_id:requestId,selected};
    const pending=recovered.state_revision===save.state_revision&&await service.hasPendingTurn(requestId);
    return {status:'blocked',reason:(error as Error).message,candidate:recovered,
      observed_revision:recovered.state_revision,evidence_request_id:null,
      ...(pending?{pending_failure:(error as Error&{retry_policy?:string}).retry_policy==='safe'?
        'temporary' as const:'deterministic' as const}:{})};
  }
  const after=await service.current(),complete=verifyContractCompletion(save,after,goal,selected,requestId);
  currentTrace()?.info('agent.completion_checked',{metadata:{goal_id:goal.goal_id,
    operation:selected.operation,complete,receipt_found:Boolean(after.resolution_receipts?.some(receipt=>
      receipt.request_id===requestId&&receipt.commit_status==='committed'))}});
  return {status:complete?'completed':'blocked',reason:complete?'已有程序结算与完成证据。':'动作已返回，但缺少对应完成证据。',
    candidate:after,observed_revision:after.state_revision,evidence_request_id:complete?requestId:null,selected};
}

/** No model-generated done, missing candidate or step budget can mark the complete graph successful. */
export function contractPlanCompleted(plan:AgentPlan){return plan.goals.length>0&&plan.goals.every(goal=>goal.status==='completed'&&
  (goal.contract?.completion.kind==='presence_observed'?goal.contract.evidence_refs.some(ref=>ref.observed_revision!==null):
    goal.contract?.evidence_refs.some(ref=>ref.request_id!==null)));}

/** Only a verified step result may advance its goal; dependency siblings remain pending. */
export function recordContractStep(plan:AgentPlan,goalId:string,result:ContractStepResult):AgentPlan{
  const next=structuredClone(plan),goal=next.goals.find(entry=>entry.goal_id===goalId);
  if(!goal?.contract)throw Error('目标契约不存在');
  goal.status=result.status==='completed'?'completed':result.status==='waiting_for_player'?'waiting_for_player':'blocked';
  goal.result={summary:result.reason,...(result.observation?{observation:result.observation}:{})};
  if(result.status==='completed')goal.contract.evidence_refs.push({request_id:result.evidence_request_id,
    observed_revision:result.observation?.revision??result.observed_revision});
  if(result.status==='completed'&&goal.contract.completion.kind==='purchase'&&result.selected?.operation==='BUY')
    goal.contract.completion={...goal.contract.completion,shop_id:result.selected.shop_id??null,
      item_id:result.selected.item_id??null,quantity:result.selected.quantity??null};
  if(result.status==='completed'&&goal.contract.completion.kind==='presence_observed'&&result.observation)
    goal.contract.completion={...goal.contract.completion,
      location_id:entityLocation(result.candidate,result.candidate.player_state.entity_id)};
  next.contract&& (next.contract.last_observed_revision=result.observed_revision);
  next.status=contractPlanCompleted(next)?'completed':result.status==='waiting_for_player'?'waiting_for_player':
    result.status==='blocked'||result.status==='unknown'?'blocked':'partial';
  return next;
}

/** Re-check persisted evidence after restart or Undo; a missing receipt blocks rather than repeats a paid action. */
export function committedGoalEvidence(save:SavePackage,goal:AtomicGoal):boolean{
  if(goal.status!=='completed'||!goal.contract)return false;
  if(goal.contract.completion.kind==='presence_observed')return Boolean(goal.result?.observation&&
    goal.result.observation.value!=='unknown'&&goal.result.observation.source==='public_location'&&
    goal.contract.evidence_refs.some(ref=>ref.observed_revision===goal.result!.observation!.revision));
  return goal.contract.evidence_refs.some(ref=>{
    if(!ref.request_id)return false;
    const receipt=save.resolution_receipts?.find(entry=>entry.request_id===ref.request_id&&entry.commit_status==='committed');
    if(!receipt)return false;
    const expected=goal.contract!.completion;
    return expected.kind==='location_at'?receipt.semantic_action==='MOVE'&&receipt.target_id===expected.destination_id&&receipt.effects.includes('position'):
      expected.kind==='purchase'?receipt.semantic_action==='BUY'&&receipt.target_id===expected.shop_id&&
        receipt.effects.includes('inventory')&&receipt.effects.includes('money')&&Boolean(expected.item_id&&expected.quantity):
      expected.kind==='conversation_attempted'?receipt.semantic_action==='TALK'&&receipt.target_id===expected.person_id:
      expected.kind==='item_location'?receipt.semantic_action==='MOVE_ITEM'&&receipt.effects.includes('inventory')&&
        Boolean(expected.item_id):
      expected.kind==='activity_occurred'?Boolean(receipt.activity?.occurred&&receipt.effects.includes('activity')):false;
  });
}

/** Typed goals use the same registered-action runner whether they came from one sentence or a staged plan. */
export function canExecuteContractPlan(plan:AgentPlan){
  return Boolean(plan.contract)&&plan.goals.length>0&&
    !(plan.goals.length===1&&!plan.local_compound&&hasMultipleClauses(plan.contract!.original_intent))&&
    plan.goals.every(goal=>!goal.condition&&!goal.branch&&goal.temporal_scope.scope==='now'&&
      ['location_at','purchase','presence_observed','conversation_attempted','activity_occurred','item_location']
        .includes(goal.contract?.completion.kind??'unsupported')&&
      !['capability_gap','needs_binding'].includes(goal.contract?.availability??'runtime_gap'));
}

async function persistGoalProgress(service:GameService,save:SavePackage,plan:AgentPlan,question:string|null,
  options:{candidate_id:string;label:string}[],key:string){
  const requestId=contractStepRequestId(plan.plan_id,key,save.state_revision);
  await service.agentTransaction({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId},
    {active_goal:plan.plan_id,key,question,options},next=>{
      plan.contract&&(plan.contract.last_observed_revision=save.state_revision+1);
      next.active_goal={plan:structuredClone(plan),waiting_question:question,options:structuredClone(options)};
    });
  return service.current();
}

/** The existing affordance runner advances one compiled plan; production calls persist every step. */
export async function runContractPlan(service:GameService,initial:SavePackage,inputPlan:AgentPlan,
  selectedByGoal:Record<string,{candidate_id:string;source:'player'|'model'}>={},persist=false,endConversation=false):
  Promise<{plan:AgentPlan;save:SavePackage;reason:string;failure?:boolean}>{
  let save=await service.current();
  if(save.game_id!==initial.game_id)throw Error('游戏已切换');
  if(persist&&save.state_revision!==initial.state_revision&&save.active_goal?.plan.plan_id!==inputPlan.plan_id)
    throw new GameError('状态已更新，请重新规划',409);
  let plan=structuredClone(save.active_goal?.plan.plan_id===inputPlan.plan_id?save.active_goal.plan:inputPlan);
  if(persist&&save.active_goal?.plan.plan_id!==plan.plan_id)
    save=await persistGoalProgress(service,save,plan,null,[],'start');
  for(const goal of plan.goals)if(goal.status==='completed'&&!committedGoalEvidence(save,goal)&&persist){
    goal.status='blocked';plan.status='blocked';
    save=await persistGoalProgress(service,save,plan,'已完成步骤的权威凭据失效，不能自动重复执行。',[],`invalid:${goal.goal_id}`);
    return {plan,save,reason:'已完成步骤的权威凭据失效，不能自动重复执行。',failure:true};
  }
  let steps=0,question:string|null=null,options:{candidate_id:string;label:string}[]=[];
  for(const id of plan.execution_order){
    let goal=plan.goals.find(entry=>entry.goal_id===id)!;
    if(goal.status==='completed')continue;
    if(goal.depends_on.some(parent=>plan.goals.find(entry=>entry.goal_id===parent)?.status!=='completed'))continue;
    if(steps>=MAX_GOAL_STEPS){
      plan.status='partial';question='已达到本轮行动预算，目标仍未完成。';break;
    }
    if(steps>0&&await service.handoffBlocker()){
      goal.status='waiting_for_player';plan.status='waiting_for_player';
      question='世界出现需要玩家决定的事项，后续目标尚未执行。';break;
    }
    const requestId=persist?contractStepRequestId(plan.plan_id,id,save.state_revision):randomUUID();
    const result=await executeContractStep(service,save,goal,requestId,selectedByGoal[id],persist?plan:undefined,
      plan.contract?.original_intent??null,endConversation);
    steps++;save=result.candidate;
    if(persist&&result.pending_failure)
      return {plan,save,reason:result.pending_failure==='temporary'?
        '行动候选尚未提交；服务暂时失败，可用“继续目标”从当前持久候选恢复。':
        '行动候选尚未提交；程序校验未通过。请先修复问题，再用“继续目标”恢复；不要反复重试。',failure:true};
    const expected=result.status==='completed'?'completed':result.status==='waiting_for_player'?'waiting_for_player':'blocked';
    plan=persist&&save.active_goal?.plan.plan_id===plan.plan_id&&
      save.active_goal.plan.goals.find(entry=>entry.goal_id===id)?.status===expected?
      structuredClone(save.active_goal.plan):recordContractStep(plan,id,result);
    goal=plan.goals.find(entry=>entry.goal_id===id)!;
    if(result.status==='waiting_for_player'||result.status==='unknown'){
      question=result.reason;
      if(result.status==='waiting_for_player')options=discoverContractCandidates(save,service.project(save),goal,
        plan.contract?.original_intent??null)
        .map(candidate=>({candidate_id:candidate.id,label:candidate.label}));
    }else if(result.status==='blocked'&&!question)question=result.reason;
    if(persist&&(!save.active_goal||save.active_goal.plan.goals.find(entry=>entry.goal_id===id)?.status!==goal.status))
      save=await persistGoalProgress(service,save,plan,question,options,`progress:${id}`);
  }
  plan.status=contractPlanCompleted(plan)?'completed':plan.goals.some(goal=>goal.status==='waiting_for_player')?
    'waiting_for_player':plan.goals.some(goal=>goal.status==='blocked')?'blocked':'partial';
  const reason=plan.status==='completed'?'所有子目标均有程序完成证据。':question??'目标仍有未完成步骤。';
  if(persist&&(!save.active_goal||JSON.stringify(save.active_goal.plan)!==JSON.stringify(plan)||
    save.active_goal.waiting_question!==question||JSON.stringify(save.active_goal.options)!==JSON.stringify(options)))
    save=await persistGoalProgress(service,save,plan,plan.status==='completed'?null:question,
      plan.status==='completed'?[]:options,'final');
  return {plan,save,reason,failure:plan.status==='blocked'};
}

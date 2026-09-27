import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SavePackage } from '../core/schema.js';
import type { PublicView } from '../shared/contracts.js';
import type { GameService } from '../server/service.js';

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
      return {ok:true,message:`${summarise()}（当前世界没有更多可直接推进「${objective}」的行动。）`,view};
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
  return {ok:true,message:`${summarise()}（已达到本轮推进步数上限，可以接着说下去让我继续推进。）`,view:service.project(current)};
}

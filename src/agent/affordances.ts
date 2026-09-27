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
export const affordanceChoiceSchema=z.strictObject({candidate_id:z.string().nullable(),reason:z.string().max(300),ambiguity:z.string().max(300).nullable()});

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

export async function executeOpenWorldGoal(service:GameService,save:SavePackage,objective:string,requestId:string){
  const view=service.project(save),candidates=discoverAffordances(save,view);
  if(!candidates.length)return {ok:false,message:'当前世界没有声明可用于推进这个目标的行动。',view};
  const choice=await service.ai.chooseAffordance(view,objective,candidates,affordanceChoiceSchema);
  if(choice.ambiguity||!choice.candidate_id)return {ok:false,message:choice.ambiguity||'还需要一个关键信息才能选择行动。',view,clarification:choice.ambiguity||'请说明你更偏向哪种做法。'};
  const selected=candidates.find(candidate=>candidate.id===choice.candidate_id);
  if(!selected)return {ok:false,message:'规划器选择了当前世界不存在的行动，世界状态没有改变。',view};
  const player=view.entities.find(entity=>entity.id===view.player_id)!,here=String(player.components.location?.location_id??'');
  if(selected.location_id&&selected.location_id!==here){
    const path=firstRoute(view,here,selected.location_id);
    if(!path?.length)return {ok:false,message:'当前没有通往所选行动地点的已知路线。',view};
    const next=await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,action:{type:'MOVE',target_id:path[0].to,parameters:{}}});
    return {ok:true,message:`已开始推进「${objective}」：先沿已知路线前往${view.locations.find(location=>location.id===path[0].to)?.name??'下一地点'}。`,view:next};
  }
  if(selected.kind==='activity'){
    const next=await service.performDeclaredActivity({activity_id:selected.id.slice('activity:'.length),game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId});
    return {ok:true,message:`已开始推进「${objective}」：完成了${selected.label}。`,view:next};
  }
  if(selected.kind==='talk'&&selected.target_id){
    const next=await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,action:{type:'TALK',target_id:selected.target_id,parameters:{topic:objective}}});
    return {ok:true,message:`已开始推进「${objective}」：向${selected.label.replace(/^与|交谈$/g,'')}打听。`,view:next};
  }
  if(selected.kind==='move'){
    const next=await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,action:{type:'MOVE',target_id:selected.location_id!,parameters:{}}});
    return {ok:true,message:`已开始推进「${objective}」：${selected.label}。`,view:next};
  }
  return {ok:false,message:'这个候选行动目前不能执行。',view};
}

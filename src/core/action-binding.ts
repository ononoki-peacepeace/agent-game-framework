import type {SavePackage} from './schema.js';
import {publicView} from './state.js';
import {evaluateWorldPrerequisites} from './prerequisites.js';
import type {Inventory} from '../modules/inventory.js';

type ItemEntity=SavePackage['entities'][number];
export type BoundItem={
  status:'bound'|'missing'|'ambiguous';
  entity:ItemEntity|undefined;
  known:boolean;
  visible:boolean;
  reachable:boolean;
  usableForAction:boolean;
  possession:'held'|'scene'|'elsewhere'|'none';
};
export type StorageBinding={
  item:BoundItem;
  container:BoundItem;
  capability:boolean;
  usableForAction:boolean;
  reason:string|null;
};

/** Extract role mentions only from the two sides of an explicit storage verb. */
function storageSides(input:string){
  const verb=/(?:收|放|装|塞)(?:进|入|到)/.exec(input);
  return verb?{item:input.slice(0,verb.index),container:input.slice(verb.index+verb[0].length)}:null;
}

function roleName(save:SavePackage,text:string,hint?:string){
  if(hint)return text.includes(hint)?hint:null;
  const names=[...new Set(save.entities.filter(entity=>entity.components.item)
    .map(entity=>String(entity.components.identity?.name??'')).filter(name=>name.length>=2&&text.includes(name)))];
  // A longer exact name supersedes its substring; two unrelated names are ambiguous.
  const maximal=names.filter(name=>!names.some(other=>other!==name&&other.includes(name)));
  return maximal.length===1?maximal[0]:null;
}

function bindRole(save:SavePackage,name:string|null,role:'item'|'container',visibleIds:Set<string>,claimedId?:string|null):BoundItem{
  const missing=():BoundItem=>({status:'missing',entity:undefined,known:false,visible:false,
    reachable:false,usableForAction:false,possession:'none'});
  if(!name)return missing();
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const owned=(player?.components.inventory as Inventory|undefined)?.items??{};
  const here=player?.components.location?.location_id;
  const candidates=save.entities.filter(entity=>entity.components.item&&entity.components.identity?.name===name);
  if(!candidates.length)return missing();
  const reachable=candidates.filter(entity=>(owned[entity.id]??0)>0||Boolean(here&&entity.components.location?.location_id===here));
  const selected=reachable.length===1?reachable[0]:candidates.length===1?candidates[0]:undefined;
  if(!selected)return {status:'ambiguous',entity:undefined,known:candidates.some(entity=>visibleIds.has(entity.id)),
    visible:reachable.some(entity=>visibleIds.has(entity.id)),reachable:reachable.length>0,
    usableForAction:false,possession:'none'};
  const held=(owned[selected.id]??0)>0;
  const inScene=Boolean(here&&selected.components.location?.location_id===here);
  const isKnown=visibleIds.has(selected.id);
  const canReach=held||inScene;
  const correctId=!claimedId||!save.entities.some(entity=>entity.id===claimedId)||claimedId===selected.id;
  return {status:'bound',entity:selected,known:isKnown,visible:isKnown&&canReach,reachable:canReach,
    usableForAction:isKnown&&canReach&&correctId&&Boolean(selected.components.item)&&(role==='item'||selected.components.item?.container===true),
    possession:held?'held':inScene?'scene':'elsewhere'};
}

/** One canonical binding decision for both offered choices and execution. Never creates entities. */
export function bindStorageAction(save:SavePackage,input:string,hints?:{
  itemName:string;containerName:string;itemId?:string|null;containerId?:string|null;
}):StorageBinding{
  const sides=storageSides(input);
  const visibleIds=new Set(publicView(save).entities.map(entity=>entity.id));
  const itemName=sides?roleName(save,sides.item,hints?.itemName):null;
  const containerName=sides?roleName(save,sides.container,hints?.containerName):null;
  const item=bindRole(save,itemName,'item',visibleIds,hints?.itemId);
  const container=bindRole(save,containerName,'container',visibleIds,hints?.containerId);
  const capability=evaluateWorldPrerequisites(save,{requirements:[{kind:'capability',subject_id:'inventory.storage'}]}).status==='EXECUTABLE';
  const usableForAction=capability&&item.usableForAction&&container.usableForAction&&item.entity?.id!==container.entity?.id;
  const reason=!capability?'当前世界没有物品收纳能力'
    :item.status==='ambiguous'||container.status==='ambiguous'?'同名物品或容器不唯一，请明确所指'
    :item.status==='missing'?'要收纳的物品当前没有对应实体'
    :container.status==='missing'?'收纳容器当前没有对应实体'
    :!item.reachable?'要收纳的物品当前不可接触'
    :!container.reachable?'收纳容器当前不可接触'
    :!item.usableForAction?'物品引用与当前状态不一致'
    :!container.usableForAction?'收纳容器不是当前可用的容器，或引用与当前状态不一致'
    :item.entity?.id===container.entity?.id?'物品不能装入自身':null;
  return {item,container,capability,usableForAction,reason};
}

import type {ActionContext} from './registry.js';
import {consumptionRuleSchema,type ConsumptionReceipt} from './consumption-contract.js';
import {advanceWorldSegment} from './runtime.js';
import {readPhysicalState} from './perception-state.js';
import {unsealedContainerAncestors} from './item-access.js';
import {worldAssert} from '../agent/outcome.js';
import type {Inventory} from '../modules/inventory.js';

function able(c:ActionContext){
 const actor=c.store.entity(c.action.actor_id);
 worldAssert(Number(actor.components.condition?.hp??1)>0&&!readPhysicalState(actor).restrained_by,'prerequisite','当前身体状态无法完成物品操作');
 worldAssert(actor.id!==c.save.player_state.entity_id||!c.save.foreground?.blocker,'prerequisite','请先处理当前中断事项');
 return actor;
}
function consumptionSource(c:ActionContext){
 const actor=able(c),item=c.save.entities.find(e=>e.id===c.action.target_id),quantity=Number(c.action.parameters.quantity);
 const rule=consumptionRuleSchema.safeParse(item?.components.item?.consumable);
 worldAssert(Boolean(item?.components.item)&&rule.success,'unavailable','该物品没有世界声明的消耗规则');
 const inventory=actor.components.inventory as Inventory|undefined;
 worldAssert(Boolean(inventory&&(inventory.items[item!.id]??0)>=quantity),'unavailable','本人持有的指定物品数量不足');
 worldAssert(item!.components.item!.condition===undefined||item!.components.item!.condition==='intact','unavailable','物品已损坏或损毁，不能按完好物品消耗');
 worldAssert(unsealedContainerAncestors(c.save,item!),'unavailable','物品仍在密封或不可接触的容器内');
 worldAssert(!Object.values(actor.components.equipment?.slots??{}).includes(item!.id),'unavailable','请先卸下这件物品');
 worldAssert(!Object.entries(inventory!.placements??{}).some(([child,parent])=>parent===item!.id&&(inventory!.items[child]??0)>0),'unavailable','请先取出容器中的物品');
 worldAssert((rule.data.required_flags??[]).every(flag=>c.save.gm_state.flags[flag.flag]===flag.equals),'prerequisite','世界规定的消耗前提尚未满足');
 return {actor,item:item!,inventory:inventory!,rule:rule.data};
}
export function executeConsumption(c:ActionContext){
 const initial=consumptionSource(c),quantity=Number(c.action.parameters.quantity),before=initial.inventory.items[initial.item.id];
 const subject=initial.actor.id===c.save.player_state.entity_id?'你':String(initial.actor.components.identity?.name??initial.actor.id);
 const origin=initial.actor.components.location?.location_id;
 const record:ConsumptionReceipt={item_id:initial.item.id,name:String(initial.item.components.identity?.name??initial.item.id),method:initial.rule.method,
  ...(typeof origin==='string'?{location_id:origin}:{}),requested_quantity:quantity,before_quantity:before,consumed_quantity:0,after_quantity:before,status:'interrupted'};
 c.consumption=record;c.result_entities.items=[initial.item.id];
 let left=initial.rule.minutes;
 while(left>0){
  const segment=advanceWorldSegment(c,left);left-=segment.elapsed;
  if(segment.interrupted){worldAssert(Number((c.store.entity(c.action.actor_id).components.inventory as Inventory|undefined)?.items[record.item_id]??0)===before,'prerequisite','中断时物品数量已由其他事件改变，不能保存过时消耗凭据');c.outcome='partial_success';c.facts.push(`${subject}尚未${record.method==='eat'?'吃掉':record.method==='drink'?'喝掉':'用掉'}${record.name}，这次尝试被打断，物品数量没有减少。`);return;}
  const live=consumptionSource(c);
  worldAssert(live.actor.components.location?.location_id===origin&&JSON.stringify(live.rule)===JSON.stringify(initial.rule)&&live.inventory.items[live.item.id]===before,'prerequisite','操作期间物品或消耗规则已改变，不能按旧状态扣量');
 }
 const current=consumptionSource(c),after=before-quantity;
 if(after)current.inventory.items[current.item.id]=after;
 else{
  delete current.inventory.items[current.item.id];if(current.inventory.placements)delete current.inventory.placements[current.item.id];
  if(current.item.components.item!.owner_id===current.actor.id)delete current.item.components.item!.owner_id;
 }
 Object.assign(record,{consumed_quantity:quantity,after_quantity:after,status:'completed'});
 const verb=record.method==='eat'?'吃掉了':record.method==='drink'?'喝掉了':'用掉了';
 c.facts.push(`${subject}${verb}${quantity}份${record.name}。`);
}
export function executeOpenContainer(c:ActionContext){
 const check=()=>{
  const actor=able(c),item=c.save.entities.find(e=>e.id===c.action.target_id),inv=actor.components.inventory as Inventory|undefined;
  worldAssert(Boolean(item?.components.item?.container&&item.components.item.openable===true),'unavailable','该容器没有可直接打开的世界授权');
  worldAssert(Boolean((inv?.items[item!.id]??0)>0||item!.components.location?.location_id===actor.components.location?.location_id)&&
   (!item!.components.item!.owner_id||item!.components.item!.owner_id===actor.id)&&unsealedContainerAncestors(c.save,item!), 'unavailable','容器不在本人可操作范围');
  worldAssert(item!.components.interactable?.access!=='locked'&&!(item!.components.item!.tags as string[]|undefined)?.includes('locked')&&
   (item!.components.interactable?.access!=='private'||item!.components.item!.owner_id===actor.id),'unavailable','容器当前的锁定或私有权限不允许直接打开');
  worldAssert(!item!.components.item!.condition||item!.components.item!.condition==='intact','unavailable','损坏的容器不能按正常规则打开');return item!;
 };
 const item=check();
 if(!(item.components.item!.tags as string[]|undefined)?.includes('sealed')){c.facts.push('容器原本已经打开。');return;}
 if(advanceWorldSegment(c,1).interrupted){c.outcome='partial_success';c.facts.push('打开容器的尝试被打断。');return;}
 const live=check();live.components.item!.tags=(live.components.item!.tags as string[]).filter(tag=>tag!=='sealed');
 c.facts.push(`你打开了${String(live.components.identity?.name??'容器')}。`);
}

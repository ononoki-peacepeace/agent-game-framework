import type {SavePackage} from './schema.js';
import type {Inventory} from '../modules/inventory.js';
type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];
/** Check a movement at its settlement boundary, before later steps can move/consume it again. */
export function hasSettledItemMovement(save:SavePackage,receipt:Receipt){
 const event=receipt.item_operation;
 if(event?.kind!=='move'||receipt.semantic_action!=='MOVE_ITEM'||receipt.kind!=='DETERMINISTIC'||receipt.outcome!=='success'||
  !receipt.effects.includes('inventory')||!receipt.result_entities?.items?.includes(event.item_id)||
  !receipt.canonical_facts.includes(`物品位置已更新：${event.name}。`))return false;
 const actor=save.entities.find(e=>e.id===receipt.actor_id),item=save.entities.find(e=>e.id===event.item_id);
 if(!actor||!item?.components.item||item.components.identity?.name!==event.name)return false;
 const inventory=actor.components.inventory as Inventory|undefined,owned=inventory?.items[item.id]===1;
 if(event.destination==='held')return owned&&!inventory?.placements?.[item.id]&&!item.components.location;
 if(event.destination==='scene')return !owned&&item.components.location?.location_id===actor.components.location?.location_id&&!item.components.item.container_id;
 const container=save.entities.find(e=>e.id===event.container_id);
 if(!container?.components.item?.container||container.components.identity?.name!==event.container_name)return false;
 return event.destination==='container'?owned&&inventory?.items[container.id]===1&&inventory.placements?.[item.id]===container.id:
  !owned&&item.components.location?.location_id===actor.components.location?.location_id&&
   item.components.item.container_id===container.id&&container.components.location?.location_id===actor.components.location?.location_id;
}

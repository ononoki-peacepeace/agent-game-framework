import type {SavePackage,Action} from '../core/schema.js';
import type {Inventory} from '../modules/inventory.js';
type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];

/** Render an exact built-in operation, not a new item outcome or an NPC response. */
export function canonicalItemFallback(save:SavePackage,action:Action,receipt:Receipt,hidden:boolean){
  if(hidden||receipt.request_id!==action.id||receipt.actor_id!==save.player_state.entity_id||
    receipt.semantic_action!==action.type||receipt.kind!=='DETERMINISTIC'||receipt.outcome!=='success'||
    !receipt.effects.includes('inventory'))return null;
  const actor=save.entities.find(e=>e.id===receipt.actor_id),item=save.entities.find(e=>e.id===action.parameters.item_id);
  const name=item?.components.identity?.name;
  if(!actor||!item?.components.item||typeof name!=='string'||!name)return null;
  const inventory=actor.components.inventory as Inventory|undefined,owned=Number(inventory?.items[item.id]??0)===1;
  if(action.type==='TRANSFER_ITEM'){
    const target=save.entities.find(e=>e.id===receipt.target_id),targetName=target?.components.identity?.name;
    if(!receipt.result_entities?.items?.includes(item.id)||
      !receipt.canonical_facts.includes('物品已交给当前在场的接收者。')||owned||
      !target?.components.character||typeof targetName!=='string'||!targetName||
      target.components.location?.location_id!==actor.components.location?.location_id||
      Number((target.components.inventory as Inventory|undefined)?.items[item.id]??0)!==1)return null;
    return `你把${name}交给了${targetName}。`;
  }
  if(action.type!=='MOVE_ITEM'||!receipt.canonical_facts.includes(`物品位置已更新：${name}。`))return null;
  const placement=inventory?.placements?.[item.id]??null,to=action.parameters.to;
  if(to==='held'&&owned&&placement===null)return `你把${name}拿在手中。`;
  const local=item.components.location?.location_id===actor.components.location?.location_id;
  if(to==='scene'&&!owned&&local&&!item.components.item.container_id)return `你放下了${name}。`;
  const container=save.entities.find(e=>e.id===action.parameters.container_id),containerName=container?.components.identity?.name;
  if(!container?.components.item?.container||typeof containerName!=='string'||!containerName)return null;
  if(to==='container'&&owned&&placement===container.id||
    to==='scene_container'&&!owned&&local&&item.components.item.container_id===container.id)
    return `你把${name}放进了${containerName}。`;
  return null;
}

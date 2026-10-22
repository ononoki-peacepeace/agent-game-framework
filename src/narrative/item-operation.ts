import type {SavePackage} from '../core/schema.js';
type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];
/** Require the registered operation's provenance; never reconstruct the past from final inventory. */
export function itemOperationNarrative(receipt:Receipt){
 const event=receipt.item_operation;
 if(!event||receipt.kind!=='DETERMINISTIC'||receipt.outcome!=='success'||!receipt.effects.includes('inventory')||
  !receipt.result_entities?.items?.includes(event.item_id))return null;
 if(event.kind==='transfer')return receipt.semantic_action==='TRANSFER_ITEM'&&receipt.target_id===event.recipient_id&&
  receipt.canonical_facts.includes('物品已交给当前在场的接收者。')?
  `${event.actor_label}把${event.name}交给了${event.recipient_name}。`:null;
 if(receipt.semantic_action!=='MOVE_ITEM'||!receipt.canonical_facts.includes(`物品位置已更新：${event.name}。`))return null;
 if(event.destination==='held')return event.from_container_id&&event.from_container_name?
  `${event.actor_label}从${event.from_container_name}里取出了${event.name}。`:
  `${event.actor_label}把${event.name}拿在手中。`;
 if(event.destination==='scene')return `${event.actor_label}放下了${event.name}。`;
 return event.container_id&&event.container_name?`${event.actor_label}把${event.name}放进了${event.container_name}。`:null;
}

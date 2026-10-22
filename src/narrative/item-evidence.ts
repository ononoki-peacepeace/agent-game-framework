import type {SavePackage} from '../core/schema.js';
import type {PublicView} from '../shared/contracts.js';
type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];
/** Public item references may vanish from PublicView after a genuine handover.
 * Project only this player's settled references, with no private NPC inventory or later private condition. */
export function narratorReceiptItems(save:SavePackage,receipt:Receipt,view:PublicView){
 if(receipt.actor_id!==save.player_state.entity_id||!receipt.effects.includes('inventory'))return [];
 const visible=new Set(view.entities.map(entity=>entity.id));
 const transfer=receipt.semantic_action==='TRANSFER_ITEM'&&receipt.canonical_facts.includes('物品已交给当前在场的接收者。')&&
  receipt.target_id&&visible.has(receipt.target_id);
 return (receipt.result_entities?.items??[]).flatMap(id=>{
  const entity=save.entities.find(item=>item.id===id&&item.components.item);
  if(!entity||!visible.has(id)&&!transfer)return [];
  const holders=save.entities.filter(holder=>(holder.id===receipt.actor_id||holder.id===receipt.target_id)&&
   Number((holder.components.inventory?.items as Record<string,number>|undefined)?.[id]??0)>0);
  return [{item_id:id,name:String(entity.components.identity?.name??id),
   transfer_recipient_id:transfer?receipt.target_id:null,
   current_holder_id:visible.has(id)&&holders.length===1?holders[0].id:null,
   current_location_id:visible.has(id)?entity.components.location?.location_id??null:null,
   condition:visible.has(id)?entity.components.item!.condition??'intact':null}];
 });
}

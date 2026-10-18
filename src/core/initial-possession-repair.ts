import type {SavePackage} from './schema.js';
import {validateSave} from './state.js';
import {canUndo} from './turn-history.js';

/** Repair a damaged opening snapshot only when the embedded initial world is the
 * complete item ledger. Later turns need a complete movement history, which old
 * saves do not retain; biography prose alone is never sufficient evidence. */
export function repairOpeningPossessionsForAction(save:SavePackage,input:string){
  const freshOpening=save.state_revision===0&&!save.runtime.receipts.length&&!save.turn_history?.length&&
    !save.resolution_receipts?.length&&!save.action_facts?.length;
  const previous=save.turn_checkpoint?.before as Partial<SavePackage>|undefined;
  const previousReceipts=previous?.resolution_receipts??[];
  const newReceipts=save.resolution_receipts?.slice(previousReceipts.length)??[];
  const lastTransition=freshOpening?false:Boolean(previous&&canUndo(save)&&
    (save.resolution_receipts?.length??0)>=previousReceipts.length&&
    save.resolution_receipts?.slice(0,previousReceipts.length).every((receipt,index)=>
      receipt.request_id===previousReceipts[index].request_id)&&newReceipts.length&&
    newReceipts.every(receipt=>!receipt.effects.some(effect=>effect==='inventory'||effect==='state')&&
      !receipt.result_entities?.items?.length));
  if(!freshOpening&&!lastTransition)return null;
  const actorId=save.player_state.entity_id;
  const initialActor=save.definition.entities.find(e=>e.id===actorId);
  const actor=save.entities.find(e=>e.id===actorId);
  const baseline=initialActor?.components.inventory?.items as Record<string,number>|undefined;
  const live=actor?.components.inventory?.items as Record<string,number>|undefined;
  if(!baseline||!actor?.components.inventory||!live)return null;
  const initialItems=Object.entries(baseline).filter(([,count])=>count===1)
    .map(([id])=>save.definition.entities.find(e=>e.id===id)).filter(e=>e?.components.item);
  const named=initialItems.some(e=>input.includes(String(e!.components.identity?.name??''))&&
    String(e!.components.identity?.name??'').length>=2);
  if(!named)return null;
  const missing=initialItems.filter(e=>live[e!.id]!==1);
  if(!missing.length)return null;
  const priorActor=previous?.entities?.find(e=>e.id===actorId);
  const priorInventory=priorActor?.components.inventory as {items:Record<string,number>;placements?:Record<string,string|null>}|undefined;
  const candidate=structuredClone(save);
  const repairedActor=candidate.entities.find(e=>e.id===actorId)!;
  const repairedInventory=repairedActor.components.inventory! as {items:Record<string,number>;placements?:Record<string,string|null>};
  const repairedIds:string[]=[];
  for(const initial of missing){
    if(lastTransition&&priorInventory?.items[initial!.id]!==1)return null;
    if(lastTransition&&newReceipts.some(receipt=>receipt.target_id===initial!.id))return null;
    const source=(lastTransition?previous?.entities?.find(e=>e.id===initial!.id):initial)!;
    if(!source?.components.item)return null;
    if(source.components.location||source.components.item?.owner_id!==actorId)return null;
    const existing=candidate.entities.find(e=>e.id===source.id);
    if(existing&&JSON.stringify(existing.components.item)!==JSON.stringify(source.components.item))return null;
    if(candidate.entities.some(e=>e.id!==source.id&&e.components.item&&
      e.components.identity?.name===source.components.identity?.name))return null;
    if(existing?.components.location||candidate.entities.some(e=>e.id!==actorId&&
      Number((e.components.inventory?.items as Record<string,number>|undefined)?.[source.id]??0)>0))return null;
    if(!existing)candidate.entities.push(structuredClone(source));
    repairedInventory.items[source.id]=1;
    const placement=(lastTransition?priorInventory?.placements:
      initialActor!.components.inventory?.placements as Record<string,string|null>|undefined)?.[source.id]??null;
    repairedInventory.placements??={};repairedInventory.placements[source.id]=placement;
    repairedIds.push(source.id);
  }
  // Validation checks ownership, equipment and nested container references before
  // the candidate may enter the normal pending-turn transaction.
  try{return {save:validateSave(candidate),itemIds:repairedIds};}catch{return null;}
}

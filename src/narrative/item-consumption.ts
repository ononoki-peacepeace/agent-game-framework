import type {ConsumptionReceipt} from '../core/consumption-contract.js';
import type {SavePackage} from '../core/schema.js';
import {consumptionQuantity} from '../core/consumption-intent.js';
type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];
const escape=(name:string)=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Known-item explicit completed consumption assertions only; typed speech has
 * already been masked. Inventory changes alone do not prove consumption. */
export function consumptionNarrativeIssue(save:SavePackage,prose:string,receipts:Receipt[]){
 const actors=save.entities.filter(e=>e.id===save.player_state.entity_id||e.components.character&&e.components.identity?.name);
 const names=[...new Set(save.entities.filter(e=>e.components.item).map(e=>String(e.components.identity?.name??'')).filter(Boolean))].sort((a,b)=>b.length-a.length);
 for(const actor of actors){
  const subject=actor.id===save.player_state.entity_id?'你|玩家':escape(String(actor.components.identity!.name));
  const prefix=`^(?:${subject})(?:已经|刚刚|刚|又)?(吃|喝|用)(掉|完|下|了)(?:了)?(?:这|那)?`;
  const amountPattern=String.raw`[零一二两三四五六七八九十\d]+`,unit='(?:份|个|块|张|瓶|枚|件|支)';
  const pattern=names.length?new RegExp(`${prefix}(?:(${amountPattern})${unit})?(${names.map(escape).join('|')})(?=$|\\s|的|后|并|再|随后|接着)`):null;
  // A numbered standalone inventory claim cannot invent an unregistered asset.
  // Generic untracked meal activities retain their existing activity semantics.
  const unknown=receipts.some(r=>r.consumption||!r.activity)?new RegExp(`${prefix}(${amountPattern})${unit}([^，,。；;！？!?]{1,80})$`):null;
  for(const clause of prose.split(/[，,。；;！？!?\n]/)){
   const match=pattern?.exec(clause.trim())??unknown?.exec(clause.trim());if(!match)continue;
   const evidence=receipts.filter(r=>r.actor_id===actor.id&&r.consumption?.name===match[4]&&r.consumption.status==='completed');
   const method=({吃:'eat',喝:'drink',用:'use'} as Record<string,string>)[match[1]];
   const total=evidence.reduce((sum,r)=>sum+(r.consumption?.method===method?r.consumption.consumed_quantity:0),0);
   const amount=match[3]?consumptionQuantity(match[3]):null;
   const final=evidence.at(-1)?.consumption;
   if(!total||amount!==null&&amount!==total||match[2]==='完'&&amount===null&&final?.after_quantity!==0)return match[0];
  }
 }
 return null;
}

/** Exact operation prose; remaining holdings require the current inventory separately. */
export function consumptionEventNarrative(record:ConsumptionReceipt,subject='你'){
 const verb=record.method==='eat'?'吃掉':record.method==='drink'?'喝掉':'用掉';
 return record.status==='completed'?`${subject}${verb}了${record.consumed_quantity}份${record.name}。`:
  `${subject}还没${verb}${record.name}，便因眼前的事情停了下来；物品数量没有减少。`;
}

/** Only event-time co-presence exposes an NPC operation; current inventory is private. */
export function visibleNpcConsumptions(save:SavePackage,receipts:Receipt[]){
 const here=save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id;
 return receipts.filter(r=>r.actor_id!==save.player_state.entity_id&&r.semantic_action==='CONSUME_ITEM'&&
  r.consumption?.location_id===here&&typeof here==='string'&&save.entities.some(e=>e.id===r.actor_id&&
   e.components.character&&e.components.discovery?.known_to_player!==false));
}

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {consumptionWorld} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {assertFreeformGoalEvidence} from '../src/core/freeform.js';
import {hasSettledItemMovement} from '../src/core/item-operation-evidence.js';
import {itemOperationNarrative} from '../src/narrative/item-operation.js';
it.each(narrativeWorldKinds)('accepts real scene-container movement and rejects missing or contradictory authority in %s',async kind=>{
 const {save}=await consumptionWorld(kind),actor=save.entities.find(e=>e.id==='player')!,bread=save.entities.find(e=>e.id==='qa_bread')!;
 (actor.components.inventory!.items as Record<string,number>).qa_bread=1;bread.components.item!.stackable=false;
 save.entities.push({id:'qa_box',type:'item',components:{identity:{name:'木盒',description:'开放容器',avatar_id:null},location:{location_id:actor.components.location!.location_id},item:{container:true,weight:1,stackable:false}}});
 const id=randomUUID(),turn=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'scene_container',container_id:'qa_box'}},id);
 const receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(hasSettledItemMovement(turn.save,receipt)).toBe(true);expect(()=>assertFreeformGoalEvidence(turn.save,'把面包放进木盒',id)).not.toThrow();
 expect(itemOperationNarrative(receipt)).toBe('你把面包放进了木盒。');
 const missing=structuredClone(turn.save);delete missing.resolution_receipts!.at(-1)!.item_operation;
 expect(()=>assertFreeformGoalEvidence(missing,'把面包放进木盒',id)).toThrow();
 const wrong=structuredClone(turn.save);delete wrong.entities.find(e=>e.id==='qa_bread')!.components.item!.container_id;
 expect(()=>assertFreeformGoalEvidence(wrong,'把面包放进木盒',id)).toThrow();
 for(const alteration of [()=>{receipt.result_entities!.items=[];},()=>{receipt.semantic_action='INSPECT';},()=>{receipt.canonical_facts=[];}]){
  const original=structuredClone(receipt);alteration();expect(itemOperationNarrative(receipt)).toBeNull();Object.assign(receipt,original);
 }
 // Old receipt shapes remain readable, but cannot invent a past event from current state.
 const legacy=structuredClone(receipt);delete legacy.item_operation;expect(itemOperationNarrative(legacy)).toBeNull();
},30000);

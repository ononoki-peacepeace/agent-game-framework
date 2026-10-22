import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import type {SavePackage} from '../src/core/schema.js';
import {validateSave} from '../src/core/state.js';
const run=randomUUID();
it.each(narrativeWorldKinds.flatMap(kind=>[false,true].map(thirdHolder=>({kind,thirdHolder}))))('preserves shared canonical stack units on transfer in $kind / thirdHolder=$thirdHolder',async({kind,thirdHolder})=>{
 const {save}=await consumptionWorld(kind);
 const add=(id:string,n:number)=>{const actor=save.entities.find(e=>e.id===id)!;actor.components.inventory??={items:{}};(actor.components.inventory.items as Record<string,number>).qa_bread=n;};
 add('npc_lin',2);if(thirdHolder)add('npc_qiao',4);
 // Reach the one-unit transfer precondition by a real Core consumption.
 let before:SavePackage;
 try{before=executeAction(validateSave(save),{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:2}},randomUUID()).save;}
 catch(error){await writeFile(`.agent-runtime/codex/stack-transfer-initial-${run}-${kind}-${thirdHolder}.json`,JSON.stringify({save,action:{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:2}},error:String(error)},null,2));throw error;}
 const original=structuredClone(before);let turn:ReturnType<typeof executeAction>|undefined,error:string|undefined;
 try{turn=executeAction(before,{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_bread'}},randomUUID());}catch(caught){error=String(caught);}
 await writeFile(`.agent-runtime/codex/stack-transfer-core-${run}-${kind}-${thirdHolder}.json`,JSON.stringify({before,turn,error,expected:{player:0,npc:3,third:thirdHolder?4:0}},null,2));
 expect(error).toBeUndefined();expect(before).toEqual(original);
 expect(quantity(turn!.save)).toBe(0);expect(quantity(turn!.save,'qa_bread','npc_lin')).toBe(3);
 expect(quantity(turn!.save,'qa_other_bread','npc_lin')).toBe(2);
 expect(quantity(turn!.save,'qa_bread','npc_qiao')).toBe(thirdHolder?4:0);
 expect(turn!.save.entities.find(e=>e.id==='qa_bread')!.components.item!.owner_id).toBeUndefined();
 expect(turn!.action.time_cost).toBe(1);expect(turn!.save.runtime.time.minute).toBe(before.runtime.time.minute+1);
 expect(turn!.save.resolution_receipts!.at(-1)).toMatchObject({semantic_action:'TRANSFER_ITEM',item_operation:{kind:'transfer',item_id:'qa_bread',recipient_id:'npc_lin'}});
},30000);

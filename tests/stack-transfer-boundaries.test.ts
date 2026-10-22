import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {validateSave} from '../src/core/state.js';
import {unsealedContainerAncestors} from '../src/core/item-access.js';
const run=randomUUID();
it.each(narrativeWorldKinds.flatMap(kind=>(['sealed','unpacked','capacity'] as const).map(boundary=>({kind,boundary}))))('keeps actor-specific stack access and recipient boundaries in $kind / $boundary',async({kind,boundary})=>{
 const {save}=await consumptionWorld(kind),actor=save.entities.find(e=>e.id==='player')!,npc=save.entities.find(e=>e.id==='npc_lin')!;
 (actor.components.inventory!.items as Record<string,number>).qa_bread=1;
 (npc.components.inventory!.items as Record<string,number>).qa_bread=boundary==='capacity'?1000000000:1;
 if(boundary!=='capacity'){
  npc.components.inventory!.placements={qa_bread:boundary==='sealed'?'qa_npc_bag':null};
  if(boundary==='sealed'){
   (npc.components.inventory!.items as Record<string,number>).qa_npc_bag=1;
   save.entities.push({id:'qa_npc_bag',type:'item',components:{identity:{name:'封袋',description:'NPC持有的封闭容器',avatar_id:null},item:{weight:.1,stackable:false,container:true,tags:['sealed'],owner_id:'npc_lin'}}});
  }
 }
 const before=validateSave(save),snapshot=structuredClone(before),item=before.entities.find(e=>e.id==='qa_bread')!;
 expect(unsealedContainerAncestors(before,item)).toBe(false);expect(unsealedContainerAncestors(before,item,'npc_qiao')).toBe(false);
 const consumed=executeAction(before,{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}},randomUUID());
 expect(quantity(consumed.save)).toBe(0);expect(quantity(consumed.save,'qa_bread','npc_lin')).toBe(boundary==='capacity'?1000000000:1);
 const npcAction=()=>executeAction(before,{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true);
 if(boundary==='sealed')expect(npcAction).toThrow(/密封/);else expect(quantity(npcAction().save,'qa_bread','npc_lin')).toBe(boundary==='capacity'?999999999:0);
 const transfer=()=>executeAction(before,{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_bread'}},randomUUID());
 let result:unknown;
 if(boundary==='unpacked'){
  const moved=transfer();result=moved;expect(quantity(moved.save,'qa_bread','npc_lin')).toBe(2);
  expect(moved.save.entities.find(e=>e.id==='npc_lin')!.components.inventory!.placements).not.toHaveProperty('qa_bread');
 }else{try{result=transfer();}catch(error){result={error:String(error)};}expect(transfer).toThrow(boundary==='sealed'?/单件容器位置/:/数量已达世界上限/);}
 expect(before).toEqual(snapshot);
 await writeFile(`.agent-runtime/codex/stack-transfer-boundary-${run}-${kind}-${boundary}.json`,JSON.stringify({before,consumed,result},null,2));
},30000);

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import type {Inventory} from '../src/modules/inventory.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';

function fixture(sealed:boolean,owned=false,nested=false){
 const world=structuredClone(demo);world.events=[];const save=newSave(world);
 for(const id of ['player','npc_lin'])save.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 const ids=['qa_case',...(nested?['qa_pouch']:[]),'qa_note'];
 for(const id of ids)save.entities.push({id,type:'item',components:{identity:{name:id==='qa_note'?'信笺':id==='qa_case'?'封存箱':'内袋',description:'已有物品',avatar_id:null},
  item:{weight:.1,stackable:false,container:id!=='qa_note',tracking:'tracked',tags:id==='qa_case'&&sealed?['sealed']:[],
   ...(id!=='qa_case'?{container_id:id==='qa_pouch'?'qa_case':nested?'qa_pouch':'qa_case'}:{})},location:{location_id:'square'},discovery:{known_to_player:true}}});
 if(owned){
  const inventory=save.entities.find(e=>e.id==='player')!.components.inventory as Inventory;inventory.placements={qa_case:null,...(nested?{qa_pouch:'qa_case'}:{}),qa_note:nested?'qa_pouch':'qa_case'};
  for(const id of ids){inventory.items[id]=1;const e=save.entities.find(e=>e.id===id)!;delete e.components.location;delete e.components.item!.container_id;}
 }
 return validateSave(save);
}
it.each([{owned:false,nested:false},{owned:false,nested:true},{owned:true,nested:false},{owned:true,nested:true}])(
 'cannot extract an existing known item through sealed ancestors (owned=$owned,nested=$nested)',({owned,nested})=>{
  const save=fixture(true,owned,nested),before=structuredClone(save);
  expect(()=>executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_note',to:'held'}},randomUUID())).toThrow('密封');
  expect(save).toEqual(before);
 });
it.each([false,true])('cannot hand over an item still inside a sealed held container (nested=%s)',nested=>{
 const save=fixture(true,true,nested),before=structuredClone(save);
 expect(()=>executeAction(save,{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_note'}},randomUUID())).toThrow('密封');
 expect(save).toEqual(before);
});
it.each([false,true])('still extracts an item from reachable unsealed nesting (owned=%s)',owned=>{
 const after=executeAction(fixture(false,owned,true),{type:'MOVE_ITEM',parameters:{item_id:'qa_note',to:'held'}},randomUUID()).save;
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_note).toBe(1);
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).placements?.qa_note).toBeNull();
});
it('still transfers an item from unsealed held nesting',()=>{
 const after=executeAction(fixture(false,true,true),{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_note'}},randomUUID()).save;
 expect((after.entities.find(e=>e.id==='npc_lin')!.components.inventory as Inventory).items.qa_note).toBe(1);
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_note).toBeUndefined();
});
it.each([false,true])('cannot insert a loose held item into a sealed container or concealed destination (nested=%s)',nested=>{
 const save=fixture(true,true,nested),inventory=save.entities.find(e=>e.id==='player')!.components.inventory as Inventory;
 inventory.placements!.qa_note=null;validateSave(save);const before=structuredClone(save);
 expect(()=>executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_note',to:'container',container_id:nested?'qa_pouch':'qa_case'}},randomUUID())).toThrow('密封');
 expect(save).toEqual(before);
});
it('cannot put a loose item into an unsealed scene container hidden behind a sealed ancestor',()=>{
 const save=fixture(true,false,true),player=save.entities.find(e=>e.id==='player')!,note=save.entities.find(e=>e.id==='qa_note')!;
 (player.components.inventory as Inventory).items.qa_note=1;delete note.components.location;delete note.components.item!.container_id;validateSave(save);
 const before=structuredClone(save);
 expect(()=>executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_note',to:'scene_container',container_id:'qa_pouch'}},randomUUID())).toThrow('当前可存放范围');
 expect(save).toEqual(before);
});
it('does not drop an item out of sealed held nesting',()=>{
 const save=fixture(true,true,true),before=structuredClone(save);
 expect(()=>executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_note',to:'scene'}},randomUUID())).toThrow('密封');expect(save).toEqual(before);
});
it('can still pick up an empty sealed container by its exterior',()=>{
 const save=fixture(true);save.entities=save.entities.filter(e=>e.id!=='qa_note');validateSave(save);
 const after=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_case',to:'held'}},randomUUID()).save;
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_case).toBe(1);
});
it.each(['MOVE_ITEM','TRANSFER_ITEM'] as const)('preserves disk bytes and time when %s is refused across service recreation',async type=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-sealed-movement-'));
 try{
  const save=fixture(true,true,true),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Blocked action must not generate');}}),service=new GameService(store,ai,save.definition),before=await service.current();
  const bytes=await readFile(join(directory,'current.json')),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),
   action:type==='MOVE_ITEM'?{type,parameters:{item_id:'qa_note',to:'held'}}:{type,target_id:'npc_lin',parameters:{item_id:'qa_note'}}};
  await expect(service.turn(body)).rejects.toThrow('密封');expect(await store.read()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);await expect(restarted.turn(body)).rejects.toThrow('密封');
  expect(await restarted.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it.each([false,true])('applies sealed source prerequisites to original-language freeform transfer (sealed=%s)',sealed=>{
 const save=fixture(sealed,true,true),before=structuredClone(save),run=()=>executeFreeform(save,'我把信笺交给林舟',{
  narrative:'转交尝试候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,item_move:{item_id:'qa_note',to:'target',position_label:null},
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'转交已有信笺',stages:[],evidence_ids:[]}},randomUUID());
 if(sealed)expect(run).toThrow('密封');
 else expect((run().save.entities.find(e=>e.id==='npc_lin')!.components.inventory as Inventory).items.qa_note).toBe(1);
 expect(save).toEqual(before);
});

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {bindStorageAction} from '../src/core/action-binding.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {executeFreeform} from '../src/core/freeform.js';
import {executeAction} from '../src/core/runtime.js';
import {makeChoiceOffers} from '../src/core/choice-offer.js';
import {validateSave} from '../src/core/state.js';
import type {Inventory} from '../src/modules/inventory.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

const input='把木板放进箱子',proposal={narrative:'候选收纳',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,
 storage_move:{item_name:'木板',item_id:'qa_board',container_name:'箱子',container_id:'qa_case'},completion_quote:null,required_conditions:[],
 resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'收纳已有物品',stages:[],evidence_ids:[]}};
async function fixture(side:'source'|'destination',sealed:boolean,held:boolean){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const player=save.entities.find(e=>e.id==='player')!,here=player.components.location!.location_id;
 for(const [id,name,container] of [['qa_board','木板',false],['qa_case','箱子',true],['qa_outer','外箱',true]] as const){
  save.entities.push({id,type:'item',components:{identity:{name,description:'已有物品',avatar_id:null},
   item:{weight:.1,stackable:false,tracking:'tracked',container,tags:sealed&&id===(side==='source'?'qa_outer':'qa_case')?['sealed']:[]},
   discovery:{known_to_player:true},...(held?{}:{location:{location_id:here}})}});
 }
 if(held){const inventory=player.components.inventory as Inventory;inventory.placements={};
  for(const id of ['qa_board','qa_case','qa_outer']){inventory.items[id]=1;inventory.placements[id]=side==='source'&&id==='qa_board'?'qa_outer':null;}
 }else if(side==='source')save.entities.find(e=>e.id==='qa_board')!.components.item!.container_id='qa_outer';
 return validateSave(save);
}
it.each((['source','destination'] as const).flatMap(side=>[false,true].flatMap(held=>[false,true].map(sealed=>({side,held,sealed})))))(
 'aligns storage binding, offered Choice and execution ($side,held=$held,sealed=$sealed)',async({side,held,sealed})=>{
 const save=await fixture(side,sealed,held),before=structuredClone(save),binding=bindStorageAction(save,input);
 expect(binding.usableForAction).toBe(!sealed);
 expect(classifyChoiceExecution(save,input)).toBe(sealed?'NOT_EXECUTABLE':'CONDITIONALLY_EXECUTABLE');
 expect(makeChoiceOffers(save,[input])).toHaveLength(sealed?0:1);
 const run=()=>executeFreeform(save,input,proposal,randomUUID());
 if(sealed)expect(run).toThrow('密封');else expect(run().save.resolution_receipts?.at(-1)?.storage).toEqual({item_id:'qa_board',container_id:'qa_case'});
 expect(save).toEqual(before);
});
it.each([false,true])('still permits moving the exterior of an empty sealed container (held=%s)',async held=>{
 const save=await fixture('destination',true,held),before=structuredClone(save);
 const turn=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_case',to:held?'scene':'held'}},randomUUID());
 const player=turn.save.entities.find(e=>e.id==='player')!,inventory=player.components.inventory as Inventory;
 if(held)expect(turn.save.entities.find(e=>e.id==='qa_case')!.components.location?.location_id).toBe(player.components.location!.location_id);
 else expect(inventory.items.qa_case).toBe(1);expect(save).toEqual(before);
});
it.each(['source','destination'] as const)('keeps unavailable %s choices filtered after JsonStore/service recreation',async side=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-sealed-binding-'));try{
  const save=await fixture(side,true,true),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Read-only choice filtering must not generate');}});
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   const state=await current.current();expect(bindStorageAction(state,input).usableForAction).toBe(false);
   expect(classifyChoiceExecution(state,input)).toBe('NOT_EXECUTABLE');expect(makeChoiceOffers(state,[input])).toHaveLength(0);
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

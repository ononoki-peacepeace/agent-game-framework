import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {setItemCondition,type Inventory} from '../src/modules/inventory.js';
import {commitTruth} from '../src/narrative/truth.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

function fixture(sealed:boolean,owned:boolean){
 const world=structuredClone(demo);world.events=[];const save=newSave(world),player=save.entities.find(e=>e.id==='player')!;
 player.components.location={location_id:'square'};
 save.entities.push({id:'qa_case',type:'item',components:{identity:{name:'封存箱',description:'箱子',avatar_id:null},location:{location_id:'square'},
  item:{weight:1,stackable:false,container:true,tags:sealed?['sealed']:[],tracking:'tracked'}}},
 {id:'qa_note',type:'item',components:{identity:{name:'信笺',description:'已登记的信笺',avatar_id:null},location:{location_id:'square'},
  item:{weight:.01,stackable:false,container_id:'qa_case',tracking:'tracked'},discovery:{known_to_player:true}}});
 if(owned){const inventory=player.components.inventory as Inventory;inventory.items.qa_case=1;inventory.items.qa_note=1;inventory.placements={qa_case:null,qa_note:'qa_case'};
  for(const id of ['qa_case','qa_note']){const entity=save.entities.find(e=>e.id===id)!;delete entity.components.location;delete entity.components.item!.container_id;}}
 commitTruth(save,{id:'qa_truth',commitment:'HARD_TRUTH',statement:'固定历史',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,known_by:[],
  evidence:[{id:'qa_mark',status:'EXISTS',description:'信笺上的记号',event_ref:null,discovered_by:[],placement:{location_id:'square',anchor_entity_id:'qa_note',scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
 return validateSave(save);
}
it.each([false,true])('does not roll or damage through a sealed container (owned=%s)',owned=>{
 const save=fixture(true,owned),before=structuredClone(save),rng=vi.fn(()=>.99);
 expect(()=>executeAction(save,{type:'DAMAGE_ITEM',target_id:'qa_note',parameters:{extent:'destroy'}},randomUUID(),'player',rng)).toThrow('密封');
 expect(rng).not.toHaveBeenCalled();expect(save).toEqual(before);
});
it.each([false,true])('keeps the shared item-condition mutation from bypassing sealed ancestry (owned=%s)',owned=>{
 const save=fixture(true,owned),before=structuredClone(save);
 expect(()=>setItemCondition(save,'qa_note','destroyed',randomUUID())).toThrow('密封');expect(save).toEqual(before);
});
it.each([false,true])('still settles real damage and evidence destruction on an accessible item (owned=%s)',owned=>{
 const save=fixture(false,owned),after=executeAction(save,{type:'DAMAGE_ITEM',target_id:'qa_note',parameters:{extent:'destroy'}},randomUUID(),'player',()=>.99).save;
 expect(after.entities.find(e=>e.id==='qa_note')!.components.item!.condition).toBe('destroyed');
 expect(after.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0].status).toBe('DESTROYED');
 expect(save.entities.find(e=>e.id==='qa_note')!.components.item!.condition).toBeUndefined();
});
it.each([false,true])('keeps refused damage and evidence unchanged on disk across service recreation (owned=%s)',async owned=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-sealed-damage-'));
 try{
  const save=fixture(true,owned),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Blocked damage must not generate');}}),service=new GameService(store,ai,save.definition),before=await service.current();
  const bytes=await readFile(join(directory,'current.json')),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'DAMAGE_ITEM',target_id:'qa_note',parameters:{extent:'destroy'}}};
  await expect(service.turn(body)).rejects.toThrow('密封');expect(await store.read()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);await expect(restarted.turn(body)).rejects.toThrow('密封');
  expect(await restarted.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

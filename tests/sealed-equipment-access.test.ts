import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import type {Inventory} from '../src/modules/inventory.js';
import type {Equipment} from '../src/modules/equipment.js';
import {WorldBlockedError} from '../src/agent/outcome.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
function fixture(actorId='player',sealed=true,nested=false){
 const world=structuredClone(demo);world.events=[];const save=newSave(world);
 if(!save.definition.enabled_modules.includes('equipment'))save.definition.enabled_modules.push('equipment');save.module_versions.equipment='0.1.0';
 const actor=save.entities.find(e=>e.id===actorId)!;actor.components.equipment={slots:{hand:null,shoulder:null}};
 actor.components.inventory={items:{qa_ring:1,qa_bag:1},placements:{qa_ring:'qa_bag',qa_bag:nested?'qa_outer':null}};
 save.entities.push({id:'qa_ring',type:'item',components:{identity:{name:'铜戒指',description:'已有装备',avatar_id:null},
  item:{weight:.01,stackable:false,tracking:'tracked',owner_id:actorId},equipment_item:{allowed_slots:['hand'],modifiers:{},effect:'无额外效果'}}},
 {id:'qa_bag',type:'item',components:{identity:{name:'随身袋',description:'已有容器',avatar_id:null},
  item:{weight:.1,stackable:false,container:true,tracking:'tracked',owner_id:actorId,tags:sealed&&!nested?['sealed']:[]},
  equipment_item:{allowed_slots:['shoulder'],modifiers:{},effect:'无额外效果'}}});
 if(nested){const inv=actor.components.inventory as Inventory;inv.items.qa_outer=1;inv.placements!.qa_outer=null;
  save.entities.push({id:'qa_outer',type:'item',components:{identity:{name:'外袋',description:'已有外层容器',avatar_id:null},
   item:{weight:.1,stackable:false,container:true,tracking:'tracked',owner_id:actorId,tags:sealed?['sealed']:[]}}});}
 return validateSave(save);
}
const action={type:'EQUIP',parameters:{item_id:'qa_ring',slot:'hand'}};
const equip=(save:ReturnType<typeof fixture>,actorId='player')=>executeAction(save,action,randomUUID(),'player',undefined,undefined,true,actorId).save;
it.each(['player','npc_lin'])('refuses %s equipping an item through its sealed source',actorId=>{
 const save=fixture(actorId),before=structuredClone(save);expect(()=>equip(save,actorId)).toThrow('密封');
 expect(()=>equip(save,actorId)).toThrow(WorldBlockedError);expect(save).toEqual(before);
});
it.each(['player','npc_lin'])('checks every ancestor for %s, including a sealed outer bag',actorId=>{
 const save=fixture(actorId,true,true),before=structuredClone(save);expect(()=>equip(save,actorId)).toThrow('密封');expect(save).toEqual(before);
});
it.each(['player','npc_lin'])('preserves %s equipment access through open nesting',actorId=>{
 const save=fixture(actorId,false,true),after=equip(save,actorId);
 expect((after.entities.find(e=>e.id===actorId)!.components.equipment as Equipment).slots.hand).toBe('qa_ring');
 expect(save.entities.find(e=>e.id===actorId)!.components.equipment!.slots).toEqual({hand:null,shoulder:null});
});
it.each(['player','npc_lin'])('allows %s to equip a sealed container itself from its accessible exterior',actorId=>{
 const save=fixture(actorId),after=executeAction(save,{type:'EQUIP',parameters:{item_id:'qa_bag',slot:'shoulder'}},randomUUID(),'player',undefined,undefined,true,actorId).save;
 expect((after.entities.find(e=>e.id===actorId)!.components.equipment as Equipment).slots.shoulder).toBe('qa_bag');
 expect(after.entities.find(e=>e.id==='qa_bag')!.components.item!.tags).toEqual(['sealed']);
});
it('preserves actual disk bytes and every state field across repeated refused service requests after restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-sealed-equip-'));
 try{
  const save=fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Refused equipment must not generate');}});
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action};
  await expect(service.turn(body)).rejects.toBeInstanceOf(WorldBlockedError);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);await expect(restarted.turn(body)).rejects.toThrow('密封');
  expect(await restarted.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

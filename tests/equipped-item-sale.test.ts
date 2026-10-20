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
import type {Shop,Wallet} from '../src/modules/commerce.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {WorldBlockedError} from '../src/agent/outcome.js';

afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const world=structuredClone(demo);world.events=[];const save=newSave(world);
 if(!save.definition.enabled_modules.includes('equipment'))save.definition.enabled_modules.push('equipment');
 save.module_versions.equipment='0.1.0';
 const player=save.entities.find(e=>e.id==='player')!;player.components.location={location_id:'market'};
 player.components.equipment={slots:{hand:'qa_ring'}};
 const inv=player.components.inventory as Inventory;inv.items.qa_ring=1;inv.placements={qa_ring:null};
 save.entities.push({id:'qa_ring',type:'item',components:{identity:{name:'铜戒指',description:'已有可出售装备',avatar_id:null},
  item:{weight:.01,stackable:false,tracking:'tracked',owner_id:'player'},equipment_item:{allowed_slots:['hand'],modifiers:{},effect:'无额外效果'}}});
 const shop=save.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop;shop.stock.qa_ring=0;shop.prices.qa_ring={buy:10,sell:5};
 return validateSave(save);
}
const action={type:'SELL',target_id:'corner_shop',parameters:{item_id:'qa_ring',quantity:1}};
it('requires unequipping before sale and preserves every authoritative fact',()=>{
 const save=fixture(),before=structuredClone(save);expect(()=>executeAction(save,action,randomUUID())).toThrow('卸下');
 expect(()=>executeAction(save,action,randomUUID())).toThrow(WorldBlockedError);expect(save).toEqual(before);
});
it('sells normally after an explicit Core UNEQUIP',()=>{
 const save=fixture(),unequipped=executeAction(save,{type:'UNEQUIP',parameters:{slot:'hand'}},randomUUID()).save;
 const after=executeAction(unequipped,action,randomUUID()).save;
 expect((after.entities.find(e=>e.id==='player')!.components.equipment as Equipment).slots.hand).toBeNull();
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_ring??0).toBe(0);
 expect((after.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop).stock.qa_ring).toBe(1);
 expect((after.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit).toBe((save.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit+5);
});
it('persists no payment, minute or prose for repeated equipped-sale refusal after service recreation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-equipped-sale-'));
 try{
  const save=fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Refused sale must not generate');}});
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action};
  await expect(service.turn(body)).rejects.toThrow('卸下');
  await expect(service.turn(body)).rejects.toBeInstanceOf(WorldBlockedError);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);await expect(restarted.turn(body)).rejects.toThrow('卸下');
  expect(await restarted.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

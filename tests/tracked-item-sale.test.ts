import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import type {Inventory} from '../src/modules/inventory.js';
import type {Shop,Wallet} from '../src/modules/commerce.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());

function fixture(nested=false,sealed=false,legacy=false){
 const world=structuredClone(demo);world.events=[];const save=newSave(world),player=save.entities.find(e=>e.id==='player')!,inventory=player.components.inventory as Inventory;
 player.components.location={location_id:'market'};inventory.items.qa_note=1;if(!legacy)inventory.placements={qa_note:nested?'qa_bag':null};
 save.entities.push({id:'qa_note',type:'item',components:{identity:{name:'旧信笺',description:'已有可交易物品',avatar_id:null},
  item:{weight:.01,stackable:false,tracking:'tracked',owner_id:'player'}}});
 if(nested){save.entities.push({id:'qa_bag',type:'item',components:{identity:{name:'随身袋',description:'已有容器',avatar_id:null},
  item:{weight:.1,stackable:false,container:true,tracking:'tracked',owner_id:'player',tags:sealed?['sealed']:[]}}});inventory.items.qa_bag=1;inventory.placements!.qa_bag=null;}
 const shop=save.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop;shop.stock.qa_note=0;shop.prices.qa_note={buy:10,sell:5};
 if(nested){shop.stock.qa_bag=0;shop.prices.qa_bag={buy:8,sell:4};}
 return validateSave(save);
}
const sell=(save:ReturnType<typeof fixture>)=>executeAction(save,{type:'SELL',target_id:'corner_shop',parameters:{item_id:'qa_note',quantity:1}},randomUUID()).save;
it.each([false,true])('sells a tracked item and removes its old placement (nested=%s)',nested=>{
 const save=fixture(nested),after=sell(save),inventory=after.entities.find(e=>e.id==='player')!.components.inventory as Inventory;
 expect(inventory.items.qa_note??0).toBe(0);expect(inventory.placements?.qa_note).toBeUndefined();
 expect(after.entities.find(e=>e.id==='qa_note')!.components.item!.owner_id).toBeUndefined();
 expect((after.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit).toBe((save.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit+5);
 expect((after.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop).stock.qa_note).toBe(1);expect(save.entities.find(e=>e.id==='qa_note')!.components.item!.owner_id).toBe('player');
});
it('refuses a sale through a sealed source before changing balances or inventory',()=>{
 const save=fixture(true,true),before=structuredClone(save);expect(()=>sell(save)).toThrow('密封');expect(save).toEqual(before);
});
it('retains the original sale behavior for a legal item without placement metadata',()=>{
 const save=fixture(false,false,true),after=sell(save);
 expect((after.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop).stock.qa_note).toBe(1);
 expect((after.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit).toBe((save.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit+5);
});
it('requires taking contents out before selling their container',()=>{
 const save=fixture(true),before=structuredClone(save);
 expect(()=>executeAction(save,{type:'SELL',target_id:'corner_shop',parameters:{item_id:'qa_bag',quantity:1}},randomUUID())).toThrow('取出');expect(save).toEqual(before);
});
it('can buy the same tracked item back after its sale without a stale placement or duplicate stock',()=>{
 const save=fixture(true),sold=sell(save),after=executeAction(sold,{type:'BUY',target_id:'corner_shop',parameters:{item_id:'qa_note',quantity:1}},randomUUID()).save;
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_note).toBe(1);
 expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).placements?.qa_note).toBeUndefined();
 expect((after.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop).stock.qa_note).toBe(0);
 expect((after.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit).toBe((save.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit-5);
 validateSave(after);
});
it('persists one real sale and replays after service recreation without another payment or minute',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-tracked-sale-'));
 try{
  const save=fixture(true),store=new JsonStore(directory);await store.write(save);const ai=new AIRuntime(new MockAIAdapter());
  vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
  const service=new GameService(store,ai,save.definition),before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'SELL',target_id:'corner_shop',parameters:{item_id:'qa_note',quantity:1}}};
  await service.turn(body);const after=await service.current();expect(after.state_revision).toBe(before.state_revision+1);
  expect((after.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit).toBe((before.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit+5);
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='SELL')).toHaveLength(1);
  expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).placements?.qa_note).toBeUndefined();
  const bytes=await readFile(join(directory,'current.json')),replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}}),restarted=new GameService(new JsonStore(directory),replayAi,before.definition);
  await restarted.turn(body);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('preserves disk bytes and payment state on a sealed sale refusal across service recreation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-sealed-sale-'));
 try{
  const save=fixture(true,true),store=new JsonStore(directory);await store.write(save);const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Refused sale must not generate');}});
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json')),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'SELL',target_id:'corner_shop',parameters:{item_id:'qa_note',quantity:1}}};
  await expect(service.turn(body)).rejects.toThrow('密封');const restarted=new GameService(new JsonStore(directory),ai,save.definition);await expect(restarted.turn(body)).rejects.toThrow('密封');
  expect(await restarted.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

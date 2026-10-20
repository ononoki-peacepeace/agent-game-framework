import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import type {Inventory} from '../src/modules/inventory.js';
import type {Shop,Wallet} from '../src/modules/commerce.js';
import {JsonStore} from '../src/storage/json-store.js';
import {executeAction} from '../src/core/runtime.js';
import {canonicalResolutionNarrative} from '../src/core/narrative-firewall.js';

afterEach(()=>vi.restoreAllMocks());
const scenes=['BUY','SELL','EQUIP','UNEQUIP'] as const;
const cases=scenes.flatMap(scene=>(['refusal','content_filter'] as const).map(reason=>({scene,reason})));
function fixture(scene:typeof scenes[number]){
 const world=structuredClone(demo);world.events=[];const save=newSave(world);
 if(!save.definition.enabled_modules.includes('equipment'))save.definition.enabled_modules.push('equipment');save.module_versions.equipment='0.1.0';
 const player=save.entities.find(e=>e.id==='player')!,inv=player.components.inventory as Inventory;player.components.location={location_id:'market'};
 player.components.equipment={slots:{hand:scene==='UNEQUIP'?'qa_ring':null}};
 if(scene!=='BUY'){inv.items.qa_ring=1;inv.placements={qa_ring:null};}
 save.entities.push({id:'qa_ring',type:'item',components:{identity:{name:'铜戒指',description:'已有可交易装备',avatar_id:null},
  item:{weight:.01,stackable:false,tracking:'tracked',...(scene==='BUY'?{}:{owner_id:'player'})},
  equipment_item:{allowed_slots:['hand'],modifiers:{},effect:'无额外效果'}}});
 const shop=save.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop;shop.stock.qa_ring=scene==='BUY'?1:0;shop.prices.qa_ring={buy:10,sell:5};
 save.gm_state.notes='PRIVATE_ITEM_FALLBACK_SECRET';
 return validateSave(save);
}
function itemAction(scene:typeof scenes[number]){
 return scene==='BUY'||scene==='SELL'?{type:scene,target_id:'corner_shop',parameters:{item_id:'qa_ring',quantity:1}}:
  scene==='EQUIP'?{type:scene,parameters:{item_id:'qa_ring',slot:'hand'}}:{type:scene,parameters:{slot:'hand'}};
}
it.each(cases)('describes actual $scene item facts without a generic summary after $reason',async({scene,reason})=>{
 const save=fixture(scene),store=new MemoryStore();await store.write(save);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition),before=await service.current();
 const narrate=vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError(reason,'offline fixture','描写未完成'));
 const action=itemAction(scene);
 const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action};
 await service.turn(body);const after=await service.current(),prose=after.last_turn!.narrative,receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
 expect(receipt.semantic_action).toBe(scene);expect(receipt.commit_status).toBe('committed');expect(receipt.canonical_facts.some(f=>f.includes('铜戒指'))).toBe(true);
 expect(prose).toContain('铜戒指');expect(prose).toMatch(scene==='BUY'?/买下|买了/:scene==='SELL'?/卖出|卖了/:scene==='EQUIP'?/装备/:/卸下/);
 expect(prose).not.toMatch(/按规则|程序|系统|回执|版本|结算|生成|已经保存|登记|位置.*更新|这次尝试|qa_ring|PRIVATE_ITEM_FALLBACK_SECRET|微笑|点头|答应/);
 const currency=before.definition.ruleset.currencies.credit;
 expect(prose).toBe(scene==='BUY'?`你买下了1件铜戒指，付了10${currency}。`:scene==='SELL'?`你卖出了1件铜戒指，收到了5${currency}。`:scene==='EQUIP'?'你装备好了铜戒指。':'你卸下了铜戒指。');
 if(scene==='BUY'||scene==='SELL'){
  const delta=(after.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit-(before.entities.find(e=>e.id==='player')!.components.wallet as Wallet).balances.credit;
  expect(delta).toBe(scene==='BUY'?-10:5);expect(prose).toContain(String(Math.abs(delta)));expect(prose).toContain(before.definition.ruleset.currencies.credit);
 }
 expect(after.last_turn!.presentation?.status).toBe('degraded');expect(after.state_revision).toBe(before.state_revision+1);expect(narrate).toHaveBeenCalledOnce();
 await service.turn(body);expect(await store.read()).toEqual(after);expect(narrate).toHaveBeenCalledOnce();
});
it('keeps ordered item stages readable after a real compound purchase and equip',async()=>{
 const save=fixture('BUY'),store=new MemoryStore();await store.write(save);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition),before=await service.current();
 vi.spyOn(ai,'interpret').mockImplementation(async(_save,input)=>itemAction(input==='买戒指'?'BUY':'EQUIP'));
 vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
 const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'买戒指，再装备戒指'};
 await service.turn(body,undefined,undefined,undefined,false,undefined,['买戒指','装备戒指']);
 const after=await service.current(),prose=after.last_turn!.narrative;
 expect(prose).toBe(`1、你买下了1件铜戒指，付了10${before.definition.ruleset.currencies.credit}。\n2、你装备好了铜戒指。`);
 expect(after.resolution_receipts!.slice(-3,-1).map(r=>r.semantic_action)).toEqual(['BUY','EQUIP']);
 expect(after.resolution_receipts!.at(-1)!.commit_status).toBe('committed');
 expect((after.entities.find(e=>e.id==='player')!.components.equipment!.slots as Record<string,string|null>).hand).toBe('qa_ring');
});
it('replays the saved factual trade prose after actual disk and service recreation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-item-prose-'));
 try{
  const save=fixture('SELL'),store=new JsonStore(directory);await store.write(save);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition),before=await service.current();
  vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:itemAction('SELL')};
  await service.turn(body);const after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.last_turn!.narrative).toBe(`你卖出了1件铜戒指，收到了5${before.definition.ruleset.currencies.credit}。`);
  const replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}}),restarted=new GameService(new JsonStore(directory),replayAi,save.definition);
  await restarted.turn(body);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('does not turn hidden, failed, foreign or incomplete facts into an item success',()=>{
 const save=fixture('BUY'),receipt=executeAction(save,itemAction('BUY'),randomUUID()).save.resolution_receipts!.at(-1)!;
 expect(canonicalResolutionNarrative(receipt,true)).not.toContain('铜戒指');
 expect(canonicalResolutionNarrative({...receipt,outcome:'failure'},false)).not.toContain('买下');
 expect(canonicalResolutionNarrative({...receipt,kind:'SIMPLE_CHECK'},false)).not.toContain('买下');
 expect(canonicalResolutionNarrative({...receipt,semantic_action:'CUSTOM_ACTION'},false)).not.toContain('铜戒指');
 expect(canonicalResolutionNarrative({...receipt,canonical_facts:['PRIVATE_ITEM_FALLBACK_SECRET','购买 1 × 铜戒指，金额']},false)).not.toContain('铜戒指');
});
it('uses actual Core stack quantity and zero sale price without inferring amounts from inventory',()=>{
 const save=fixture('BUY'),item=save.entities.find(e=>e.id==='qa_ring')!,shop=save.entities.find(e=>e.id==='corner_shop')!.components.shop as Shop;
 item.components.item!.stackable=true;shop.stock.qa_ring=3;shop.prices.qa_ring.sell=0;
 const bought=executeAction(validateSave(save),{type:'BUY',target_id:'corner_shop',parameters:{item_id:'qa_ring',quantity:2}},randomUUID()).save;
 const receipt=bought.resolution_receipts!.at(-1)!;
 expect(canonicalResolutionNarrative(receipt,false)).toBe(`你买下了2件铜戒指，付了20${save.definition.ruleset.currencies.credit}。`);
 const sold=executeAction(bought,{type:'SELL',target_id:'corner_shop',parameters:{item_id:'qa_ring',quantity:1}},randomUUID()).save;
 expect(canonicalResolutionNarrative(sold.resolution_receipts!.at(-1)!,false)).toBe(`你卖出了1件铜戒指，收到了0${save.definition.ruleset.currencies.credit}。`);
 expect((sold.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_ring).toBe(1);
});

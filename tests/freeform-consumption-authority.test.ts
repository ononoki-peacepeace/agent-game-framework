import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {WorldBlockedError} from '../src/agent/outcome.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {validateSave} from '../src/core/state.js';
import {EventBus} from '../src/core/registry.js';
import type {Inventory} from '../src/modules/inventory.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'活动候选',minutes:2,target_id:null,facts:[],relationship:null,
 resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,visibility:'public' as const,
  stakes:'普通活动',stages:[],evidence_ids:[]}};
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const inventory=save.entities.find(e=>e.id==='player')!.components.inventory as Inventory;
 for(const [id,name] of [['qa_cookie','饼干'],['qa_water','瓶装水']]){
  save.entities.push({id,type:'item',components:{identity:{name,description:'已登记资源',avatar_id:null},
   item:{weight:.1,stackable:true,tracking:'tracked',condition:'intact',tags:[]},discovery:{known_to_player:true}}});
  inventory.items[id]=2;
 }
 return validateSave(save);
}
it.each(['吃掉饼干','把饼干吃完','喝完瓶装水','把瓶装水喝掉'].flatMap(input=>[false,true].map(staleBinding=>({input,staleBinding}))))(
 'does not substitute an activity receipt for canonical consumption: $input / staleBinding=$staleBinding',async({input,staleBinding})=>{
 const save=await fixture(),before=structuredClone(save),rng=vi.fn(()=>.99);
 const emit=vi.spyOn(EventBus.prototype,'emit');
 expect(()=>executeFreeform(save,input,{...proposal,completion_quote:input},randomUUID(),rng,false,
  staleBinding?{target_ids:['npc_lin']}:undefined)).toThrow(WorldBlockedError);
 expect(save).toEqual(before);expect(rng).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();
});
it.each(['仔细观察饼干','闻一闻饼干','查看瓶装水','不要吃掉饼干，只查看它','做一份简单早饭并吃完'])(
 'preserves lawful observation and untracked daily activity: %s',async input=>{
 const save=await fixture(),before=structuredClone(save),turn=executeFreeform(save,input,proposal,randomUUID());
 expect(turn.save.resolution_receipts!.at(-1)!.activity?.occurred).toBe(true);
 expect(turn.action.time_cost).toBe(2);expect(save).toEqual(before);
 expect(turn.save.entities.find(e=>e.id==='player')!.components.inventory).toEqual(before.entities.find(e=>e.id==='player')!.components.inventory);
});
it.each([false,true])('keeps refused resource consumption off disk and out of prose (fallback=%s)',async fallback=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-consumption-authority-'));try{
  const save=await fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'offline-consumption',generate:async()=>{throw Error('Unexpected provider');}});
  const freeform=vi.spyOn(ai,'freeform').mockResolvedValue({...proposal,completion_quote:'吃掉饼干'});
  const narrate=vi.spyOn(ai,'narrate').mockImplementation(async()=>{
   if(fallback)throw new ProviderError('refusal','offline-only','No provider');
   return {narrative:'你吃掉了饼干。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]};
  });
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const bytes=await readFile(join(directory,'current.json'));
  const writes=vi.spyOn(JsonStore.prototype,'write');
  const body={input:'吃掉饼干',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toBeInstanceOf(WorldBlockedError);
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(freeform).toHaveBeenCalledTimes(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);expect(writes).not.toHaveBeenCalled();
 }finally{await rm(directory,{recursive:true,force:true});}
});

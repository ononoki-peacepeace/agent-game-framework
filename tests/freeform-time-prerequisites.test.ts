import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {EventBus,type ActionContext} from '../src/core/registry.js';
import {validateSave} from '../src/core/state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import type {Inventory} from '../src/modules/inventory.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'行动候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'普通行动',stages:[],evidence_ids:[]}};
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 save.entities.push({id:'qa_piano',type:'item',components:{identity:{name:'钢琴',description:'已登记的钢琴',avatar_id:null},
  item:{weight:1,stackable:false,tracking:'tracked',condition:'intact',tags:[]},discovery:{known_to_player:true},location:{location_id:here}}});
 return validateSave(save);
}
function timeHook(mutate:(ctx:ActionContext)=>void){
 const original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);
  if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){calls++;mutate(ctx);}
 });
 return ()=>calls;
}
it.each(['destroyed','remote'] as const)('refuses activity if time hooks make its registered instrument %s',async change=>{
 const save=await fixture(),before=structuredClone(save),rng=vi.fn(()=>0.5);
 const calls=timeHook(c=>{
  const piano=c.save.entities.find(e=>e.id==='qa_piano')!;
  if(change==='destroyed')piano.components.item!.condition='destroyed';else piano.components.location!.location_id='station';
 });
 expect(()=>executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID(),rng)).toThrow();
 expect(calls()).toBe(1);expect(save).toEqual(before);expect(rng).not.toHaveBeenCalled();
});
it('does not pull a resource back from a remote location after its time hook moved it',async()=>{
 const save=await fixture(),before=structuredClone(save),rng=vi.fn(()=>0.5);
 const calls=timeHook(c=>{c.save.entities.find(e=>e.id==='qa_piano')!.components.location!.location_id='station';});
 expect(()=>executeFreeform(save,'拿起钢琴',{...proposal,item_move:{item_id:'qa_piano',to:'held',position_label:null}},randomUUID(),rng)).toThrow();
 expect(calls()).toBe(1);expect(save).toEqual(before);expect(rng).not.toHaveBeenCalled();
});
it('keeps a still-accessible instrument usable after time hooks',async()=>{
 const save=await fixture(),calls=timeHook(c=>{c.save.entities.find(e=>e.id==='qa_piano')!.components.item!.condition='damaged';});
 const after=executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID()).save;
 expect(calls()).toBe(1);expect(after.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);
 expect(after.entities.find(e=>e.id==='qa_piano')!.components.item!.condition).toBe('damaged');
 expect(save.entities.find(e=>e.id==='qa_piano')!.components.item!.condition).toBe('intact');
});
it('rechecks sealed ancestry introduced by a time hook before moving an item',async()=>{
 const save=await fixture(),before=structuredClone(save);
 const calls=timeHook(c=>{
  const player=c.save.entities.find(e=>e.id==='player')!,item=c.save.entities.find(e=>e.id==='qa_piano')!;
  c.save.entities.push({id:'qa_case',type:'item',components:{identity:{name:'箱子',description:'封存箱',avatar_id:null},
   item:{weight:1,stackable:false,tracking:'tracked',container:true,tags:['sealed']},discovery:{known_to_player:true}}});
  const inventory=player.components.inventory as Inventory;
  inventory.items={...inventory.items,qa_case:1,qa_piano:1};
  inventory.placements={qa_case:null,qa_piano:'qa_case'};delete item.components.location;
 });
 expect(()=>executeFreeform(save,'拿起钢琴',{...proposal,item_move:{item_id:'qa_piano',to:'held',position_label:null}},randomUUID())).toThrow('密封');
 expect(calls()).toBe(1);expect(save).toEqual(before);
});
it('does not settle a targeted action against a person moved away during time advancement',async()=>{
 const save=await fixture(),before=structuredClone(save);
 const calls=timeHook(c=>{c.save.entities.find(e=>e.id==='npc_lin')!.components.location!.location_id='station';});
 expect(()=>executeFreeform(save,'向林舟挥手',{...proposal,target_id:'npc_lin'},randomUUID())).toThrow('当前场景');
 expect(calls()).toBe(1);expect(save).toEqual(before);
});
it('preserves disk bytes and has no narration or committed result across repeated service recreation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-time-prerequisite-'));try{
  const save=await fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected generation');}});
  const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal),narrate=vi.spyOn(ai,'narrate');
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const calls=timeHook(c=>{c.save.entities.find(e=>e.id==='qa_piano')!.components.item!.condition='destroyed';});
  const body={input:'弹两分钟钢琴',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow('前置条件失效');
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(calls()).toBe(2);expect(freeform).toHaveBeenCalledTimes(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

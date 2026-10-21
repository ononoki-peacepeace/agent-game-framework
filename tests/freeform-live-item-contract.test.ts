import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {EventBus,type ActionContext} from '../src/core/registry.js';
import {WorldBlockedError} from '../src/agent/outcome.js';
import {validateSave} from '../src/core/state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'物品行动候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'SIMPLE_CHECK' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'尝试处理真实物品',stages:[],evidence_ids:[]}};
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 const here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 for(const [id,name,container] of [['qa_board','木板',false],['qa_case','箱子',true]] as const)
  save.entities.push({id,type:'item',components:{identity:{name,description:'已有登记物品',avatar_id:null},
   item:{weight:.1,stackable:false,tracking:'tracked',condition:'intact',container,tags:[]},discovery:{known_to_player:true},location:{location_id:here}}});
 return validateSave(save);
}
function timeHook(mutate:(ctx:ActionContext)=>void){
 const original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){calls++;mutate(ctx);}
 });return ()=>calls;
}
it.each([false,true])('rejects a newly destroyed damage target before result RNG (destroyed=%s)',async destroyed=>{
 const save=await fixture(),before=structuredClone(save),input='尝试损坏木板';
 const calls=timeHook(c=>{if(destroyed)c.save.entities.find(e=>e.id==='qa_board')!.components.item!.condition='destroyed';});
 const rng=vi.fn(()=>.99),run=()=>executeFreeform(save,input,{...proposal,item_change:{item_id:'qa_board',condition:'damaged',source_quote:input}},randomUUID(),rng);
 if(destroyed){expect(run).toThrow(WorldBlockedError);expect(rng).not.toHaveBeenCalled();}
 else{expect(run().save.entities.find(e=>e.id==='qa_board')!.components.item!.condition).toBe('damaged');expect(rng).toHaveBeenCalledTimes(1);}
 expect(calls()).toBe(1);expect(save).toEqual(before);
});
it.each(['open','sealed','not_container'] as const)('rechecks the storage destination before result RNG (%s)',async state=>{
 const save=await fixture(),before=structuredClone(save),input='把木板放进箱子';
 const calls=timeHook(c=>{
  const item=c.save.entities.find(e=>e.id==='qa_case')!.components.item!;
  if(state==='sealed')item.tags=['sealed'];if(state==='not_container')item.container=false;
 });
 const rng=vi.fn(()=>.99),run=()=>executeFreeform(save,input,{...proposal,storage_move:{item_name:'木板',item_id:'qa_board',container_name:'箱子',container_id:'qa_case'}},randomUUID(),rng);
 if(state!=='open'){expect(run).toThrow(WorldBlockedError);expect(rng).not.toHaveBeenCalled();}
 else{expect(run().save.entities.find(e=>e.id==='qa_board')!.components.item!.container_id).toBe('qa_case');expect(rng).toHaveBeenCalledTimes(1);}
 expect(calls()).toBe(1);expect(save).toEqual(before);
});
it.each(['damage','storage'] as const)('keeps exact disk bytes across repeated %s world refusals and recreated services',async action=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-live-item-'));try{
  const save=await fixture(),store=new JsonStore(directory);await store.write(save);
  const input=action==='damage'?'尝试损坏木板':'把木板放进箱子';
  const raw=action==='damage'?{...proposal,item_change:{item_id:'qa_board',condition:'damaged' as const,source_quote:input}}:
   {...proposal,storage_move:{item_name:'木板',item_id:'qa_board',container_name:'箱子',container_id:'qa_case'}};
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected generation');}});
  vi.spyOn(ai,'freeform').mockResolvedValue(raw);const narrate=vi.spyOn(ai,'narrate');
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const calls=timeHook(c=>{
   if(action==='damage')c.save.entities.find(e=>e.id==='qa_board')!.components.item!.condition='destroyed';
   else c.save.entities.find(e=>e.id==='qa_case')!.components.item!.tags=['sealed'];
  });
  const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toBeInstanceOf(WorldBlockedError);
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(calls()).toBe(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it.each([false,true])('honors a declared capability that a time hook disables (disabled=%s)',async disabled=>{
 const save=await fixture(),before=structuredClone(save),calls=timeHook(c=>{
  if(disabled){c.save.definition.enabled_modules=c.save.definition.enabled_modules.filter(id=>id!=='attributes');c.save.modules.attributes.enabled=false;}
 });
 const rng=vi.fn(()=>.99),run=()=>executeFreeform(save,'尝试按已登记能力搬运重物',{...proposal,required_conditions:[{kind:'capability',subject_id:'character.attributes'}]},randomUUID(),rng);
 if(disabled){expect(run).toThrow(WorldBlockedError);expect(rng).not.toHaveBeenCalled();}else{expect(run().save.resolution_receipts?.at(-1)?.outcome).toBe('success');expect(rng).toHaveBeenCalledTimes(1);}
 expect(calls()).toBe(1);expect(save).toEqual(before);
});

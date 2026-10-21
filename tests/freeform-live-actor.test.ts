import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {EventBus} from '../src/core/registry.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'候选动作',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'普通动作',stages:[],evidence_ids:[]}};
it.each([false,true].flatMap(physical=>[0,1].map(hp=>({physical,hp}))))(
 'settles only while the actor remains alive (physical=$physical,hp=$hp)',async({physical,hp})=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];const before=structuredClone(save);
 const original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
   calls++;ctx.save.entities.find(e=>e.id==='player')!.components.condition!.hp=hp;
  }
 });
 const rng=vi.fn(()=>.99),input=physical?'尝试打击林舟':'整理值班记录';
 const raw=physical?{...proposal,target_id:'npc_lin',physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
  resolution:{...proposal.resolution,type:'OPPOSED_CHECK',domain:'strength',stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}]}}:proposal;
 const run=()=>executeFreeform(save,input,raw,randomUUID(),rng);
 if(hp===0){expect(run).toThrow('身体状态');expect(rng).not.toHaveBeenCalled();}
 else{
  const turn=run();expect(turn.save.entities.find(e=>e.id==='player')!.components.condition!.hp).toBe(1);
  expect(turn.save.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
 }
 expect(calls).toBe(1);expect(save).toEqual(before);
});
it('preserves original disk state across refused HP-zero candidates and service recreation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-live-actor-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected generation');}});
  vi.spyOn(ai,'freeform').mockResolvedValue(proposal);const narrate=vi.spyOn(ai,'narrate');
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const original=EventBus.prototype.emit;let calls=0;
  vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
   original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
    calls++;ctx.save.entities.find(e=>e.id==='player')!.components.condition!.hp=0;
   }
  });
  const body={input:'整理值班记录',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow('身体状态');
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(calls).toBe(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform,boundLocalDestination} from '../src/core/freeform.js';
import {EventBus} from '../src/core/registry.js';
import {validateSave} from '../src/core/state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'局部移动候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'走向当前可见物体',stages:[],evidence_ids:[]}};
it.each([false,true])('requires a local non-item anchor at actual settlement (moved=%s)',async moved=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 save.entities.push({id:'qa_statue',type:'object',components:{identity:{name:'雕像',description:'公开登记的雕像',avatar_id:null},
  discovery:{known_to_player:true},location:{location_id:here}}});validateSave(save);
 const input='走到雕像旁',before=structuredClone(save);expect(boundLocalDestination(save,input)).toBe('雕像旁');
 const original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
   calls++;if(moved)ctx.save.entities.find(e=>e.id==='qa_statue')!.components.location!.location_id='station';
  }
 });
 const rng=vi.fn(()=>.99),run=()=>executeFreeform(save,input,proposal,randomUUID(),rng);
 if(moved){expect(run).toThrow();expect(rng).not.toHaveBeenCalled();}
 else{
  const turn=run();expect(turn.save.entities.find(e=>e.id==='player')!.components.scene_position).toEqual({label:'雕像旁'});
  expect(turn.save.resolution_receipts?.at(-1)?.effects).toContain('position');
 }
 expect(calls).toBe(1);expect(save).toEqual(before);
});
it('preserves disk state when its local movement anchor disappears and the service is recreated',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-live-anchor-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  const here=String(save.entities.find(e=>e.id==='player')!.components.location!.location_id);
  save.environment_state={resolutions:[{id:'qa_env',location_id:here,name:'壁龛',aliases:[],status:'present',classification:'environment_detail',
   entity_id:null,description:'公开登记的壁龛',take_allowed:false,source_request_id:randomUUID(),at:{...save.runtime.time},known_by:['player']}]};
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected generation');}});
  vi.spyOn(ai,'freeform').mockResolvedValue(proposal);const narrate=vi.spyOn(ai,'narrate');
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const original=EventBus.prototype.emit;let calls=0;
  vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
   original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
    calls++;ctx.save.environment_state!.resolutions[0].status='absent';
   }
  });
  const body={input:'走到壁龛旁',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow('现场位置已经改变');
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(calls).toBe(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it.each([false,true])('requires a still-present resolved environment anchor (absent=%s)',async absent=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const here=String(save.entities.find(e=>e.id==='player')!.components.location!.location_id);
 save.environment_state={resolutions:[{id:'qa_env',location_id:here,name:'壁龛',aliases:[],status:'present',classification:'environment_detail',
  entity_id:null,description:'公开登记的壁龛',take_allowed:false,source_request_id:randomUUID(),at:{...save.runtime.time},known_by:['player']}]};
 validateSave(save);const before=structuredClone(save),input='走到壁龛旁';expect(boundLocalDestination(save,input)).toBe('壁龛旁');
 const original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
   calls++;if(absent)ctx.save.environment_state!.resolutions[0].status='absent';
  }
 });
 const rng=vi.fn(()=>.99),run=()=>executeFreeform(save,input,proposal,randomUUID(),rng);
 if(absent){expect(run).toThrow();expect(rng).not.toHaveBeenCalled();}
 else expect(run().save.entities.find(e=>e.id==='player')!.components.scene_position).toEqual({label:'壁龛旁'});
 expect(calls).toBe(1);expect(save).toEqual(before);
});

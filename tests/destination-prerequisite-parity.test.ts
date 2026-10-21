import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {executeAction} from '../src/core/runtime.js';
import {evaluateWorldPrerequisites} from '../src/core/prerequisites.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {validateSave} from '../src/core/state.js';
import {EventBus} from '../src/core/registry.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'路线探查候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[{kind:'destination_reachable' as const,subject_id:'station'}],
 resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'在可达路线范围内探查',stages:[],evidence_ids:[]}};
async function fixture(mode:'open'|'flag'|'closed'|'unknown'|'closed_transit'){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const map=save.definition.map!;save.gm_state.flags.qa_route_open=mode!=='flag';
 map.routes=[{from:'square',to:'station',travel_minutes:2,conditions:[{flag:'qa_route_open',equals:true}]}];
 if(mode==='closed')map.locations.find(p=>p.id==='station')!.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',
  creation_reason:'权威关闭目的地',source_ref:'fixture',recorded_at:{...save.runtime.time}};
 if(mode==='unknown'){
  map.locations.find(p=>p.id==='station')!.known_by_default=false;save.map_state.known_location_ids=save.map_state.known_location_ids.filter(id=>id!=='station');
 }
 if(mode==='closed_transit'){
  map.routes=[{from:'square',to:'market',travel_minutes:1,conditions:[]},{from:'market',to:'station',travel_minutes:1,conditions:[]}];
  map.locations.find(p=>p.id==='market')!.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',
   creation_reason:'权威关闭中间地点',source_ref:'fixture',recorded_at:{...save.runtime.time}};
 }
 return validateSave(save);
}
it.each(['open','flag','closed','unknown','closed_transit'] as const)('matches registered MOVE prerequisites for %s routes',async mode=>{
 const save=await fixture(mode),before=structuredClone(save),requirements=proposal.required_conditions;
 const move=()=>executeAction(save,{type:'MOVE',target_id:'station',parameters:{companions:'none'}},randomUUID());
 if(mode==='open')expect(move().save.entities.find(e=>e.id==='player')!.components.location!.location_id).toBe('station');
 else expect(move).toThrow();
 expect(evaluateWorldPrerequisites(save,{requirements}).status).toBe(mode==='open'?'EXECUTABLE':'NOT_EXECUTABLE');
 const name=save.definition.map!.locations.find(p=>p.id==='station')!.name;
 // An unbound name outside the public map stays an uncertain exploration
 // request. Only a known destination promises a canonical route.
 expect(classifyChoiceExecution(save,'前往'+name)).toBe(mode==='unknown'?'CONDITIONALLY_EXECUTABLE':mode==='open'?'EXECUTABLE':'NOT_EXECUTABLE');
 const run=()=>executeFreeform(save,'尝试探查可达路线',proposal,randomUUID());
 if(mode==='open')expect(run().save.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);else expect(run).toThrow();
 expect(save).toEqual(before);
});
it('revokes a route-dependent Freeform action when a time hook closes the only route',async()=>{
 const save=await fixture('open'),before=structuredClone(save),original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
   calls++;ctx.save.gm_state.flags.qa_route_open=false;
  }
 });
 expect(()=>executeFreeform(save,'尝试探查可达路线',proposal,randomUUID())).toThrow('前置条件失效');
 expect(calls).toBe(1);expect(save).toEqual(before);
});
it('retains the existing implicit parent-child transition without inventing a route edge',async()=>{
 const save=await fixture('open');save.definition.map!.locations.find(p=>p.id==='station')!.parent_id='square';save.definition.map!.routes=[];
 expect(evaluateWorldPrerequisites(save,{requirements:proposal.required_conditions}).status).toBe('EXECUTABLE');
 const move=executeAction(save,{type:'MOVE',target_id:'station',parameters:{companions:'none'}},randomUUID());
 expect(move.save.entities.find(e=>e.id==='player')!.components.location!.location_id).toBe('station');expect(move.action.time_cost).toBe(1);
});
it('retains an available alternate route when a shorter route flag is false',async()=>{
 const save=await fixture('flag');save.definition.map!.routes.push({from:'square',to:'market',travel_minutes:3,conditions:[]},
  {from:'market',to:'station',travel_minutes:3,conditions:[]});
 expect(evaluateWorldPrerequisites(save,{requirements:proposal.required_conditions}).status).toBe('EXECUTABLE');
 const move=executeAction(save,{type:'MOVE',target_id:'station',parameters:{companions:'none'}},randomUUID());
 expect(move.action.time_cost).toBe(6);expect(move.save.resolution_receipts?.at(-1)?.movement_route?.location_ids).toEqual(['square','market','station']);
});
it('refuses route-dependent execution without disk writes or narration after a new service loads the save',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-route-prerequisite-'));try{
  const save=await fixture('flag'),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected live generation');}});
  const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal),narrate=vi.spyOn(ai,'narrate');
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const body={input:'尝试探查可达路线',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow('不可到达');
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(freeform).toHaveBeenCalledTimes(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

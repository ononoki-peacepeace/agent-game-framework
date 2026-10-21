import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {ProviderError} from '../src/ai/failures.js';
import {interruptedActivity} from '../src/core/completion-evidence.js';

afterEach(()=>vi.restoreAllMocks());
const lane={kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none'}} as never;
async function fixture(due:number|null,later=true){
 let decisions=0;
 const directory=await mkdtemp(join(tmpdir(),'agf-open-wait-complete-'));
 const f=await sparseSetup(async request=>{
  const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(p.decision){
   decisions++;return {data:decisions===1?{decision:'transaction',transaction:{kind:'wait',destination:null,minutes:2,reason:'先等待两分钟'},reason:null,question:null}:
    decisions===2&&later?{decision:'transaction',transaction:{kind:'move',destination:'河岸车站',minutes:null,reason:'等待完成后前往'},reason:null,question:null}:
    {decision:'done',transaction:null,reason:null,question:null}};
  }
  throw Error('Unexpected offline stage');
 });
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','权威降级描写'));
 const before=await f.service.current();for(const e of before.entities)if(e.components.character)e.components.location={location_id:'square'};
 if(due!==null){
  before.entities.find(e=>e.id==='player')!.components.opportunities={entries:{wait_meeting:{status:'accepted',title:'已接受的等待会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'wait_meeting',label:'已接受的等待会面',
   at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,
   window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 const store=new JsonStore(directory);await store.write(before);const service=new GameService(store,f.ai,before.definition),save=await service.current();
 return {directory,store,service,ai:f.ai,before:save,decisions:()=>decisions,request:{game_id:save.game_id,expected_revision:save.state_revision,
  request_id:randomUUID(),input:'先等待2分钟'+(later?'，再去河岸车站。':'。')}};
}
it.each([0,1])('stops open-goal continuation when WAIT is interrupted at minute %s',async due=>{
 const f=await fixture(due);try{
  const turns=vi.spyOn(f.service,'turn'),result=await handleAgentInput(f.service,f.request,undefined,null,false,lane),after=await f.service.current();
  expect(result.outcome,JSON.stringify(result.outcome)).toMatchObject({type:'game',kind:due===0?'interrupted':'partial_progress',completed_steps:[],goal_status:due===0?'unresolved':'partial'});
  expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);expect(interruptedActivity(after.resolution_receipts![0])).toBe(true);
  expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);expect(f.decisions()).toBe(1);expect(turns).toHaveBeenCalledTimes(1);
  expect(result.story).toContain('已接受的等待会面');expect(result.outcome!.receipt_ids).toEqual([after.resolution_receipts![0].request_id]);
  expect(after.entities.find(e=>e.id==='player')!.components.location).toEqual(f.before.entities.find(e=>e.id==='player')!.components.location);
  const bytes=await readFile(join(f.directory,'current.json')),calls=f.ai.metrics.requests,writes=vi.spyOn(f.store,'write');
  expect(await handleAgentInput(f.service,f.request,undefined,null,false,lane)).toEqual(result);
  expect(writes).not.toHaveBeenCalled();expect(f.ai.metrics.requests).toBe(calls);expect(f.decisions()).toBe(1);
  expect(await new GameService(new JsonStore(f.directory),f.ai,f.before.definition).current()).toEqual(after);
  expect(await readFile(join(f.directory,'current.json'))).toEqual(bytes);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('does not use an unrelated revision increase as proof that the WAIT completed',async()=>{
 const f=await fixture(null);try{
  vi.spyOn(f.service,'turn').mockImplementation(async()=>{
   const s=await f.service.current();return f.service.agentTransaction({game_id:s.game_id,expected_revision:s.state_revision,request_id:randomUUID()},
    {unrelated:true},next=>{next.gm_state.flags.unrelated_change=true;});
  });
  const result=await handleAgentInput(f.service,f.request,undefined,null,false,lane),after=await f.service.current();
  expect(result.outcome).toMatchObject({type:'engine_failure',code:'invariant_failure',committed_steps:[],receipt_ids:[]});
  expect(f.decisions()).toBe(1);expect(after.gm_state.flags.unrelated_change).toBe(true);
  expect(result.message).not.toContain('世界没有改变');expect(result.view).toEqual(f.service.project(after));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each([null,2])('retains the completed WAIT evidence with due=%s',async due=>{
 const f=await fixture(due);try{
  const result=await handleAgentInput(f.service,f.request,undefined,null,false,lane),after=await f.service.current();
  expect(result.outcome,JSON.stringify(result.outcome)).toMatchObject({type:'game',completed_steps:['等待 2 分钟','到达 河岸车站']});
  expect(after.resolution_receipts?.find(r=>r.semantic_action==='WAIT')?.time_cost).toBe(2);expect(f.decisions()).toBe(3);
  expect(result.view).toEqual(f.service.project(after));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

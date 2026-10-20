import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {RoutineJobs} from '../src/routine/jobs.js';
import {ProviderError} from '../src/ai/failures.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const f=await sparseSetup(),initial=await f.service.current();
 await f.service.turn({request_id:randomUUID(),game_id:initial.game_id,expected_revision:initial.state_revision,action:{type:'START_ROUTINE',parameters:{label:'正常生活',pattern:'按现有规则工作'}}},undefined,undefined,undefined,true);
 const save=await f.service.current();save.runtime.time.minute=960;save.gm_state.flags.routine_routes_open=false;
 for(const edge of save.definition.map!.routes)edge.conditions=[{flag:'routine_routes_open',equals:true}];
 await f.store.write(save);return {...f,save};
}
async function run(f:Awaited<ReturnType<typeof fixture>>){
 const jobs=new RoutineJobs(f.service),job=await jobs.start({request_id:randomUUID(),game_id:f.save.game_id,expected_revision:f.save.state_revision,action:{type:'CONTINUE_ROUTINE',parameters:{}}});
 for(let i=0;i<2000;i++){const current=(await jobs.get(job.job_id))!;if(!['queued','running'].includes(current.status))return {jobs,result:current};await new Promise<void>(resolve=>setTimeout(resolve,2));}
 throw Error('Offline routine job did not finish');
}
it('classifies the real canonical unavailable route as a world interruption without work effects',async()=>{
 const f=await fixture(),{result}=await run(f),after=await f.service.current();
 expect(result.status).toBe('interrupted');expect(result.outcome).toMatchObject({type:'game',kind:'interrupted'});
 expect(result.message).toContain('没有可通行的已知路线');expect(after.runtime.time).toEqual(f.save.runtime.time);
 expect(after.entities.find(e=>e.id===after.player_state.entity_id)!.components.wallet).toEqual(f.save.entities.find(e=>e.id===f.save.player_state.entity_id)!.components.wallet);
 expect(after.entities.find(e=>e.id===after.player_state.entity_id)!.components.location).toEqual(f.save.entities.find(e=>e.id===f.save.player_state.entity_id)!.components.location);
 expect(f.service.routineLease).toBeNull();
});
it.each(['program','provider'] as const)('retains %s failure as a technical failure rather than a world pause',async kind=>{
 const f=await fixture();vi.spyOn(f.service,'turn').mockRejectedValue(kind==='provider'?new ProviderError('timeout','offline fixture','model timed out'):new Error('controlled programmer failure'));
 const {result}=await run(f);expect(result.status).toBe('failed');expect(result.outcome).toMatchObject({type:'engine_failure',code:kind==='provider'?'provider_failure':'unexpected_internal_failure'});expect(f.service.routineLease).toBeNull();
});
it('persists the world-blocked terminal job across disk restart without redoing the refused segment',async()=>{
 const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'agf-routine-world-block-'));
 try{
  const store=new JsonStore(directory);await store.write(f.save);const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('No generation for known blocked route');}}),service=new GameService(store,ai,f.save.definition),jobs=new RoutineJobs(service,directory);
  const body={request_id:randomUUID(),game_id:f.save.game_id,expected_revision:f.save.state_revision,action:{type:'CONTINUE_ROUTINE',parameters:{}}};
  const started=await jobs.start(body);let terminal=await jobs.get(started.job_id);
  for(let i=0;i<2000&&terminal&&['queued','running'].includes(terminal.status);i++){await new Promise<void>(resolve=>setTimeout(resolve,2));terminal=await jobs.get(started.job_id);}
  expect(terminal?.status).toBe('interrupted');expect(terminal?.outcome).toMatchObject({type:'game',kind:'interrupted'});
  const after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));expect(after.runtime.time).toEqual(f.save.runtime.time);expect(after.entities).toEqual(f.save.entities);
  const restarted=new GameService(new JsonStore(directory),ai,f.save.definition),recovered=new RoutineJobs(restarted,directory);
  expect(await recovered.get(started.job_id)).toEqual(terminal);expect(await recovered.start(body)).toEqual(terminal);
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);expect(restarted.routineLease).toBeNull();
 }finally{await rm(directory,{recursive:true,force:true});}
});

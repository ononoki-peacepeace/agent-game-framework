import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {RoutineJobs} from '../src/routine/jobs.js';
import {withInputRecovery,type InputRecovery} from '../src/recovery/request-context.js';
import {withRequestBudget} from '../src/ai/request-budget.js';
import * as atomic from '../src/storage/atomic-json.js';
import {fresh} from './helpers.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'agf-background-journal-')),store=new JsonStore(directory),initial=fresh();await store.write(initial);
 const service=new GameService(store,new AIRuntime(new MockAIAdapter()),initial.definition),baseline=await service.current();
 const jobs=new RoutineJobs(service,directory);await jobs.ready;
 const body={game_id:baseline.game_id,expected_revision:baseline.state_revision,request_id:randomUUID(),
   action:{type:'START_ROUTINE',parameters:{label:'普通生活',pattern:'日常活动'}}};
 return {directory,store,service,baseline,jobs,body,
   async finished(id:string){for(let i=0;i<400;i++){const job=await jobs.get(id);
     if(job&&!['queued','running'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('job did not terminate');},
   async close(){await rm(directory,{recursive:true,force:true});}};
}

describe('P0-A background journal safe termination',()=>{
 it('recovers its persistence queue and removes the unlaunched job after a creation flush failure',async()=>{
  const f=await fixture();try{
   const flush=vi.spyOn(atomic,'writeAtomicJson').mockRejectedValueOnce(Error('Injected job disk failure'));
   vi.spyOn(f.service,'handoffBlocker').mockResolvedValue({kind:'player_decision',reason:'等待玩家'});
   await expect(f.jobs.start(f.body)).rejects.toThrow('Injected job disk failure');
   expect(await f.jobs.get()).toBeNull();expect(f.service.routineLease).toBeNull();
   const job=await f.finished((await f.jobs.start(f.body)).job_id);
   expect(job.status).toBe('interrupted');expect(f.service.routineLease).toBeNull();
   const persisted=JSON.parse(await readFile(join(f.directory,'routine-jobs.json'),'utf8'));
   expect(persisted).toHaveLength(1);expect(persisted[0].status).toBe('interrupted');
   expect(flush.mock.calls.length).toBeGreaterThan(1);expect(await f.store.read()).toEqual(f.baseline);
  }finally{await f.close();}
 });

 it('owns its child commit journal and budget after the foreground request has ended',async()=>{
  const f=await fixture();try{
   const parent:InputRecovery={original_player_input:'继续我的原定生活',trace_id:'tr_foreground',transactions:[]};
   const persistParent=vi.fn(async()=>{}),turn=f.service.turn.bind(f.service),write=f.store.write.bind(f.store);
   vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
     const journal=JSON.parse(await readFile(join(f.directory,'routine-jobs.json'),'utf8'));
     const child=save.runtime.receipts.at(-1)!;
     expect(journal[0].recovery.transactions).toContainEqual({request_id:child.id,fingerprint:child.fingerprint,
       expected_revision:child.revision-1});
     await write(save,slot);
   });
   const run=vi.spyOn(f.service,'turn').mockImplementation(async(raw,owner,signal,phase)=>{
     await turn({...raw as object,action:{type:'WAIT',parameters:{minutes:5}}},owner,signal,phase);
     throw new ProviderError('timeout','injected after commit','timeout');
   });
   const started=await withInputRecovery({game_id:f.body.game_id,recovery:parent,persist:persistParent},()=>
     withRequestBudget(()=>f.jobs.start(f.body),{calls:0,tokens:0,milliseconds:1}));
   const job=await f.finished(started.job_id),after=(await f.store.read())!;
   expect(job.status).toBe('failed');expect(job.outcome).toMatchObject({type:'engine_failure',code:'provider_failure',
     receipt_ids:[f.body.request_id],state_certain:true,revision:after.state_revision});
   expect(job.recovery?.original_player_input).toBe(parent.original_player_input);
   expect(job.recovery?.trace_id).not.toBe(parent.trace_id);
   expect(parent.transactions).toEqual([]);expect(persistParent).not.toHaveBeenCalled();expect(run).toHaveBeenCalledTimes(1);
   const persisted=JSON.parse(await readFile(join(f.directory,'routine-jobs.json'),'utf8'));
   expect(persisted[0].outcome).toEqual(job.outcome);expect(f.service.routineLease).toBeNull();
   const restarted=new RoutineJobs(f.service,f.directory);await restarted.ready;
   expect((await restarted.get())?.outcome).toEqual(job.outcome);expect(await f.store.read()).toEqual(after);
  }finally{await f.close();}
 });

 it('persists a terminal unknown state and releases the lease even if its final state read fails',async()=>{
  const f=await fixture();try{
   vi.spyOn(f.service,'handoffBlocker').mockResolvedValue({kind:'player_decision',reason:'等待玩家'});
   const read=f.store.read.bind(f.store);
   vi.spyOn(f.store,'read').mockImplementation(async(slot,source)=>{
     if(source==='request_recovery')throw Error('Final read unavailable');return read(slot,source);
   });
   const job=await f.finished((await f.jobs.start(f.body)).job_id);
   expect(job.outcome).toMatchObject({type:'engine_failure',state_certain:false,revision:null,receipt_ids:[]});
   expect(f.service.routineLease).toBeNull();
   expect(JSON.parse(await readFile(join(f.directory,'routine-jobs.json'),'utf8'))[0].outcome).toEqual(job.outcome);
  }finally{await f.close();}
 });

 it('stops active jobs on restart and reports only authoritative prepared child receipts',async()=>{
  const f=await fixture();try{
   const child=randomUUID();await f.service.agentTransaction({...f.body,request_id:child},{restarted:true},()=>{});
   const after=(await f.store.read())!,receipt=after.runtime.receipts.find(entry=>entry.id===child)!;
   await writeFile(join(f.directory,'routine-jobs.json'),JSON.stringify([{job_id:randomUUID(),game_id:f.body.game_id,
     request_id:f.body.request_id,status:'running',phase:'committing',last_revision:f.body.expected_revision,
     recovery:{original_player_input:'原请求',trace_id:'tr_interrupted',transactions:[{request_id:child,
       fingerprint:receipt.fingerprint,expected_revision:receipt.revision-1}]}}]));
   const restarted=new RoutineJobs(f.service,f.directory);await restarted.ready;const job=await restarted.get();
   expect(job).toMatchObject({status:'cancelled',last_revision:after.state_revision,
     outcome:{type:'engine_failure',stage:'routine_restart',receipt_ids:[child],state_certain:false}});
   expect(await f.store.read()).toEqual(after);expect(f.service.routineLease).toBeNull();
  }finally{await f.close();}
 });
});

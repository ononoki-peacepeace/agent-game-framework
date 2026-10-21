import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
const input='检查鞋底、身体疲劳眩晕、湿滑地面',items=['鞋底','身体疲劳眩晕','湿滑地面'];
const goal=(id:string,text:string,depends_on:string[]=[]):GoalInput=>({goal_id:id,type:'WORLD_ACTION',
 normalized_goal:text,depends_on,condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]});
it.each((['complete','partial','world_blocked','not_executed'] as const).flatMap(status=>[false,true].map(lostAck=>({status,lostAck}))))(
 'keeps dependent plan actions behind actual inspection completion ($status/lostAck=$lostAck)',async({status,lostAck})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-plan-inspection-'));try{
  const f=await sparseSetup(),seed=await f.service.current();seed.definition.events=[];
  const store=new JsonStore(directory);await store.write(seed);
  const service=new GameService(store,f.ai,seed.definition),before=await service.current();
  const results=items.map((item,index)=>({item,result:status==='complete'?'nothing':status==='world_blocked'?'blocked':
   status==='partial'&&index===0?'nothing':'not_checked',detail:'固定离线逐项检查结果'}));
  const interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,text)=>text===input?
   {type:'FREEFORM_ACTION',parameters:{}}:{type:'WAIT',parameters:{minutes:1}});
  const freeform=vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'逐项检查',minutes:2,target_id:null,facts:[],
   inspection_results:results,relationship:null,required_conditions:[],resolution:{type:'DETERMINISTIC',domain:'perception',
    band:'normal',visibility:'public',stakes:'检查列举项目',stages:[],evidence_ids:[],discover_facts:true}} as never);
  vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','使用权威降级描写'));
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:input+'，再等一分钟'};
  const write=store.write.bind(store),writes=vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   await write(next,slot);if(lostAck&&next.resolution_receipts?.some(r=>r.inspection_status))throw Error('plan inspection acknowledgement lost');
  });
  const plan=()=>validatePlan({goals:[goal('inspect',input),goal('wait','等一分钟',['inspect'])]});
  const response=await executePlan(service,request,plan()),after=await service.current();
  const receipt=after.resolution_receipts!.find(r=>r.inspection_status)!;
  expect(receipt.inspection_status).toBe(status);expect(receipt.inspection_results).toEqual(results);
  const continues=status==='complete'&&!lostAck;
  expect(after.state_revision).toBe(before.state_revision+1+Number(continues));
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(2+Number(continues));
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='WAIT')).toHaveLength(Number(continues));
  expect(interpret).toHaveBeenCalledTimes(1+Number(continues));expect(freeform).toHaveBeenCalledOnce();
  if(lostAck)expect(response.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',
   committed_steps:[],receipt_ids:[receipt.request_id]});
  else{
   expect(response.outcome).toMatchObject({type:'game',kind:status==='complete'?'completed':status==='partial'?'partial_progress':
    status==='world_blocked'?'blocked_by_world':'unresolved_goal',goal_status:status==='complete'?'completed':status==='partial'?'partial':'unresolved',
    completed_steps:continues?['world_action:inspect','world_action:wait']:[]});
   expect(response.results?.map(result=>result.status)).toEqual(continues?['completed','completed']:
    [status==='world_blocked'?'blocked':'unresolved','skipped']);
  }
  expect(response.story).toContain(after.narrative_history!.find(entry=>entry.request_id===receipt.request_id)!.narrative);
  expect(response.view).toEqual(service.project(after));
  const bytes=await readFile(join(directory,'current.json')),calls=f.ai.metrics.requests,count=writes.mock.calls.length;
  // Explicit retry recovers the saved inspection; only a complete one can authorize the pending WAIT.
  await executePlan(service,{...request,expected_revision:after.state_revision},plan());
  const resumedWait=status==='complete'&&lostAck;
  expect(writes).toHaveBeenCalledTimes(count+Number(resumedWait));
  if(!resumedWait)expect(f.ai.metrics.requests).toBe(calls);
  expect(freeform).toHaveBeenCalledOnce();
  const afterRetry=await service.current();
  expect(afterRetry.runtime.time.minute-after.runtime.time.minute).toBe(Number(resumedWait));
  expect(afterRetry.resolution_receipts!.find(r=>r.request_id===receipt.request_id)).toEqual(receipt);
  expect(await new GameService(new JsonStore(directory),f.ai,before.definition).current()).toEqual(afterRetry);
  if(!resumedWait)expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

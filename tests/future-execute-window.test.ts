import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
import {validatePlan,fastPlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,window:'morning'|'afternoon'|'any',type:GoalInput['type']='FUTURE_INTENT'):GoalInput=>({goal_id:id,type,normalized_goal:'向林舟问好',target_entities:['npc_lin'],depends_on:[],condition:null,branch:null,temporal_scope:{scope:type==='EXECUTE_FUTURE'?'now':'future',day_offset:type==='EXECUTE_FUTURE'?0:1,window}});
async function fixture(withAny=false){
 const mock=new MockAIAdapter(),f=await sparseSetup(r=>mock.generate(r)),before=await f.service.current();
 for(const id of ['player','npc_lin'])before.entities.find(e=>e.id===id)!.components.location={location_id:'square'};await f.store.write(before);
 await executePlan(f.service,{input:'明天下午向林舟问好',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},validatePlan({goals:[goal('afternoon','afternoon'),...(withAny?[goal('any','any')]:[])]}));
 const due=await f.service.current();due.runtime.time={day:2,minute:800};await f.store.write(due);
 const interpret=vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}});
 return {...f,interpret,before:await f.service.current()};
}
async function run(f:Awaited<ReturnType<typeof fixture>>,window:'morning'|'afternoon'|'any'){
 return executePlan(f.service,{input:`执行${window==='morning'?'上午':window==='afternoon'?'下午':''}向林舟问好的打算`,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()},validatePlan({goals:[goal('execute',window,'EXECUTE_FUTURE')]}));
}
it('does not execute an afternoon commitment when the player explicitly asks for the morning one',async()=>{
 const f=await fixture();await run(f,'morning');expect(f.interpret).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.before);
});
it('uses the explicit afternoon window to select one due commitment instead of unrelated any-time ambiguity',async()=>{
 const f=await fixture(true),result=await run(f,'afternoon'),after=await f.service.current();
 expect(result.plan?.status).toBe('completed');expect(f.interpret).toHaveBeenCalledOnce();
 expect(after.future_intents?.map(i=>[i.goal_id,i.status])).toEqual([['afternoon','completed'],['any','due']]);
 expect(after.resolution_receipts?.filter(r=>r.semantic_action==='TALK')).toHaveLength(1);
});
it('retains genuine ambiguity when no execution window was specified',async()=>{
 const f=await fixture(true);await run(f,'any');expect(f.interpret).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.before);
});
it.each(['morning','afternoon'] as const)('keeps the explicit %s window from original-language execution input',async window=>{
 const f=await fixture(window==='afternoon'),input=`执行${window==='morning'?'上午':'下午'}向林舟问好的打算`;
 expect(fastPlan(f.service.project(f.before),input)?.goals[0].temporal_scope).toMatchObject({scope:'now',window});
 const result=await handleAgentInput(f.service,{input,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 if(window==='morning'){expect(f.interpret).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.before);}
 else{expect(result.plan?.status).toBe('completed');expect(f.interpret).toHaveBeenCalledOnce();}
});
it('does not use a current due commitment for an explicit tomorrow execution request',async()=>{
 const f=await fixture(),input='执行明天下午向林舟问好的打算';
 expect(fastPlan(f.service.project(f.before),input)?.goals[0].temporal_scope).toMatchObject({scope:'now',day_offset:1,window:'afternoon'});
 await handleAgentInput(f.service,{input,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 expect(f.interpret).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.before);
});
it('executes only the explicitly selected window after disk restart and replays without a second social attempt',async()=>{
 const f=await fixture(true),directory=await mkdtemp(join(tmpdir(),'agf-future-execute-window-'));
 try{
  const store=new JsonStore(directory);await store.write(f.before);const first=new GameService(store,f.ai,f.before.definition),before=await first.current();
  const input='执行下午向林舟问好的打算',body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const result=await handleAgentInput(first,body),after=await first.current();expect(result.plan?.status).toBe('completed');
  expect(after.future_intents?.map(i=>[i.goal_id,i.status])).toEqual([['afternoon','completed'],['any','due']]);
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='TALK')).toHaveLength(1);expect(f.interpret).toHaveBeenCalledOnce();
  const bytes=await readFile(join(directory,'current.json')),ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}});
  const restarted=new GameService(new JsonStore(directory),ai,f.before.definition);await handleAgentInput(restarted,{...body,expected_revision:after.state_revision});
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

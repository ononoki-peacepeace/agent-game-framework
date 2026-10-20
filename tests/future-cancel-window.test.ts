import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
import {fastPlan,validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,window:'morning'|'afternoon',day=1):GoalInput=>({goal_id:id,type:'SCHEDULED_INTENT',
 normalized_goal:`${day===1?'明天':'后天'}${window==='morning'?'上午':'下午'}向林舟问好`,depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'scheduled',day_offset:day,window},target_entities:['npc_lin']});
async function fixture(duplicate=false){
 const f=await sparseSetup(),before=await f.service.current();
 before.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};
 before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};await f.store.write(before);
 await executePlan(f.service,{input:'明天上午和下午分别向林舟问好，后天下午也问好',game_id:before.game_id,
  expected_revision:before.state_revision,request_id:randomUUID()},validatePlan({goals:[
   goal('morning','morning'),goal('afternoon','afternoon'),goal('later','afternoon',2),
   ...(duplicate?[goal('duplicate','afternoon')]:[])]}));
 return {...f,beforeCancel:await f.service.current()};
}
it.each(['morning','afternoon'] as const)('cancels only the explicitly named date/time window: %s',async window=>{
 const f=await fixture(),input=`取消明天${window==='morning'?'上午':'下午'}找林舟的打算`;
 const plan=fastPlan(f.service.project(f.beforeCancel),input)!;
 expect(plan.goals[0]).toMatchObject({type:'CANCEL_FUTURE',temporal_scope:{day_offset:1,window}});
 const body={input,game_id:f.beforeCancel.game_id,expected_revision:f.beforeCancel.state_revision,request_id:randomUUID()};
 const result=await handleAgentInput(f.service,body),after=await f.service.current();
 expect(after.future_intents!.filter(i=>i.status==='cancelled').map(i=>i.goal_id)).toEqual([window]);
 expect(after.future_intents!.filter(i=>i.status==='planned').map(i=>i.goal_id)).toEqual([window==='morning'?'afternoon':'morning','later']);
 expect(result.message).toContain('已取消');expect(after.runtime.time).toEqual(f.beforeCancel.runtime.time);
 expect(after.entities).toEqual(f.beforeCancel.entities);expect(after.resolution_receipts).toEqual(f.beforeCancel.resolution_receipts);
 expect(after.state_revision).toBe(f.beforeCancel.state_revision+1);expect(f.calls).toHaveLength(0);
 expect(await handleAgentInput(f.service,body)).toEqual(result);expect(await f.store.read()).toEqual(after);
});
it.each([false,true])('does not guess among genuinely ambiguous plans (explicit but duplicate=%s)',async duplicate=>{
 const f=await fixture(duplicate),input=duplicate?'取消明天下午找林舟的打算':'取消明天找林舟的打算';
 const result=await handleAgentInput(f.service,{input,game_id:f.beforeCancel.game_id,
  expected_revision:f.beforeCancel.state_revision,request_id:randomUUID()});
 expect(result.results?.some(g=>g.status==='failed')).toBe(true);expect(await f.store.read()).toEqual(f.beforeCancel);
 expect(f.calls).toHaveLength(0);
});
it('keeps the cancelled morning terminal after disk recreation and a later explicit execution request',async()=>{
 const f=await fixture(),input='取消明天上午找林舟的打算';
 await handleAgentInput(f.service,{input,game_id:f.beforeCancel.game_id,expected_revision:f.beforeCancel.state_revision,request_id:randomUUID()});
 const save=await f.service.current();expect(save.future_intents!.find(i=>i.goal_id==='morning')!.status).toBe('cancelled');
 save.runtime.time={day:2,minute:400};
 const directory=await mkdtemp(join(tmpdir(),'agf-cancel-window-'));
 try{
  const store=new JsonStore(directory);await store.write(save);
  const disk=new JsonStore(directory),ai=new AIRuntime(new MockAIAdapter()),service=new GameService(disk,ai,save.definition);
  const before=await service.current(),interpret=vi.spyOn(ai,'interpret'),writes=vi.spyOn(disk,'write');
  const execute:GoalInput={...goal('execute','morning'),type:'EXECUTE_FUTURE',normalized_goal:'执行上午向林舟问好的打算',
   temporal_scope:{scope:'now',day_offset:0,window:'morning'}};
  await executePlan(service,{input:execute.normalized_goal,game_id:before.game_id,
   expected_revision:before.state_revision,request_id:randomUUID()},validatePlan({goals:[execute]}));
  expect(interpret).not.toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();expect(await disk.read()).toEqual(before);
  expect(before.future_intents!.map(i=>i.status)).toEqual(['cancelled','planned','planned']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('does not invent an afternoon commitment for an original any-time plan',async()=>{
 const f=await sparseSetup(),before=await f.service.current();
 const any:GoalInput={...goal('any','morning'),type:'FUTURE_INTENT',normalized_goal:'明天向林舟问好',
  temporal_scope:{scope:'future',day_offset:1,window:'any'}};
 await executePlan(f.service,{input:any.normalized_goal,game_id:before.game_id,expected_revision:before.state_revision,
  request_id:randomUUID()},validatePlan({goals:[any]}));
 const registered=await f.service.current();
 await handleAgentInput(f.service,{input:'取消明天下午找林舟的打算',game_id:registered.game_id,
  expected_revision:registered.state_revision,request_id:randomUUID()});
 expect(await f.store.read()).toEqual(registered);expect(f.calls).toHaveLength(0);
});

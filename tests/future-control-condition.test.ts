import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
import {fastPlan,validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';
import {once} from 'node:events';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,type:GoalInput['type'],extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type,
 normalized_goal:'向林舟问好',target_entities:['npc_lin'],depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},...extra});
async function fixture(type:'CANCEL_FUTURE'|'EXECUTE_FUTURE',familiar:boolean){
 const mock=new MockAIAdapter(),f=await sparseSetup(r=>mock.generate(r)),initial=await f.service.current();
 initial.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};
 initial.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 initial.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:familiar?60:0}}};
 await f.store.write(initial);
 await executePlan(f.service,{input:'明天下午向林舟问好',game_id:initial.game_id,expected_revision:initial.state_revision,request_id:randomUUID()},
  validatePlan({goals:[goal('future','SCHEDULED_INTENT',{temporal_scope:{scope:'scheduled',day_offset:1,window:'afternoon'}})]}));
 if(type==='EXECUTE_FUTURE'){const due=await f.service.current();due.runtime.time={day:2,minute:800};await f.store.write(due);}
 const before=await f.service.current(),input=type==='CANCEL_FUTURE'?'如果我和林舟比较熟，就取消明天下午找林舟的打算':'如果我和林舟比较熟，就执行下午向林舟问好的打算';
 await f.store.write(before);
 const check=goal('condition','CONDITIONAL_INTENT',{normalized_goal:'判断我和林舟是否熟悉',condition:{kind:'familiar',entity_id:'npc_lin',description:'我和林舟比较熟'}});
 const control=goal('control',type,{normalized_goal:type==='CANCEL_FUTURE'?'取消明天下午找林舟的打算':'执行下午向林舟问好的打算',
  depends_on:['condition'],branch:'then',temporal_scope:{scope:'now',day_offset:type==='CANCEL_FUTURE'?1:0,window:'afternoon'}});
 const planner=vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[check,control]});
 const interpret=vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}});
 return {...f,before,input,planner,interpret,check,control};
}
it.each(['CANCEL_FUTURE','EXECUTE_FUTURE'] as const)('does not erase an explicit condition in the %s fast path',async type=>{
 const f=await fixture(type,false);expect(fastPlan(f.service.project(f.before),f.input)).toBeNull();
});
it.each(['CANCEL_FUTURE','EXECUTE_FUTURE'] as const)('leaves the world and pending intention unchanged for a false %s condition',async type=>{
 const f=await fixture(type,false),body={input:f.input,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()};
 const writes=vi.spyOn(f.store,'write'),result=await handleAgentInput(f.service,body);
 expect(await f.store.read()).toEqual(f.before);expect(f.interpret).not.toHaveBeenCalled();
 expect(writes).not.toHaveBeenCalled();expect(result.results?.map(g=>g.status)).toEqual(['completed','skipped']);
});
it.each(['CANCEL_FUTURE','EXECUTE_FUTURE'] as const)('retains authorized %s behavior when the condition holds',async type=>{
 const f=await fixture(type,true);
 await handleAgentInput(f.service,{input:f.input,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 const after=await f.service.current();expect(after.future_intents![0].status).toBe(type==='CANCEL_FUTURE'?'cancelled':'completed');
 expect(f.interpret).toHaveBeenCalledTimes(type==='CANCEL_FUTURE'?0:1);
});
it.each(['CANCEL_FUTURE','EXECUTE_FUTURE'] as const)('keeps an unknown %s condition unresolved without writing',async type=>{
 const f=await fixture(type,false);f.check.condition!.kind='unknown';f.planner.mockResolvedValue({goals:[f.check,f.control]});
 const writes=vi.spyOn(f.store,'write'),result=await handleAgentInput(f.service,{input:f.input,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 expect(result.results?.map(g=>g.status)).toEqual(['completed','unresolved']);expect(writes).not.toHaveBeenCalled();
 expect(f.interpret).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
});
it.each(['CANCEL_FUTURE','EXECUTE_FUTURE'] as const)('does not accept a %s candidate that drops the original condition',async type=>{
 const f=await fixture(type,false);f.planner.mockResolvedValue({goals:[goal('unguarded',type,{temporal_scope:{scope:'now',day_offset:type==='CANCEL_FUTURE'?1:0,window:'afternoon'}})]});
 await handleAgentInput(f.service,{input:f.input,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 expect(f.planner).toHaveBeenCalledTimes(2);expect(f.interpret).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
});
it.each(['CANCEL_FUTURE','EXECUTE_FUTURE'] as const)('persists one authorized conditional %s and replays after service recreation',async type=>{
 const f=await fixture(type,true),directory=await mkdtemp(join(tmpdir(),'agf-conditional-control-'));
 try{
  const store=new JsonStore(directory);await store.write(f.before);const service=new GameService(store,f.ai,f.before.definition);
  const before=await service.current(),body={input:f.input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  vi.spyOn(f.ai,'systemAgent').mockResolvedValue({destination:'WORLD_INTENT',confidence:1,clarification:null,speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false});
  let server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
  const post=async()=>{
   const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,session=await (await fetch(base+'/api/session')).json() as {token:string};
   return fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},body:JSON.stringify(body)});
  };
  try{
   const response=await post(),result=await response.json();expect(response.status).toBe(200);const after=await service.current();
   expect(after.future_intents![0].status).toBe(type==='CANCEL_FUTURE'?'cancelled':'completed');
   expect(after.resolution_receipts?.filter(r=>r.semantic_action==='TALK')??[]).toHaveLength(type==='CANCEL_FUTURE'?0:1);
   const bytes=await readFile(join(directory,'current.json')),ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}});
   await close();const restarted=new GameService(new JsonStore(directory),ai,before.definition);
   server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
   const replay=await post();expect(replay.status).toBe(200);expect(await replay.json()).toEqual(result);
   expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
  }finally{await close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});

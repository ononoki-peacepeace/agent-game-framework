import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {sparseSetup} from './sparse-fixture.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {createApp} from '../src/server/app.js';
import * as router from '../src/system/context-router.js';
import * as planner from '../src/agent/planner.js';
import * as alignment from '../src/agent/goal-alignment.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
afterEach(()=>vi.restoreAllMocks());
it.each(['then','else'] as const)('retains the original %s recipient over HTTP and exact persisted replay after service recreation',async branch=>{
 const f=await sparseSetup(),initial=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-conditional-listener-'));
 initial.definition.events=[];initial.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
 initial.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:branch==='then'?60:0}}};
 const store=new JsonStore(directory);await store.write(initial);
 const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,initial.definition),before=await service.current();
 const input=`如果我和林舟${branch==='then'?'熟悉':'不熟'}，就询问林舟今天的安排`;
 const condition:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我与林舟是否熟悉',
  condition:{kind:'familiar',entity_id:'npc_lin',description:'我与林舟熟悉'},branch:null,depends_on:[],target_entities:[],temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const proposed=planner.validatePlan({goals:[condition,{...condition,goal_id:'speech',type:'WORLD_SPEECH',condition:null,branch,
  depends_on:['condition'],normalized_goal:'询问乔宁今天的安排',operation_hint:'talk',referent:'乔宁',speech_recipients:['乔宁']}]});
 const route=vi.spyOn(router,'routeContext').mockResolvedValue({destination:'WORLD_INTENT',semantic:{kind:'world_action'}} as never);
 const plan=vi.spyOn(planner,'createAgentPlan').mockImplementation(async()=>structuredClone(proposed));
 const audit=vi.spyOn(alignment,'verifyGoalAlignment').mockResolvedValue({verdict:'aligned',explanation:'controlled offline plan fixture'});
 const interpret=vi.spyOn(ai,'interpret').mockRejectedValue(Error('must not reinterpret the planner recipient'));
 const narrate=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你询问了今天的安排。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 let server=createApp(service).listen(0,'127.0.0.1');
 const post=async(value:unknown=body)=>{
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(value)});
  return {status:response.status,body:await response.json()};
 };
 try{
  await once(server,'listening');const first=await post(),after=(await store.read())!;
  expect(first.status,JSON.stringify(first.body)).toBe(200);
  expect(first.body.plan.goals.map((g:{status:string})=>g.status)).toEqual(['completed','completed']);
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
  expect(interpret).not.toHaveBeenCalled();expect(narrate).toHaveBeenCalledOnce();
  for(let i=0;i<100;i++){if((await store.readInputRecord(body.game_id,body.request_id))?.state==='completed')break;await new Promise(done=>setTimeout(done,5));}
  expect((await store.readInputRecord(body.game_id,body.request_id))?.state).toBe('completed');
  const bytes=await readFile(join(directory,'current.json')),counts=[route.mock.calls.length,plan.mock.calls.length,audit.mock.calls.length];
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
  const disk=new JsonStore(directory),restartedAI=new AIRuntime(new MockAIAdapter());
  const generation=vi.spyOn(restartedAI.adapter,'generate').mockRejectedValue(Error('replay must not generate'));
  const writes=vi.spyOn(disk,'write'),restarted=new GameService(disk,restartedAI,initial.definition);
  server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
  expect(await post()).toEqual(first);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(writes).not.toHaveBeenCalled();expect(generation).not.toHaveBeenCalled();
  expect([route.mock.calls.length,plan.mock.calls.length,audit.mock.calls.length]).toEqual(counts);
  expect((await post({...body,input:'询问乔宁另外的事情'})).status).toBe(409);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(generation).not.toHaveBeenCalled();
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}
});

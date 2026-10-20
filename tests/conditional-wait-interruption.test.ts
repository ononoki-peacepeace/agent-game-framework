import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {ProviderError} from '../src/ai/failures.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';
import {interruptedActivity,interruptedWaitFact} from '../src/core/completion-evidence.js';
import {canonicalResolutionNarrative} from '../src/core/narrative-firewall.js';
import {executeAction} from '../src/core/runtime.js';

afterEach(()=>vi.restoreAllMocks());
async function setup(due:number|null,dependent=true){
 const f=await sparseSetup(async r=>{
  const properties=(r.schema as {properties?:Record<string,unknown>}).properties??{};
  if('preserved' in properties)return {data:{preserved:true,reason:'固定原句'}};
  if('aligned' in properties)return {data:{aligned:true,reason:'固定原句'}};
  if('verdict' in properties)return {data:{verdict:'aligned',explanation:'固定条件及步骤'}};
  if('domain' in properties)return {data:{domain:'world',kind:'world_action',confidence:.99,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null}};
  throw Error('Unexpected offline candidate request');
 }),before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:60}}};
 if(due!==null){
  before.entities.find(e=>e.id==='player')!.components.opportunities={entries:{wait_meeting:{status:'accepted',title:'已接受的等待会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'wait_meeting',label:'已接受的等待会面',
   at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 await f.store.write(before);const normalized=await f.service.current();
 const base:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我和林舟是否熟悉',target_entities:[],depends_on:[],
  condition:{kind:'familiar',entity_id:'npc_lin',description:'我和林舟比较熟'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const goals=[base,{...base,goal_id:'wait',type:'WORLD_ACTION' as const,normalized_goal:'等待十分钟',operation_hint:'activity' as const,
  referent:'原地',condition:null,depends_on:['condition'],branch:'then' as const},
  ...(dependent?[{...base,goal_id:'speech',type:'WORLD_SPEECH' as const,normalized_goal:'向林舟问好',operation_hint:'talk' as const,
   referent:'林舟',condition:null,depends_on:['wait']}]:[])];
 const input='如果我和林舟比较熟，就等待十分钟'+(dependent?'，再向林舟问好':''),
  plan=compileGoalContract(publicView(normalized),validatePlan({goals}),{kind:'manual',text:input});
 const interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,text)=>{
  if(text!=='等待十分钟')throw Error('Dependent TALK must not run before requested wait elapsed');
  return {type:'WAIT',parameters:{minutes:10}};
 });
 vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals});
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
 const body={game_id:normalized.game_id,expected_revision:normalized.state_revision,request_id:randomUUID(),input};
 return {...f,before:normalized,plan,body,interpret,run:()=>executePlan(f.service,body,plan)};
}
it.each([0,1])('keeps interrupted explicit ten-minute WAIT incomplete at %s minutes',async due=>{
 const f=await setup(due),result=await f.run(),after=await f.service.current();
 expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','blocked','skipped']);
 expect(result.outcome).toMatchObject({type:'game',kind:due===0?'interrupted':'partial_progress',completed_steps:[]});
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['WAIT']);
 expect(f.interpret).toHaveBeenCalledTimes(1);expect(result.story).toContain('已接受的等待会面');
 expect(result.story).not.toMatch(/10分钟|十分钟|完成/);
});
it.each([0,1])('replays actual HTTP conditional interrupted WAIT at %s minutes after disk/service recreation',async due=>{
 const f=await setup(due),directory=await mkdtemp(join(tmpdir(),'agf-conditional-wait-'));
 const store=new JsonStore(directory);await store.write(f.before);let service=new GameService(store,f.ai,f.before.definition);
 let server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
 const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
 const post=async()=>{
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,session=await (await fetch(base+'/api/session')).json() as {token:string};
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},body:JSON.stringify(f.body)});
  return {status:response.status,body:await response.json() as Record<string,any>};
 };
 try{
  const response=await post(),after=await service.current();expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body.plan.goals.map((g:{status:string})=>g.status)).toEqual(['completed','blocked','skipped']);
  expect(response.body.outcome).toMatchObject({type:'game',kind:due===0?'interrupted':'partial_progress',completed_steps:[]});
  expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);
  const receipts=after.resolution_receipts?.filter(r=>r.actor_id==='player');expect(receipts).toHaveLength(1);expect(interruptedActivity(receipts![0])).toBe(true);
  const bytes=await readFile(join(directory,'current.json'));await close();
  const ai=new AIRuntime({name:'no-replay-generation',generate:async()=>{throw Error('Replay generated');}});
  service=new GameService(new JsonStore(directory),ai,f.before.definition);server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  expect(await post()).toEqual(response);expect(await service.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(ai.metrics.requests).toBe(0);
 }finally{await close();await rm(directory,{recursive:true,force:true});}
});
it('accepts only exact WAIT interruption evidence matching the actual receipt',async()=>{
 const f=await setup(1),receipt=executeAction(f.before,{type:'WAIT',parameters:{minutes:10}},randomUUID()).save.resolution_receipts!.at(-1)!;
 expect(interruptedActivity(receipt)).toBe(true);expect(canonicalResolutionNarrative(receipt,false)).toBe('你等了1分钟便停了下来。');
 expect(interruptedActivity({...receipt,canonical_facts:[interruptedWaitFact(2)]})).toBe(false);
 expect(interruptedActivity({...receipt,canonical_facts:['听说：'+interruptedWaitFact(1)]})).toBe(false);
 expect(interruptedActivity({...receipt,outcome:'failure'})).toBe(false);
 expect(interruptedActivity({...receipt,semantic_action:'HOLD'})).toBe(false);
});
it.each([null,10])('retains complete ten-minute WAIT at due=%s',async due=>{
 const f=await setup(due,false),result=await f.run();
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','completed']);
 expect(result.outcome).toMatchObject({type:'game',kind:'completed',goal_status:'completed'});
 expect((await f.service.current()).runtime.time.minute-f.before.runtime.time.minute).toBe(10);
});

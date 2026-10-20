import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';

afterEach(()=>vi.restoreAllMocks());
const activity='整理手头的值班记录十分钟';
const proposal={narrative:'普通活动候选',minutes:10,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}};
async function setup(mode:'freeform'|'hold',due:number|null,condition:boolean|null=true,withSpeech=true){
 const f=await sparseSetup(async r=>{
  const p=(r.schema as {properties?:Record<string,unknown>}).properties??{};
  if('preserved' in p)return {data:{preserved:true,reason:'固定候选保留原句'}};
  if('aligned' in p)return {data:{aligned:true,reason:'固定候选保留原句'}};
  if('verdict' in p)return {data:{verdict:'aligned',explanation:'固定条件和完整步骤'}};
  if('domain' in p)return {data:{domain:'world',kind:'world_action',confidence:.99,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
   ...(mode==='freeform'?{goal_spec:{objective:input,play_action:'other',targets:[],constraints:[],desired_state:[],desired_outputs:[],persistence:'none',
    temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null}}:{})}};
  throw Error('Unexpected offline candidate request');
 });let before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:condition===null?{}:{npc_lin:{familiarity:condition?60:0}}};
 if(due!==null){
  before.entities.find(e=>e.id==='player')!.components.opportunities={entries:{condition_activity_meeting:{status:'accepted',title:'已接受的活动会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'condition_activity_meeting',label:'已接受的活动会面',
   at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 await f.store.write(before);
 before=await f.service.current();
 const base:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我和林舟是否熟悉',target_entities:[],depends_on:[],
  condition:{kind:'familiar',entity_id:'npc_lin',description:'我和林舟比较熟'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const step:GoalInput={...base,goal_id:'activity',type:'WORLD_ACTION',normalized_goal:activity,operation_hint:'activity',referent:'值班记录',
  condition:null,branch:'then',depends_on:['condition']};
 const goals=[base,step,...(withSpeech?[{...step,goal_id:'speech',type:'WORLD_SPEECH' as const,normalized_goal:'向林舟问好',
  operation_hint:'talk' as const,referent:'林舟',depends_on:['activity'],branch:null}]:[])];
 const input='如果我和林舟比较熟，就'+activity+(withSpeech?'，再向林舟问好':'');
 const plan=compileGoalContract(publicView(before),validatePlan({goals}),{kind:'manual',text:input});
 vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals});
 const freeform=vi.spyOn(f.ai,'freeform').mockImplementation(async(_save,input)=>{
  if(input!==activity)throw Error('Dependent speech must not be interpreted as ordinary activity');return proposal;
 });
 const interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>input===activity?
  {type:'HOLD',parameters:{minutes:10,activity}}:{type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}});
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 const run=()=>executePlan(f.service,body,plan,undefined,undefined,false,undefined,mode==='freeform'?'other':undefined);
 return {...f,before,body,plan,run,freeform,interpret};
}
it.each((['freeform','hold'] as const).flatMap(mode=>[0,1].map(due=>({mode,due}))))(
 'keeps interrupted $mode/$due-minute activity unresolved with no completed-action claim',async({mode,due})=>{
 const f=await setup(mode,due),result=await f.run(),after=await f.service.current(),receipt=after.resolution_receipts!.find(r=>r.actor_id==='player')!;
 expect(receipt.time_cost).toBe(due);expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','blocked','skipped']);
 expect(result.outcome).toMatchObject({type:'game',kind:due===0?'interrupted':'partial_progress',goal_status:due===0?'unresolved':'partial',completed_steps:[]});
 expect(result.outcome.receipt_ids).toContain(receipt.request_id);expect(result.story).toBe(after.last_turn!.narrative);
 expect(result.message).toMatch(/未完成|暂停/);expect(result.message).not.toContain('已完成');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player')).toHaveLength(1);
 expect(after.last_turn!.narrative).toContain('已接受的活动会面');
});
it.each((['freeform','hold'] as const).flatMap(mode=>[0,1].map(due=>({mode,due}))))(
 'replays exact conditional $mode/$due partial result after real HTTP and JsonStore recreation',async({mode,due})=>{
 const f=await setup(mode,due),directory=await mkdtemp(join(tmpdir(),'agf-conditional-activity-'));
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
  expect(response.body.outcome).toMatchObject({type:'game',kind:due===0?'interrupted':'partial_progress',goal_status:due===0?'unresolved':'partial',completed_steps:[]});
  expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);expect(after.resolution_receipts?.filter(r=>r.actor_id==='player')).toHaveLength(1);
  const bytes=await readFile(join(directory,'current.json'));await close();
  const ai=new AIRuntime({name:'no-replay-generation',generate:async()=>{throw Error('Replay generated');}});
  service=new GameService(new JsonStore(directory),ai,f.before.definition);server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  expect(await post()).toEqual(response);expect(await service.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(ai.metrics.requests).toBe(0);
 }finally{await close();await rm(directory,{recursive:true,force:true});}
});
it.each(['freeform','hold'] as const)('retains completed %s full-interval behavior',async mode=>{
 const f=await setup(mode,null,true,false),result=await f.run();expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','completed']);
 expect(result.outcome).toMatchObject({type:'game',kind:'completed',goal_status:'completed'});
 expect((await f.service.current()).runtime.time.minute-f.before.runtime.time.minute).toBe(10);
});
it('retains the earlier settled WAIT and later partial activity prose without claiming activity completion',async()=>{
 const f=await setup('hold',3),goals:GoalInput[]=f.plan.goals.map(({side_effect_level,requires_confirmation,status,contract,...raw})=>structuredClone(raw));
 const prefix:GoalInput={...goals[1],goal_id:'prefix',normalized_goal:'等待两分钟',branch:null,depends_on:[],referent:'原地'};
 goals[0].depends_on=['prefix'];goals.unshift(prefix);
 const input='先等待两分钟，'+f.body.input,plan=compileGoalContract(publicView(f.before),validatePlan({goals}),{kind:'manual',text:input});
 f.interpret.mockImplementation(async(_save,text)=>text==='等待两分钟'?{type:'WAIT',parameters:{minutes:2}}:
  {type:'HOLD',parameters:{minutes:10,activity}});
 const result=await executePlan(f.service,{...f.body,input},plan),after=await f.service.current();
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','completed','blocked','skipped']);
 expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',completed_steps:['world_action:prefix'],goal_status:'partial'});
 expect(result.story).toContain('2分钟');expect(result.story).toContain('1分钟');expect(result.story).toContain('已接受的活动会面');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['WAIT','HOLD']);
 expect(result.canonical_changes).toEqual(['world_action:prefix','world_action:activity']);
});
it.each((['freeform','hold'] as const).flatMap(mode=>[false,null].map(condition=>({mode,condition}))))(
 'keeps $mode/$condition guard without any activity or state mutation',async({mode,condition})=>{
 const f=await setup(mode,1,condition),result=await f.run();expect(await f.store.read()).toEqual(f.before);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed',condition===false?'skipped':'unresolved','skipped']);
 expect(f.freeform).not.toHaveBeenCalled();expect(f.interpret).not.toHaveBeenCalled();
});

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeOpenWorldGoal} from '../src/agent/affordances.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {SavePackage} from '../src/core/schema.js';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Server} from 'node:http';
import {createApp} from '../src/server/app.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';

type Progress={completed:{candidate:string;summary:string}[];preparation?:{candidate:string;summary:string}[];player_location:string};
const decision=(decision:'act'|'done'|'blocked',candidate_id:string|null=null)=>({data:{decision,candidate_id,reason:'controlled goal decision',ambiguity:null}});
const wallet=(save:SavePackage)=>Number((save.entities.find(e=>e.id===save.player_state.entity_id)!.components.wallet as {balances:Record<string,number>}).balances.credit);
const context=(prompt:string)=>JSON.parse(prompt.slice(prompt.indexOf('{"objective"')).split('\n')[0]) as {progress:Progress};

async function fixture(mode:'blocked'|'repair'|'exhaust'|'sleep'|'move'){
 const progress:Progress[]=[],prompts:string[]=[];let calls=0;
 const f=await sparseSetup(async request=>{
  const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(p.destination)return {data:{destination:'WORLD_INTENT',confidence:1,clarification:null,speech_target_id:null,
   world_input:null,resolved_input:null,end_conversation:false}};
  if(p.goals)return {data:{goals:[{goal_id:'g1',type:'WORLD_GOAL',normalized_goal:'想办法挣钱',depends_on:[],condition:null,branch:null,
   temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]}};
  if(p.verdict)return {data:{verdict:'aligned',explanation:'保留原始挣钱目标'}};
  if(p.decision){
   calls++;prompts.push(request.prompt);progress.push(context(request.prompt).progress);
   if(mode==='move')return decision(calls===1?'act':'done',calls===1?'move:market':null);
   if(mode==='sleep')return decision(calls===1?'act':'done',calls===1?'activity:sleep':null);
   if(calls===1)return decision('act','activity:work');
   if(mode==='blocked')return decision('blocked');
   if(mode==='repair'&&request.prompt.includes('generation_repair'))return decision('act','activity:work');
   return decision('done');
  }
  if(request.role==='narrator')return {data:{narrative:'你完成了程序记录的这一步。',speaker:null,dialogue:null,choices:[],patches:[]}};
  if(request.role==='npc_decision')return {data:{kind:'no_action',speech:null,vote_target:null,intent:'继续自己的安排',proposed_action:null,
   evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'无额外行动'}};
  throw Error('Unexpected offline stage '+request.role);
 });
 return {...f,progress,prompts,calls:()=>calls};
}
async function run(f:Awaited<ReturnType<typeof fixture>>,input='想办法挣钱'){
 const before=await f.service.current();
 const plan=validatePlan({goals:[{goal_id:'g1',type:'WORLD_GOAL',normalized_goal:input,depends_on:[],condition:null,branch:null,
  temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]});
 const result=await executePlan(f.service,{request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input},plan);
 return {before,result,after:await f.service.current()};
}
it('reports remote work travel as preparation rather than a completed work affordance',async()=>{
 const f=await fixture('blocked'),before=await f.service.current();
 await executeOpenWorldGoal(f.service,before,'想办法挣钱',randomUUID());
 expect(f.progress[1].completed).toEqual([]);
 expect(f.progress[1].preparation).toEqual([expect.objectContaining({candidate:'activity:work'})]);
 expect(wallet(await f.service.current())).toBe(wallet(before));
});
it('repairs premature done after travel before actually performing the declared work once',async()=>{
 const f=await fixture('repair'),r=await run(f);
 expect(r.result.plan?.status).toBe('completed');expect(wallet(r.after)-wallet(r.before)).toBe(8);
 expect(r.after.state_revision-r.before.state_revision).toBe(2);
 expect(f.calls()).toBe(4);expect(f.prompts[2]).toContain('generation_repair');
 expect(f.progress.at(-1)?.completed.map(s=>s.candidate)).toEqual(['activity:work']);
 expect(f.progress.at(-1)?.preparation).toEqual([]);
});
it('stops bounded repeated false completion claims while retaining the single settled route',async()=>{
 const f=await fixture('exhaust'),r=await run(f);
 expect(r.result.plan?.status).not.toBe('completed');expect(r.result.outcome?.type).toBe('engine_failure');
 expect(wallet(r.after)).toBe(wallet(r.before));expect(r.after.state_revision-r.before.state_revision).toBe(1);
 expect(r.after.resolution_receipts?.filter(x=>x.semantic_action==='MOVE')).toHaveLength(1);
 expect(f.calls()).toBe(3);expect(r.result.story).toBe(r.after.last_turn?.narrative);
});
it('retains actual local declared activity as completed evidence',async()=>{
 const f=await fixture('sleep'),r=await run(f,'找地方睡觉');
 expect(r.result.plan?.status).toBe('completed');expect(r.after.state_revision-r.before.state_revision).toBe(1);
 expect(f.progress.at(-1)?.completed.map(s=>s.candidate)).toEqual(['activity:sleep']);
});
it('treats arrival at an explicitly selected MOVE destination as fulfilled',async()=>{
 const f=await fixture('move'),r=await run(f,'去市场看看');
 expect(r.result.plan?.status).toBe('completed');expect(r.after.entities.find(e=>e.id===r.after.player_state.entity_id)?.components.location?.location_id).toBe('market');
 expect(f.progress.at(-1)?.completed.map(s=>s.candidate)).toEqual(['move:market']);
});
it.each(['repair','exhaust'] as const)('preserves %s completion evidence over actual HTTP restart and original-request replay',async mode=>{
 const f=await fixture(mode),seed=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-open-completion-'));
 const disk=new JsonStore(directory);await disk.write(seed);
 let server:Server|undefined;
 const close=async()=>{if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));server=undefined;}};
 const listen=async(service:GameService)=>{server=createApp(service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;};
 const token=async(base:string)=>(await(await fetch(base+'/api/session',{headers:{connection:'close'}})).json() as {token:string}).token;
 const body={request_id:randomUUID(),game_id:seed.game_id,expected_revision:seed.state_revision,input:'想办法挣钱'};
 const post=(base:string,key:string)=>fetch(base+'/api/input',{method:'POST',headers:{connection:'close','content-type':'application/json','X-Game-Token':key},body:JSON.stringify(body)});
 try{
  const base=await listen(new GameService(disk,f.ai,seed.definition)),response=await post(base,await token(base)),result=await response.json();
  expect(response.status,JSON.stringify(result)).toBe(200);expect(result.plan,JSON.stringify(result)).toBeDefined();
  expect(result.plan.status).toBe(mode==='repair'?'completed':'partial');
  expect(result.outcome.type).toBe(mode==='repair'?'game':'engine_failure');
  const after=(await disk.read())!;expect(wallet(after)-wallet(seed)).toBe(mode==='repair'?8:0);
  expect(after.state_revision-seed.state_revision).toBe(mode==='repair'?2:1);
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='MOVE')).toHaveLength(1);
  const bytes=await readFile(join(directory,'current.json'));await close();
  const ai=new AIRuntime({name:'restart-no-generation',generate:async()=>{throw Error('Replay must not generate');}});
  const restarted=await listen(new GameService(new JsonStore(directory),ai,seed.definition));
  const status=await(await fetch(`${restarted}/api/input/status/${body.request_id}?game_id=${body.game_id}`,{headers:{connection:'close'}})).json();
  expect(status.state).toBe('completed');expect(status.result).toEqual(result);
  const replay=await post(restarted,await token(restarted));expect(replay.status).toBe(200);expect(await replay.json()).toEqual(result);
  expect(ai.metrics.requests).toBe(0);expect(await disk.read()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
 }finally{await close();await rm(directory,{recursive:true,force:true});}
});

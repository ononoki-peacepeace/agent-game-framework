import {afterEach,expect,it,vi} from 'vitest';
import * as coreRuntime from '../src/core/runtime.js';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
const resources:{directory:string;servers:Server[]}[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const r of resources.splice(0)){for(const s of r.servers)await new Promise<void>(done=>s.close(()=>done()));await rm(r.directory,{recursive:true,force:true});}});
function field(prompt:string,key:string){const from=prompt.indexOf(`"${key}":`);if(from<0)return null;const start=prompt.indexOf(':',from)+1;
 for(let end=start+1;end<=prompt.length;end++){try{return JSON.parse(prompt.slice(start,end));}catch{}}return null;}
async function setup(eventEnabled:boolean,failFirstDecision=false,immediate=false,conflicting=false){
 const directory=await mkdtemp(join(tmpdir(),'agf-npc-world-http-')),r={directory,servers:[] as Server[]};resources.push(r);
 const world=sparseWorld();world.routine_rules=undefined;world.events=[{id:'arrive_for_shift',hook:'on_location_enter',location_id:'market',actor_scope:'any',probability:1,once:true,
 set_flag:'worker_arrived',public_text:'',reveal_location_id:null,interrupt_automation:false}];
 world.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:2,minimum_gap_minutes:60,replenishment:false};
 world.background_incidents=[{id:'daily_shift',title:'普通工作交接',summary:'独立的工作安排',source:'WORLD_PACKAGE',created_at:world.runtime.time,
 earliest_activation:world.runtime.time,latest_activation:null,activation_flags:eventEnabled?['worker_arrived']:['not_satisfied'],activation_chance:1,
 participants:['npc_lin'],locations:['market'],stages:[{id:'record',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',effects:[{kind:'set_flag',flag:'shift_recorded'}],
 exposures:[{id:'record',channel:'same_location',location_id:'market',npc_id:null,text:'这里留下了一份普通交接记录。',interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
 const calls:{role:string;actor:string|null}[]=[];
 const ai=new AIRuntime({name:'synthetic-npc-causal-http',generate:async request=>{
  const p=(request.schema as any).properties??{},context=field(request.prompt,'context');calls.push({role:request.role,actor:context?.npc_id??null});
  if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',confidence:.99,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'world_transaction'}};
  if(request.role==='npc_decision'){
   // Mirrors the actual failing field from tr_bda104c27457; other fields are synthetic.
   const base={kind:'no_action',speech:null,vote_target:null,intent:'自己的日常安排',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],plan_updates:null,decision_summary:'继续自己的安排',social_response:null};
   // A malformed schema field is now repaired by the owner; only a semantic conflict (an evidence
   // reference the NPC cannot know) is unrepairable and must back off instead.
   if(failFirstDecision){failFirstDecision=false;return {data:{...base,evidence_refs:['unknown_secret']}};}
   if(context?.npc_id==='npc_lin')return {data:{...base,...(immediate?{kind:'proposed_action',proposed_action:{type:'MOVE',target_id:'market',reason:'前往已知岗位',duration_minutes:null}}:{}),goal_proposals:[{id:'own_shift',description:'处理自己已决定的工作安排',horizon:'short',priority:5}],plan_proposals:[{
    id:'shift_steps',goal_id:'own_shift',intention:'前往市场、工作并与熟人交接',not_before:null,steps:[
     {type:'MOVE',target_id:conflicting?'station':'market',description:'前往已知岗位',duration_minutes:null,speech:null},
     {type:'HOLD',target_id:null,description:'整理既有工作安排',duration_minutes:8,speech:null},
     {type:'TALK',target_id:'npc_qiao',description:'向熟人说明自己的交接情况',duration_minutes:null,speech:'我这边的普通交接安排好了。'}]}]}};
   const heard=context?.memories?.some((m:any)=>m.summary.includes('普通交接'));
   return {data:heard?{...base,kind:'speech',speech:'知道了，我会按自己的安排处理。',decision_summary:'根据刚刚实际听见的消息回应'}:base};
  }
  if(request.role==='narrator')return {data:{narrative:'你留在原地等了一阵，周围依旧安静。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],item_claims:[],stable_locations:[],mechanical_claims:[]}};
  if(p.grounded)return {data:{grounded:true,reports_result:true,reason:'仅描述实际等待',unsupported_claims:[]}};
  throw Error('unexpected offline stage '+request.role+' '+Object.keys(p).join(','));
 }});
 const store=new JsonStore(directory),service=new GameService(store,ai,world);await service.newGame();
 const before=await service.current();before.npc_agent_state??={};before.npc_agent_state.npc_lin=emptyNpcAgentState();
 before.npc_agent_state.npc_lin.memories.push({event_ref:'known_contact',kind:'heard',summary:'曾与这位熟人交流',participant_ids:['npc_lin','npc_qiao'],at:before.runtime.time,importance:2});await store.write(before);
 const open=async(svc:GameService)=>{const server=createApp(svc,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');r.servers.push(server);await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`,{token}=await(await fetch(base+'/api/session')).json() as any;
  return async(path:string,body:unknown)=>{const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});return {status:res.status,data:await res.json() as any};};};
 return {service,store,ai,calls,open,post:await open(service),world,before};
}
it.each([true,false])('natural HTTP WAIT -> own plan -> causal Core actions -> save/reload/Undo, event %s',async eventEnabled=>{
 const f=await setup(eventEnabled);let before=await f.service.current();const firstBody={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'等待180分钟'};
 const first=await f.post('/api/input',firstBody);expect(first.status,JSON.stringify(first.data)).toBe(200);
 const planned=await f.service.current();expect(planned.runtime.time.minute).toBe(180);expect(planned.npc_agent_state!.npc_lin.plans[0].execution!.cursor).toBe(0);
 expect(planned.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 const body={game_id:planned.game_id,expected_revision:planned.state_revision,request_id:randomUUID(),input:'等待30分钟'};
 const response=await f.post('/api/input',body);expect(response.status,JSON.stringify(response.data)).toBe(200);
 const after=await f.service.current();expect(after.runtime.time.minute).toBe(210);expect(after.state_revision).toBe(planned.state_revision+1);
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
 const receipts=after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.at!.minute>180);
 expect(receipts.map(r=>r.semantic_action)).toEqual(['MOVE','HOLD','TALK']);expect(receipts.every(r=>r.commit_status==='committed')).toBe(true);
 expect(after.npc_agent_state!.npc_qiao.memories.some(m=>m.kind==='heard'&&m.summary.includes('普通交接'))).toBe(true);
 expect(after.resolution_receipts!.some(r=>r.actor_id==='npc_qiao'&&r.semantic_action==='TALK')).toBe(true);
 expect(Boolean(after.gm_state.flags.shift_recorded)).toBe(eventEnabled);expect(after.background_state!.exposure_log).toHaveLength(0);
 expect(after.last_turn!.narrative).not.toContain('交接记录');
 const revision=after.state_revision,calls=f.calls.length;await f.post('/api/input',body);expect((await f.service.current()).state_revision).toBe(revision);expect(f.calls.length).toBe(calls);
 const reloaded=new GameService(new JsonStore(f.store.directory),f.ai,f.world),post=await f.open(reloaded);
 expect((await reloaded.current()).npc_agent_state).toEqual(after.npc_agent_state);await post('/api/input',body);expect((await reloaded.current()).state_revision).toBe(revision);
 await post('/api/undo',{game_id:after.game_id,expected_revision:revision,request_id:randomUUID()});const undone=await reloaded.current();
 expect(undone.runtime.time).toEqual(planned.runtime.time);expect(undone.npc_agent_state).toEqual(planned.npc_agent_state);expect(undone.background_state).toEqual(planned.background_state);
 if(eventEnabled)await writeFile('docs/qa-npc-world-http-evidence.json',JSON.stringify({synthetic_provider:true,formal_save_used:false,inputs:[firstBody.input,body.input],
 revisions:[f.before.state_revision,planned.state_revision,after.state_revision,undone.state_revision],time:[planned.runtime.time,after.runtime.time],
 npc_actions:receipts.map(r=>({id:r.request_id,type:r.semantic_action,time_cost:r.time_cost,at:r.at,status:r.commit_status})),
 calls:f.calls,remote_exposures:after.background_state!.exposure_log.length,reload_equal:true,undo_equal:true},null,2));
});

it('keeps a failed write uncommitted and recovers the same pending Core candidate once',async()=>{
 const f=await setup(false),before=await f.service.current();await f.post('/api/input',{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'等待180分钟'});
 const planned=await f.service.current(),original=f.store.write.bind(f.store);let failed=false;
 f.store.write=async(...args:Parameters<typeof original>)=>{if(!failed&&args[0].state_revision===planned.state_revision+1){failed=true;throw Error('isolated final write failure');}return original(...args);};
 const body={game_id:planned.game_id,expected_revision:planned.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:30}}};
 await f.post('/api/action',body);expect(failed).toBe(true);expect((await f.service.current()).runtime.time).toEqual(planned.runtime.time);
 const response=await f.post('/api/action',body);expect(response.status,JSON.stringify(response.data)).toBe(200);
 const after=await f.service.current();expect(after.runtime.time.minute).toBe(210);expect(after.state_revision).toBe(planned.state_revision+1);
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.at!.minute>180).map(r=>r.semantic_action)).toEqual(['MOVE','HOLD','TALK']);
 expect(new Set(after.resolution_receipts!.map(r=>r.request_id)).size).toBe(after.resolution_receipts!.length);
});

it('commits an immediate MOVE and plan cursor together; failed save/retry/reload/Undo never repeat that MOVE',async()=>{
 const f=await setup(false,false,true),before=await f.service.current();
 const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'等待180分钟'};
 expect((await f.post('/api/input',body)).status).toBe(200);const moved=await f.service.current();
 const plan=moved.npc_agent_state!.npc_lin.plans[0],first=plan.execution!.last_receipt_id;
 expect(plan.execution!.cursor).toBe(1);expect(moved.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
 expect(moved.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
 expect(moved.runtime.time.minute).toBe(180);
 const calls=f.calls.length;await f.post('/api/input',body);expect(f.calls).toHaveLength(calls);
 const original=f.store.write.bind(f.store);let fail=true;
 f.store.write=async(...args:Parameters<typeof original>)=>{if(fail&&args[0].state_revision===moved.state_revision+1){fail=false;throw Error('isolated final write failure');}return original(...args);};
 const nextBody={game_id:moved.game_id,expected_revision:moved.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:30}}};
 expect((await f.post('/api/action',nextBody)).status).not.toBe(200);
 expect((await f.service.current()).npc_agent_state!.npc_lin.plans[0].execution!.cursor).toBe(1);
 const afterFailedCalls=f.calls.filter(c=>c.role==='npc_decision').length;expect((await f.post('/api/action',nextBody)).status).toBe(200);
 expect(f.calls.filter(c=>c.role==='npc_decision')).toHaveLength(afterFailedCalls);
 const after=await f.service.current();expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(after.runtime.time.minute).toBe(210);
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
 const reloaded=new GameService(new JsonStore(f.store.directory),f.ai,f.world),post=await f.open(reloaded);
 expect((await reloaded.current()).npc_agent_state).toEqual(after.npc_agent_state);
 expect((await post('/api/undo',{game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()})).status).toBe(200);
 const undone=await reloaded.current();expect(undone.npc_agent_state!.npc_lin.plans[0].execution).toMatchObject({cursor:1,last_receipt_id:first});
 expect(undone.runtime.time.minute).toBe(180);
 expect(undone.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
});

it('rejects a conflicting immediate/plan target before Core and retains the legal player WAIT',async()=>{
 const f=await setup(false,false,true,true),before=await f.service.current();
 expect((await f.post('/api/input',{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'等待180分钟'})).status).toBe(200);
 const after=await f.service.current();expect(after.npc_agent_state!.npc_lin.plans).toHaveLength(0);
 expect(after.npc_agent_state!.npc_lin.autonomy_retry?.stage).toBe('decision');
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(0);
 expect(after.runtime.time.minute).toBe(180);
});

it('rolls back a failed immediate-step save and recovers its exact candidate without a second execution',async()=>{
 const execute=vi.spyOn(coreRuntime,'executeAction');
 const f=await setup(false,false,true),before=await f.service.current(),original=f.store.write.bind(f.store);let fail=true;
 f.store.write=async(...args:Parameters<typeof original>)=>{if(fail&&args[0].state_revision===before.state_revision+1){fail=false;throw Error('isolated immediate commit failure');}return original(...args);};
 const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:180}}};
 expect((await f.post('/api/action',body)).status).not.toBe(200);
 expect(await f.service.current()).toEqual(before);
 const calls=f.calls.filter(c=>c.role==='npc_decision').length;
 const moveCalls=()=>execute.mock.calls.filter(args=>args[7]==='npc_lin'&&(args[1] as any).type==='MOVE').length;
 expect(moveCalls()).toBe(1);
 expect((await f.post('/api/action',body)).status).toBe(200);expect(f.calls.filter(c=>c.role==='npc_decision')).toHaveLength(calls);
 expect(moveCalls()).toBe(1);
 const after=await f.service.current(),execution=after.npc_agent_state!.npc_lin.plans[0].execution!;
 expect(execution.cursor).toBe(1);
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
 expect(after.resolution_receipts!.some(r=>r.request_id===execution.last_receipt_id&&r.commit_status==='committed')).toBe(true);
 expect((await f.post('/api/undo',{game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()})).status).toBe(200);
 const undone=await f.service.current();expect(undone.runtime.time).toEqual(before.runtime.time);
 expect(undone.npc_agent_state).toEqual(before.npc_agent_state);
 expect(undone.entities.find(e=>e.id==='npc_lin')!.components.location).toEqual(before.entities.find(e=>e.id==='npc_lin')!.components.location);
});

it('persists invalid-decision backoff across HTTP replay/reload/Undo, then admits a null-compatible plan once',async()=>{
 const f=await setup(false,true),initial=await f.service.current();
 const failedRequest={game_id:initial.game_id,expected_revision:initial.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:180}}};
 const response=await f.post('/api/action',failedRequest);expect(response.status).toBe(200);
 const failed=await f.service.current(),state=failed.npc_agent_state!.npc_lin;
 expect(state.last_autonomous_at).toBeUndefined();expect(state.autonomy_retry?.retry_at.minute).toBe(195);
 const decisions=f.calls.filter(c=>c.role==='npc_decision').length;
 await f.post('/api/action',failedRequest);expect(f.calls.filter(c=>c.role==='npc_decision')).toHaveLength(decisions);
 const reloaded=new GameService(new JsonStore(f.store.directory),f.ai,f.world),post=await f.open(reloaded);
 expect((await reloaded.current()).npc_agent_state!.npc_lin.autonomy_retry).toEqual(state.autonomy_retry);
 await post('/api/action',{game_id:failed.game_id,expected_revision:failed.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:14}}});
 expect((await reloaded.current()).npc_agent_state!.npc_lin.last_autonomous_at).toBeUndefined();
 const beforeUndo=await reloaded.current();
 expect((await post('/api/undo',{game_id:beforeUndo.game_id,expected_revision:beforeUndo.state_revision,request_id:randomUUID()})).status).toBe(200);
 expect((await reloaded.current()).runtime.time).toEqual(failed.runtime.time);
 expect((await reloaded.current()).npc_agent_state!.npc_lin.autonomy_retry).toEqual(state.autonomy_retry);
 for(const minutes of [15,1]){const current=await reloaded.current();
   expect((await post('/api/action',{game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes}}})).status).toBe(200);
 }
 const planned=await reloaded.current();expect(planned.npc_agent_state!.npc_lin.autonomy_retry).toBeUndefined();
 expect(planned.npc_agent_state!.npc_lin.plans[0].execution?.steps).toHaveLength(3);
 const body={game_id:planned.game_id,expected_revision:planned.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:30}}};
 expect((await post('/api/action',body)).status).toBe(200);const after=await reloaded.current();
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.at!.minute>196).map(r=>r.semantic_action)).toEqual(['MOVE','HOLD','TALK']);
 expect(after.runtime.time.minute).toBe(226);
 const calls=f.calls.length;await post('/api/action',body);expect((await reloaded.current()).state_revision).toBe(after.state_revision);expect(f.calls).toHaveLength(calls);
});

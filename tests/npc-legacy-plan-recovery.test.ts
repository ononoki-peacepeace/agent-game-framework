import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,type NpcDecision} from '../src/agent/npc-agent.js';
import {executeAction} from '../src/core/runtime.js';
import type {GameService} from '../src/server/service.js';
import * as runtime from '../src/core/runtime.js';

function fixture(blocked=true){
 const world=structuredClone(demo);world.events=[];
 if(blocked)world.map!.routes=[];
 const save=newSave(world),state=emptyNpcAgentState();
 state.goals=Array.from({length:13},(_,i)=>({id:`goal_${i}`,description:'本人的持续目标',horizon:'long' as const,status:'active' as const,origin:'self',priority:1}));
 state.plans=state.goals.slice(0,12).map((goal,i)=>({id:`abstract_${i}`,goal_id:goal.id,intention:'尚未确定的办法',status:'active' as const}));
 state.plans.push({id:'legacy_travel',goal_id:'goal_12',intention:'前往市场处理本人事务',status:'active',activity:{kind:'move',origin_location_id:'square',destination_id:'market',source_request_id:randomUUID(),condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0}});
 save.npc_agent_state={npc_lin:state};return validateSave(save);
}
it('exposes a route-blocked legacy plan and its owner within the bounded recovery view after reload',()=>{
 const before=fixture(),after=executeAction(before,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 const loaded=validateSave(JSON.parse(JSON.stringify(after))),snapshot=structuredClone(loaded),context=buildNpcAgentContext(loaded,'npc_lin',{kind:'world_event',description:'本人路线受阻'});
 expect(context.plan_recovery).toMatchObject([{plan_id:'legacy_travel',goal_id:'goal_12',blocked_reason:'route_unavailable'}]);
 expect(context.active_plans.map(p=>p.id)).toContain('legacy_travel');
 expect(context.active_goals.map(g=>g.id)).toContain('goal_12');
 expect(context.active_plans.length).toBeLessThanOrEqual(12);expect(context.active_goals).toHaveLength(12);
 expect(loaded).toEqual(snapshot);expect(after.resolution_receipts?.some(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toBe(false);
});
it('accepts the legacy plan owner replacing the blocked method, preserving the long goal and settling the new method once',async()=>{
 const before=fixture(),blocked=executeAction(before,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 const response:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'改为在原地准备',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_updates:[{plan_id:'legacy_travel',status:'abandoned'}],plan_proposals:[{id:'local_revision',goal_id:'goal_12',intention:'持续处理同一目标',steps:[{type:'HOLD',target_id:null,description:'整理本人的准备安排',duration_minutes:8,speech:null}]}],decision_summary:'路线不可达，保留长期目标并换方法',social_response:null};
 let calls=0;const service={ai:{npcDecision:async()=>{calls++;return response;}}} as unknown as GameService;
 const decision=await decideNpc(service,blocked,'npc_lin',{kind:'world_event',description:'本人路线受阻'});
 applyNpcDecision(blocked,'npc_lin','legacy-route-revision',decision);
 const after=executeAction(validateSave(blocked),{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals.find(g=>g.id==='goal_12')!.status).toBe('active');
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='legacy_travel')!.status).toBe('abandoned');
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='local_revision')!.status).toBe('completed');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>r.semantic_action)).toEqual(['HOLD']);
 expect(calls).toBe(1);
 const later=executeAction(validateSave(JSON.parse(JSON.stringify(after))),{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
 expect(later.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>r.semantic_action)).toEqual(['HOLD']);
 expect(later.npc_agent_state!.npc_lin.goals.find(g=>g.id==='goal_12')!.status).toBe('active');
});
it('does not invent route failure for an ordinary reachable legacy journey',()=>{
 const before=fixture(false),context=buildNpcAgentContext(before,'npc_lin',{kind:'world_event',description:'查看本人计划'});
 expect(context.plan_recovery).toEqual([]);
});
it.each(['conditional','arrived','different-origin','ended'] as const)('does not label unrelated legacy prerequisites as route failure: %s',mode=>{
 const save=fixture(),plan=save.npc_agent_state!.npc_lin.plans.at(-1)!;
 if(mode==='conditional')plan.activity!.condition='等待本人确认';
 if(mode==='arrived')save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'market'};
 if(mode==='different-origin')save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
 if(mode==='ended')save.npc_agent_state!.npc_lin.goals.at(-1)!.status='abandoned';
 const recovery=buildNpcAgentContext(validateSave(save),'npc_lin',{kind:'world_event',description:'核对本人安排'}).plan_recovery;
 if(mode==='conditional')expect(recovery).toMatchObject([{blocked_reason:'condition_pending'}]);
 else expect(recovery).toEqual([]);
});
it.each([false,true])('uses the same known-route boundary as the legacy executor (known=%s)',known=>{
 const save=fixture(false);save.definition.map!.locations.find(p=>p.id==='market')!.known_by_default=false;
 save.map_state.known_location_ids=save.map_state.known_location_ids.filter(id=>id!=='market');
 if(known)save.map_state.known_location_ids.push('market');
 const context=buildNpcAgentContext(validateSave(save),'npc_lin',{kind:'world_event',description:'核对本人路线'});
 expect(context.plan_recovery.some(p=>p.plan_id==='legacy_travel')).toBe(!known);
});
it('retains the real Core rejection diagnostic when a legacy route exists but its destination is closed',()=>{
 const before=fixture(false),market=before.definition.map!.locations.find(p=>p.id==='market')!;
 market.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'隔离关闭目的地',source_ref:'fixture',recorded_at:before.runtime.time};
 const after=executeAction(validateSave(before),{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 const plan=after.npc_agent_state!.npc_lin.plans.at(-1)!;
 expect(plan.last_failed_request_id).toBeTruthy();
 const loaded=validateSave(JSON.parse(JSON.stringify(after))),context=buildNpcAgentContext(loaded,'npc_lin',{kind:'world_event',description:'本人出行未能完成'});
 expect(context.plan_recovery).toMatchObject([{plan_id:'legacy_travel',blocked_reason:'core_rejected',diagnostic:expect.any(String)}]);
 expect(context.plan_recovery[0].diagnostic).toMatch(/关闭|封闭|进入/);
 expect(context.plan_recovery[0].last_receipt_id).toBeNull();
 expect(loaded.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')??[]).toHaveLength(0);
 loaded.definition.map!.locations.find(p=>p.id==='market')!.lifecycle!.status='active';
 const one=executeAction(loaded,{type:'WAIT',parameters:{minutes:1}},randomUUID()).save;
 expect(one.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 const done=executeAction(one,{type:'WAIT',parameters:{minutes:5}},randomUUID()).save;
 const completed=done.npc_agent_state!.npc_lin.plans.find(p=>p.id==='legacy_travel')!;
 expect(completed.status).toBe('completed');expect(completed.last_failed_request_id).toBeUndefined();
 expect(completed.activity).not.toHaveProperty('blocked_reason');expect(completed.activity).not.toHaveProperty('failure_diagnostic');
 expect(done.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>r.semantic_action)).toEqual(['MOVE']);
 expect(done.npc_agent_state!.npc_lin.goals.find(g=>g.id==='goal_12')!.status).toBe('active');
});
it('keeps old failed legacy activities manageable without inventing their missing failure diagnosis',()=>{
 const before=fixture(false);before.npc_agent_state!.npc_lin.plans.at(-1)!.last_failed_request_id='old-failed-request';
 const context=buildNpcAgentContext(validateSave(before),'npc_lin',{kind:'world_event',description:'读取旧计划'});
 expect(context.plan_recovery).toMatchObject([{plan_id:'legacy_travel',blocked_reason:'previous_attempt_failed',last_receipt_id:null}]);
 expect(context.plan_recovery[0].diagnostic).toContain('未保存');
});
it('keeps a legacy technical failure distinct from a real Core refusal',()=>{
 const before=fixture(false),original=runtime.executeAction;
 const spy=vi.spyOn(runtime,'executeAction').mockImplementation((...args)=>{
  if(args[7]==='npc_lin')throw Error('offline injected legacy execution fault');
  return original(...args);
 });
 try{
  const after=executeAction(before,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
  const context=buildNpcAgentContext(validateSave(JSON.parse(JSON.stringify(after))),'npc_lin',{kind:'world_event',description:'核对上次异常'});
  expect(context.plan_recovery).toMatchObject([{plan_id:'legacy_travel',blocked_reason:'system_error',diagnostic:'offline injected legacy execution fault',last_receipt_id:null}]);
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')??[]).toHaveLength(0);
 }finally{spy.mockRestore();}
});
it('does not assign the legacy missing-cause message to modern plans',()=>{
 const save=fixture(false),plan=save.npc_agent_state!.npc_lin.plans.at(-1)!;delete plan.activity;
 plan.execution={steps:[{type:'HOLD',target_id:null,description:'原地准备',duration_minutes:8,speech:null}],cursor:0,not_before:null,condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:'core_rejected'};
 expect(buildNpcAgentContext(validateSave(save),'npc_lin',{kind:'world_event',description:'核对现代计划'}).plan_recovery[0].diagnostic).toBeNull();
});

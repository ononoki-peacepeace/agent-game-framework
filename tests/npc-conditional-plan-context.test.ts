import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,type NpcDecision} from '../src/agent/npc-agent.js';
import {executeAction} from '../src/core/runtime.js';
import type {GameService} from '../src/server/service.js';

function fixture(legacy:boolean){
 const world=structuredClone(demo);world.events=[];const save=newSave(world),state=emptyNpcAgentState();
 state.goals=Array.from({length:13},(_,i)=>({id:`g_${i}`,description:'本人持续目标',horizon:'long' as const,status:'active' as const,origin:'self',priority:1}));
 state.plans=state.goals.slice(0,12).map((g,i)=>({id:`abstract_${i}`,goal_id:g.id,intention:'其他抽象安排',status:'active' as const}));
 state.plans.push({id:'conditional',goal_id:'g_12',intention:'条件成立后处理本人事务',status:'active',...(legacy?{activity:{kind:'move' as const,origin_location_id:'square',destination_id:'market',source_request_id:randomUUID(),condition:'等本人确认准备完成',last_accounted_at:{...save.runtime.time},time_credit_minutes:0}}:{execution:{steps:[{type:'HOLD' as const,target_id:null,description:'原方法',duration_minutes:8,speech:null}],cursor:0,not_before:null,condition:'等本人确认准备完成',last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}})});
 save.npc_agent_state={npc_lin:state};return validateSave(save);
}
it.each([false,true])('surfaces an unresolved condition and its owner without automatically satisfying it (legacy=%s)',legacy=>{
 const before=fixture(legacy),after=executeAction(before,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 const loaded=validateSave(JSON.parse(JSON.stringify(after))),snapshot=structuredClone(loaded),context=buildNpcAgentContext(loaded,'npc_lin',{kind:'world_event',description:'本人有待确认的前提'});
 expect(context.plan_recovery).toMatchObject([{plan_id:'conditional',goal_id:'g_12',blocked_reason:'condition_pending',diagnostic:expect.stringContaining('等本人确认准备完成')}]);
 expect(context.active_plans.map(p=>p.id)).toContain('conditional');expect(context.active_goals.map(g=>g.id)).toContain('g_12');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')??[]).toHaveLength(0);expect(loaded).toEqual(snapshot);
 expect(context.active_plans.length).toBeLessThanOrEqual(12);expect(context.active_goals.length).toBeLessThanOrEqual(12);
});
it.each([false,true])('lets only the NPC owner revise a now-resolved condition and execute once (legacy=%s)',async legacy=>{
 const before=fixture(legacy),blocked=executeAction(before,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 const decision:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'本人已完成准备，改用当前可行方法',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_updates:[{plan_id:'conditional',status:'abandoned'}],plan_proposals:[{id:'confirmed_method',goal_id:'g_12',intention:'准备之后继续本人事务',steps:[{type:'HOLD',target_id:null,description:'本人在原地整理安排',duration_minutes:8,speech:null}]}],decision_summary:'本人确认准备完成并选择新方法',social_response:null};
 const service={ai:{npcDecision:async()=>decision}} as unknown as GameService;
 const admitted=await decideNpc(service,blocked,'npc_lin',{kind:'world_event',description:'由本人核对准备是否完成'});
 applyNpcDecision(blocked,'npc_lin','owner-confirms-condition',admitted);
 let after=executeAction(validateSave(blocked),{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
 after=executeAction(validateSave(JSON.parse(JSON.stringify(after))),{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='conditional')!.status).toBe('abandoned');
 expect(after.npc_agent_state!.npc_lin.goals.find(g=>g.id==='g_12')!.status).toBe('active');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>r.semantic_action)).toEqual(['HOLD']);
});
it.each([false,true])('keeps waiting when the NPC owner does not confirm the condition (legacy=%s)',async legacy=>{
 const before=fixture(legacy),context=buildNpcAgentContext(before,'npc_lin',{kind:'world_event',description:'不要把催促当作准备完成'});
 const response:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'准备尚未完成，保留条件',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'本人继续等待',social_response:null};
 const service={ai:{npcDecision:async()=>response}} as unknown as GameService;
 const decision=await decideNpc(service,before,'npc_lin',{kind:'world_event',description:'核对本人准备'});
 applyNpcDecision(before,'npc_lin','owner-keeps-waiting',decision);
 const after=executeAction(before,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 expect(context.plan_recovery[0].instruction).toContain('不会因时间经过自动成立');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')??[]).toHaveLength(0);
 expect(after.npc_agent_state!.npc_lin.plans.at(-1)!.status).toBe('active');
 expect(after.npc_agent_state!.npc_lin.goals.at(-1)!.status).toBe('active');
});

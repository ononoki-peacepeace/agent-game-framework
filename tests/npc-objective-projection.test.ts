import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,type NpcDecision} from '../src/agent/npc-agent.js';
import {executeAction} from '../src/core/runtime.js';
import type {GameService} from '../src/server/service.js';

function fixture(manyPlans=false){
 const save=newSave(demo);save.definition.events=[];const state=emptyNpcAgentState();
 state.goals=Array.from({length:13},(_,i)=>({id:`goal_${i}`,description:`本人的长期任务${i}`,horizon:'long' as const,
  status:'active' as const,origin:'fixture',priority:i===12?10:1}));
 const blocked={id:'blocked_plan',goal_id:'goal_12',intention:'处理本人的长期任务',status:'active' as const,
  execution:{steps:[{type:'HOLD' as const,target_id:null,description:'原地准备',duration_minutes:8,speech:null}],cursor:0,
   not_before:null,condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:'core_rejected'}};
 state.plans=manyPlans?[...state.goals.slice(0,12).map((g,i)=>({id:`abstract_${i}`,goal_id:g.id,intention:g.description,status:'active' as const})),blocked]:[blocked];
 save.npc_agent_state={npc_lin:state,npc_qiao:{...emptyNpcAgentState(),goals:[{id:'OTHER_PRIVATE_GOAL',description:'OTHER_PRIVATE_MOTIVE',horizon:'long',status:'active',origin:'private',priority:10}]}};
 return {save:validateSave(save),blocked};
}
it.each([false,true])('shows the goal of every exposed active plan within the same bounded context (many=%s)',many=>{
 const {save}=fixture(many),before=structuredClone(save),context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'原计划受阻'});
 expect(context.active_plans.every(plan=>context.active_goals.some(goal=>goal.id===plan.goal_id))).toBe(true);
 expect(context.active_goals).toHaveLength(12);expect(context.active_plans.length).toBeLessThanOrEqual(12);
 expect(JSON.stringify(context)).not.toContain('OTHER_PRIVATE');expect(save).toEqual(before);
});
it('keeps a recoverable plan inside active_plans even when it originally followed twelve other plans',()=>{
 const {save,blocked}=fixture(true),context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'原计划受阻'});
 expect(context.plan_recovery.map(plan=>plan.plan_id)).toContain(blocked.id);
 expect(context.active_plans.map(plan=>plan.id)).toContain(blocked.id);
 expect(context.active_goals.map(goal=>goal.id)).toContain(blocked.goal_id);
});
it.each([false,true])('accepts the owner replacement of a visible blocked plan and continues it once (many=%s)',async many=>{
 const {save,blocked}=fixture(many),before=structuredClone(save);
 const response:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'换一种准备方式',proposed_action:null,evidence_refs:[],belief_updates:[],
  goal_updates:[],goal_proposals:[],plan_updates:[{plan_id:blocked.id,status:'abandoned'}],
  plan_proposals:[{id:'replacement',goal_id:blocked.goal_id,intention:'处理同一长期任务',steps:[{type:'HOLD',target_id:null,description:'在原地重新准备',duration_minutes:8,speech:null}]}],
  decision_summary:'保留长期目标，放弃受阻方法',social_response:null};
 const service={ai:{npcDecision:async()=>response}} as unknown as GameService;
 const decision=await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'原计划已受阻，请本人修订'});
 expect(save).toEqual(before);applyNpcDecision(save,'npc_lin','replan-visible',decision);
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals.find(g=>g.id===blocked.goal_id)!.status).toBe('active');
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id===blocked.id)!.status).toBe('abandoned');
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='replacement')!.status).toBe('completed');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='HOLD')).toHaveLength(1);
});
it('keeps higher-priority unplanned goals visible after including plan owners',()=>{
 const {save}=fixture();save.npc_agent_state!.npc_lin.goals[11].priority=9;
 const context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'新的重要目标'});
 expect(context.active_goals.map(g=>g.id)).toContain('goal_12');expect(context.active_goals.map(g=>g.id)).toContain('goal_11');
 expect(context.active_goals).toHaveLength(12);
});
it('does not expose an ended goal as active or revive its lingering plan',()=>{
 const {save,blocked}=fixture(true),state=save.npc_agent_state!.npc_lin;state.goals.find(g=>g.id===blocked.goal_id)!.status='completed';
 const before=structuredClone(save),context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'保持日常生活'});
 expect(context.active_goals.some(g=>g.id===blocked.goal_id)).toBe(false);
 expect(context.active_plans.some(p=>p.id===blocked.id)).toBe(false);expect(context.plan_recovery.some(p=>p.plan_id===blocked.id)).toBe(false);
 expect(context.objective_ids.plans).toContain(blocked.id);expect(context.objective_ids.goals).toContain(blocked.goal_id);expect(save).toEqual(before);
});

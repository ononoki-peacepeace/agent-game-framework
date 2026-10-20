import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,recordSceneObservation,type NpcDecision} from '../src/agent/npc-agent.js';
import type {GameService} from '../src/server/service.js';

function fixture(legacy:boolean,trigger:'relationship'|'new-fact'){
 const world=structuredClone(demo);world.events=[];
 world.ruleset.relationship_dimensions={familiarity:{min:0,max:10,initial:0,event_deltas:{contact:1}}};
 let save=newSave(world);save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
 for(const e of save.entities)delete e.components.relationships;
 const state=emptyNpcAgentState();
 state.goals=Array.from({length:13},(_,i)=>({id:`g_${i}`,description:'本人持续事务',horizon:'long' as const,status:'active' as const,origin:'self',priority:1}));
 state.plans=state.goals.slice(0,12).map((g,i)=>({id:`abstract_${i}`,goal_id:g.id,intention:'抽象安排',status:'active' as const}));
 state.plans.push({id:'working_method',goal_id:'g_12',intention:'本人当前执行方法',status:'active',...(legacy?{activity:{kind:'move' as const,origin_location_id:'square',destination_id:'market',source_request_id:randomUUID(),condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0}}:{execution:{steps:[{type:'HOLD' as const,target_id:null,description:'本人原先准备',duration_minutes:120,speech:null}],cursor:0,not_before:null,condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}})});
 save.npc_agent_state={npc_lin:state};
 if(trigger==='relationship')save=executeAction(save,{type:'TALK',target_id:'npc_qiao',parameters:{topic:'本人重新认识对方'}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true).save;
 else recordSceneObservation(save,randomUUID(),[{speaker_id:'npc_qiao',utterance:'我今天不去市场，我会留在广场。'}],['npc_lin']);
 return validateSave(save);
}
const cases=([false,true] as const).flatMap(legacy=>(['relationship','new-fact'] as const).map(trigger=>({legacy,trigger})));
it.each(cases)('shows a currently executable method and owned goal before it fails (legacy=$legacy, trigger=$trigger)',({legacy,trigger})=>{
 const save=fixture(legacy,trigger),before=structuredClone(save),context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'本人根据刚才经历重新考虑方法'});
 expect(context.active_plans.map(p=>p.id)).toContain('working_method');expect(context.active_goals.map(g=>g.id)).toContain('g_12');
 expect(context.plan_recovery).toEqual([]);expect(context.active_plans.length).toBeLessThanOrEqual(12);expect(context.active_goals).toHaveLength(12);
 if(trigger==='relationship')expect(context.relationships).toMatchObject({npc_qiao:{familiarity:1}});
 else expect(JSON.stringify(context.memories)).toContain('我今天不去市场');
 expect(save).toEqual(before);
});
it.each(cases)('lets its owner revise a viable method after actual new inputs, without ending the long goal (legacy=$legacy, trigger=$trigger)',async({legacy,trigger})=>{
 const save=fixture(legacy,trigger),prior=structuredClone(save.npc_agent_state!.npc_lin.goals.at(-1));
 const decision:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'依据刚才经历调整方法',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_updates:[{plan_id:'working_method',status:'abandoned'}],plan_proposals:[{id:'revised_method',goal_id:'g_12',intention:'保留长期事务，在原地准备',steps:[{type:'HOLD',target_id:null,description:'根据新情况整理本人安排',duration_minutes:8,speech:null}]}],decision_summary:'调整方法，长期目标保留',social_response:null};
 const service={ai:{npcDecision:async()=>decision}} as unknown as GameService;
 const admitted=await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'本人根据刚才经历重新考虑方法'});
 applyNpcDecision(save,'npc_lin','owner-adaptive-method',admitted);
 let after=executeAction(validateSave(save),{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
 after=executeAction(validateSave(JSON.parse(JSON.stringify(after))),{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals.find(g=>g.id==='g_12')).toEqual(prior);
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='working_method')!.status).toBe('abandoned');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='HOLD')).toHaveLength(1);
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')??[]).toHaveLength(0);
});
it.each([false,true])('preserves a viable method when its owner chooses not to revise it (legacy=%s)',async legacy=>{
 const save=fixture(legacy,'relationship'),prior=structuredClone(save.npc_agent_state!.npc_lin.goals.at(-1));
 const response:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'继续原安排',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'关系变化不要求放弃本人计划',social_response:null};
 const service={ai:{npcDecision:async()=>response}} as unknown as GameService;
 applyNpcDecision(save,'npc_lin','keep-original-method',await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'本人重新考虑'}));
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:6}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals.find(g=>g.id==='g_12')).toEqual(prior);
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='working_method')!.status).toBe(legacy?'completed':'active');
 expect(after.npc_agent_state!.npc_lin.plans.some(p=>p.id==='revised_method')).toBe(false);
});

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,type NpcDecision} from '../src/agent/npc-agent.js';
import type {GameService} from '../src/server/service.js';

function fixture(mode:'closed-destination'|'absent-listener'){
 const world=structuredClone(demo);world.events=[];const save=newSave(world),state=emptyNpcAgentState();
 state.goals=[{id:'long_goal',description:'持续处理本人事务',horizon:'long',status:'active',origin:'self',priority:5}];
 state.plans=[{id:'original',goal_id:'long_goal',intention:'先观察，再处理现场之外的事务',status:'active',execution:{steps:[
  {type:'INSPECT',target_id:null,description:'先确认本人当前场景',duration_minutes:null,speech:null},
  mode==='closed-destination'?{type:'MOVE',target_id:'market',description:'本人前往市场',duration_minutes:null,speech:null}:
   {type:'TALK',target_id:'npc_qiao',description:'向乔宁传达本人安排',duration_minutes:null,speech:'我来核对安排。'}],cursor:0,not_before:null,condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}}];
 save.npc_agent_state={npc_lin:state};
 if(mode==='closed-destination')save.definition.map!.locations.find(p=>p.id==='market')!.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'隔离关闭场景',source_ref:'fixture',recorded_at:save.runtime.time};
 else save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'station'};
 return validateSave(save);
}
it.each(['closed-destination','absent-listener'] as const)('preserves the successful prefix, long goal and real blocked cursor over repeated attempts and owner revision: %s',async mode=>{
 const before=fixture(mode),goal=structuredClone(before.npc_agent_state!.npc_lin.goals[0]);
 let save=before;let prefix:string|undefined;
 for(let i=0;i<3;i++){
  save=executeAction(validateSave(JSON.parse(JSON.stringify(save))),{type:'WAIT',parameters:{minutes:20}},randomUUID()).save;
  const receipts=save.resolution_receipts!.filter(r=>r.actor_id==='npc_lin');
  expect(receipts.map(r=>r.semantic_action)).toEqual(['INSPECT']);prefix??=receipts[0].request_id;
  expect(receipts[0].request_id).toBe(prefix);
  expect(save.npc_agent_state!.npc_lin.goals[0]).toEqual(goal);
  const recovery=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'本人再次面对同一未完成前提'}).plan_recovery;
  expect(recovery).toMatchObject([{plan_id:'original',goal_id:'long_goal',cursor:1,last_receipt_id:prefix,
   blocked_reason:mode==='closed-destination'?'core_rejected':'listener_not_present'}]);
  expect(recovery[0].failed_step?.type).toBe(mode==='closed-destination'?'MOVE':'TALK');
  expect(save.npc_agent_state!.npc_lin.plans[0].execution!.time_credit_minutes).toBe(0);
 }
 const decision:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'重复受阻后换本人方法',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_updates:[{plan_id:'original',status:'abandoned'}],plan_proposals:[{id:'revision',goal_id:'long_goal',intention:'在原地继续本人事务',steps:[{type:'HOLD',target_id:null,description:'依据已确认情况调整准备',duration_minutes:2,speech:null}]}],decision_summary:'已完成观察不重做，保留长期目标',social_response:null};
 const service={ai:{npcDecision:async()=>decision}} as unknown as GameService;
 applyNpcDecision(save,'npc_lin','repeat-failure-revision',await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'本人决定如何继续'}));
 save=executeAction(validateSave(save),{type:'WAIT',parameters:{minutes:2}},randomUUID()).save;
 save=executeAction(validateSave(JSON.parse(JSON.stringify(save))),{type:'WAIT',parameters:{minutes:20}},randomUUID()).save;
 expect(save.resolution_receipts!.filter(r=>r.actor_id==='npc_lin').map(r=>r.semantic_action)).toEqual(['INSPECT','HOLD']);
 expect(save.npc_agent_state!.npc_lin.plans.find(p=>p.id==='original')!.execution).toMatchObject({cursor:1,last_receipt_id:prefix});
 expect(save.npc_agent_state!.npc_lin.goals[0]).toEqual(goal);
 expect(save.npc_agent_state!.npc_lin.plans.find(p=>p.id==='revision')!.status).toBe('completed');
});

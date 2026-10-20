import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';

function fixture(kind:'activity'|'execution',status:'completed'|'abandoned'){
 const save=newSave(demo);save.definition.events=[];
 const state=emptyNpcAgentState();
 state.goals=[{id:'ended',description:'本人已结束的安排',horizon:'short',status,priority:4,origin:'persisted'}];
 state.plans=[{id:'lingering',goal_id:'ended',intention:'旧的出行步骤',status:'active',...(kind==='activity'?{
  activity:{kind:'move' as const,origin_location_id:'square',destination_id:'market',source_request_id:randomUUID(),condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0}}:{
  execution:{steps:[{type:'MOVE' as const,target_id:'market',description:'前往市场',duration_minutes:null,speech:null}],cursor:0,not_before:null,condition:null,
   last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}})}];
 save.npc_agent_state={npc_lin:state};return validateSave(save);
}
it.each((['activity','execution'] as const).flatMap(kind=>(['completed','abandoned'] as const).map(status=>({kind,status}))))(
 'does not execute a lingering $kind plan whose goal is $status',({kind,status})=>{
 const before=fixture(kind,status),save=validateSave(JSON.parse(JSON.stringify(before)));
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(after.resolution_receipts?.some(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toBe(false);
 expect(after.npc_agent_state!.npc_lin.goals).toEqual(before.npc_agent_state!.npc_lin.goals);
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('abandoned');
 expect(before.npc_agent_state!.npc_lin.plans[0].status).toBe('active');
});

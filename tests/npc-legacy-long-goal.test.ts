import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';

function fixture(horizon:'short'|'long',alreadyThere:boolean){
 const save=newSave(demo);save.definition.events=[];
 recordNpcActivityPlans(save,sceneResultSchema.parse({understanding:'本人安排',narrative:'林舟准备去市场。',dialogue:'我去市场。',
  speech_events:[{speaker_id:'npc_lin',utterance:'我去市场。',provenance:'npc_response'}],effects:[],
  npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',readiness:'ready',condition:null,plan_id:null}]}),randomUUID(),'square');
 const state=save.npc_agent_state!.npc_lin;state.goals[0].horizon=horizon;
 if(horizon==='long')state.goals[0].description='持续照料市场的日常事务';
 if(alreadyThere)save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'market'};
 return validateSave(save);
}
it.each([false,true])('does not complete a long goal just because a legacy travel activity reaches its destination (already there=%s)',alreadyThere=>{
 const save=fixture('long',alreadyThere),goal=structuredClone(save.npc_agent_state!.npc_lin.goals[0]);
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(after.npc_agent_state!.npc_lin.goals[0]).toEqual(goal);
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
 const later=executeAction(validateSave(JSON.parse(JSON.stringify(after))),{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 expect(later.npc_agent_state!.npc_lin.goals[0]).toEqual(goal);
 expect(later.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(alreadyThere?0:1);
});
it.each([false,true])('still completes the short arrival objective (already there=%s)',alreadyThere=>{
 const after=executeAction(fixture('short',alreadyThere),{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('completed');
});
it.each([false,true])('keeps a short goal active while another owned abstract plan remains (already there=%s)',alreadyThere=>{
 const save=fixture('short',alreadyThere),state=save.npc_agent_state!.npc_lin;
 state.plans.push({id:'later_arrangement',goal_id:state.goals[0].id,intention:'到达之后还有自己的安排',status:'active'});
 const after=executeAction(validateSave(save),{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
 expect(after.npc_agent_state!.npc_lin.plans[1].status).toBe('active');
});

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {settleAutonomousNpcTurn,type NpcDecision} from '../src/agent/npc-agent.js';
import type {GameService} from '../src/server/service.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';

const decision:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'处理刚听到的约定',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'本人选择接受',social_response:'accept'};
async function run(elapsed:number,bank:number){
 const save=newSave(demo);save.definition.events=[];save.runtime.time={day:1,minute:600};
 for(const id of ['npc_lin','npc_qiao'])save.entities.find(e=>e.id===id)!.components.location={location_id:'market'};
 save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location={location_id:'station'};
 save.npc_agent_state={npc_lin:emptyNpcAgentState(),npc_qiao:emptyNpcAgentState()};
 save.npc_agent_state.npc_lin.social_tasks.push({id:'banked_relay',kind:'relay',status:'active',message:'请到广场参加约定的会面',organizer_id:save.player_state.entity_id,activity_location_id:'square',destination_ids:['market'],recipient_ids:['npc_qiao'],notified_ids:[],declined_ids:[],activity_at:{day:1,minute:620},next_at:{...save.runtime.time},source_request_id:randomUUID(),last_accounted_at:{...save.runtime.time},time_credit_minutes:bank,condition:null});
 validateSave(save);const before=structuredClone(save.runtime.time),candidate=executeAction(save,{type:'WAIT',parameters:{minutes:elapsed}},randomUUID()).save;
 const service={ai:{npcDecision:async()=>decision}} as unknown as GameService;
 const after=(await settleAutonomousNpcTurn(service,candidate,before,randomUUID())).save;
 return {save,candidate,after};
}
it.each([1,10])('a newly notified NPC cannot inherit the relayer old bank beyond the remaining %i-minute interval',async elapsed=>{
 const {after,candidate}=await run(elapsed,100),task=after.npc_agent_state!.npc_qiao.social_tasks[0];
 expect(after.entities.find(e=>e.id==='npc_qiao')!.components.location.location_id).toBe('market');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_qiao'&&r.semantic_action==='MOVE')??[]).toEqual([]);
 expect(task.time_credit_minutes).toBe(Math.max(0,elapsed-after.definition.ruleset.talk_minutes));
 expect(after.runtime.time).toEqual(candidate.runtime.time);expect(task.kind).toBe('attend');
});
it('retains a lawful same-interval notification and attendance when actual remaining time covers travel',async()=>{
 const {after}=await run(25,0);expect(after.entities.find(e=>e.id==='npc_qiao')!.components.location.location_id).toBe('square');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_qiao'&&r.semantic_action==='MOVE')).toHaveLength(1);
});
it('preserves zero inherited credit on disk and requires new elapsed time for the notified NPC to move once',async()=>{
 const {after}=await run(1,100),directory=await mkdtemp(join(tmpdir(),'agf-npc-notification-credit-'));
 try{
  const store=new JsonStore(directory);await store.write(after);const bytes=await readFile(join(directory,'current.json')),loaded=(await new JsonStore(directory).read())!;
  expect(loaded.npc_agent_state!.npc_qiao.social_tasks[0].time_credit_minutes).toBe(0);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const before=structuredClone(loaded.runtime.time),candidate=executeAction(loaded,{type:'WAIT',parameters:{minutes:7}},randomUUID()).save;
  const service={ai:{npcDecision:async()=>({...decision,social_response:null})}} as unknown as GameService;
  const settled=(await settleAutonomousNpcTurn(service,candidate,before,randomUUID())).save;
  expect(settled.entities.find(e=>e.id==='npc_qiao')!.components.location.location_id).toBe('square');
  expect(settled.resolution_receipts?.filter(r=>r.actor_id==='npc_qiao'&&r.semantic_action==='MOVE')).toHaveLength(1);
  expect(settled.runtime.time).toEqual(candidate.runtime.time);await store.write(settled);
  const final=(await new JsonStore(directory).read())!,unchanged=(await settleAutonomousNpcTurn(service,final,final.runtime.time,randomUUID())).save;
  expect(unchanged).toEqual(final);
 }finally{await rm(directory,{recursive:true,force:true});}
});

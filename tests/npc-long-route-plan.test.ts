import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

function fixture(direct=false,directMinutes=150){
 const world=structuredClone(demo);world.events=[];world.map!.routes=direct?
  [{from:'square',to:'station',travel_minutes:directMinutes,conditions:[]}]:
  [{from:'square',to:'market',travel_minutes:150,conditions:[]},{from:'market',to:'station',travel_minutes:150,conditions:[]}];
 const save=newSave(world),state=emptyNpcAgentState();
 state.goals=[{id:'long_motive',description:'持续照管自己的异地事务',horizon:'long',status:'active',origin:'self',priority:1}];
 state.plans=[{id:'travel_method',goal_id:'long_motive',intention:'先前往车站，再整理本人的行程安排',status:'active',execution:{
  steps:[{type:'MOVE',target_id:'station',description:'前往车站处理自己的事务',duration_minutes:null,speech:null},
   {type:'HOLD',target_id:null,description:'整理本人行程安排',duration_minutes:1,speech:null}],
  cursor:0,not_before:null,condition:null,last_accounted_at:structuredClone(save.runtime.time),time_credit_minutes:0,last_request_id:null,blocked_reason:null}}];
 save.npc_agent_state={npc_lin:state};return validateSave(save);
}
const advance=(save:ReturnType<typeof fixture>,minutes:number)=>executeAction(save,{type:'WAIT',parameters:{minutes}},randomUUID()).save;
function legacyFixture(minutes:number){
 const save=fixture(true,minutes),plan=save.npc_agent_state!.npc_lin.plans[0];delete plan.execution;
 plan.activity={kind:'move',origin_location_id:'square',destination_id:'station',source_request_id:randomUUID(),condition:null,
  last_accounted_at:structuredClone(save.runtime.time),time_credit_minutes:0};return validateSave(save);
}
it.each([150,300,1440])('completes legacy travel across a declared %s-minute edge using actual elapsed time',minutes=>{
 const initial=legacyFixture(minutes),after=advance(initial,minutes),plan=after.npc_agent_state!.npc_lin.plans[0];
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('station');
 expect(plan).toMatchObject({status:'completed',activity:{origin_location_id:'station',time_credit_minutes:0}});
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',minutes]]);
});
it('persists a legacy 270-minute paid balance and settles the remaining edge once after disk restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-legacy-long-edge-'));
 try{
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Core plans need no model');}}),store=new JsonStore(directory);
  await store.write(legacyFixture(300));const initial=await new GameService(store,ai,demo).current(),partial=advance(initial,270);
  expect(partial.npc_agent_state!.npc_lin.plans[0].activity?.time_credit_minutes).toBe(270);
  expect(partial.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');await store.write(partial);
  const bytes=await readFile(join(directory,'current.json')),loaded=await new GameService(new JsonStore(directory),ai,demo).current();
  expect(loaded).toEqual(partial);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const after=advance(loaded,30),later=advance(validateSave(JSON.parse(JSON.stringify(after))),10);
  expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
  expect(later.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',300]]);
  expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it.each(['condition','unavailable','closed'] as const)('does not convert legacy long travel prerequisite %s into arrival or free credit',mode=>{
 const initial=legacyFixture(300);
 if(mode==='condition')initial.npc_agent_state!.npc_lin.plans[0].activity!.condition='本人仍需确认出发';
 else if(mode==='unavailable')initial.entities.find(e=>e.id==='npc_lin')!.components.condition={hp:0,stamina:50,stress:20};
 else initial.definition.map!.locations.find(place=>place.id==='station')!.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',
  creation_reason:'隔离关闭目的地',source_ref:'fixture',recorded_at:initial.runtime.time};
 const after=advance(validateSave(initial),300),plan=after.npc_agent_state!.npc_lin.plans[0];
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(plan.status).toBe('active');expect(plan.activity?.time_credit_minutes).toBe(0);
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')).toHaveLength(0);
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
 if(mode==='closed')expect(plan.activity?.blocked_reason).toBe('core_rejected');
});
it('makes a real intermediate arrival instead of waiting forever for credit above its cap',()=>{
 const initial=fixture(),after=advance(initial,150),plan=after.npc_agent_state!.npc_lin.plans[0];
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
 expect(plan.status).toBe('active');expect(plan.execution?.cursor).toBe(0);expect(plan.execution?.time_credit_minutes).toBe(0);
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>({action:r.semantic_action,time:r.time_cost}))).toEqual([{action:'MOVE',time:150}]);
});
it('accumulates only actually elapsed travel time for a single edge above the old cap',()=>{
 const initial=fixture(true,300),early=advance(initial,240);
 expect(early.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(early.npc_agent_state!.npc_lin.plans[0].execution).toMatchObject({cursor:0,time_credit_minutes:240});
 expect(early.resolution_receipts?.some(r=>r.actor_id==='npc_lin')).toBe(false);
 const arrived=advance(validateSave(JSON.parse(JSON.stringify(early))),60);
 expect(arrived.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('station');
 expect(arrived.npc_agent_state!.npc_lin.plans[0].execution).toMatchObject({cursor:1,time_credit_minutes:0});
 const done=advance(arrived,1);expect(done.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(done.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',300],['HOLD',1]]);
});
it('reaches a long single-edge destination at its actual time within one WAIT',()=>{
 const initial=fixture(true,300),after=advance(initial,301),receipts=after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin');
 expect(receipts.map(r=>[r.semantic_action,r.time_cost,r.at!.minute-initial.runtime.time.minute])).toEqual([['MOVE',300,300],['HOLD',1,301]]);
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
});
it('respects a scheduled start before accruing a long-edge travel budget',()=>{
 const initial=fixture(true,300);initial.npc_agent_state!.npc_lin.plans[0].execution!.not_before={...initial.runtime.time,minute:initial.runtime.time.minute+20};
 const early=advance(initial,300);expect(early.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(early.npc_agent_state!.npc_lin.plans[0].execution?.time_credit_minutes).toBe(280);
 const after=advance(early,21);expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.at!.minute-initial.runtime.time.minute])).toEqual([['MOVE',320],['HOLD',321]]);
});
it('bounds declared edge credit by the legal 1440-minute maximum and never charges world time twice',()=>{
 const initial=fixture(true,1440),after=advance(initial,1441),receipts=after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin');
 const at=(time:typeof initial.runtime.time)=>time.day*initial.definition.ruleset.minutes_per_day+time.minute;
 expect(at(after.runtime.time)-at(initial.runtime.time)).toBe(1441);
 expect(receipts.map(r=>[r.semantic_action,r.time_cost,at(r.at!)-at(initial.runtime.time)])).toEqual([['MOVE',1440,1440],['HOLD',1,1441]]);
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
});
it('persists more than 240 paid travel minutes through actual disk/service restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-long-edge-credit-'));
 try{
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Core plans need no model');}}),store=new JsonStore(directory);
  await store.write(fixture(true,300));const initial=await new GameService(store,ai,demo).current(),partial=advance(initial,270);
  expect(partial.npc_agent_state!.npc_lin.plans[0].execution?.time_credit_minutes).toBe(270);await store.write(partial);
  const bytes=await readFile(join(directory,'current.json')),restarted=new GameService(new JsonStore(directory),ai,demo),loaded=await restarted.current();
  expect(loaded).toEqual(partial);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const done=advance(loaded,31);expect(done.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
  expect(done.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',300],['HOLD',1]]);
  expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('finishes a multi-edge journey and its dependent work without losing the long motive or double spending',()=>{
 const initial=fixture();let after=advance(initial,150);after=advance(after,150);after=advance(after,1);
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('station');
 expect(after.npc_agent_state!.npc_lin.plans[0]).toMatchObject({status:'completed',execution:{cursor:2,time_credit_minutes:0}});
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',150],['MOVE',150],['HOLD',1]]);
 const loaded=validateSave(JSON.parse(JSON.stringify(after))),later=advance(loaded,10);
 expect(later.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')).toEqual(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'));
});
it('preserves an ordinary direct route and original step cursor',()=>{
 const after=advance(fixture(true),151);
 expect(after.npc_agent_state!.npc_lin.plans[0]).toMatchObject({status:'completed',execution:{cursor:2}});
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',150],['HOLD',1]]);
});
it('preserves exact intermediate and destination timing inside one long WAIT',()=>{
 const initial=fixture(),after=advance(initial,301),receipts=after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin');
 const at=(time:typeof initial.runtime.time)=>time.day*initial.definition.ruleset.minutes_per_day+time.minute;
 expect(receipts.map(r=>[r.semantic_action,r.time_cost,at(r.at!)-at(initial.runtime.time)])).toEqual([['MOVE',150,150],['MOVE',150,300],['HOLD',1,301]]);
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
});
it('keeps partial destination ownership after actual disk/service restart and finishes once',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-long-route-'));
 try{
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Core plans need no model');}}),store=new JsonStore(directory);
  await store.write(fixture());const initial=await new GameService(store,ai,demo).current(),partial=advance(initial,150);await store.write(partial);
  const bytes=await readFile(join(directory,'current.json')),restarted=new GameService(new JsonStore(directory),ai,demo),loaded=await restarted.current();
  expect(loaded).toEqual(partial);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const after=advance(loaded,151);expect(after.npc_agent_state!.npc_lin.plans[0]).toMatchObject({status:'completed',execution:{cursor:2}});
  expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>[r.semantic_action,r.time_cost])).toEqual([['MOVE',150],['MOVE',150],['HOLD',1]]);
  expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it.each(['first_edge','remaining_edge'] as const)('retains Core refusal for a closed %s without completing the destination step',mode=>{
 let save=fixture();if(mode==='remaining_edge')save=advance(save,150);
 const closed=mode==='first_edge'?'market':'station';save.definition.map!.locations.find(place=>place.id===closed)!.lifecycle={
  status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'隔离关闭目的地',source_ref:'fixture',recorded_at:save.runtime.time};
 const after=advance(validateSave(save),150),plan=after.npc_agent_state!.npc_lin.plans[0];
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe(mode==='first_edge'?'square':'market');
 expect(plan).toMatchObject({status:'active',execution:{cursor:0,time_credit_minutes:0,blocked_reason:'core_rejected'}});
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='HOLD')).toHaveLength(0);
});

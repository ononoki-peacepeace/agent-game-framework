import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,recordSceneObservation,type NpcDecision} from '../src/agent/npc-agent.js';
import {JsonStore} from '../src/storage/json-store.js';
import type {GameService} from '../src/server/service.js';

const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
const triggers=['new-fact','resource-shortage','location-change','relationship-change','repeated-failure'] as const;
const cases=triggers.flatMap(trigger=>[false,true].flatMap(legacy=>[false,true].map(revise=>({trigger,legacy,revise}))));
const quiet=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'保留本人的持续目标',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'本人依据当前事实核对执行方法',social_response:null});
it.each(cases)('persists owner adaptation across fact updates and disk recreation: $trigger / legacy=$legacy / revise=$revise',async({trigger,legacy,revise})=>{
 const world=structuredClone(demo);world.events=[];
 world.ruleset.relationship_dimensions={familiarity:{min:0,max:10,initial:0,event_deltas:{contact:1}}};
 let save=newSave(world);for(const entity of save.entities)delete entity.components.relationships;
 save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
 const owner=save.entities.find(e=>e.id==='npc_lin')!,peer=save.entities.find(e=>e.id==='npc_qiao')!;
 owner.components.wallet={balances:{credit:23}};peer.components.wallet={balances:{credit:987654321}};
 const state=emptyNpcAgentState();
 state.goals=[{id:'long_goal',description:'持续处理本人日常事务',horizon:'long',status:'active',origin:'self',priority:6}];
 state.plans=[{id:'original',goal_id:'long_goal',intention:'本人原定方法',status:'active',...(legacy?{activity:{kind:'move' as const,
  origin_location_id:'square',destination_id:'market',source_request_id:randomUUID(),condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0}}:
  {execution:{steps:[{type:'INSPECT' as const,target_id:null,description:'确认当前环境',duration_minutes:null,speech:null},
   {type:'MOVE' as const,target_id:'market',description:'前往市场',duration_minutes:null,speech:null}],cursor:0,not_before:null,
   condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}})}];
 save.npc_agent_state={npc_lin:state};
 const goal=structuredClone(state.goals[0]),directory=await mkdtemp(join(tmpdir(),'agf-npc-adaptation-'));folders.push(directory);
 const persist=async()=>{await new JsonStore(directory).write(validateSave(save));save=(await new JsonStore(directory).read())!;};
 await persist();
 if(trigger==='new-fact')recordSceneObservation(save,randomUUID(),[{speaker_id:'npc_qiao',utterance:'我今天留在广场核对安排。'}],['npc_lin']);
 if(trigger==='resource-shortage'){
  // An injected authoritative resource update, not a fabricated action/receipt.
  save.entities.find(e=>e.id==='npc_lin')!.components.wallet={balances:{credit:0}};
 }
 if(trigger==='location-change')save=executeAction(save,{type:'MOVE',target_id:'station',parameters:{}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true).save;
 if(trigger==='relationship-change')save=executeAction(save,{type:'TALK',target_id:'npc_qiao',parameters:{topic:'重新认识对方'}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true).save;
 if(trigger==='repeated-failure'){
  save.definition.map!.routes=[];
  for(let i=0;i<3;i++){save=executeAction(save,{type:'WAIT',parameters:{minutes:12}},randomUUID()).save;await persist();}
 }
 await persist();
 const context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'核对本人刚获得的事实'}),before=structuredClone(save);
 expect(context.active_plans.map(p=>p.id)).toContain('original');expect(context.active_goals).toEqual([goal]);
 expect(JSON.stringify(context)).not.toContain('987654321');
 if(trigger==='new-fact')expect(JSON.stringify(context.memories)).toContain('今天留在广场');
 if(trigger==='resource-shortage')expect(context.own_wallet).toEqual({balances:{credit:0}});
 if(trigger==='location-change')expect(context.scene.location_id).toBe('station');
 if(trigger==='relationship-change')expect(context.relationships).toMatchObject({npc_qiao:{familiarity:1}});
 if(trigger==='repeated-failure')expect(context.plan_recovery).toMatchObject([{plan_id:'original',goal_id:'long_goal',blocked_reason:'route_unavailable'}]);
 expect(save).toEqual(before);
 let calls=0;
 const service={ai:{npcDecision:async(_profile:unknown,actual:ReturnType<typeof buildNpcAgentContext>)=>{
  calls++;expect(actual).toEqual(context);
  return {...quiet(),...(revise?{plan_updates:[{plan_id:'original',status:'abandoned'}],plan_proposals:[{id:'revised',goal_id:'long_goal',
   intention:'根据本人已知事实调整方法',steps:[{type:'HOLD',target_id:null,description:'本人在当前地点继续准备',duration_minutes:2,speech:null}]}]}:{})};
 }}} as unknown as GameService;
 const decision=await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'核对本人刚获得的事实'});
 expect(save).toEqual(before);applyNpcDecision(save,'npc_lin','owner-first-review',decision);await persist();
 const receiptIds=save.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').map(r=>r.request_id)??[];
 for(let i=0;i<2;i++){
  save=executeAction(save,{type:'WAIT',parameters:{minutes:20}},randomUUID()).save;await persist();
  expect(save.npc_agent_state!.npc_lin.goals).toEqual([goal]);
 }
 expect(calls).toBe(1);
 // Legacy travel belongs to its recorded origin; an independent actual departure
 // invalidates that method, while preserving the long goal (not fake completion).
 const staleOrigin=legacy&&trigger==='location-change';
 expect(save.npc_agent_state!.npc_lin.plans.find(p=>p.id==='original')!.status).toBe(revise||staleOrigin?'abandoned':trigger==='repeated-failure'?'active':'completed');
 expect(save.npc_agent_state!.npc_lin.plans.some(p=>p.id==='revised')).toBe(revise);
 const receipts=save.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')??[];
 expect(new Set(receipts.map(r=>r.request_id)).size).toBe(receipts.length);
 expect(receipts.filter(r=>receiptIds.includes(r.request_id)).map(r=>r.request_id)).toEqual(receiptIds);
 expect(receipts.filter(r=>r.semantic_action==='HOLD')).toHaveLength(revise?1:0);
 if(revise)expect(save.npc_agent_state!.npc_lin.plans.find(p=>p.id==='revised')!.status).toBe('completed');
 // A later fact is considered again after the prior method actually settled.
 recordSceneObservation(save,randomUUID(),[{speaker_id:'npc_lin',utterance:'我确认自己的持续事务仍需处理。'}],['npc_lin']);await persist();
 const again={ai:{npcDecision:async()=>{calls++;return quiet();}}} as unknown as GameService;
 applyNpcDecision(save,'npc_lin','owner-second-review',await decideNpc(again,save,'npc_lin',{kind:'world_event',description:'本人再次核对后续事实'}));
 await persist();
 expect(calls).toBe(2);expect(save.npc_agent_state!.npc_lin.goals).toEqual([goal]);
 expect(save.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')??[]).toEqual(receipts);
 expect(save.npc_agent_state!.npc_lin.last_decisions.slice(-2).map(d=>d.event_ref)).toEqual(['owner-first-review','owner-second-review']);
 expect(save.entities.find(e=>e.id==='npc_lin')!.components.wallet).toEqual(before.entities.find(e=>e.id==='npc_lin')!.components.wallet);
});

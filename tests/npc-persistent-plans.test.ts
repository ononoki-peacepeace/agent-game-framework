import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';
import {applyNpcDecision,buildNpcAgentContext,decideNpc,settleAutonomousNpcTurn,type NpcDecision} from '../src/agent/npc-agent.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import type {GameService} from '../src/server/service.js';
const quiet=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'保持自己的安排',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'留在此处',social_response:null});
const move=(target_id:string)=>({type:'MOVE' as const,target_id,description:'前往已知地点',duration_minutes:null,speech:null});
const hold=(minutes:number)=>({type:'HOLD' as const,target_id:null,description:'进行已有岗位的准备工作',duration_minutes:minutes,speech:null});
function addPlan(save:ReturnType<typeof newSave>,steps=[move('market'),hold(8)],condition:string|null=null,not_before:{day:number;minute:number}|null=null,npc='npc_lin'){
 const scene=sceneResultSchema.parse({understanding:'本人日常安排',narrative:'林舟说起自己的安排。',dialogue:'我去市场处理日常准备，之后在岗位工作一阵。',
 speech_events:[{speaker_id:npc,utterance:'我去市场处理日常准备，之后在岗位工作一阵。',provenance:'npc_response'}],effects:[],
 npc_activity_intents:[{npc_id:npc,speech_index:0,destination_id:steps.filter(s=>s.type==='MOVE').at(-1)?.target_id??'square',
 readiness:condition?'conditional':'ready',condition,plan_id:null,steps,not_before}]});
 recordNpcActivityPlans(save,scene,randomUUID(),'square');return scene;
}
describe('continuous authoritative NPC plans',()=>{
 it.each([1,30,40])('advances ordinary WAIT %i with causal Core work and no invented products',minutes=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save);
 const before=structuredClone(save.runtime.time),items=save.entities.filter(e=>e.components.item);
 const after=executeAction(save,{type:'WAIT',parameters:{minutes}},randomUUID()).save;
 expect(after.runtime.time.minute-before.minute).toBe(minutes);
 expect(after.entities.filter(e=>e.components.item)).toEqual(items);
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe(minutes>=6?'market':'square');
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe(minutes>=14?'completed':'active');
 if(minutes>=14){const receipts=after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin');expect(receipts.map(r=>r.semantic_action)).toEqual(['MOVE','HOLD']);expect(receipts.map(r=>r.time_cost)).toEqual([6,8]);
 expect(receipts.every(r=>r.commit_status==='committed')).toBe(true);expect(after.npc_agent_state!.npc_lin.memories.some(m=>m.summary.includes('准备工作'))).toBe(true);}
 validateSave(JSON.parse(JSON.stringify(after)));
 });
 it('has the same scheduled result for one long WAIT and several shorter WAITs',()=>{
 const initial=newSave(demo);initial.definition.events=[];addPlan(initial);
 const whole=executeAction(initial,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 let split=initial;for(const minutes of [1,4,5,10,20])split=executeAction(split,{type:'WAIT',parameters:{minutes}},randomUUID()).save;
 expect(split.runtime.time).toEqual(whole.runtime.time);expect(split.entities.find(e=>e.id==='npc_lin')!.components.location).toEqual(whole.entities.find(e=>e.id==='npc_lin')!.components.location);
 expect(split.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(split.resolution_receipts!.filter(r=>r.actor_id==='npc_lin').reduce((sum,r)=>sum+r.time_cost,0)).toBe(14);
 });
 it('does not spend time before a real scheduled start or while a prerequisite is unresolved',()=>{
 const save=newSave(demo);save.definition.events=[];const start={...save.runtime.time,minute:save.runtime.time.minute+20};addPlan(save,[move('market'),hold(8)],null,start);
 const early=executeAction(save,{type:'WAIT',parameters:{minutes:25}},randomUUID()).save;
 expect(early.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 const done=executeAction(early,{type:'WAIT',parameters:{minutes:10}},randomUUID()).save;
 expect(done.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 const conditional=newSave(demo);conditional.definition.events=[];addPlan(conditional,[move('market')],'等实际工作完成');
 const blocked=executeAction(conditional,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 expect(blocked.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(blocked.npc_agent_state!.npc_lin.plans[0].execution).toMatchObject({time_credit_minutes:0,blocked_reason:'condition_pending'});
 });
 it('does not use an unreachable or closed route, and records the blocked reason',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save);save.definition.map!.routes=[];
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].execution!.blocked_reason).toBe('route_unavailable');
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 });
  it('returns a blocked persistent step and receipt cursor to the next NPC decision for safe replanning',async()=>{
  const save=newSave(demo);save.definition.events=[];addPlan(save,[move('market')]);save.definition.map!.routes=[];
  const blocked=executeAction(save,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
  const old=blocked.npc_agent_state!.npc_lin.plans[0],goal=blocked.npc_agent_state!.npc_lin.goals[0];
  let supplied:ReturnType<typeof buildNpcAgentContext>|null=null;
  const corrected={...quiet(),plan_updates:[{plan_id:old.id,status:'abandoned' as const}],
    plan_proposals:[{id:'replacement_at_home',goal_id:goal.id,intention:'在原地继续可执行的准备',steps:[hold(8)]}]};
  const service={ai:{npcDecision:async(_profile:unknown,context:ReturnType<typeof buildNpcAgentContext>)=>{
    supplied=context;return corrected;}}} as unknown as GameService;
  const decision=await decideNpc(service,blocked,'npc_lin',{kind:'world_event',description:'原计划受阻'});
  expect(supplied!.plan_recovery).toMatchObject([{plan_id:old.id,goal_id:goal.id,cursor:0,
    last_receipt_id:null,blocked_reason:'route_unavailable',
    diagnostic:expect.stringContaining('没有符合权威地图条件')}]);
  applyNpcDecision(blocked,'npc_lin','replan-after-route-failure',decision);
  expect(blocked.npc_agent_state!.npc_lin.plans.find(plan=>plan.id===old.id)?.status).toBe('abandoned');
  const after=executeAction(blocked,{type:'WAIT',parameters:{minutes:8}},randomUUID()).save;
  expect(after.npc_agent_state!.npc_lin.plans.find(plan=>plan.id==='replacement_at_home')?.status).toBe('completed');
  expect(after.resolution_receipts!.filter(receipt=>receipt.actor_id==='npc_lin').map(receipt=>receipt.semantic_action)).toEqual(['HOLD']);
  });
 it('lets a real NPC arrival affect an event during the WAIT rather than after its deadline',()=>{
 const save=newSave(demo),at=save.runtime.time;save.definition.events=[{id:'npc_arrives',hook:'on_location_enter',location_id:'market',actor_scope:'any',probability:1,once:true,
 set_flag:'npc_arrived',public_text:'',reveal_location_id:null,interrupt_automation:false}];addPlan(save,[move('market')]);
 save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:2,minimum_gap_minutes:60,replenishment:false};
 save.definition.background_incidents=[{id:'causal_shift',title:'普通交接',summary:'既有安排',source:'WORLD_PACKAGE',created_at:at,
 earliest_activation:at,latest_activation:{...at,minute:at.minute+10},activation_flags:['npc_arrived'],activation_chance:1,
 participants:['npc_lin'],locations:['market'],stages:[{id:'done',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',
 effects:[{kind:'set_flag',flag:'shift_done'}],exposures:[{id:'local_record',channel:'same_location',location_id:'market',npc_id:null,text:'一份普通交接记录留在现场。',interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
 delete save.background_state;const after=executeAction(save,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 expect(after.gm_state.flags.shift_done).toBe(true);expect(after.background_state!.incidents[0].activated_at!.minute).toBe(at.minute+6);
 expect(after.background_state!.exposure_log).toHaveLength(0);expect(JSON.stringify(publicView(after))).not.toContain('普通交接记录');
 });
 it('does not backdate an NPC arrival to satisfy an already expired event window',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save,[move('market')],null,{...save.runtime.time,minute:save.runtime.time.minute+20});
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save;
 expect(after.resolution_receipts!.find(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')!.at!.minute).toBe(save.runtime.time.minute+26);
 });
 it('bounds execution across a long WAIT and fairly serves deferred residents later',()=>{
 const save=newSave(demo);save.definition.events=[];const model=save.entities.find(e=>e.id==='npc_lin')!;
 for(let i=0;i<5;i++){const id='worker_'+i,npc=structuredClone(model);npc.id=id;delete npc.components.relationships;save.entities.push(npc);addPlan(save,[hold(1)],null,null,id);}
 let after=executeAction(save,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 expect(after.resolution_receipts!.filter(r=>r.actor_id.startsWith('worker_'))).toHaveLength(3);
 after=executeAction(after,{type:'WAIT',parameters:{minutes:1}},randomUUID()).save;
 expect(new Set(after.resolution_receipts!.filter(r=>r.actor_id.startsWith('worker_')).map(r=>r.actor_id)).size).toBe(5);
 });
 it('invalidates executable steps on a real goal cancellation, while a long motive survives one completed plan',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save);
 const goal=save.npc_agent_state!.npc_lin.goals[0];goal.horizon='long';
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');
 const cancelled=newSave(demo);addPlan(cancelled);applyNpcDecision(cancelled,'npc_lin','cancelled',{...quiet(),goal_updates:[{goal_id:cancelled.npc_agent_state!.npc_lin.goals[0].id,status:'abandoned'}]});
 expect(executeAction(cancelled,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 });
 it('links a matching immediate first step but still rejects a conflicting target',async()=>{
 const save=newSave(demo);const context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'自己安排'});
 expect(context.scene).not.toHaveProperty('remote_positions');
 const decision={...quiet(),goal_proposals:[{id:'g',description:'自己的工作',horizon:'short' as const,priority:4}],plan_proposals:[{id:'p',goal_id:'g',intention:'工作',steps:[move('market')]}],
 kind:'proposed_action' as const,proposed_action:{type:'MOVE',target_id:'market',reason:'前往市场'}};
 const service={ai:{npcDecision:async()=>decision}} as unknown as GameService;
 await expect(decideNpc(service,save,'npc_lin',{kind:'world_event',description:'自己安排'})).resolves.toEqual(decision);
 decision.plan_proposals[0].steps=[move('station')];
 await expect(decideNpc(service,save,'npc_lin',{kind:'world_event',description:'自己安排'})).rejects.toThrow('NPC_IMMEDIATE_PLAN_CONFLICT: target_id');
 });
 it('preserves a validated autonomous work plan for execution in later real time, not in the past',async()=>{
 const save=newSave(demo),before=structuredClone(save.runtime.time),candidate=executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
 const service={ai:{npcDecision:async()=>({...quiet(),goal_proposals:[{id:'g',description:'自己的工作',horizon:'short',priority:4}],
 plan_proposals:[{id:'p',goal_id:'g',intention:'工作',steps:[move('market'),hold(8)]}]})}} as unknown as GameService;
 const staged=(await settleAutonomousNpcTurn(service,candidate,before,randomUUID())).save;
 expect(staged.npc_agent_state!.npc_lin.plans[0].execution!.cursor).toBe(0);
 expect(staged.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 const after=executeAction(staged,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 });
});

it('does not freeze independent work behind an unresolved conditional invitation',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save,[hold(8)]);
 save.npc_agent_state!.npc_lin.social_tasks.push({id:'conditional_invitation',kind:'attend',status:'blocked',condition:'先完成自己的工作',
 message:'之后再决定是否赴约',organizer_id:'player',activity_location_id:'station',destination_ids:[],recipient_ids:[],notified_ids:[],declined_ids:[],
 activity_at:{...save.runtime.time,minute:save.runtime.time.minute+60},next_at:save.runtime.time,source_request_id:randomUUID(),last_accounted_at:save.runtime.time,time_credit_minutes:0});
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');expect(after.npc_agent_state!.npc_lin.social_tasks[0].status).toBe('blocked');
});
it('does not use player foreground state as an NPC work prohibition or charge the world twice',()=>{
 const save=newSave(demo);save.foreground={blocker:'task',reason:'玩家需要选择后续安排'};
 const result=executeAction(save,{type:'HOLD',parameters:{minutes:8,activity:'自己的日常准备'}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true);
 expect(result.action.time_cost).toBe(8);expect(result.save.runtime.time).toEqual(save.runtime.time);expect(result.save.foreground).toEqual(save.foreground);
 expect(result.save.resolution_receipts!.at(-1)).toMatchObject({actor_id:'npc_lin',semantic_action:'HOLD',time_cost:8});
});
it('gives each NPC only its own authored motivation, without the arc secret or other motives',()=>{
 const save=newSave(demo);save.definition.world_macro_arcs=[{id:'private_arc',title:'PRIVATE_TITLE',summary:'PRIVATE_SUMMARY',underlying_pressure:'PRIVATE_PRESSURE',
 actor_motivations:[{actor_id:'npc_lin',motivation:'MY_MOTIVE'},{actor_id:'npc_qiao',motivation:'OTHER_MOTIVE'}],resource_constraint:'PRIVATE_RESOURCE',historical_cause:'PRIVATE_CAUSE',social_relationship:'PRIVATE_RELATION',trigger:'PRIVATE_TRIGGER',unintended_consequence:'PRIVATE_CONSEQUENCE',truth_refs:[],incident_refs:[],horizon:'long'}];
 const context=buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'日常选择'});
 expect(context.own_story_motivations).toEqual(['MY_MOTIVE']);expect(JSON.stringify(context)).not.toContain('PRIVATE_');expect(JSON.stringify(context)).not.toContain('OTHER_MOTIVE');
});
it('backs off a Core-rejected route for this turn and cannot bank blocked travel time',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save,[move('market')]);
 save.definition.map!.locations.find(p=>p.id==='market')!.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'隔离封闭测试',source_ref:'fixture',recorded_at:save.runtime.time};
 const requestId=randomUUID(),after=executeAction(save,{type:'WAIT',parameters:{minutes:240}},requestId).save;
 expect(after.npc_agent_state!.npc_lin.plans[0].last_failed_request_id).toMatch(/^npc-time:/);
 expect(after.npc_agent_state!.npc_lin.plans[0].execution).toMatchObject({cursor:0,time_credit_minutes:0,blocked_reason:'core_rejected'});
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin')).toHaveLength(0);
 after.definition.map!.locations.find(p=>p.id==='market')!.lifecycle!.status='active';
 const early=executeAction(after,{type:'WAIT',parameters:{minutes:1}},randomUUID()).save;
 expect(early.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 const done=executeAction(early,{type:'WAIT',parameters:{minutes:5}},randomUUID()).save;
 expect(done.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
});

it('can abandon a blocked plan without abandoning the underlying long-term goal',async()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save);const state=save.npc_agent_state!.npc_lin;
 state.goals[0].horizon='long';const prior=state.plans[0],goalId=state.goals[0].id;
 const response={...quiet(),plan_updates:[{plan_id:prior.id,status:'abandoned' as const}],plan_proposals:[{id:'new_approach',goal_id:goalId,intention:'改用可执行的原地准备',steps:[hold(8)]}]};
 const service={ai:{npcDecision:async()=>response}} as unknown as GameService;
 const validated=await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'原计划受阻后重新决定'});
 applyNpcDecision(save,'npc_lin','replan',validated);
 expect(save.npc_agent_state!.npc_lin.plans.find(p=>p.id===prior.id)!.status).toBe('abandoned');
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('active');expect(after.npc_agent_state!.npc_lin.plans.at(-1)!.status).toBe('completed');
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 await expect(decideNpc({ai:{npcDecision:async()=>({...quiet(),plan_proposals:[{id:prior.id,goal_id:goalId,intention:'重置旧计划',steps:[move('market')]}]})}} as unknown as GameService,
 after,'npc_lin',{kind:'world_event',description:'重复旧计划'})).rejects.toThrow('reuses an existing ID');
});
it('keeps the player turn valid when NPC objective admission exceeds its bounded capacity',async()=>{
 const save=newSave(demo);save.definition.events=[];save.npc_agent_state??={};save.npc_agent_state.npc_lin=emptyNpcAgentState();
 save.npc_agent_state.npc_lin.goals=Array.from({length:24},(_,i)=>({id:'existing_'+i,description:'持续的个人目标',horizon:'long',status:'active',origin:'fixture',priority:4}));
 const before=structuredClone(save.runtime.time),candidate=executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
 const service={ai:{npcDecision:async()=>({...quiet(),kind:'proposed_action',proposed_action:{type:'MOVE',target_id:'market',reason:'处理新的任务'},
 goal_proposals:[{id:'overflow',description:'超过目标容量的新任务',horizon:'short',priority:4}]})}} as unknown as GameService;
 const result=await settleAutonomousNpcTurn(service,candidate,before,randomUUID());
 expect(result.save.runtime.time).toEqual(candidate.runtime.time);expect(result.save.npc_agent_state!.npc_lin.goals).toHaveLength(24);
 expect(result.save.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(result.save.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(0);
});

it('does not fire a later player appointment early when an NPC creates an earlier time boundary',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save);
 const before=structuredClone(save.runtime.time),at=before.day*save.definition.ruleset.minutes_per_day+before.minute+20;
 save.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'player_appointment',label:'玩家自己的约定',at,window:'exact',status:'accepted',source:'confirmed fixture',resolved:false}]};
 const after=executeAction(save,{type:'WAIT',parameters:{minutes:40}},randomUUID()).save;
 expect(after.runtime.time.minute-before.minute).toBe(20);expect(after.foreground?.blocker).toBe('task');
 expect(after.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin').map(r=>r.time_cost)).toEqual([6,8]);
});

it('does not permanently freeze plans when a later routine step reuses its internal action name',()=>{
 const save=newSave(demo);save.definition.events=[];addPlan(save,[move('market')]);
 const place=save.definition.map!.locations.find(p=>p.id==='market')!;place.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'隔离封闭测试',source_ref:'fixture',recorded_at:save.runtime.time};
 const first=executeAction(save,{type:'WAIT',parameters:{minutes:10}},'local-routine','player',undefined,undefined,false).save;
 first.definition.map!.locations.find(p=>p.id==='market')!.lifecycle!.status='active';
 const second=executeAction(first,{type:'WAIT',parameters:{minutes:6}},'local-routine','player',undefined,undefined,false).save;
 expect(second.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
});

import {resolveActionEntities} from '../src/agent/entities.js';
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {backgroundCausalSources,applyBackgroundProposal,proposeValidatedBackground} from '../src/background/generation.js';
import {compileGoalContract,sameGoalShape} from '../src/agent/goal-contract.js';
import {validatePlan} from '../src/agent/planner.js';
import {goalSpecSchema} from '../src/system/goals.js';
import type {SavePackage} from '../src/core/schema.js';

const cause={underlying_pressure:'既有值班需要交接',actor_motivation:'完成自己的工作',resource_constraint:'工作时间有限',
 historical_cause:'延续已经登记的岗位',social_relationship:'两位同事协作',trigger:'本轮工作完成',unintended_consequence:'交接记录留在现场'};
function world(){
 const save=newSave(demo);save.definition.events=[];save.runtime.time={day:1,minute:540};
 save.definition.map!.routes.push({from:'station',to:'market',travel_minutes:4,conditions:[]},{from:'market',to:'station',travel_minutes:4,conditions:[]});
 save.definition.background_incidents=[];save.definition.world_macro_arcs=[];delete save.background_state;
 save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:180,replenishment:true};
 save.npc_agent_state={};
 for(const npc of save.entities.filter(e=>e.components.character&&e.id!==save.player_state.entity_id)){
  npc.components.location={location_id:'station'};const state=emptyNpcAgentState();
  state.goals=[{id:'work',description:'在市场完成岗位交接，与同事保持联系',horizon:'long',status:'active',origin:'world_creation',priority:5}];
  save.npc_agent_state[npc.id]=state;
 }
 save.npc_daily_last_at=structuredClone(save.runtime.time);save.npc_autonomy_last_at=structuredClone(save.runtime.time);
 return validateSave(save);
}
function proposal(save:SavePackage,id='shift'){
 const source=backgroundCausalSources(save).find(s=>s.ref.startsWith('receipt:'))??backgroundCausalSources(save)[0];
 return {decision:'propose' as const,reason:'延续已经登记的工作与实际行动',incident:{id,title:'岗位交接',summary:'既有岗位的工作记录',source:'WORLD_RUNTIME' as const,
  causal_parent_id:null,causal_source_refs:[source.ref],created_at:save.runtime.time,earliest_activation:save.runtime.time,latest_activation:null,
  activation_flags:[],activation_chance:1,participants:['npc_lin','npc_qiao'],locations:['market'],causal_basis:cause,
  stages:[{id:'start',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',
    effects:[{kind:'set_flag' as const,flag:`${id}_started`}],exposures:[],terminal:'none' as const},
   {id:'finish',earliest_after_minutes:60,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',
    effects:[{kind:'set_flag' as const,flag:`${id}_finished`}],exposures:[{id:'record',channel:'public_notice' as const,
     location_id:'market',npc_id:null,text:'岗位交接记录已更新。',interrupt:false,open_loop_label:null}],terminal:'resolved' as const}]}};
}
const wait=(s:SavePackage,minutes:number)=>executeAction(s,{type:'WAIT',parameters:{minutes}},randomUUID(),'player',()=>.2).save;

describe('cross-path authority and bounded sustained-world contracts (synthetic independent world)',()=>{
 it('binds a stage recipient before prose, without turning a discussed person into an addressee',()=>{
  const view=publicView(world()),names=['npc_lin','npc_qiao'].map(id=>String(view.entities.find(e=>e.id===id)!.components.identity.name));
  const plan=validatePlan({goals:[{goal_id:'speech',type:'WORLD_SPEECH',operation_hint:'talk',normalized_goal:`向${names[0]}询问${names[1]}`,
   referent:names[0],target_entities:[],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]});
  const compiled=compileGoalContract(view,plan,{kind:'manual',text:`向${names[0]}询问${names[1]}`});
  expect(compiled.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
  expect(compiled.goals[0].contract?.availability).toBe('ready');
  const semantic=goalSpecSchema.parse({objective:'向两人告知',targets:names.map((reference,i)=>({kind:'entity',role:'audience',reference,entity_id:['npc_lin','npc_qiao'][i]})),
   persistence:'none',world_mutation:true,external_artifact:false,multi_step:false});
  const group=compileGoalContract(view,plan,{kind:'manual',text:'向两人告知',semanticGoal:semantic});
  expect(group.goals[0].contract?.completion).toMatchObject({audience_ids:['npc_lin','npc_qiao']});
  expect(sameGoalShape(group)).not.toEqual(sameGoalShape(compiled));
  for(const order of [[0,1],[1,0]]){
   const spec=structuredClone(semantic);spec.targets=order.map(i=>semantic.targets[i]);
   const variant=compileGoalContract(view,plan,{kind:'manual',text:'向两名听众告知',semanticGoal:spec});
   expect(variant.goals[0].contract?.completion).toMatchObject({audience_ids:order.map(i=>['npc_lin','npc_qiao'][i])});
  }
  expect(resolveActionEntities(view,`向${names[0]}提及${names[1]}`,['npc_lin']).matches.map(e=>e.id)).toEqual(['npc_lin']);
  expect(resolveActionEntities(view,names[0],['missing_authorized_target']).matches).toEqual([]);
 });
 it('empty enabled pools cool down, request candidates, accept quiet and request again without forcing events',()=>{
  let save=wait(world(),60);expect(save.background_state?.needs_generation).toBe(false);
  save=wait(save,120);expect(save.background_state?.needs_generation).toBe(true);
  save=applyBackgroundProposal(save,{decision:'quiet',incident:null,reason:'没有合适条件'});
  expect(wait(save,60).background_state?.needs_generation).toBe(false);
  expect(wait(save,180).background_state?.needs_generation).toBe(true);
  expect(save.definition.background_incidents).toHaveLength(0);
 });
 it('a distant dormant seed does not starve independent daily candidates, while imminent seeds reserve capacity',()=>{
  let save=world();const seed=proposal(save,'later').incident;seed.source='WORLD_PACKAGE' as never;
  seed.earliest_activation={day:5,minute:0};save.definition.background_incidents=[seed];
  save=wait(save,180);expect(save.background_state?.needs_generation).toBe(true);
  const fresh=world(),near=proposal(fresh,'soon').incident;near.source='WORLD_PACKAGE' as never;
  near.earliest_activation={day:1,minute:780};fresh.definition.background_incidents=[near];
  expect(wait(fresh,180).background_state?.needs_generation).toBe(false);
 });
 it('feeds exact schema paths to the existing repair loop, fully revalidates, and never retries program/network errors',async()=>{
  let save=world();save=wait(save,180);let attempts=0;
  const fixed=await proposeValidatedBackground(save,async feedback=>{
   attempts++;if(!feedback)return {decision:'propose',incident:{},reason:'bad schema'} as never;
   expect(feedback.reason).toContain('incident.id');expect(feedback.previous.incident).toEqual({});return proposal(save);
  });
  expect(attempts).toBe(2);expect(validateSave(JSON.parse(JSON.stringify(fixed))).background_state?.incidents).toHaveLength(1);
  let calls=0;await expect(proposeValidatedBackground(save,async()=>{calls++;throw new TypeError('transport unavailable');})).rejects.toThrow('transport unavailable');
  expect(calls).toBe(1);
  const invalid=proposal(save);invalid.incident.causal_source_refs=['npc_goal:nobody:invented'];
  expect(()=>applyBackgroundProposal(save,invalid)).toThrow('因果引用');expect(save.definition.background_incidents).toHaveLength(0);
 });
 it('allows a macro arc to retain more than ten completed successors within the existing 100-incident budget',()=>{
  let save=wait(world(),180);const first=proposal(save,'past').incident;
  save.definition.background_incidents=Array.from({length:10},(_,i)=>({...structuredClone(first),id:`past_${i}`}));
  save.background_state!.incidents=save.definition.background_incidents.map(i=>({id:i.id,status:'resolved',stage_index:1,activated_at:save.runtime.time,ended_at:save.runtime.time,missed:true,player_exposed:false,activation_roll:null,delivered_exposure_ids:[]}));
  const {actor_motivation,...arcCause}=cause;
  const arc={id:'work_arc',title:'长期岗位',summary:'工作持续',...arcCause,actor_motivations:[{actor_id:'npc_lin',motivation:'工作'}],
   truth_refs:[],incident_refs:save.definition.background_incidents!.map(i=>i.id),horizon:'open_ended' as const};
  save.definition.world_macro_arcs=[arc];save.background_state!.macro_arcs=[{id:arc.id,status:'resolved',last_event_ref:null}];
  save.background_state!.needs_generation=true;
  const successor=proposal(save,'successor');successor.incident.causal_source_refs=[];
  save=applyBackgroundProposal(save,successor);
  expect(save.definition.world_macro_arcs![0].incident_refs).toHaveLength(11);
  expect(save.background_state!.macro_arcs[0].status).toBe('developing');expect(()=>validateSave(save)).not.toThrow();
 });
 it('background movement waits for route time and settles via Core once without moving the world clock twice',()=>{
  let save=wait(world(),180);const p=proposal(save,'travel');
  p.incident.stages=[{id:'journey',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',
   effects:[{kind:'move_npc',npc_id:'npc_lin',location_id:'market'}],exposures:[],terminal:'resolved'}] as never;
  save=applyBackgroundProposal(save,p);
  save=wait(save,1);expect(save.background_state?.incidents[0].stage_index).toBe(-1);
  expect(save.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('station');
  expect(save.resolution_receipts?.some(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toBe(false);
  const before=save.runtime.time.minute;save=wait(save,4);
  expect(save.runtime.time.minute-before).toBe(4);expect(save.background_state?.incidents[0].status).toBe('resolved');
  const receipt=save.resolution_receipts?.find(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE');
  expect(receipt).toMatchObject({time_cost:4,commit_status:'committed',movement_route:{origin_id:'station',destination_id:'market'}});
  const count=save.resolution_receipts?.filter(r=>r.actor_id==='npc_lin').length;save=wait(save,5);
  expect(save.resolution_receipts?.filter(r=>r.actor_id==='npc_lin')).toHaveLength(count!);
 });
 it('a route-blocked event stage does not partially apply effects or fail a valid player rest',()=>{
  let save=wait(world(),180);const p=proposal(save,'blocked');
  save.definition.map!.routes=save.definition.map!.routes.filter(route=>route.from!=='station');
  p.incident.stages=[{id:'journey',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',
   effects:[{kind:'set_flag',flag:'must_not_partially_apply'},{kind:'move_npc',npc_id:'npc_lin',location_id:'market'}],exposures:[],terminal:'resolved'}] as never;
  save=applyBackgroundProposal(save,p);save=wait(save,60);
  expect(save.gm_state.flags.must_not_partially_apply).toBeUndefined();expect(save.background_state?.incidents[0].stage_index).toBe(-1);
  expect(save.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('station');
 });
 it('runs 48 normal hourly rest turns: offscreen NPC interaction, successor events, aftermath, reload, Undo and idempotency',async()=>{
  const started=performance.now();const store=new MemoryStore();let current=world(),decisions=0,generated=0,seenPublicMemory=false;
  const ai=new AIRuntime({name:'bounded-world-fixture',generate:async request=>{
   const fields=(request.schema as any).properties??{};
   if(fields.decision&&fields.incident){generated++;return {data:proposal(current,`shift_${generated}`)};}
   if(request.role==='npc_decision'){
    decisions++;seenPublicMemory||=request.prompt.includes('岗位交接记录已更新');
    const npcId=request.prompt.match(/"npc_id":"([^"]+)"/)?.[1]??'npc_lin';
    const npc=current.entities.find(e=>e.id===npcId)!;
    const atMarket=npc.components.location?.location_id==='market';
    const other=current.entities.find(e=>e.id!==npcId&&e.id!==current.player_state.entity_id&&e.components.character&&e.components.location?.location_id==='market');
    return {data:{kind:'proposed_action',speech:atMarket&&other?'今天岗位交接已经记下了。':null,vote_target:null,
     intent:'继续自己的工作',proposed_action:!atMarket?{type:'MOVE',target_id:'market',reason:'前往自己的岗位'}:
       other?{type:'TALK',target_id:other.id,reason:'与同事交流'}:{type:'HOLD',target_id:null,reason:'照看岗位',duration_minutes:10},
     evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'根据当前位置履行目标',social_response:null}};
   }
   if(request.role==='narrator')return {data:{narrative:'你按原计划在原地休息。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],item_claims:[],stable_locations:[],mechanical_claims:[]}};
   throw Error(`unexpected world simulation call: ${request.role}`);
  }});
  await store.write(current);const service=new GameService(store,ai,current.definition),start=structuredClone(current.runtime.time);
  for(let hour=0;hour<48;hour++){
   current=await service.current();const before=structuredClone(current),body={game_id:current.game_id,expected_revision:current.state_revision,
    request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:60}}};
   const result=await service.turn(body);const after=await service.current(),calls=ai.metrics.requests;
   expect(after.runtime.time.day*1440+after.runtime.time.minute-(before.runtime.time.day*1440+before.runtime.time.minute)).toBe(60);
   expect(JSON.stringify(result.last_turn)).not.toContain('岗位交接记录');expect(after.background_state?.exposure_log).toHaveLength(0);
   await service.turn(body);expect(ai.metrics.requests).toBe(calls);expect((await service.current()).state_revision).toBe(after.state_revision);
  }
  current=await service.current();expect(current.runtime.time.day*1440+current.runtime.time.minute-start.day*1440-start.minute).toBe(48*60);
  expect(generated).toBeGreaterThan(2);expect(generated).toBeLessThanOrEqual(16);expect(decisions).toBeLessThanOrEqual(32);
  const receipts=current.resolution_receipts??[];
  expect(receipts.some(r=>r.actor_id!=='player'&&r.semantic_action==='MOVE')).toBe(true);
  const talk=receipts.find(r=>r.actor_id!=='player'&&r.semantic_action==='TALK');expect(talk?.commit_status).toBe('committed');
  expect(current.definition.background_incidents?.some(i=>i.causal_source_refs?.some(ref=>ref.startsWith('receipt:')))).toBe(true);
  expect(current.background_state?.incidents.some(i=>i.status==='resolved')).toBe(true);expect(seenPublicMemory).toBe(true);
  const listener=Object.values(current.npc_agent_state??{}).some(state=>state.memories.some(m=>m.kind==='heard'));
  expect(listener).toBe(true);expect(current.background_state?.exposure_log).toHaveLength(0);
  await store.write(validateSave(JSON.parse(JSON.stringify(current))));const reloaded=new GameService(store,ai,current.definition);
  expect((await reloaded.current()).npc_agent_state).toEqual(current.npc_agent_state);
  const old=await reloaded.current();await reloaded.turn({game_id:old.game_id,expected_revision:old.state_revision,request_id:randomUUID(),action:{type:'MOVE',target_id:'market'}});
  const arrived=await reloaded.current();expect(arrived.background_state?.exposure_log.length).toBeGreaterThan(0);
  await reloaded.undo({game_id:arrived.game_id,expected_revision:arrived.state_revision,request_id:randomUUID()});
  const undone=await reloaded.current();expect(undone.runtime.time).toEqual(old.runtime.time);expect(undone.npc_agent_state).toEqual(old.npc_agent_state);
  expect(undone.background_state).toEqual(old.background_state);
  const activities=receipts.filter(r=>r.actor_id!==current.player_state.entity_id&&r.commit_status==='committed');
  process.stdout.write('ISOLATED_WORLD_METRICS '+JSON.stringify({hours:48,player_turns:48,npc_decision_calls:decisions,candidates:generated,
    npc_actions:activities.length,npc_actions_per_hour:activities.length/48,actions:activities.reduce((out,r)=>{out[r.semantic_action]=(out[r.semantic_action]??0)+1;return out;},{} as Record<string,number>),
    resolved:current.background_state?.incidents.filter(i=>i.status==='resolved').length,offscreen_exposures:current.background_state?.exposure_log.length,
    later_exposures:arrived.background_state?.exposure_log.length,total_provider_substitute_calls:ai.metrics.requests,real_api_calls:0,duration_ms:Math.round(performance.now()-started)})+'\n');
 },90000);
});

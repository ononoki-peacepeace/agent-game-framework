import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {settleAutonomousNpcTurn,type NpcDecision} from '../src/agent/npc-agent.js';
import type {GameService} from '../src/server/service.js';
import {GameService as Service} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {commitTruth} from '../src/narrative/truth.js';
import {checkpointTurn} from '../src/core/turn-history.js';
vi.mock('../src/core/dice.js',async original=>({...await original<typeof import('../src/core/dice.js')>(),secureRng:()=>.99}));
function fixture(){
 const world=structuredClone(demo);world.events=[];
 const save=newSave(world),model=save.entities.find(e=>e.id==='npc_lin')!;
 save.entities=save.entities.filter(e=>!e.components.character||e.id===save.player_state.entity_id);
 save.npc_agent_state={};
 for(let index=0;index<12;index++){
  const npc=structuredClone(model);npc.id=`npc_test_${String(index).padStart(2,'0')}`;
  npc.components.location={location_id:'square'};delete npc.components.relationships;
  save.entities.push(npc);const state=emptyNpcAgentState();
  state.goals=[{id:'own_goal',description:index===0?'前往已知市场处理自己的事务':'留在此处照看自己的事务',horizon:'long',status:'active',origin:'world_creation',priority:5}];
  save.npc_agent_state[npc.id]=state;
 }
 // Character relationships on the player may reference the removed fixture NPCs.
 delete save.entities.find(e=>e.id===save.player_state.entity_id)!.components.relationships;
 save.definition.events=[];
 save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:60,replenishment:false};
 save.definition.background_incidents=[{id:'quiet_change',title:'既定日常变化',summary:'与玩家调查无关的背景安排',source:'WORLD_PACKAGE',
  created_at:{day:1,minute:540},earliest_activation:{day:2,minute:600},latest_activation:{day:3,minute:600},activation_flags:[],activation_chance:1,
  participants:['npc_test_00'],locations:['station'],stages:[
   {id:'started',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_test_00',effects:[{kind:'set_flag',flag:'quiet_started'}],exposures:[],terminal:'none'},
   {id:'closed',earliest_after_minutes:1440,latest_after_minutes:null,required_flags:[],actor_id:'npc_test_00',effects:[{kind:'set_flag',flag:'quiet_closed'}],exposures:[],terminal:'resolved'},
  ]}];
 return validateSave(save);
}
const noAction=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'继续自己的安排',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保留已有个人目标',social_response:null});
describe('long-running background opportunities',()=>{
 it('does not expose an NPC private search result merely because the player sees them looking',async()=>{
  let save=fixture();commitTruth(save,{id:'private_discovery',commitment:'HARD_TRUTH',statement:'PRIVATE_CAUSE',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,known_by:[],
   evidence:[{id:'private_mark',status:'EXISTS',description:'PRIVATE_OBSERVATION',event_ref:null,discovered_by:[],placement:{location_id:'square',anchor_entity_id:null,scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
  const before=structuredClone(save.runtime.time);save=executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
  save.npc_daily_last_at=structuredClone(save.runtime.time);
  const fake={ai:{npcDecision:async()=>({...noAction(),kind:'proposed_action',proposed_action:{type:'INSPECT',target_id:null,reason:'检查自己的环境'}})}} as unknown as GameService;
  const result=await settleAutonomousNpcTurn(fake,save,before,randomUUID());
  expect(result.save.npc_agent_state?.npc_test_00.knowledge.some(item=>item.id==='private_mark')).toBe(true);
  expect(result.visibleFacts.join(' ')).not.toContain('PRIVATE_OBSERVATION');
  expect(JSON.stringify(publicView(result.save))).not.toContain('PRIVATE_OBSERVATION');
  expect(publicView(result.save).known_evidence).toEqual([]);
 });
 it('executes an NPC own item pickup without changing the player inventory or sharing discoveries',async()=>{
  let save=fixture();save.entities.push({id:'npc_object',type:'item',components:{identity:{name:'记号盒',description:'普通盒子',avatar_id:null},
   item:{weight:1,stackable:false},location:{location_id:'square'}}});
  const before=structuredClone(save.runtime.time),playerInventory=structuredClone(save.entities.find(e=>e.id==='player')!.components.inventory);
  save=executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
  const paid=structuredClone(save.runtime.time);
  const fake={ai:{npcDecision:async()=>({...noAction(),kind:'proposed_action',proposed_action:{type:'TAKE',target_id:'npc_object',reason:'保管眼前的盒子'}})}} as unknown as GameService;
  save=(await settleAutonomousNpcTurn(fake,save,before,randomUUID())).save;
  expect(save.entities.find(e=>e.id==='player')!.components.inventory).toEqual(playerInventory);
  expect(save.entities.find(e=>e.id==='npc_object')!.components.location).toBeUndefined();
  expect(save.entities.find(e=>e.id==='npc_object')!.components.item?.owner_id).toBe('npc_test_00');
  expect(save.resolution_receipts?.at(-1)).toMatchObject({actor_id:'npc_test_00',semantic_action:'MOVE_ITEM',commit_status:'committed'});
  expect(save.runtime.time).toEqual(paid);
 });
 it.each([0,.47,.99])('does not starve NPCs under repeated large time jumps, seed %s',async seed=>{
  let save=fixture();const opportunities:string[]=[];
  const fake={ai:{npcDecision:async(_p:unknown,context:any)=>{
   opportunities.push(context.npc_id);
   if(context.npc_id==='npc_test_00'&&context.scene.location_id==='square')return {...noAction(),kind:'proposed_action',
    proposed_action:{type:'MOVE',target_id:'market',reason:context.active_goals[0].description}};
   return noAction();
  }}} as unknown as GameService;
  const initialMinute=save.runtime.time.day*1440+save.runtime.time.minute;
  for(let step=0;step<6;step++){
   const before=structuredClone(save.runtime.time),id=randomUUID(),calls=opportunities.length;
   save=executeAction(save,{type:'WAIT',parameters:{minutes:2160}},id,'player',()=>seed).save;
   const paid=structuredClone(save.runtime.time);
   save=(await settleAutonomousNpcTurn(fake,save,before,id)).save;
   expect(opportunities.length-calls).toBeLessThanOrEqual(2);expect(save.runtime.time).toEqual(paid);
   save=validateSave(JSON.parse(JSON.stringify(save)));
  }
  expect(new Set(opportunities).size).toBe(12);expect(opportunities).toHaveLength(12);
  expect(save.runtime.time.day*1440+save.runtime.time.minute-initialMinute).toBe(6*2160);
  expect(save.entities.find(e=>e.id==='npc_test_00')!.components.location?.location_id).toBe('market');
  expect(save.entities.find(e=>e.id==='npc_test_11')!.components.location?.location_id).toBe('square');
  expect(save.resolution_receipts?.filter(r=>r.actor_id==='npc_test_00'&&r.semantic_action==='MOVE')).toHaveLength(1);
  expect(save.gm_state.flags.quiet_started).toBe(true);expect(save.gm_state.flags.quiet_closed).toBe(true);
  expect(save.background_state?.event_log.length).toBeGreaterThanOrEqual(2);
  expect(save.npc_agent_state?.npc_test_11.goals[0].description).toBe('留在此处照看自己的事务');
  expect(JSON.stringify(publicView(save))).not.toContain('既定日常变化');
 });
 it('does not let provider failures monopolize opportunities, and Undo restores scheduling state',async()=>{
  let save=fixture();const seen:string[]=[];
  const fake={ai:{npcDecision:async(_p:unknown,c:any)=>{seen.push(c.npc_id);throw Error('isolated temporary provider failure');}}} as unknown as GameService;
  for(let index=0;index<2;index++){
   const before=structuredClone(save.runtime.time);save=executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
   save=(await settleAutonomousNpcTurn(fake,save,before,randomUUID())).save;
  }
  // At 360 minutes the unserved residents retain two due slots; a failed
  // provider attempt must not reset everyone else's personal opportunity.
  expect(new Set(seen).size).toBe(3);
  const store=new MemoryStore(),ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('no real provider');}}),service=new Service(store,ai,save.definition);
  await store.write(save);const normalized=await service.current(),before=structuredClone(normalized);
  const id=randomUUID(),after=structuredClone(before);after.runtime.time.minute+=1;after.state_revision++;
  after.npc_agent_state!.npc_test_00.last_autonomous_at=structuredClone(after.runtime.time);
  checkpointTurn(before,after,id);await store.write(after);
  await service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
  expect((await service.current()).npc_agent_state).toEqual(before.npc_agent_state);
  expect((await service.current()).runtime.time).toEqual(before.runtime.time);
 });
});

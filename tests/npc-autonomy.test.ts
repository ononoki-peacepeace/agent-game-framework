import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {buildNpcAgentContext,settleAutonomousNpcTurn,type NpcDecision} from '../src/agent/npc-agent.js';
import type {GameService} from '../src/server/service.js';
import {GameService as Service} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {recordSocialCommitments,recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';

function decision(kind:NpcDecision['kind'],action:NpcDecision['proposed_action']=null,speech:string|null=null):NpcDecision{
  return {kind,speech,vote_target:null,intent:'按自己当前目标处理日常',proposed_action:action,
    evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'自主选择下一步',social_response:null};
}
function fake(next:(context:any)=>NpcDecision){
  let calls=0;
  const service={ai:{npcDecision:async(_profile:unknown,context:unknown)=>{calls++;return next(context);}}} as unknown as GameService;
  return {service,calls:()=>calls};
}
describe('background NPC Agent settlement',()=>{
  it('settles an NPC own departure decision only after real world time, without a second AI call or player time charge',async()=>{
    const save=newSave(demo),now=structuredClone(save.runtime.time),sceneId=randomUUID();
    const scene=sceneResultSchema.parse({understanding:'散会',narrative:'林舟准备离开。',dialogue:'我去市场看看。',
      speech_events:[{speaker_id:'npc_lin',utterance:'我去市场看看。',provenance:'npc_response'}],
      effects:[],npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',
        readiness:'ready',condition:null,plan_id:null}]});
    recordNpcActivityPlans(save,scene,sceneId,'square');
    expect(save.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('square');
    const ai=fake(()=>decision('no_action'));
    const candidate=executeAction(save,{type:'WAIT',parameters:{minutes:7}},randomUUID()).save;
    const after=(await settleAutonomousNpcTurn(ai.service,candidate,now,randomUUID())).save;
    expect(after.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('market');
    expect(after.runtime.time).toEqual(candidate.runtime.time);
    const moves=after.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&item.semantic_action==='MOVE')??[];
    expect(moves).toHaveLength(1);expect(moves[0]).toMatchObject({time_cost:6,commit_status:'committed'});
    expect(after.npc_agent_state?.npc_lin?.plans.find(plan=>plan.activity)?.status).toBe('completed');
    expect(ai.calls()).toBe(0);
    const reloaded=validateSave(JSON.parse(JSON.stringify(after)));
    const replay=(await settleAutonomousNpcTurn(ai.service,reloaded,now,randomUUID())).save;
    expect(replay.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&item.semantic_action==='MOVE')).toHaveLength(1);
  });
  it('keeps conditional departures pending and permits only the NPC to cancel or release them',async()=>{
    const save=newSave(demo),sceneId=randomUUID(),utterance='收拾完东西我再去市场。';
    const scene=sceneResultSchema.parse({understanding:'稍后离开',narrative:'林舟继续手头的事。',dialogue:utterance,
      speech_events:[{speaker_id:'npc_lin',utterance,provenance:'npc_response'}],effects:[],
      npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',
        readiness:'conditional',condition:'先收拾东西',plan_id:null}]});
    recordNpcActivityPlans(save,scene,sceneId,'square');
    const plan=save.npc_agent_state!.npc_lin.plans[0],ai=fake(()=>decision('no_action'));
    const held=(await settleAutonomousNpcTurn(ai.service,
      executeAction(save,{type:'WAIT',parameters:{minutes:10}},randomUUID()).save,
      save.runtime.time,randomUUID())).save;
    expect(held.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('square');
    const release=sceneResultSchema.parse({...scene,speech_events:[{speaker_id:'npc_lin',
      utterance:'收拾好了，我现在去市场。',provenance:'npc_response'}],
      npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',
        readiness:'ready',condition:null,plan_id:plan.id}]});
    recordNpcActivityPlans(held,release,randomUUID(),'square');
    const moved=(await settleAutonomousNpcTurn(ai.service,
      executeAction(held,{type:'WAIT',parameters:{minutes:6}},randomUUID()).save,
      held.runtime.time,randomUUID())).save;
    expect(moved.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('market');
    expect(()=>recordNpcActivityPlans(newSave(demo),release,randomUUID(),'square')).toThrow('没有可变更');
  });
  it('cancels, postpones, releases conditions and expires short-term social tasks without inventing attendance',async()=>{
    const world=structuredClone(demo);world.runtime.time={day:1,minute:11*60+5};
    const base=newSave(world);
    const proposal=sceneResultSchema.parse({understanding:'约定协助',narrative:'林舟答应通知。',dialogue:'我去通知。',
      speech_events:[{speaker_id:'npc_lin',utterance:'我去通知。',provenance:'npc_response'}],effects:[],
      social_commitments:[{npc_id:'npc_lin',speech_index:0,kind:'relay',status:'accepted',
        message:'通知乔宁到广场',organizer_id:base.player_state.entity_id,
        activity_location_id:'square',activity_at:{day:1,minute:11*60+30},
        destination_ids:['market'],recipient_ids:['npc_qiao'],condition:null}]});
    const revise=(save:typeof base,status:'cancelled'|'postponed'|'condition_cleared',minute:number)=>{
      const task=save.npc_agent_state?.npc_lin?.social_tasks[0];
      const scene=sceneResultSchema.parse({...proposal,social_commitments:[{
        ...proposal.social_commitments[0],task_id:task?.id,status,
        message:status==='postponed'?'通知乔宁十一点四十五到广场':proposal.social_commitments[0].message,
        activity_at:{day:1,minute}}]});
      recordSocialCommitments(save,scene,randomUUID(),'square');
    };
    const cancelled=structuredClone(base);recordSocialCommitments(cancelled,proposal,randomUUID(),'square');
    revise(cancelled,'cancelled',11*60+30);
    expect(cancelled.npc_agent_state?.npc_lin?.social_tasks).toHaveLength(1);
    expect(cancelled.npc_agent_state?.npc_lin?.social_tasks[0].status).toBe('cancelled');
    const quiet=fake(()=>decision('no_action'));
    const cancelledAfter=(await settleAutonomousNpcTurn(quiet.service,
      executeAction(cancelled,{type:'WAIT',parameters:{minutes:25}},randomUUID()).save,
      cancelled.runtime.time,randomUUID())).save;
    expect(cancelledAfter.resolution_receipts?.some(item=>item.actor_id==='npc_lin'&&
      ['MOVE','TALK'].includes(item.semantic_action))).toBe(false);
    const postponed=structuredClone(base);recordSocialCommitments(postponed,proposal,randomUUID(),'square');
    revise(postponed,'postponed',11*60+45);
    expect(postponed.npc_agent_state?.npc_lin?.social_tasks).toHaveLength(1);
    expect(postponed.npc_agent_state?.npc_lin?.social_tasks[0].activity_at.minute).toBe(11*60+45);
    expect(postponed.npc_agent_state?.npc_lin?.social_tasks[0].message).toBe('通知乔宁十一点四十五到广场');
    postponed.npc_agent_state!.npc_lin.social_tasks[0].notified_ids.push('npc_qiao');
    expect(()=>revise(postponed,'postponed',12*60)).toThrow('不能未经传播就改期');
    const conditional=structuredClone(base);
    recordSocialCommitments(conditional,sceneResultSchema.parse({...proposal,social_commitments:[{
      ...proposal.social_commitments[0],status:'conditional',condition:'先完成手头的工作'}]}),randomUUID(),'square');
    revise(conditional,'condition_cleared',11*60+30);
    expect(conditional.npc_agent_state?.npc_lin?.social_tasks[0]).toMatchObject({status:'active',condition:null});
    const missed=structuredClone(base);
    recordSocialCommitments(missed,sceneResultSchema.parse({...proposal,social_commitments:[{
      ...proposal.social_commitments[0],status:'conditional',condition:'尚需确认'}]}),randomUUID(),'square');
    const expired=(await settleAutonomousNpcTurn(quiet.service,
      executeAction(missed,{type:'WAIT',parameters:{minutes:60}},randomUUID()).save,
      missed.runtime.time,randomUUID())).save;
    expect(expired.npc_agent_state?.npc_lin?.social_tasks[0].status).toBe('missed');
    expect(expired.resolution_receipts?.some(item=>item.actor_id==='npc_lin'&&
      ['MOVE','TALK'].includes(item.semantic_action))).toBe(false);
    expect(quiet.calls()).toBe(0);
  });
  it('turns an explicit scene commitment into a timed relay, independent reply and real arrival',async()=>{
    const world=structuredClone(demo);
    world.runtime.time={day:1,minute:11*60+5};
    const save=newSave(world),now=structuredClone(save.runtime.time);
    save.entities.find(item=>item.id===save.player_state.entity_id)!.components.location={location_id:'station'};
    const remote=structuredClone(save.entities.find(item=>item.id==='npc_qiao')!);
    remote.id='npc_remote';remote.components.identity.name='未被通知者';
    remote.components.location={location_id:'station'};save.entities.push(remote);
    const scene=sceneResultSchema.parse({understanding:'社区活动邀请',narrative:'林舟答应去通知。',dialogue:'我去通知乔宁。',
      speech_events:[{speaker_id:'npc_lin',utterance:'我去通知乔宁。',provenance:'npc_response'}],
      effects:[],travel_intents:[],social_commitments:[{npc_id:'npc_lin',speech_index:0,kind:'relay',
        status:'accepted',message:'11:30在广场集合商量接下来的安排',organizer_id:save.player_state.entity_id,
        activity_location_id:'square',activity_at:{day:1,minute:11*60+30},
        destination_ids:['market'],recipient_ids:['npc_qiao'],condition:null}]});
    recordSocialCommitments(save,scene,randomUUID(),'square');
    expect(save.npc_agent_state?.npc_lin?.social_tasks[0].status).toBe('active');
    const candidate=executeAction(save,{type:'WAIT',parameters:{minutes:25}},randomUUID()).save;
    const ai=fake(context=>context.scene.event.kind==='social_invitation'
      ?{...decision('no_action'),social_response:'accept'}:decision('no_action'));
    const after=(await settleAutonomousNpcTurn(ai.service,candidate,now,randomUUID())).save;
    expect(after.entities.find(item=>item.id==='npc_qiao')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts?.filter(item=>['MOVE','TALK'].includes(item.semantic_action)&&
      item.actor_id!==after.player_state.entity_id).map(item=>item.semantic_action)).toEqual(['MOVE','TALK','MOVE']);
    expect(after.npc_agent_state?.npc_qiao?.memories.some(item=>item.summary.includes('11:30'))).toBe(true);
    expect(after.npc_agent_state?.npc_remote?.memories.some(item=>item.summary.includes('11:30'))??false).toBe(false);
    expect(after.npc_agent_state?.npc_qiao?.social_tasks.some(item=>item.kind==='attend')).toBe(true);
    expect(after.runtime.time).toEqual(candidate.runtime.time);
    expect(ai.calls()).toBe(1);
    expect(validateSave(JSON.parse(JSON.stringify(after))).npc_agent_state?.npc_lin?.social_tasks[0].notified_ids)
      .toContain('npc_qiao');
    let split=structuredClone(save);
    for(let index=0;index<5;index++){
      const before=structuredClone(split.runtime.time);
      split=executeAction(split,{type:'WAIT',parameters:{minutes:5}},randomUUID()).save;
      split=(await settleAutonomousNpcTurn(ai.service,split,before,randomUUID())).save;
    }
    expect(split.entities.find(item=>item.id==='npc_qiao')?.components.location?.location_id).toBe('square');
    expect(split.resolution_receipts?.filter(item=>['MOVE','TALK'].includes(item.semantic_action)&&
      item.actor_id!==split.player_state.entity_id).map(item=>item.semantic_action)).toEqual(['MOVE','TALK','MOVE']);
    const refusing=structuredClone(save);
    const declined=fake(context=>context.scene.event.kind==='social_invitation'
      ?{...decision('no_action'),social_response:'decline'}:decision('no_action'));
    const refused=(await settleAutonomousNpcTurn(declined.service,
      executeAction(refusing,{type:'WAIT',parameters:{minutes:25}},randomUUID()).save,
      refusing.runtime.time,randomUUID())).save;
    expect(refused.entities.find(item=>item.id==='npc_qiao')?.components.location?.location_id).toBe('market');
    expect(refused.npc_agent_state?.npc_qiao?.social_tasks[0].status).toBe('cancelled');
    expect(refused.npc_agent_state?.npc_qiao?.memories.some(item=>item.summary.includes('11:30'))).toBe(true);
    const conditional=sceneResultSchema.parse({...scene,social_commitments:scene.social_commitments.map(item=>({
      ...item,status:'conditional',condition:'完成自己当前的工作后再决定'}))});
    const notReady=newSave(world);
    recordSocialCommitments(notReady,conditional,randomUUID(),'square');
    const held=(await settleAutonomousNpcTurn(ai.service,
      executeAction(notReady,{type:'WAIT',parameters:{minutes:25}},randomUUID()).save,
      notReady.runtime.time,randomUUID())).save;
    expect(held.npc_agent_state?.npc_lin?.social_tasks[0]).toMatchObject({status:'blocked',
      condition:'完成自己当前的工作后再决定'});
    expect(held.resolution_receipts?.some(item=>item.actor_id==='npc_lin'&&
      ['MOVE','TALK'].includes(item.semantic_action))).toBe(false);
  });
  it('settles bounded daily activity before deep decisions without charging player time again',async()=>{
    const initial=newSave(demo),before=structuredClone(initial.runtime.time),requestId=randomUUID();
    const candidate=executeAction(initial,{type:'WAIT',parameters:{minutes:60}},requestId).save;
    const ai=fake(()=>decision('no_action'));
    const first=await settleAutonomousNpcTurn(ai.service,candidate,before,requestId);
    const daily=first.save.resolution_receipts?.filter(item=>
      item.actor_id!==first.save.player_state.entity_id&&item.semantic_action==='INSPECT')??[];
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.length).toBeLessThanOrEqual(2);
    expect(daily.every(item=>item.commit_status==='committed'&&item.time_cost===1)).toBe(true);
    expect(first.save.runtime.time).toEqual(candidate.runtime.time);
    expect(ai.calls()).toBe(0);
    const reloaded=validateSave(JSON.parse(JSON.stringify(first.save)));
    const again=await settleAutonomousNpcTurn(ai.service,reloaded,before,requestId);
    expect(again.save.resolution_receipts?.filter(item=>daily.some(receipt=>receipt.request_id===item.request_id)))
      .toHaveLength(daily.length);
    expect(again.save.npc_daily_last_at).toEqual(first.save.npc_daily_last_at);
  });
  it('uses a registered route home at night and never treats willingness to follow as permission to leave',async()=>{
    const world=structuredClone(demo);
    world.runtime.time={day:1,minute:20*60};
    const resident=world.entities.find(item=>item.id==='npc_lin')!;
    resident.components.world_resident={origin_incident_id:'daily_fixture',entrance_reason:'既有住处',
      created_at:world.runtime.time,entered_world_at:world.runtime.time,importance:'minor',
      lifecycle:'active',home_location_id:'station',motivation:'按已有住处返回'};
    const initial=newSave(world),before=structuredClone(initial.runtime.time);
    const candidate=executeAction(initial,{type:'WAIT',parameters:{minutes:60}},randomUUID()).save;
    const ai=fake(()=>decision('no_action'));
    const first=(await settleAutonomousNpcTurn(ai.service,candidate,before,randomUUID())).save;
    const moved=first.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&item.semantic_action==='MOVE')??[];
    expect(moved).toHaveLength(1);
    expect(moved[0].movement_route?.location_ids).toEqual(['square','station']);
    expect(first.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
    expect(first.runtime.time).toEqual(candidate.runtime.time);
    expect(ai.calls()).toBe(0);
    const companion=newSave(world);
    companion.npc_agent_state??={};
    companion.npc_agent_state.npc_lin={...companion.npc_agent_state.npc_lin,
      travel_intent:{status:'willing',origin_location_id:'square',source_request_id:randomUUID(),recorded_revision:0}};
    const waiting=executeAction(companion,{type:'WAIT',parameters:{minutes:60}},randomUUID()).save;
    const after=(await settleAutonomousNpcTurn(ai.service,waiting,companion.runtime.time,randomUUID())).save;
    expect(after.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&item.semantic_action==='MOVE')).toHaveLength(0);
  });
  it('moves independently within paid world time and keeps a single Core receipt on retry',async()=>{
    const world=structuredClone(demo);
    world.events[0].actor_scope='any';
    const initial=newSave(world),before=structuredClone(initial.runtime.time),requestId=randomUUID();
    const candidate=executeAction(initial,{type:'WAIT',parameters:{minutes:180}},requestId).save;
    const ai=fake(()=>decision('proposed_action',{type:'MOVE',target_id:'station',reason:'前往站台'}));
    const first=await settleAutonomousNpcTurn(ai.service,candidate,before,requestId);
    const moved=first.save.entities.find(item=>item.id==='npc_lin')!;
    expect(moved.components.location?.location_id).toBe('station');
    expect(first.save.runtime.time).toEqual(candidate.runtime.time);
    expect(first.save.gm_state.flags.heard_station_notice).toBe(true);
    const npcReceipts=first.save.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&item.semantic_action==='MOVE')??[];
    expect(npcReceipts).toHaveLength(1);
    expect(npcReceipts[0]).toMatchObject({commit_status:'committed',time_cost:18});
    const again=await settleAutonomousNpcTurn(ai.service,first.save,before,requestId);
    expect(ai.calls()).toBe(1);
    expect(again.save.resolution_receipts?.filter(item=>item.request_id===npcReceipts[0].request_id)).toHaveLength(1);
    expect(validateSave(JSON.parse(JSON.stringify(again.save))).entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
  });
  it('does not let an NPC trigger a legacy player-only arrival event',async()=>{
    const initial=newSave(demo),before=structuredClone(initial.runtime.time),requestId=randomUUID();
    const candidate=executeAction(initial,{type:'WAIT',parameters:{minutes:180}},requestId).save;
    const ai=fake(()=>decision('proposed_action',{type:'MOVE',target_id:'station',reason:'前往站台'}));
    const after=(await settleAutonomousNpcTurn(ai.service,candidate,before,requestId)).save;
    expect(after.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
    expect(after.gm_state.flags.heard_station_notice).toBeUndefined();
  });
  it('accumulates ordinary short turns into a bounded persisted autonomy interval',async()=>{
    const initial=newSave(demo),ai=fake(()=>decision('proposed_action',
      {type:'MOVE',target_id:'station',reason:'前往站台'}));
    const first=executeAction(initial,{type:'WAIT',parameters:{minutes:90}},randomUUID()).save;
    const staged=(await settleAutonomousNpcTurn(ai.service,first,initial.runtime.time,randomUUID())).save;
    expect(ai.calls()).toBe(0);
    const reloaded=validateSave(JSON.parse(JSON.stringify(staged)));
    const second=executeAction(reloaded,{type:'WAIT',parameters:{minutes:90}},randomUUID()).save;
    const after=(await settleAutonomousNpcTurn(ai.service,second,reloaded.runtime.time,randomUUID())).save;
    expect(ai.calls()).toBe(1);
    expect(after.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
    expect(after.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&item.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.runtime.time).toEqual(second.runtime.time);
  });
  it('records NPC-to-NPC speech as heard memory without disclosing private knowledge',async()=>{
    const initial=newSave(demo),listener=initial.entities.find(item=>item.id==='npc_qiao')!;
    listener.components.location={location_id:'square'};
    const before=structuredClone(initial.runtime.time),requestId=randomUUID();
    const candidate=executeAction(initial,{type:'WAIT',parameters:{minutes:180}},requestId).save;
    const ai=fake(()=>decision('speech',null,'我先去看看站台那边的情况。'));
    const after=(await settleAutonomousNpcTurn(ai.service,candidate,before,requestId)).save;
    expect(after.resolution_receipts?.some(item=>item.semantic_action==='TALK'&&item.actor_id==='npc_lin')).toBe(true);
    expect(after.npc_agent_state?.npc_qiao?.memories.some(item=>item.summary.includes('站台那边'))).toBe(true);
    const context=buildNpcAgentContext(after,'npc_qiao',{kind:'world_event',description:'稍后继续日常'});
    expect(context.memories.some(item=>item.summary.includes('站台那边'))).toBe(true);
    expect(JSON.stringify(context)).not.toContain('gm_state');
  });
  it('carries an NPC goal into its next independent decision instead of resetting intent',async()=>{
    let sawPriorGoal=false;
    const ai=fake(context=>{
      if(context.npc_id!=='npc_lin')return decision('no_action');
      sawPriorGoal=context.active_goals.some((item:{id:string})=>item.id==='reach_station');
      if(sawPriorGoal)return decision('proposed_action',
        {type:'MOVE',target_id:'station',reason:'继续前往站台'});
      return {...decision('no_action'),goal_proposals:[{id:'reach_station',description:'前往站台了解日常安排',
        horizon:'short',priority:4}]};
    });
    let save=newSave(demo);
    for(let index=0;index<3;index++){
      const before=structuredClone(save.runtime.time);
      save=executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
      save=(await settleAutonomousNpcTurn(ai.service,save,before,randomUUID())).save;
    }
    expect(sawPriorGoal).toBe(true);
    expect(save.npc_agent_state?.npc_lin?.goals.find(item=>item.id==='reach_station')?.status).toBe('active');
    expect(save.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
  });
  it('lets a settled NPC action causally start a later world incident across normal life turns',async()=>{
    const world=structuredClone(demo),opening=world.runtime.time;
    world.events[0].actor_scope='any';
    world.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:2,
      minimum_gap_minutes:60,replenishment:false};
    world.background_incidents=[{id:'station_notice',title:'站台日常变化',summary:'站台公告后出现日程变化',
      source:'WORLD_PACKAGE',created_at:opening,earliest_activation:opening,latest_activation:null,
      activation_flags:['heard_station_notice'],activation_chance:1,participants:['npc_lin'],locations:['station'],
      stages:[{id:'onset',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',
        effects:[{kind:'set_flag',flag:'station_story_advanced'}],exposures:[{id:'public_change',
          channel:'public_notice',location_id:'station',npc_id:null,text:'站台公布了新的日程。',
          interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
    const ai=fake(context=>context.npc_id==='npc_lin'&&
      context.scene.location_id!=='station'?decision('proposed_action',
        {type:'MOVE',target_id:'station',reason:'自己的日程需要前往站台'}):decision('no_action'));
    let save=newSave(world),paidMinutes=0;
    for(const minutes of [180,180,180,720,720]){
      const before=structuredClone(save.runtime.time);
      save=executeAction(save,{type:'WAIT',parameters:{minutes}},randomUUID()).save;
      paidMinutes+=minutes;
      save=(await settleAutonomousNpcTurn(ai.service,save,before,randomUUID())).save;
    }
    expect(save.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
    expect(save.gm_state.flags.station_story_advanced).toBe(true);
    expect(save.background_state?.incidents[0].status).toBe('resolved');
    expect(save.npc_agent_state?.npc_lin?.memories.some(item=>item.kind==='public_event'&&
      item.summary.includes('新的日程'))).toBe(true);
    expect(save.runtime.time.day*world.ruleset.minutes_per_day+save.runtime.time.minute)
      .toBe(opening.day*world.ruleset.minutes_per_day+opening.minute+paidMinutes);
    expect(validateSave(JSON.parse(JSON.stringify(save))).background_state?.incidents[0].status).toBe('resolved');
  });
  it('commits an autonomous action with the player turn and restores it through Undo',async()=>{
    const store=new MemoryStore();
    const ai=new AIRuntime({name:'npc-batch-fixture',generate:async request=>{
      if(request.role==='npc_decision')return {data:decision('proposed_action',
        {type:'MOVE',target_id:'station',reason:'前往站台'})};
      if(request.role==='narrator')return {data:{narrative:'你在原地等了一阵。',speaker:null,
        dialogue:null,choices:[],context_actions:[],patches:[],interaction:null}};
      throw Error(`unexpected role: ${request.role}`);
    }});
    const service=new Service(store,ai,demo);
    await service.newGame();const before=await service.current();
    const request_id=randomUUID(),turn=await service.turn({request_id,game_id:before.game_id,
      expected_revision:before.state_revision,action:{type:'WAIT',parameters:{minutes:180}}});
    const after=await service.current();
    expect(after.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe('station');
    expect(after.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&
      item.semantic_action==='MOVE'&&item.commit_status==='committed')).toHaveLength(1);
    expect(after.resolution_receipts?.filter(item=>item.actor_id==='npc_lin'&&
      item.semantic_action==='INSPECT'&&item.commit_status==='committed')).toHaveLength(1);
    expect(turn.revision).toBe(after.state_revision);
    const reloaded=await new Service(store,ai,demo).current();
    expect(reloaded.npc_agent_state).toEqual(after.npc_agent_state);
    await service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
    const undone=await service.current();
    expect(undone.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id)
      .toBe(before.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id);
    expect(undone.resolution_receipts?.filter(item=>item.actor_id==='npc_lin')??[]).toHaveLength(0);
    expect(undone.npc_autonomy_last_at).toEqual(before.npc_autonomy_last_at);
    expect(undone.npc_daily_last_at).toEqual(before.npc_daily_last_at);
  });
});


it('does not schedule an incapacitated NPC for deep or daily activity',async()=>{
  const save=newSave(demo);for(const npc of save.entities.filter(e=>e.id!==save.player_state.entity_id&&e.components.character))npc.components.condition={hp:0,stamina:100,stress:0};
  const before=structuredClone(save.runtime.time);save.runtime.time.minute+=240;
  const stub=fake(()=>{throw Error('must not ask an incapacitated NPC to act');});
  const result=await settleAutonomousNpcTurn(stub.service,save,before,randomUUID());
  expect(stub.calls()).toBe(0);
  expect(result.save.entities.find(e=>e.id==='npc_lin')!.components.condition.hp).toBe(0);
  expect(result.save.entities.find(e=>e.id==='npc_lin')!.components.location).toEqual(save.entities.find(e=>e.id==='npc_lin')!.components.location);
});

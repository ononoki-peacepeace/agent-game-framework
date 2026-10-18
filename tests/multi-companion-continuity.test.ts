import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {executeAction} from '../src/core/runtime.js';
import {validateMovementNarrative,canonicalMovementNarrative} from '../src/core/narrative-firewall.js';
import {handleAgentInput} from '../src/agent/executor.js';
import type {SavePackage} from '../src/core/schema.js';

const where=(save:SavePackage,id:string)=>save.entities.find(entity=>entity.id===id)?.components.location?.location_id;
const move=(save:SavePackage,target:string,actorId=save.player_state.entity_id,companions?:'none')=>
  executeAction(save,{type:'MOVE',target_id:target,parameters:companions?{companions}:{}},randomUUID(),
    actorId===save.player_state.entity_id?'player':'ai',undefined,undefined,true,actorId,
    actorId!==save.player_state.entity_id).save;

async function party(generate?:Parameters<typeof sparseSetup>[0]){
  const {service,store}=await sparseSetup(generate);
  const save=await service.current(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  player.components.location={location_id:'square'};
  const base=save.entities.find(entity=>entity.id==='npc_lin')!;
  const ids=['npc_lin','npc_qiao','npc_third'];
  for(const [index,id] of ids.entries()){
    const entity=index===0?base:index===1?save.entities.find(item=>item.id===id)!:structuredClone(base);
    entity.id=id;entity.components.location={location_id:'square'};
    if(index===2)entity.components.identity!.name='第三人';
    if(index===2)save.entities.push(entity);
    save.npc_agent_state??={};save.npc_agent_state[id]={...emptyNpcAgentState(),travel_intent:{
      status:'willing',origin_location_id:'square',source_request_id:randomUUID(),recorded_revision:save.state_revision}};
  }
  return {save,ids,service,store};
}

describe('authoritative multi-NPC travel continuity',()=>{
  it('honors first-time consent after ordinary turns and Undo advance revision without time',async()=>{
    const {save,ids}=await party();
    const beforeMinute=save.runtime.time.minute;
    save.state_revision+=8;
    expect(save.resolution_receipts?.some(receipt=>
      receipt.result_entities?.moved_companions?.includes(ids[2]))).not.toBe(true);
    const after=move(save,'market'),receipt=after.resolution_receipts!.at(-1)!;
    expect(receipt.result_entities?.moved_companions).toEqual(ids);
    expect(ids.map(id=>where(after,id))).toEqual(ids.map(()=>'market'));
    expect(after.runtime.time.minute-beforeMinute).toBe(6);
    expect(receipt.movement_route?.total_minutes).toBe(6);
  });

  it('keeps three willing companions across later revisions and records one route and time cost',async()=>{
    const {save,ids}=await party();
    const first=move(save,'market');
    const firstReceipt=first.resolution_receipts!.at(-1)!;
    expect(firstReceipt.result_entities?.moved_companions).toEqual(ids);
    firstReceipt.commit_status='committed';
    first.state_revision+=12;
    // Simulate an older save whose original consent revision was never renewed.
    for(const id of ids)first.npc_agent_state![id].travel_intent!.recorded_revision=save.state_revision;
    const second=move(first,'square'),receipt=second.resolution_receipts!.at(-1)!;
    expect(receipt.result_entities?.moved_companions).toEqual(ids);
    expect(ids.map(id=>where(second,id))).toEqual(['square','square','square']);
    expect(receipt.time_cost).toBe(6);
    expect(second.runtime.time.minute-first.runtime.time.minute).toBe(6);
    expect(receipt.movement_route?.total_minutes).toBe(6);
    expect(ids.map(id=>second.npc_agent_state![id].travel_intent?.recorded_revision))
      .toEqual(ids.map(()=>first.state_revision+1));
    const wrong={narrative:'跟上来的只有林舟的脚步声。',speaker:null,dialogue:null,choices:[],context_actions:[]} as never;
    expect(()=>validateMovementNarrative(receipt,wrong,second)).toThrow('同行人物');
    expect(canonicalMovementNarrative(receipt,second)).toContain('与你同行抵达');
  });

  it('respects a refusal and never moves an absent person',async()=>{
    const {save,ids}=await party();
    save.npc_agent_state![ids[1]].travel_intent!.status='declined';
    save.entities.find(entity=>entity.id===ids[2])!.components.location={location_id:'market'};
    const after=move(save,'market');
    expect(after.resolution_receipts!.at(-1)?.result_entities?.moved_companions).toEqual([ids[0]]);
    expect(where(after,ids[1])).toBe('square');
    expect(where(after,ids[2])).toBe('market');
  });

  it('ends consent when an NPC independently leaves, even if they later return',async()=>{
    const {save,ids}=await party();
    const left=move(save,'market',ids[0]);
    expect(left.npc_agent_state![ids[0]].travel_intent).toBeUndefined();
    const returned=move(left,'square',ids[0]);
    const group=move(returned,'market');
    expect(group.resolution_receipts!.at(-1)?.result_entities?.moved_companions).toEqual(ids.slice(1));
  });

  it('respects an explicit change of mind at an intermediate stop',async()=>{
    const {save,ids}=await party();
    const first=move(save,'market');
    first.npc_agent_state![ids[1]].travel_intent={...first.npc_agent_state![ids[1]].travel_intent!,
      status:'declined',recorded_revision:first.state_revision+1};
    const next=move(first,'square');
    expect(next.resolution_receipts!.at(-1)?.result_entities?.moved_companions)
      .toEqual([ids[0],ids[2]]);
    expect(where(next,ids[1])).toBe('market');
  });

  it('honors an explicit solo departure without charging companions time',async()=>{
    const {save,ids}=await party();
    const after=move(save,'market',save.player_state.entity_id,'none');
    expect(after.resolution_receipts!.at(-1)?.result_entities?.moved_companions).toEqual([]);
    expect(ids.map(id=>where(after,id))).toEqual(['square','square','square']);
    expect(ids.map(id=>after.npc_agent_state?.[id].travel_intent)).toEqual([undefined,undefined,undefined]);
    const returned=move(after,'square');
    const departedAgain=move(returned,'market');
    expect(departedAgain.resolution_receipts!.at(-1)?.result_entities?.moved_companions).toEqual([]);
  });

  it('keeps a resolved deictic destination and an unrelated future social task through group MOVE',async()=>{
    const {save,ids,service,store}=await party(async request=>{
      const fields=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(request.role==='narrator')return {data:{narrative:'你们一起抵达街角商店。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;
      if(fields.verdict)return {data:{verdict:'aligned',explanation:'地点与玩家已表达的目标一致。'}} as never;
      throw new Error(`unexpected ${request.role} call`);
    });
    save.last_turn={narrative:'你们谈到稍后回街角商店。',speaker:null,dialogue:null,choices:[],context_actions:[]};
    const now=structuredClone(save.runtime.time);
    save.npc_agent_state![ids[0]].social_tasks.push({id:'later_meeting',kind:'attend',status:'active',
      message:'稍后参加另一场会面',organizer_id:save.player_state.entity_id,activity_location_id:'square',
      destination_ids:['square'],recipient_ids:[],notified_ids:[],declined_ids:[],
      activity_at:{day:now.day,minute:now.minute+60},next_at:{day:now.day,minute:now.minute+60},
      source_request_id:randomUUID(),last_accounted_at:now,time_credit_minutes:0,condition:null});
    await store.write(save);
    const input='我们四个人一起回那里。';
    const semantic={domain:'world',kind:'world_action',original_user_request:input,operation_plane:'play',
      goal_spec:{objective:input,play_action:'move',targets:[{kind:'location',reference:'街角商店',entity_id:'market'}],
        desired_state:[{path:'entity:player.location.location_id',value:'market',target_ref:'player'}],
        desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
        dependencies:[],world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null},
      confidence:.95,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
      interaction_lane:'world_transaction',player_speech_mode:'none',temporal_wait:null,open_goal_context:null};
    await handleAgentInput(service,{request_id:randomUUID(),game_id:save.game_id,
      expected_revision:save.state_revision,input},undefined,null,false,semantic as never);
    const after=await service.current();
    expect(after.resolution_receipts?.at(-1)?.result_entities?.moved_companions).toEqual(ids);
    expect(where(after,after.player_state.entity_id)).toBe('market');
    expect(after.npc_agent_state![ids[0]].social_tasks[0]).toMatchObject({id:'later_meeting',status:'active'});
    expect(after.runtime.time.minute-save.runtime.time.minute).toBe(6);
  });
});

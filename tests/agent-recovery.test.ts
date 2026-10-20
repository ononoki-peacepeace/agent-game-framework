import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {startTrace,runWithTrace} from '../src/observability/trace.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {ProviderError,SemanticSchemaError} from '../src/ai/failures.js';
import {AIRuntime} from '../src/ai/runtime.js';

const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const goal=(id:string,text:string,operation:'activity'|'other'='activity'):GoalInput=>({
  goal_id:id,type:'WORLD_ACTION',normalized_goal:text,operation_hint:operation,depends_on:[],
  condition:null,branch:null,temporal_scope:temporal,target_entities:[],referent:null,
});
const narration={narrative:'你完成了眼前这次尝试。',speaker:null,dialogue:null,choices:[],
  context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
const proposal=(target_id:string|null)=>({narrative:'你做出了这次尝试。',minutes:2,target_id,
  facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'普通尝试',
    stages:[],evidence_ids:[]}});
const semantic={kind:'world_action',interaction_lane:'world_transaction'} as const;

async function fixture(){
  const f=await sparseSetup();
  vi.spyOn(f.ai,'narrate').mockResolvedValue(narration as never);
  vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal(null) as never);
  return f;
}
async function act(f:Awaited<ReturnType<typeof fixture>>,input:string,lane='world_transaction'){
  const before=await f.service.current(),request_id=randomUUID();
  const trace=startTrace({module:'agent',logger:f.service.logger,request_id,game_id:before.game_id});
  const result=await runWithTrace(trace,()=>handleAgentInput(f.service,{request_id,game_id:before.game_id,
    expected_revision:before.state_revision,input},undefined,null,false,
    {...semantic,interaction_lane:lane} as never));
  return {before,after:await f.service.current(),result,trace_id:trace.trace_id};
}

describe('bounded pre-commit agent recovery',()=>{
  it.each([
    ['我走到长条桌旁，在一张固定座椅上坐下。','长条桌','固定座椅','长条桌旁的固定座椅'],
    ['我走到书架旁，在空着的软垫上坐下。','书架','软垫','书架旁的软垫'],
  ])('returns a wrong map binding and its full candidate to planning, then performs %s once',async(input,base,anchor,wrongDestination)=>{
    const f=await fixture(),seeded=await f.service.current(),here=seeded.entities.find(entity=>entity.id===seeded.player_state.entity_id)!
      .components.location!.location_id as string;
    seeded.definition.map!.locations.find(location=>location.id===here)!.description=`现场有${base}与${anchor}。`;
    seeded.environment_state={resolutions:[{id:'known_base',location_id:here,name:base,aliases:[],
      status:'present',classification:'environment_detail',entity_id:null,description:`现场有${base}。`,
      take_allowed:false,source_request_id:randomUUID(),at:structuredClone(seeded.runtime.time),
      known_by:[seeded.player_state.entity_id]},{id:'known_anchor',location_id:here,name:anchor,aliases:[],
      status:'present',classification:'environment_detail',entity_id:null,description:`现场有${anchor}。`,
      take_allowed:false,source_request_id:randomUUID(),at:structuredClone(seeded.runtime.time),
      known_by:[seeded.player_state.entity_id]}]};
    await f.store.write(seeded);
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    const contexts:unknown[]=[];
    const planner=vi.spyOn(f.ai,'planGoals').mockImplementation(async(_view,_input,_schema,context)=>{
      contexts.push(context);
      if(contexts.length===1)return {goals:[{...goal('attempt',input),operation_hint:'move',
        referent:wrongDestination}]};
      const [walk,sit]=input.replace(/[。！!]$/,'').split('，');
      const first=goal('walk',walk),second={...goal('sit',sit),depends_on:['walk']};
      delete first.operation_hint;delete second.operation_hint;
      return {goals:[first,second]};
    });
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'保留完整目标。'} as never);
    const {before,after,result,trace_id}=await act(f,input);
    expect(planner).toHaveBeenCalledTimes(2);
    expect(contexts[1]).toMatchObject({recovery:{original_request:input,
      failure_code:'plan_binding_invalid',failure_stage:'plan_admission',completed_steps:[],
      generation_repair:{stage:'plan_admission',previous_output:{goals:[{operation_hint:'move',
        referent:wrongDestination}]},issues:[{path:'goals.attempt.referent',code:'unresolved_binding'}]}}});
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+3);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.scene_position?.label)
      .toBe(base+'旁');
    expect(f.service.logger.entries({limit:1000}).some(entry=>entry.trace_id===trace_id&&
      entry.event==='agent.recovery.decision'&&entry.metadata?.failure_stage==='plan_admission')).toBe(true);
  });
  it('stops an unchanged invalid plan as a technical failure without a world write',async()=>{
    const f=await fixture(),input='我走到长条桌旁，在一张固定座椅上坐下。';
    const planner=vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{...goal('attempt',input),
      operation_hint:'move',referent:'长条桌旁的固定座椅'}]});
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'保留完整目标。'} as never);
    const {before,after,result}=await act(f,input);
    expect(planner).toHaveBeenCalledTimes(2);
    expect(result.outcome).toMatchObject({type:'engine_failure',code:'schema_failure',stage:'plan_admission'});
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('executes a perception identified by GoalSpec beyond the legacy fastPlan vocabulary',async()=>{
    const f=await fixture(),seed=await f.service.current();
    for(const entity of seed.entities)if(entity.id!==seed.player_state.entity_id&&
      entity.components.character&&entity.components.location?.location_id===
        seed.entities.find(player=>player.id===seed.player_state.entity_id)?.components.location?.location_id)
      entity.components.location.location_id='station';
    await f.store.write(seed);
    const before=await f.service.current();
    const planner=vi.spyOn(f.ai,'planGoals').mockImplementation(async()=>{throw Error('perception must retain its semantic goal');});
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'现场感知与原目标一致'} as never);
    const input='我想亲自环视这间屋子的布局';
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,{
      kind:'world_action',interaction_lane:'natural_scene',goal_spec:{objective:input,
        play_action:'perceive',targets:[],desired_state:[],desired_outputs:[],constraints:[],
        persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],
        world_mutation:false,external_artifact:false,multi_step:false,ambiguity:null},
    } as never);
    const after=await f.service.current();
    expect(planner).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);
  });
  it('repairs invalid registered action parameters before any commit',async()=>{
    const f=await fixture(),before=await f.service.current();
    const interpret=vi.spyOn(f.ai,'interpret').mockReset()
      .mockResolvedValueOnce({type:'WAIT',parameters:{minutes:0}} as never)
      .mockResolvedValueOnce({type:'WAIT',parameters:{minutes:5}} as never);
    await f.service.turn({request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'等一会儿'});
    const after=await f.service.current();
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(interpret.mock.calls[1][2]).toMatchObject({failure_code:'action_parameters_invalid',previous_action:'WAIT'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+5);
    expect(after.runtime.receipts.length).toBe(before.runtime.receipts.length+1);
  });
   it('feeds an unregistered action type to its interpreter before Core and executes the corrected action once',async()=>{
     const f=await fixture(),before=await f.service.current();
     const interpret=vi.spyOn(f.ai,'interpret').mockReset()
       .mockResolvedValueOnce({type:'UNREGISTERED_MOVE',parameters:{minutes:5}} as never)
       .mockResolvedValueOnce({type:'WAIT',parameters:{minutes:5}} as never);
     await f.service.turn({request_id:randomUUID(),game_id:before.game_id,
       expected_revision:before.state_revision,input:'等待五分钟'});
     const after=await f.service.current();
     expect(interpret).toHaveBeenCalledTimes(2);
     expect(interpret.mock.calls[1][2]).toMatchObject({failure_code:'action_type_invalid',
       generation_repair:{stage:'action_type',previous_output:{type:'UNREGISTERED_MOVE'},
         issues:[{path:'type',code:'unregistered_action'}]}});
     expect(after.state_revision).toBe(before.state_revision+1);
     expect(after.runtime.time.minute).toBe(before.runtime.time.minute+5);
     expect(after.runtime.receipts.length).toBe(before.runtime.receipts.length+1);
   });
   it('returns a misclassified physical action for correction without executing its wrong Core action',async()=>{
     const f=await fixture(),before=await f.service.current();
     const interpret=vi.spyOn(f.ai,'interpret').mockReset()
       .mockResolvedValue({type:'WAIT',parameters:{minutes:5}} as never);
     await expect(f.service.turn({request_id:randomUUID(),game_id:before.game_id,
       expected_revision:before.state_revision,input:'我试着攻击林舟'})).rejects.toThrow('行动参数未能通过校验');
     const after=await f.service.current();
     expect(interpret).toHaveBeenCalledTimes(2);
     expect(interpret.mock.calls[1][2]).toMatchObject({failure_code:'action_family_mismatch',
       generation_repair:{stage:'action_family',issues:[{path:'type',code:'physical_action_mismatch'}]}});
     expect(after.state_revision).toBe(before.state_revision);
     expect(after.runtime.receipts).toEqual(before.runtime.receipts);
   });
  it('stops repeated invalid action parameters without committing',async()=>{
    const f=await fixture(),before=await f.service.current();
    const interpret=vi.spyOn(f.ai,'interpret').mockReset()
      .mockResolvedValue({type:'WAIT',parameters:{minutes:0}} as never);
    await expect(f.service.turn({request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'等一会儿'})).rejects.toThrow('行动参数未能通过校验');
    const after=await f.service.current();
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.runtime.receipts).toEqual(before.runtime.receipts);
  });
  it('passes a bounded binding failure into the next real provider prompt',async()=>{
    const f=await fixture(),prompts:string[]=[];
    const ai=new AIRuntime({name:'repair-capture',generate:async request=>{
      prompts.push(request.prompt);return {data:proposal(null)} as never;
    }});
    await ai.freeform(await f.service.current(),'向乔宁挥手',{
      failure_code:'target_binding_invalid',public_targets:[{id:'npc_qiao',name:'乔宁'}]});
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"proposal_repair"');
    expect(prompts[0]).toContain('"failure_code":"target_binding_invalid"');
    expect(prompts[0]).toContain('向乔宁挥手');
  });
  it('repairs a diagnosed open-goal schema failure without replaying any world action',async()=>{
    const f=await fixture(),contexts:unknown[]=[];
    const planner=vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      contexts.push(data);
      if(contexts.length===1)throw new SemanticSchemaError([{path:'decision',code:'invalid_value',expected:'合法下一步枚举',message:'无效决策'}],{decision:'bad_choice'});
      return {decision:'clarify',transaction:null,reason:null,question:'你想优先调查哪一个可见区域？'} as never;
    });
    const before=await f.service.current(),request_id=randomUUID();
    const result=await handleAgentInput(f.service,{request_id,game_id:before.game_id,
      expected_revision:before.state_revision,input:'想办法离开这座建筑'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,
        continuation:'none'}} as never);
    const after=await f.service.current();
    expect(planner).toHaveBeenCalledTimes(2);
    expect(contexts[1]).toMatchObject({recovery:{original_goal:'想办法离开这座建筑',
      failure_stage:'open_goal_planning',revision:before.state_revision,completed_steps:[]}});
    expect(result.clarification).toContain('哪一个');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('hands a misrouted simple action from open goal to the receipt-checked runner',async()=>{
    const f=await fixture();
    const planner=vi.spyOn(f.ai,'planGoals').mockImplementation(async()=>{throw Error('route handoff must avoid model replanning');});
    const {before,after,result,trace_id}=await act(f,'先观察房间','open_goal');
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);
    expect(planner).not.toHaveBeenCalled();
    expect(f.service.logger.entries({limit:1000}).some(entry=>entry.trace_id===trace_id&&
      entry.event==='agent.route_handoff')).toBe(true);
  });
  it('feeds a rejected plan back to the planner and commits only the corrected goal',async()=>{
    const f=await fixture();
    const contexts:unknown[]=[];
    vi.spyOn(f.ai,'planGoals').mockImplementation(async(_view,_input,_schema,context)=>{
      contexts.push(context);
      return contexts.length===1?{goals:[goal('prep1','看看窗边'),goal('prep2','站在窗边')]}:
        {goals:[goal('attempt','伸个懒腰')]};
    });
    const alignment=vi.spyOn(f.ai,'systemAgent').mockImplementation(async()=>({
      verdict:alignment.mock.calls.length===1?'incomplete':'aligned',explanation:'检查玩家目标。',
    }) as never);
    const {before,after,result,trace_id}=await act(f,'伸个懒腰');
    expect(alignment).toHaveBeenCalledTimes(2);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toMatchObject({recovery:{original_request:'伸个懒腰',
      failure_code:'incomplete',failure_stage:'goal_alignment',revision:before.state_revision,completed_steps:[]}});
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
    const events=f.service.logger.entries({limit:1000}).filter(entry=>entry.trace_id===trace_id);
    expect(events.filter(entry=>entry.event==='agent.plan_attempt')).toHaveLength(2);
    expect(events.some(entry=>entry.event==='agent.recovery.decision'&&
      entry.metadata?.failure_code==='incomplete')).toBe(true);
  });
  it('does not silently turn an authorized action into a read-only answer',async()=>{
    const f=await fixture(),contexts:unknown[]=[];
    const planner=vi.spyOn(f.ai,'planGoals').mockImplementation(async(_view,_input,_schema,context)=>{
      contexts.push(context);
      return contexts.length===1
        ?{goals:[{...goal('query','伸个懒腰'),type:'WORLD_QUERY' as const}]}
        :{goals:[goal('attempt','伸个懒腰')]};
    });
    const alignment=vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'同一目标。'} as never);
    const {before,after,result}=await act(f,'伸个懒腰');
    expect(planner).toHaveBeenCalledTimes(2);
    expect(contexts[1]).toMatchObject({recovery:{failure_code:'incomplete',failure_stage:'goal_alignment'}});
    expect(alignment).toHaveBeenCalledTimes(1);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
  });
  it('stops repeated rejected plans without changing the world',async()=>{
    const f=await fixture();
    const planned=vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal('prep1','看看窗边'),goal('prep2','站在窗边')]});
    const alignment=vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'incomplete',explanation:'缺少最终尝试。'} as never);
    const {before,after,result}=await act(f,'伸个懒腰');
    expect(planned).toHaveBeenCalledTimes(2);
    expect(alignment).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('尚未规划');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('repairs an invented target before commit without acting on that entity',async()=>{
    const f=await fixture(),save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_qiao')!.components.location=
      structuredClone(save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location);
    await f.store.write(save);
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal('attempt','向乔宁挥手')]});
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'同一目标。'} as never);
    const freeform=vi.spyOn(f.ai,'freeform').mockReset().mockImplementation(async(_save,_input,repair)=>
      proposal(repair?'npc_qiao':'npc_lin') as never);
    const {before,after,result,trace_id}=await act(f,'向乔宁挥手');
    expect(freeform).toHaveBeenCalledTimes(2);
    expect(freeform.mock.calls[1][2]).toMatchObject({failure_code:'target_binding_invalid',
      public_targets:[{id:'npc_qiao',name:'乔宁'}]});
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
    expect(after.resolution_receipts?.at(-1)?.target_id).toBe('npc_qiao');
    expect(f.service.logger.entries({limit:1000}).some(entry=>entry.trace_id===trace_id&&
      entry.event==='agent.recovery.completed')).toBe(true);
  });
  it('stops two invalid target proposals with no receipt or time cost',async()=>{
    const f=await fixture();
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal('attempt','向乔宁挥手')]});
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'同一目标。'} as never);
    const freeform=vi.spyOn(f.ai,'freeform').mockReset().mockResolvedValue(proposal('npc_lin') as never);
    const {before,after,result}=await act(f,'向乔宁挥手');
    expect(freeform).toHaveBeenCalledTimes(2);
    expect(result.outcome).toMatchObject({type:'engine_failure',code:'schema_failure',stage:'freeform_binding'});
    expect(result.message).toContain('世界没有改变');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('regenerates narration from one pending candidate without executing the action twice',async()=>{
    const f=await fixture();
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal('attempt','伸个懒腰')]});
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'同一目标。'} as never);
    const freeform=vi.spyOn(f.ai,'freeform');
    const narrator=vi.spyOn(f.ai,'narrate').mockReset()
      .mockRejectedValueOnce(new ProviderError('max_output_tokens','incomplete','narration incomplete'))
      .mockResolvedValueOnce(narration as never);
    const {before,after,result,trace_id}=await act(f,'伸个懒腰');
    expect(narrator).toHaveBeenCalledTimes(2);
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
    expect(after.last_turn?.narrative).toBe(narration.narrative);
    expect(f.service.logger.entries({limit:1000}).some(entry=>entry.trace_id===trace_id&&
      entry.event==='agent.recovery.decision'&&entry.metadata?.strategy==='retry_narration_candidate')).toBe(true);
  });
  it('uses a verified receipt after a terminal provider error without blind retries or rerunning the action',async()=>{
    const f=await fixture();
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal('attempt','伸个懒腰')]});
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({verdict:'aligned',explanation:'同一目标。'} as never);
    const freeform=vi.spyOn(f.ai,'freeform');
    const narrator=vi.spyOn(f.ai,'narrate').mockReset()
      .mockRejectedValue(new ProviderError('server_error','temporary','narration unavailable'));
    const {before,after,result}=await act(f,'伸个懒腰');
    expect(narrator).toHaveBeenCalledTimes(1);
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(result.outcome).toMatchObject({type:'game'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
    expect(after.last_turn?.narrative).not.toContain('narration unavailable');
    expect(f.service.logger.entries({event:'narrative.safe_fallback'}).length).toBeGreaterThan(0);
  });
});

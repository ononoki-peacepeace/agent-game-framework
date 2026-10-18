import {ProviderError} from '../src/ai/failures.js';
import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {interpretSemanticEntry} from '../src/agent/semantic-entry.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {routeContext} from '../src/system/context-router.js';

const worldRead=(answer:string)=>({domain:'world',kind:'read_only',confidence:.96,answer,
  answer_basis:'reasoned_advice',evidence_ids:[],clarification:null,speech_target_id:null,
  interaction_lane:'deterministic_read',player_speech_mode:null,open_goal_context:null});
const worldAction={domain:'world',kind:'world_action',confidence:.95,answer:null,answer_basis:null,
  evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'world_transaction',
  player_speech_mode:null,open_goal_context:null};

describe('semantic understanding bounded retry',()=>{
  it('repairs the REV 39 optional-null schema shape without another provider call or world write',async()=>{
    const f=await sparseSetup(async()=>({data:{...worldAction,open_goal_context:{
      destination:null,continuation:'none',search_query:null,travel_after_discovery:null,route_choice:null}}}));
    (f.ai.adapter as {name:string}).name='controlled-model';
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),
      '我想去另一处已经知道的地方看看','WORLD');
    expect(decision?.kind).toBe('world_action');
    expect(decision?.open_goal_context).toMatchObject({destination:null,continuation:'none'});
    expect(decision?.open_goal_context).not.toHaveProperty('travel_after_discovery');
    expect(f.calls).toHaveLength(1);
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('passes a non-deterministic schema error to the one bounded model repair and revalidates it',async()=>{
    let calls=0;
    const f=await sparseSetup(async()=>({data:++calls===1?
      {...worldAction,interaction_lane:'invalid_lane'}:worldAction}));
    (f.ai.adapter as {name:string}).name='controlled-model';
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),
      '我走到旁边看看','WORLD');
    expect(decision?.interaction_lane).toBe('world_transaction');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].prompt).toContain('interaction_lane');
    expect(f.calls[1].prompt).toContain('invalid_value');
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });
  it('does not execute or make a third provider call after two invalid schema candidates',async()=>{
    const f=await sparseSetup(async()=>({data:{...worldAction,interaction_lane:'invalid_lane'}}));
    (f.ai.adapter as {name:string}).name='controlled-model';
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),
      '我走到旁边看看','WORLD');
    expect(decision).toBeNull();
    expect(f.calls).toHaveLength(2);
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('executes once only after schema recovery has accepted the original perception goal',async()=>{
    let calls=0;
    const goal_spec={objective:'我仔细看看四周',play_action:'perceive',targets:[],desired_state:[],
      desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
      dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null};
    const candidate={...worldAction,goal_spec};
    const f=await sparseSetup(async()=>({data:++calls===1?
      {...candidate,interaction_lane:'invalid_lane'}:candidate}));
    (f.ai.adapter as {name:string}).name='controlled-model';
    const before=await f.service.current(),input='我仔细看看四周';
    const route=await routeContext(f.service,input,'world_input');
    expect(route.semantic?.goal_spec?.play_action).toBe('perceive');
    expect(f.calls).toHaveLength(2);
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
    vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'查看四周',minutes:2,target_id:null,
      facts:[],relationship:null,required_conditions:[],blocker:null,
      resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',
        stakes:'查看当前区域',stages:[],evidence_ids:[],discover_facts:true}} as never);
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你查看了四周，这次没有发现新的线索。',
      speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,
      item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({grounded:true,reports_result:true,
      reason:'调查结果已交代',unsupported_claims:[]} as never);
    const request_id=randomUUID();
    const response=await handleAgentInput(f.service,{game_id:before.game_id,
      expected_revision:before.state_revision,request_id,input},undefined,null,false,route.semantic);
    const after=await f.service.current();
    expect(after.resolution_receipts?.filter(receipt=>receipt.request_id===request_id)).toHaveLength(1);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+2);
    expect(response.message).toContain('没有发现新的线索');
  });
  it('returns a downgraded action to the same semantic owner before any world write',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent')
      .mockResolvedValueOnce(worldRead('房间目前很安静') as never)
      .mockResolvedValueOnce({preserved:false,reason:'玩家要求角色现场观察，不是查询旧资料'} as never)
      .mockResolvedValueOnce(worldAction as never);
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),'我想亲自确认屋里现在的情况','WORLD');
    expect(semantic).toHaveBeenCalledTimes(3);
    expect(semantic.mock.calls[2][2]).toMatchObject({semantic_recovery:{failure_code:'semantic_goal_mismatch'}});
    expect(decision?.kind).toBe('world_action');
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });
  it('rejects a scene lane that loses the physical goal and retries the original request',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent')
      .mockResolvedValueOnce({...worldAction,interaction_lane:'natural_scene'} as never)
      .mockResolvedValueOnce({preserved:false,reason:'候选只安排对话，未保留玩家的物理目标'} as never)
      .mockResolvedValueOnce(worldAction as never);
    const decision=await interpretSemanticEntry(f.service,f.service.project(await f.service.current()),
      '把桌上的物品拿到手中','WORLD');
    expect(semantic).toHaveBeenCalledTimes(3);
    expect(decision?.interaction_lane).toBe('world_transaction');
  });
  it('retries an unavailable semantic result once and executes only after the accepted result',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(worldAction as never);
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),'去河岸车站看看','WORLD',null);
    expect(semantic).toHaveBeenCalledTimes(2);
    expect(decision?.kind).toBe('world_action');
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });
  it('does not repeat a full semantic provider timeout with no candidate to repair',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,_data,_save,onFailure)=>{
      onFailure?.({reason:'timeout',detail:'The operation was aborted due to timeout'});
      return null;
    });
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),
      '请通知大家参加会议','WORLD');
    expect(decision).toBeNull();
    expect(semantic).toHaveBeenCalledTimes(1);
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });

  it('does not retry a deterministic Codex output-schema rejection',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,_data,_save,onFailure)=>{
      onFailure?.({reason:'invalid_provider_schema',detail:'unsupported propertyNames'});
      return null;
    });
    const before=await f.service.current();
    const decision=await interpretSemanticEntry(f.service,f.service.project(before),'请通知大家参加会议','WORLD');
    expect(decision).toBeNull();
    expect(semantic).toHaveBeenCalledTimes(1);
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });

  it('retries a schema-valid but semantically unusable result with a correction context',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent')
      .mockResolvedValueOnce({...worldRead(''),confidence:.95} as never)
      .mockResolvedValueOnce(worldRead('当前公开资料没有这项记录') as never)
      .mockResolvedValueOnce({preserved:true,reason:'保留了资料查询'} as never);
    const decision=await interpretSemanticEntry(f.service,f.service.project(await f.service.current()),'这个地方有记录吗','WORLD',null);
    expect(semantic).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(semantic.mock.calls[1][2])).toContain('上一份语义解释没有通过校验');
    expect(decision?.answer).toContain('没有这项记录');
  });

  it('preserves a valid clarification as a user-dependent outcome',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const ambiguous={domain:'ambiguous',kind:'clarification',confidence:.42,answer:null,answer_basis:null,
      evidence_ids:[],clarification:'请说明你的意思。',speech_target_id:null,interaction_lane:null,
      player_speech_mode:null,open_goal_context:null};
    const semantic=vi.spyOn(f.ai,'systemAgent')
      .mockResolvedValueOnce(ambiguous as never)
      .mockResolvedValueOnce(worldAction as never);
    const decision=await interpretSemanticEntry(f.service,f.service.project(await f.service.current()),'去河岸车站看看','WORLD',null);
    expect(semantic).toHaveBeenCalledTimes(1);
    expect(decision?.kind).toBe('clarification');
    expect(decision?.clarification?.trim().length).toBeGreaterThanOrEqual(4);
  });

  it('retries an unusable clarification with no actionable question',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const invalid={domain:'ambiguous',kind:'clarification',confidence:.42,answer:null,answer_basis:null,
      evidence_ids:[],clarification:'',speech_target_id:null,interaction_lane:null,
      player_speech_mode:null,open_goal_context:null};
    const semantic=vi.spyOn(f.ai,'systemAgent')
      .mockResolvedValueOnce(invalid as never)
      .mockResolvedValueOnce(worldAction as never);
    const decision=await interpretSemanticEntry(f.service,f.service.project(await f.service.current()),'去河岸车站看看','WORLD',null);
    expect(semantic).toHaveBeenCalledTimes(2);
    expect(decision?.kind).toBe('world_action');
  });

  it('stops after the bounded retry budget and leaves the world untouched',async()=>{
    const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
    const semantic=vi.spyOn(f.ai,'systemAgent').mockResolvedValue(null);
    const before=await f.service.current();
    const route=await routeContext(f.service,'去河岸车站看看','world_input');
    expect(semantic).toHaveBeenCalledTimes(2);
    expect(route.destination).toBe('AMBIGUOUS');
    expect(route.clarification).toContain('可重试原请求');
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
});

it('returns alignment feedback to the semantic owner once before committing a bounded attempt',async()=>{
 const f=await sparseSetup();(f.ai.adapter as {name:string}).name='controlled-model';
 const input='在接下来十秒内反复查看四周，不能继续时停止。';
 const base={objective:input,play_action:'perceive',targets:[],desired_state:[],desired_outputs:[],constraints:[],
  persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null};
 const revised={...worldAction,goal_spec:{...base,repetition:{source_quote:input,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable'}}};
 let audits=0,corrections=0;
 vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
  const d=data as any;
  if((_schema as any).shape?.grounded)return {grounded:true,reports_result:true,reason:'调查已反馈',unsupported_claims:[]} as never;
  if(d.proposed_steps){audits++;return (audits===1?{verdict:'incomplete',explanation:'原句授权十秒，GoalSpec错误缩短成两秒',semantic_revision:'repetition'}:
   {verdict:'aligned',explanation:'原始请求与修正契约一致',semantic_revision:'none'}) as never;}
  if(d.recovery){corrections++;expect(d.recovery).toMatchObject({failure_code:'repetition',failure_stage:'goal_alignment'});
   expect(d.input).toBe(input);return revised as never;}
  throw Error('unexpected extra interpretation');
 });
 vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'查看四周',minutes:1,target_id:null,facts:[],relationship:null,required_conditions:[],blocker:null,
  resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',stakes:'尝试查看',stages:[],evidence_ids:[],discover_facts:true}} as never);
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你反复查看四周，没有发现新的线索。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
 const before=await f.service.current();
 await handleAgentInput(f.service,{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input},undefined,null,false,
  {...worldAction,goal_spec:{...base,repetition:{...revised.goal_spec.repetition,duration_seconds:2}}} as never);
 const after=await f.service.current();
 expect(corrections).toBe(1);expect(audits).toBe(2);expect(after.state_revision).toBe(before.state_revision+1);
 expect(after.runtime.scene_seconds).toBe(10);
 expect(after.resolution_receipts?.at(-1)?.canonical_facts[0]).toContain('5 次');
});

  it('does not multiply the semantic budget with an inner truncation retry',async()=>{
    let calls=0;const f=await sparseSetup(async()=>{calls++;throw new ProviderError('max_output_tokens','isolated truncated output','truncated');});
    (f.ai.adapter as {name:string}).name='controlled-model';
    const before=await f.service.current();await interpretSemanticEntry(f.service,f.service.project(before),'我仔细看看四周','WORLD');
    expect(calls).toBe(2);expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });
  it('does not ask the model to repair a program error',async()=>{
    let calls=0;const f=await sparseSetup(async()=>{calls++;throw new TypeError('isolated program defect');});
    (f.ai.adapter as {name:string}).name='controlled-model';
    const before=await f.service.current();expect(await interpretSemanticEntry(f.service,f.service.project(before),'我仔细看看四周','WORLD')).toBeNull();
    expect(calls).toBe(1);expect((await f.service.current()).runtime.time).toEqual(before.runtime.time);
  });

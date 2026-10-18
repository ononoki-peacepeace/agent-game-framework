import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const goal=(goal_id:string,normalized_goal:string,operation_hint:'move'|'other',referent:string,
  depends_on:string[]=[]):GoalInput=>({goal_id,type:'WORLD_ACTION',normalized_goal,operation_hint,referent,
  depends_on,condition:null,branch:null,temporal_scope:temporal,target_entities:[]});

async function fixture(present:boolean,refuse=false){
  let decisions=0,scenes=0;
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.verdict)return {data:{verdict:'aligned',explanation:'准备步骤与最终目标均在计划内。'}} as never;
    if(properties.decision){
      decisions+=1;
      const decision=decisions===1?'transaction':present?'scene':'done';
      return {data:{decision,transaction:decision==='transaction'
        ?{kind:'move',destination:'河岸车站',minutes:null,reason:'前往真实地点'}:null,
        reason:decision==='done'?'现场没有可接触的人物。':null,question:null}} as never;
    }
    if(properties.understanding){
      scenes+=1;
      return {data:{understanding:'尝试与在场人物商谈',narrative:'你向在场的人提出请求。',
        dialogue:refuse?'不，我不愿意。':'我会考虑。',
        speech_events:[{speaker_id:'player',utterance:'可以谈一谈吗？',provenance:'generated_from_player_intent'},
          {speaker_id:'npc_lin',utterance:refuse?'不，我不愿意。':'我会考虑。',provenance:'npc_response'}],effects:[]}} as never;
    }
    if(request.role==='narrator')return {data:{narrative:'你到了河岸车站。',speaker:null,dialogue:null,
      choices:[],patches:[]}} as never;
    throw Error('unexpected AI call');
  });
  vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
    goal('travel','前往河岸车站','move','河岸车站'),
    goal('settle','达成交易并取得报酬','other','报酬',['travel'])]});
  const save=await f.service.current();
  const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
  npc.components.location={location_id:present?'station':'square'};
  await f.store.write(save);
  return {f,counts:()=>({decisions,scenes})};
}

async function run(input:string,present:boolean,refuse=false,speechMode:'none'|'intent'='intent'){
  const {f,counts}=await fixture(present,refuse),before=await f.service.current();
  const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
    expected_revision:before.state_revision,input},undefined,null,false,
    {kind:'world_action',interaction_lane:'world_transaction',player_speech_mode:speechMode} as never);
  return {before,after:await f.service.current(),result,counts:counts()};
}

describe('open goals with a later unsupported persistent effect',()=>{
  it.each([
    '去河岸车站卖画，有人买就收钱。',
    '去河岸车站找临时工作，谈好以后拿报酬。',
    '去河岸车站找人帮忙，谈好价格再成交。',
  ])('keeps executable progress for %s',async input=>{
    const {before,after,result,counts}=await run(input,true);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(after.runtime.time).not.toEqual(before.runtime.time);
    expect(after.narrative_history?.at(-1)?.player_input).toBe(input);
    expect(result.plan?.status).toBe('partial');
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    expect(result.presentation).toBe('story');
    expect(result.message).toContain('后续目标仍未发生');
    expect(result.message).not.toMatch(/capability|runtime_gap|已注册结算/);
    expect(counts.scenes).toBe(1);
    expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE']);
  });

  it('does not invent a partner in an empty destination or erase a committed MOVE',async()=>{
    const {before,after,result,counts}=await run('去河岸车站寻找愿意合作的人，谈成后收取报酬。',false);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(counts.scenes).toBe(0);
    expect(result.message).toContain('没有可以交谈的人');
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    expect(result.message).not.toContain('进行了场景交互');
  });

  it('preserves a real NPC refusal without claiming a transaction or payment',async()=>{
    const {after,result}=await run('去河岸车站向在场的人提出合作，谈成后拿报酬。',true,true);
    expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE']);
    expect(after.narrative_history?.at(-1)?.dialogue).toBe('不，我不愿意。');
    expect(result.message).toContain('不，我不愿意');
    expect(result.message).toContain('后续目标仍未发生');
    expect(result.presentation).toBe('story');
    expect(result.plan?.status).toBe('partial');
  });

  it('does not claim prior progress when an open-goal scene fails before any step',async()=>{
    const {f}=await fixture(true,false);
    const seeded=await f.service.current();
    const player=seeded.entities.find(entity=>entity.id===seeded.player_state.entity_id)!;
    player.components.location={location_id:'station'};
    await f.store.write(seeded);
    const before=await f.service.current();
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'去河岸车站找人谈谈。'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',player_speech_mode:'none',
        open_goal_context:{destination:'河岸车站',continuation:'natural_interaction_if_available'}} as never);
    const after=await f.service.current();
    expect(result.outcome).toMatchObject({type:'engine_failure'});
    expect(result.message).not.toMatch(/schema|provider|scene\./);
    expect(result.message).not.toContain('此前已提交');
    expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)??[]).toEqual([]);
  });
});

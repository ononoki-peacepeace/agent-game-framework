import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {SceneInteractionError} from '../src/agent/scene-interaction.js';
import * as sceneInteraction from '../src/agent/scene-interaction.js';

afterEach(()=>vi.restoreAllMocks());

async function facing(){
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
      answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:'npc_lin',
      interaction_lane:'natural_scene',player_speech_mode:'verbatim',
      goal_spec:{objective:'说话',play_action:'speak',targets:[],desired_state:[],desired_outputs:[],constraints:[],
        persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],world_mutation:false,
        external_artifact:false,multi_step:false,ambiguity:null}}} as never;
    if(properties.understanding)return {data:{understanding:'回答玩家的问题',narrative:'林舟停下来听你说话。',dialogue:'我听见了钟声。',
      speech_events:[{speaker_id:'player',utterance:'快说，你到底看到了什么？',provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:'我听见了钟声。',provenance:'npc_response'}],
      beats:[{kind:'narration',text:'林舟停下来听你说话。'},{kind:'speech',speech_index:0},{kind:'speech',speech_index:1}],effects:[]}} as never;
    throw Error('unexpected AI call');
  });
  const save=await f.service.current();
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
  npc.components.location=structuredClone(player.components.location);
  await f.store.write(save);
  return f;
}

describe('P0-A bounded cross-stage scene recovery',()=>{
  it('continues after two different failures, validates the final scene and commits exactly once',async()=>{
    const f=await facing(),original=sceneInteraction.runSceneInteraction;
    const spy=vi.spyOn(sceneInteraction,'runSceneInteraction')
      .mockRejectedValueOnce(new SceneInteractionError('PLAYER_SPEECH_NOT_REALIZED','speech_events_validation','漏掉已授权发言'))
      .mockRejectedValueOnce(new SceneInteractionError('PLAYER_SPEECH_OUT_OF_SCOPE','speech_alignment','玩家发言越出授权'))
      .mockImplementationOnce(original);
    const before=await f.service.current(),body={request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'快说，你到底看到了什么？'};
    const result=await handleAgentInput(f.service,body,undefined,'npc_lin',false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never);
    const after=await f.service.current();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2][6]).toMatchObject({failure_code:'PLAYER_SPEECH_OUT_OF_SCOPE',revision:before.state_revision});
    expect(spy.mock.calls.every(call=>call[3]===body.input)).toBe(true);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.last_turn?.scene_beats?.filter(beat=>beat.kind==='speech'&&beat.speaker_id==='player')).toHaveLength(1);
    const calls=f.ai.metrics.requests;
    await handleAgentInput(f.service,body,undefined,'npc_lin',false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never);
    expect(f.ai.metrics.requests).toBe(calls);expect(await f.service.current()).toEqual(after);
  });

  it('stops on immediate lack of progress and reports the actual attempt count',async()=>{
    const f=await facing();
    const spy=vi.spyOn(sceneInteraction,'runSceneInteraction').mockRejectedValue(
      new SceneInteractionError('PLAYER_SPEECH_NOT_REALIZED','speech_events_validation','漏掉已授权发言'));
    const before=await f.service.current();
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'快说，你到底看到了什么？'},undefined,'npc_lin',false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never);
    expect(spy).toHaveBeenCalledTimes(2);expect(result.recovery?.candidate_diagnostics).toMatchObject({attempts:2});
    expect(await f.service.current()).toEqual(before);
  });

  it('retries a different repairable category, then stops on a repeated category',async()=>{
    const f=await facing();
    const spy=vi.spyOn(sceneInteraction,'runSceneInteraction')
      .mockImplementationOnce(async()=>{throw new SceneInteractionError('PLAYER_SPEECH_NOT_REALIZED','speech_events_validation','场景没有实现已授权的玩家发言');})
      .mockImplementationOnce(async()=>{throw new SceneInteractionError('PLAYER_SPEECH_OUT_OF_SCOPE','speech_alignment','生成的玩家台词偏离原意');})
      .mockImplementationOnce(async()=>{throw new SceneInteractionError('PLAYER_SPEECH_OUT_OF_SCOPE','speech_alignment','生成的玩家台词偏离原意');});
    const before=await f.service.current();
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'快说，你到底看到了什么？'},
      undefined,'npc_lin',false,{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.outcome?.type).toBe('engine_failure');
    expect(result.presentation).toBe('failure');
    expect(result.recovery).toMatchObject({
      original_player_input:'快说，你到底看到了什么？',
      failure_stage:'natural_scene',
      failure_code:'schema_failure',
      committed_steps:[],receipt_ids:[],latest_revision:before.state_revision,state_certain:true,
    });
    expect(result.recovery?.candidate_diagnostics).toMatchObject({attempts:3,failed_category:'PLAYER_SPEECH_OUT_OF_SCOPE'});
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });
});

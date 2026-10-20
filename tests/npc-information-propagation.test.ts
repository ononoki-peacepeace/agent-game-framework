import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {validateSave} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {sceneEnsembleContext} from '../src/agent/scene-interaction.js';
import {recordSceneObservation,buildNpcAgentContext,admitNpcDecision} from '../src/agent/npc-agent.js';

/** Three characters: a speaker, a witness who may repeat it, and one who was never present. */
async function town(){
  const f=await sparseSetup(),save=await f.service.current();
  const player=save.entities.find(item=>item.id===save.player_state.entity_id)!;
  const here=String(player.components.location!.location_id);
  const source=save.entities.find(item=>item.id==='npc_lin')!;
  source.components.location={location_id:here};
  const witness=structuredClone(source);witness.id='npc_witness';
  witness.components.identity.name='听到的人';witness.components.location={location_id:here};
  const outsider=structuredClone(source);outsider.id='npc_outsider';
  outsider.components.identity.name='不在场的人';outsider.components.location={location_id:'station'};
  save.entities.push(witness,outsider);
  save.npc_agent_state={npc_lin:emptyNpcAgentState(),npc_witness:emptyNpcAgentState(),
    npc_outsider:emptyNpcAgentState()};
  return {f,save,here};
}

describe('sourced NPC information propagation',()=>{
  it('forms hearsay only for present listeners and lets a witness carry it to a second hop',async()=>{
    const {save}=await town(),first=randomUUID();
    recordSceneObservation(save,first,[{speaker_id:'npc_lin',utterance:'仓库的钥匙昨晚不见了。'}],
      ['npc_witness']);
    const learned=save.npc_agent_state!.npc_witness.knowledge;
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({id:`heard:${first}:npc_lin`,source_type:'told_by',
      source_ref:'npc_lin',confidence:0.4,learned_at:save.runtime.time});
    expect(learned[0].proposition).toContain('仓库的钥匙昨晚不见了。');
    // The source is named, and the record stays that person's claim rather than world truth.
    expect(learned[0].proposition).toContain(String(
      save.entities.find(item=>item.id==='npc_lin')!.components.identity!.name));
    expect(learned[0].proposition).toContain('未核实');
    // Nobody who was absent learns anything, and the speaker does not quote itself.
    expect(save.npc_agent_state!.npc_outsider.knowledge).toEqual([]);
    expect(save.npc_agent_state!.npc_outsider.memories).toEqual([]);
    expect(save.npc_agent_state!.npc_lin.knowledge).toEqual([]);

    // Second hop: the witness repeats it where someone else can hear.
    const second=randomUUID();
    recordSceneObservation(save,second,[{speaker_id:'npc_witness',utterance:'听说仓库的钥匙不见了。'}],
      ['npc_outsider']);
    const relayed=save.npc_agent_state!.npc_outsider.knowledge;
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({source_type:'told_by',source_ref:'npc_witness'});
    expect(relayed[0].proposition).toContain('仓库的钥匙不见了。');
    expect(validateSave(structuredClone(save))).toBeDefined();
  });

  it('ignores questions and fragments, replays idempotently and keeps hearsay out of absent minds',async()=>{
    const {save}=await town(),requestId=randomUUID();
    recordSceneObservation(save,requestId,[
      {speaker_id:save.player_state.entity_id,utterance:'你知道仓库的事吗？'},
      {speaker_id:save.player_state.entity_id,utterance:'嗯。'},
    ],['npc_witness']);
    expect(save.npc_agent_state!.npc_witness.knowledge).toEqual([]);
    expect(save.npc_agent_state!.npc_witness.memories).toHaveLength(1);

    const informative=randomUUID();
    recordSceneObservation(save,informative,[
      {speaker_id:'npc_lin',utterance:'那扇门整晚都开着。'},
      {speaker_id:'npc_lin',utterance:'你看见是谁了吗？'},
    ],['npc_witness']);
    const entry=save.npc_agent_state!.npc_witness.knowledge.at(-1)!;
    expect(entry.proposition).toContain('那扇门整晚都开着。');
    expect(entry.proposition).not.toContain('你看见是谁了吗？');
    recordSceneObservation(save,informative,[{speaker_id:'npc_lin',utterance:'重放不应新增条目。'}],
      ['npc_witness']);
    expect(save.npc_agent_state!.npc_witness.knowledge).toHaveLength(1);
    expect(save.npc_agent_state!.npc_witness.knowledge.at(-1)).toEqual(entry);
  });

  it('keeps first-hand knowledge when hearsay reaches the private capacity',async()=>{
    const {save}=await town();
    const state=save.npc_agent_state!.npc_witness;
    state.knowledge.push({id:'firsthand',proposition:'我亲眼看见门开着',source_type:'observed',
      source_ref:null,learned_at:save.runtime.time,confidence:0.9});
    for(let index=0;index<90;index++)
      recordSceneObservation(save,`rumor-${index}`,
        [{speaker_id:'npc_lin',utterance:`第${index}条听说的消息内容。`}],['npc_witness']);
    const kept=save.npc_agent_state!.npc_witness.knowledge;
    expect(kept.length).toBeLessThanOrEqual(80);
    expect(kept.some(item=>item.id==='firsthand')).toBe(true);
    expect(kept.filter(item=>item.source_type==='told_by').length).toBe(kept.length-1);
    // Eviction drops the oldest rumours, not the newest ones.
    expect(kept.some(item=>item.id==='heard:rumor-89:npc_lin')).toBe(true);
    expect(kept.some(item=>item.id==='heard:rumor-0:npc_lin')).toBe(false);
    expect(validateSave(structuredClone(save))).toBeDefined();
  });

  it('does not buy a bystander a dedicated decision call just for overhearing',async()=>{
    const {save}=await town();
    const witness=save.entities.find(item=>item.id==='npc_witness')!;
    witness.components.world_resident={origin_incident_id:'origin',entrance_reason:'在场',
      created_at:save.runtime.time,entered_world_at:save.runtime.time,importance:'minor',
      lifecycle:'active',home_location_id:null,motivation:'照看自己的事'};
    expect(admitNpcDecision(save,'npc_witness','direct_scene')).toBe(false);
    recordSceneObservation(save,randomUUID(),
      [{speaker_id:'npc_lin',utterance:'仓库那边出了点事。'}],['npc_witness']);
    expect(save.npc_agent_state!.npc_witness.knowledge).toHaveLength(1);
    expect(admitNpcDecision(save,'npc_witness','direct_scene')).toBe(false);
    // First-hand knowledge, an active goal or a private fact is still a real stake.
    save.npc_agent_state!.npc_witness.knowledge.push({id:'saw',proposition:'亲眼看见门开着',
      source_type:'observed',source_ref:null,learned_at:save.runtime.time,confidence:0.9});
    expect(admitNpcDecision(save,'npc_witness','direct_scene')).toBe(true);
  });

  it('exposes learned hearsay with its source to the listener own decision and scene context',async()=>{
    const {save}=await town(),requestId=randomUUID();
    recordSceneObservation(save,requestId,[{speaker_id:'npc_lin',utterance:'站台今晚会关门。'}],
      ['npc_witness']);
    const reloaded=validateSave(structuredClone(save));
    const context=buildNpcAgentContext(reloaded,'npc_witness',
      {kind:'direct_scene',description:'有人提到站台'});
    expect(context.knowledge.some(item=>item.id===`heard:${requestId}:npc_lin`)).toBe(true);
    expect(context.knowledge.find(item=>item.id===`heard:${requestId}:npc_lin`)!.source_type)
      .toBe('told_by');
    // The character who was never told must not see it in their own decision context.
    expect(JSON.stringify(buildNpcAgentContext(reloaded,'npc_outsider',
      {kind:'direct_scene',description:'有人提到站台'}))).not.toContain('站台今晚会关门');
    const ensemble=sceneEnsembleContext(reloaded,
      reloaded.entities.filter(item=>item.id==='npc_witness'||item.id==='npc_outsider'));
    const listener=ensemble.find(item=>item.npc_id==='npc_witness')!;
    expect(JSON.stringify(listener.subjective_knowledge)).toContain('站台今晚会关门');
    expect(JSON.stringify(listener.subjective_knowledge)).toContain('told_by');
    expect(JSON.stringify(ensemble.find(item=>item.npc_id==='npc_outsider')!))
      .not.toContain('站台今晚会关门');
  });
});

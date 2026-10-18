import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { interpretSemanticEntry } from '../src/agent/semantic-entry.js';
import { handleAgentInput } from '../src/agent/executor.js';

/** The provider insists on "ambiguous"; the program guard is what decides the lane when somebody is faced. */
const ambiguous = { data: { domain: 'ambiguous', kind: 'clarification', confidence: 0.9, answer: null, answer_basis: null,
  evidence_ids: [], clarification: '你想问什么？', clarification_cause:'unverified_premise',
  speech_target_id: null, interaction_lane: 'deterministic_read' } };

async function facing(secondNpc = false,clarificationCause:'unverified_premise'|'other'='unverified_premise') {
  let sceneCalls = 0;
  const f = await sparseSetup(async request => {
    const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if (properties.interaction_lane) return {data:{...ambiguous.data,clarification_cause:clarificationCause}} as never;
    if (properties.understanding) { sceneCalls += 1; return { data: { understanding: '闲聊', narrative: '他抬起头。', dialogue: '在家？我刚从外面回来啊。', speech_events:[{speaker_id:'npc_lin',utterance:'在家？我刚从外面回来啊。',provenance:'npc_response'}], effects: [] } } as never; }
    if (request.role === 'narrator') return { data: { narrative: '你照做了。', speaker: null, dialogue: null, choices: [], patches: [] } } as never;
    throw new Error('unexpected AI call');
  });
  const save = await f.service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
  npc.components.location = structuredClone(player.components.location);
  if (secondNpc) { const other = structuredClone(npc); other.id = 'npc_second'; other.components.identity.name = '另一个人'; save.entities.push(other); }
  await f.store.write(save);
  return { f, npcId: npc.id, sceneCalls: () => sceneCalls };
}
const laneFor = async (f: Awaited<ReturnType<typeof facing>>, input: string) => {
  const view = (await f.f.service.view())!;
  const save = await f.f.service.current();
  const decision = await interpretSemanticEntry(f.f.service, view, input, 'WORLD', null);
  expect(decision, `no decision for ${input}`).not.toBeNull();
  return { decision: decision!, save };
};

describe('scene lane guards', () => {
  it('does not confuse a world action submitted during NPC conversation with an absent conversation target',async()=>{
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.resolution)return {data:{narrative:'查看当前环境',minutes:1,target_id:null,facts:[],relationship:null,
        resolution:{type:'DETERMINISTIC',domain:'perception',band:'trivial',visibility:'public',stakes:'本次无新发现',stages:[],evidence_ids:[],discover_facts:true}}};
      if(properties.preserved)return {data:{preserved:true,reason:'执行原始观察请求'}};
      if(properties.verdict)return {data:{verdict:'aligned',explanation:'单步观察符合请求'}};
      if(request.role==='narrator')return {data:{narrative:'你查看眼前的环境，在这次范围内没有新的发现。',speaker:null,dialogue:null,choices:[],patches:[]}};
      throw Error(`unexpected provider role ${request.role}`);
    });
    const before=await f.service.current();
    const response=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'观察周围环境',interaction:{source:'npc_interaction',target_id:'npc_lin',mode:'conversation'}},
      undefined,'npc_lin',false,{kind:'world_action',interaction_lane:'world_transaction',player_speech_mode:'none'} as never);
    expect(response.message).not.toContain('交谈对象已不在');
    const after=await f.service.current();
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(after.resolution_receipts?.at(-1)?.commit_status).toBe('committed');
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+1);
  });
  // Speech act wins over presupposition fact-checking: the NPC answers, the framework does not fact-check first.
  for (const input of ['你今天怎么这么早就在家？', '你不是说昨天要上班吗？', '你看起来心情不太好。', '你不是住二楼吗？']) {
    it(`treats "${input}" as speech to the person in front of the player`, async () => {
      const f = await facing();
      const { decision } = await laneFor(f, input);
      expect(decision.interaction_lane).toBe('natural_scene');
      expect(decision.kind).toBe('world_action');
      expect(decision.clarification ?? null).toBeNull();
      // The unverified premise is dialogue, never a committed world fact.
      expect(decision.answer ?? null).toBeNull();
    });
  }

  it('runs the guarded turn without a TALK transaction or a committed presupposition', async () => {
    const f = await facing();
    const before = await f.f.service.current();
    const decision = (await interpretSemanticEntry(f.f.service, (await f.f.service.view())!, '你今天怎么这么早就在家？', 'WORLD', null))!;
    const result = await handleAgentInput(f.f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input: '你今天怎么这么早就在家？' }, undefined, decision.speech_target_id ?? null, false, decision);
    const after = await f.f.service.current();
    expect(result.presentation).toBe('story');
    expect(after.resolution_receipts?.length ?? 0).toBe(before.resolution_receipts?.length ?? 0);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.last_turn?.dialogue).toContain('我刚从外面回来');
  });

  it('preserves a genuine player-dependent ambiguity even when one character is present', async () => {
    const f = await facing(false,'other');
    const { decision } = await laneFor(f, '帮我把那个处理一下。');
    expect(decision.kind).toBe('clarification');
    expect(decision.interaction_lane).not.toBe('natural_scene');
  });

  it('never auto-enters the scene lane when the open goal does not ask for interaction', async () => {
    let sceneCalls = 0;
    const f = await sparseSetup(async request => {
      const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if (properties.decision) return { data: { decision: 'transaction', transaction: { kind: 'move', destination: '河岸车站', minutes: null, reason: '去买票' }, reason: null, question: null } } as never;
      if (properties.understanding) { sceneCalls += 1; return { data: { understanding: '打招呼', narrative: '你打了招呼。', dialogue: '你好。', speech_events:[{speaker_id:'npc_lin',utterance:'你好。',provenance:'npc_response'}], effects: [] } } as never; }
      if (request.role === 'narrator') return { data: { narrative: '你走到了车站。', speaker: null, dialogue: null, choices: [], patches: [] } } as never;
      throw new Error('unexpected AI call');
    });
    const save = await f.service.current();
    const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
    const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
    npc.components.location = { location_id: 'station' };
    player.components.location = { location_id: 'square' };
    await f.store.write(save);
    const before = await f.service.current();
    await handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input: '去车站买票。' }, undefined, null, false,
      { kind: 'world_action', interaction_lane: 'open_goal', open_goal_context: { destination: '河岸车站', continuation: 'none' } } as never);
    const after = await f.service.current();
    expect((after.resolution_receipts ?? []).filter(receipt => receipt.semantic_action === 'MOVE')).toHaveLength(1);
    expect(sceneCalls).toBe(0);
    expect(after.last_turn?.dialogue ?? null).toBeNull();
  });
});

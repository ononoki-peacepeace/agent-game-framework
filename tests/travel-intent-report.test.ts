import { describe, expect, it } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { deriveWorldQuery } from '../src/agent/truth-query.js';

/** The assistant must be able to cite recorded public travel intents and the lines that produced them. */
async function fixture() {
  let captured: { evidence?: { id: string; kind: string; value: unknown }[]; instruction?: string } = {};
  const f = await sparseSetup(async request => {
    const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if (properties.evidence_ids) {
      const marker=Math.max(request.prompt.lastIndexOf('{"question"'),request.prompt.lastIndexOf('{"instruction"'));
      const data = JSON.parse(request.prompt.slice(marker)) as {
        evidence: { id: string; kind: string; value: unknown }[]; instruction?: string };
      captured = { evidence: data.evidence, instruction: data.instruction };
      return { data: { status: 'FOUND', kind: 'fact',
        answer: '神代千尋 和 エレナ・コヴァーチ 当时都只是附条件同意：说不清去向、不先定起点就不跟着走，出发前没有形成明确同意的记录。',
        evidence_ids: ['travel_intent:npc_lin', 'speech:0:0'], rule_evidence_ids: [], missing_information: [] } } as never;
    }
    throw new Error('unexpected AI call');
  });
  const save = await f.service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
  npc.components.location = { location_id: 'square' };
  save.npc_agent_state = save.npc_agent_state ?? {};
  save.npc_agent_state[npc.id] = {
    ...(save.npc_agent_state[npc.id] ?? { knowledge: [], beliefs: [], memories: [], goals: [], plans: [], private_facts: [], last_decisions: [] }),
    travel_intent: { status: 'conditional', origin_location_id: 'square', source_request_id: '11111111-1111-4111-8111-111111111111', recorded_revision: save.state_revision },
  };
  save.narrative_history = [{
    request_id: '11111111-1111-4111-8111-111111111111', narrative: '你们在宿舍里商量。', dialogue: null, speaker: null, facts: [],
    speech_events: [{ speaker_id: npc.id, utterance: '……你们打算走到哪儿为止？说不清的话，我不跟着走。', provenance: 'npc_response', source_intent: null }],
  }];
  await f.store.write(save);
  return { f, npcId: npc.id, captured: () => captured };
}

describe('assistant reports recorded travel intentions', () => {
  it('puts the recorded intent and the public lines into the read-only evidence', async () => {
    const { f, npcId, captured } = await fixture();
    const view = (await f.service.view())!;
    const answer = await deriveWorldQuery(f.service, view, '她们不是答应过要一起走吗，为什么没跟来？');
    const evidence = captured().evidence ?? [];
    const intent = evidence.find(item => item.id === `travel_intent:${npcId}`);
    expect(intent).toBeTruthy();
    expect(intent!.value).toMatchObject({ status: 'conditional' });
    const speech = evidence.filter(item => item.id.startsWith('speech:'));
    expect(speech.some(item => JSON.stringify(item.value).includes('不跟着走'))).toBe(true);
    // Only the public projection is handed over: four intent fields plus recorded lines, never the NPC's whole
    // agent state (beliefs/plans/goals/private_facts) and never a private field name.
    expect(Object.keys(intent!.value as Record<string, unknown>).sort()).toEqual(['npc_id', 'origin_location_id', 'recorded_revision', 'status']);
    expect(JSON.stringify(evidence)).not.toContain('private_facts');
    expect(evidence.filter(item => item.id.startsWith('npc_agent_state')).length).toBe(0);
    expect(String(captured().instruction)).toContain('travel_intent');
    expect(answer.message).toContain('附条件');
    expect(answer.message).not.toContain('完全没有可确认');
  });

  it('never turns plain absence of a MOVE record into a private refusal, and never exposes inner state', async () => {
    let captured: { evidence?: { id: string; kind: string; value: unknown }[]; instruction?: string } = {};
    const f = await sparseSetup(async request => {
      const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if (properties.evidence_ids) {
        const marker = Math.max(request.prompt.lastIndexOf('{"question"'), request.prompt.lastIndexOf('{"instruction"'));
        const data = JSON.parse(request.prompt.slice(marker)) as {
          evidence: { id: string; kind: string; value: unknown }[]; instruction?: string };
        captured = { evidence: data.evidence, instruction: data.instruction };
        return { data: { status: 'UNKNOWN', kind: 'inference', answer: '目前公开记录里没有可确认的同行表态。',
          evidence_ids: [], rule_evidence_ids: [], missing_information: ['没有已提交的同行表态记录'] } } as never;
      }
      throw new Error('unexpected AI call');
    });
    const save = await f.service.current();
    const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
    // The person is somewhere else and never recorded any intention or public line at all.
    const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
    npc.components.location = { location_id: 'station' };
    save.npc_agent_state = save.npc_agent_state ?? {};
    save.npc_agent_state[npc.id] = { ...(save.npc_agent_state[npc.id] ?? { knowledge: [], beliefs: [], memories: [],
      goals: [], plans: [], private_facts: [], last_decisions: [] }),
      private_facts: [{ id: 'secret', proposition: '其实我并不想跟着去。', source_ref: null }] };
    await f.store.write(save);
    const view = (await f.service.view())!;
    await deriveWorldQuery(f.service, view, '她为什么没跟我一起出发？');
    const evidence = captured.evidence ?? [];
    // Nothing was ever expressed, so there is nothing to cite as a decision — and no private cognition leaks in.
    expect(evidence.filter(item => item.id.startsWith('travel_intent:')).length).toBe(0);
    expect(evidence.filter(item => item.id.startsWith('npc_agent_state')).length).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain('其实我并不想跟着去');
    expect(JSON.stringify(evidence)).not.toContain('private_facts');
    expect(String(captured.instruction)).toContain('不得据此推断人物自己决定留下');
    expect(String(captured.instruction)).toContain('绝不引用 beliefs/plans/goals/private_facts');
  });
});

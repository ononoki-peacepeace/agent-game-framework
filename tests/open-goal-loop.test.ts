import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { handleAgentInput } from '../src/agent/executor.js';

type Step = { decision: 'transaction' | 'scene' | 'done' | 'clarify'; destination?: string; minutes?: number; question?: string; reason?: string };
type Lane = { kind: 'world_action'; interaction_lane: 'open_goal'; open_goal_context: { destination: string | null; continuation: 'natural_interaction_if_available' | 'none' } };

async function goalFixture(script: Step[], npcAt: 'station' | 'square') {
  let stepCalls = 0, sceneCalls = 0;
  const f = await sparseSetup(async request => {
    const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if (properties.decision) {
      const next = script[Math.min(stepCalls, script.length - 1)];
      stepCalls += 1;
      return { data: { decision: next.decision, transaction: next.decision === 'transaction'
        ? { kind: next.minutes ? 'wait' : 'move', destination: next.destination ?? null, minutes: next.minutes ?? null, reason: next.reason ?? '下一步' } : null,
        reason: next.reason ?? null, question: next.question ?? null } } as never;
    }
    if (properties.understanding) { sceneCalls += 1; return { data: { understanding: '与遇到的人交谈', narrative: '你和他聊了几句。', dialogue: '最近还行，你呢？', speech_events:[{speaker_id:'npc_lin',utterance:'最近还行，你呢？',provenance:'npc_response'}], effects: [] } } as never; }
    if (request.role === 'narrator') return { data: { narrative: '你走到了车站。', speaker: null, dialogue: null, choices: [], patches: [] } } as never;
    throw new Error('unexpected AI call');
  });
  const save = await f.service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
  npc.components.location = { location_id: npcAt };
  player.components.location = { location_id: 'square' };
  await f.store.write(save);
  return { f, counts: () => ({ stepCalls, sceneCalls }) };
}
const run = async (f: { service: Parameters<typeof handleAgentInput>[0] }, input: string, lane: Lane) => {
  const before = await f.service.current();
  return handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input }, undefined, null, false, lane as never);
};
const kinds = (save: { resolution_receipts?: { semantic_action?: string }[] }) => (save.resolution_receipts ?? []).map(receipt => receipt.semantic_action);
const toward = (destination: string): Lane => ({ kind: 'world_action', interaction_lane: 'open_goal', open_goal_context: { destination, continuation: 'natural_interaction_if_available' } });

describe('open goal: transaction → canonical refresh → scene continuation', () => {
  it('moves, re-reads the canonical scene, then continues in the natural scene lane without a TALK receipt', async () => {
    const { f, counts } = await goalFixture([{ decision: 'transaction', destination: '河岸车站' }], 'station');
    const result = await run(f, '去河岸车站看看有没有人，如果碰到人的话就聊两句。', toward('河岸车站'));
    const after = await f.service.current();
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(kinds(after)).not.toContain('TALK');
    expect(after.last_turn?.dialogue).toContain('最近还行');
    expect(counts()).toEqual({ stepCalls: 0, sceneCalls: 1 });
    expect(String(result.message)).toContain('你和他聊了几句');
  });

  it('ends naturally when the refreshed destination has nobody, and never waits for an absent person', async () => {
    const { f, counts } = await goalFixture([{ decision: 'transaction', destination: '河岸车站' }, { decision: 'done', reason: '站台上没有人。' }], 'square');
    const result = await run(f, '去河岸车站看看有没有人，如果碰到人的话就聊两句。', toward('河岸车站'));
    const after = await f.service.current();
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(kinds(after)).not.toContain('WAIT');
    expect(kinds(after)).not.toContain('TALK');
    expect(counts().sceneCalls).toBe(0);
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    expect(String(result.message)).toContain('没有可以交谈的人');
  });

  it('never repeats a committed step and stays inside the bounded step limit', async () => {
    const { f, counts } = await goalFixture([{ decision: 'transaction', destination: '河岸车站' }], 'square');
    await run(f, '去河岸车站看看有没有人，如果碰到人的话就聊两句。', toward('河岸车站'));
    const after = await f.service.current();
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(counts().stepCalls).toBeLessThanOrEqual(2);
  });

  it('does not consume the destination continuation with somebody standing at the origin', async () => {
    const { f, counts } = await goalFixture([{ decision: 'done', reason: '没有可做的事。' }], 'square');
    await run(f, '去河岸车站看看有没有人，如果碰到人的话就聊两句。', toward('河岸车站'));
    const after = await f.service.current();
    // The person at the origin is not the goal's destination partner, so no scene beat happens there.
    expect(counts().sceneCalls).toBe(0);
    expect(kinds(after)).not.toContain('TALK');
  });

  it('asks the player instead of acting when the goal itself is underspecified', async () => {
    const { f, counts } = await goalFixture([{ decision: 'clarify', question: '你说的“他”是指哪一位？' }], 'station');
    const before = await f.service.current();
    const result = await run(f, '去看看他在不在，在的话聊两句。', { kind: 'world_action', interaction_lane: 'open_goal', open_goal_context: { destination: null, continuation: 'natural_interaction_if_available' } });
    const after = await f.service.current();
    expect(String(result.clarification ?? result.message)).toContain('哪一位');
    expect(kinds(after).length).toBe(kinds(before).length);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(counts().sceneCalls).toBe(0);
  });
});

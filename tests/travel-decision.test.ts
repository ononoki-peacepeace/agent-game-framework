import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { handleAgentInput } from '../src/agent/executor.js';
import { emptyNpcAgentState } from '../src/agent/npc-state.js';
import { applyDepartureTravelDecisions, conditionalTravelCandidates } from '../src/agent/travel-decision.js';
import type { SavePackage } from '../src/core/schema.js';

type Lane = { kind: 'world_action'; interaction_lane: 'open_goal';
  open_goal_context: { destination: string | null; continuation: 'natural_interaction_if_available' | 'none' } };
type Decision = { npc_id: string; status: 'willing' | 'conditional' | 'declined'; line: string | null };

const toward = (destination: string, continuation: Lane['open_goal_context']['continuation'] = 'none'): Lane =>
  ({ kind: 'world_action', interaction_lane: 'open_goal', open_goal_context: { destination, continuation } });
const loc = (save: SavePackage, id: string) => String(save.entities.find(entity => entity.id === id)?.components.location?.location_id ?? '');
const kinds = (save: SavePackage) => (save.resolution_receipts ?? []).map(receipt => receipt.semantic_action);

/** Two on-scene people who publicly asked for a condition before the player ever left. */
async function fixture(options: {
  decisions: Decision[] | 'throw';
  status?: 'conditional' | 'willing' | 'declined';
  sentinel?: string;
}) {
  const prompts: string[] = [];
  let decisionCalls = 0;
  const f = await sparseSetup(async request => {
    const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if (properties.decisions) {
      decisionCalls += 1;
      prompts.push(request.prompt);
      if (options.decisions === 'throw') throw new Error('provider unavailable');
      return { data: { decisions: options.decisions } } as never;
    }
    if (properties.decision) return { data: { decision: 'done', transaction: null, reason: '没有更多步骤。', question: null } } as never;
    if (properties.verdict) return { data: { verdict: 'aligned', explanation: '与玩家原请求一致。' } } as never;
    if (request.role === 'narrator') return { data: { narrative: '你们动身了。', speaker: null, dialogue: null, choices: [], patches: [] } } as never;
    throw new Error('unexpected AI call');
  });
  const save = await f.service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  player.components.location = { location_id: 'square' };
  const lin = save.entities.find(entity => entity.id === 'npc_lin')!;
  const qiao = save.entities.find(entity => entity.id === 'npc_qiao')!;
  lin.components.location = { location_id: 'square' };
  qiao.components.location = { location_id: 'square' };
  save.npc_agent_state = save.npc_agent_state ?? {};
  for (const npc of [lin, qiao]) {
    save.npc_agent_state[npc.id] = { ...emptyNpcAgentState(),
      travel_intent: { status: options.status ?? 'conditional', origin_location_id: 'square',
        source_request_id: '22222222-2222-4222-8222-222222222222', recorded_revision: save.state_revision } };
  }
  save.narrative_history = [{ request_id: '22222222-2222-4222-8222-222222222222', narrative: '你们在广场上商量。',
    dialogue: null, speaker: null, facts: [],
    speech_events: [
      { speaker_id: 'npc_lin', utterance: '要去哪儿？说不清的话我先不跟着走。', provenance: 'npc_response', source_intent: null },
      { speaker_id: 'npc_qiao', utterance: '我可以去，但你得先说清方向。', provenance: 'npc_response', source_intent: null },
    ] }];
  if (options.sentinel) save.gm_state.notes = options.sentinel;
  await f.store.write(save);
  return { f, prompts, decisionCalls: () => decisionCalls };
}

async function run(f: { service: Parameters<typeof handleAgentInput>[0] }, input: string, lane: Lane, requestId = randomUUID()) {
  const before = await f.service.current();
  return handleAgentInput(f.service, { request_id: requestId, game_id: before.game_id,
    expected_revision: before.state_revision, input }, undefined, null, false, lane as never);
}

describe('conditional companion re-decision at departure', () => {
  it('lets one conditional person join and another refuse, before the authoritative MOVE', async () => {
    const { f, decisionCalls } = await fixture({ decisions: [
      { npc_id: 'npc_lin', status: 'willing', line: '好，那就去街角商店看看。' },
      { npc_id: 'npc_qiao', status: 'declined', line: '我还是留在这儿。' },
    ] });
    const before = await f.service.current();
    const result = await run(f, '我们一起去街角商店吧。', toward('街角商店'));
    const after = await f.service.current();
    // Exactly one model call decides for both people, and the MOVE is the only world settlement.
    expect(decisionCalls()).toBe(1);
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(loc(after, 'npc_lin')).toBe('market');
    expect(loc(after, 'npc_qiao')).toBe('square');
    expect(after.npc_agent_state!.npc_lin.travel_intent).toMatchObject({ status: 'willing', origin_location_id: 'market' });
    expect(after.npc_agent_state!.npc_qiao.travel_intent).toMatchObject({ status: 'declined', origin_location_id: 'square' });
    // Time advances once for the group, never once per head.
    expect(after.runtime.time.day - before.runtime.time.day).toBe(0);
    expect(after.runtime.time.minute - before.runtime.time.minute).toBe(6);
    // Only the person who actually walked is described as arriving together.
    const facts = after.narrative_history?.at(-1)?.facts ?? [];
    expect(facts.some(fact => fact.includes('同行') && fact.includes('林舟'))).toBe(true);
    expect(facts.some(fact => fact.includes('乔宁'))).toBe(false);
    // Departure speech and arrival share the atomic MOVE commit but retain distinct event locations and times.
    expect(after.narrative_history?.at(-1)?.player_input).toBe('我们一起去街角商店吧。');
    expect(after.narrative_history?.at(-2)?.location_id).toBe('square');
    expect(after.narrative_history?.at(-1)?.location_id).toBe('market');
    expect(after.narrative_history?.at(-2)?.speech_events?.map(event => event.utterance))
      .toEqual(['好，那就去街角商店看看。', '我还是留在这儿。']);
    expect(String(result.message)).toContain('你们动身了');
  });

  it('carries two already-willing people on the next real MOVE without any extra model call', async () => {
    const { f, decisionCalls } = await fixture({ decisions: [], status: 'willing' });
    const before = await f.service.current();
    await run(f, '我们出发吧。', toward('街角商店'));
    const after = await f.service.current();
    expect(decisionCalls()).toBe(0);
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(loc(after, 'npc_lin')).toBe('market');
    expect(loc(after, 'npc_qiao')).toBe('market');
    expect(after.runtime.time.minute - before.runtime.time.minute).toBe(6);
  });

  it('does not spend a call on ordinary solo movement', async () => {
    const { f, decisionCalls } = await fixture({ decisions: [] });
    const first = await f.service.current();
    // An internal / unsolicited MOVE carries neither the player's words nor a request id.
    await f.service.turn({ game_id: first.game_id, expected_revision: first.state_revision,
      request_id: randomUUID(), action: { type: 'MOVE', target_id: 'market', parameters: {} } });
    expect(decisionCalls()).toBe(0);
    const second = await f.service.current();
    expect(loc(second, 'npc_lin')).toBe('square');
    expect(loc(second, 'npc_qiao')).toBe('square');
  });

  it('never re-decides the same player request', async () => {
    const { f, decisionCalls } = await fixture({ decisions: [
      { npc_id: 'npc_lin', status: 'willing', line: null },
      { npc_id: 'npc_qiao', status: 'conditional', line: null },
    ] });
    const before = await f.service.current();
    const request = randomUUID();
    const first = await applyDepartureTravelDecisions(f.service, before, f.service.project(before),
      { actorId: before.player_state.entity_id, requestId: request, playerInput: '我们一起走。', moveDestinationId: 'market' });
    expect(first).not.toBeNull();
    expect(decisionCalls()).toBe(1);
    // The committing transaction stamps the receipt; a later leg of the same request then skips the call.
    const stamped = structuredClone(first!.save);
    stamped.runtime.receipts = [...stamped.runtime.receipts,
      { id: first!.receiptId, fingerprint: first!.fingerprint, revision: stamped.state_revision }];
    const second = await applyDepartureTravelDecisions(f.service, stamped, f.service.project(stamped),
      { actorId: stamped.player_state.entity_id, requestId: request, playerInput: '我们一起走。', moveDestinationId: 'market' });
    expect(second).toBeNull();
    expect(decisionCalls()).toBe(1);
  });

  it('keeps the decision public: no internal plan, route or hidden note reaches the people', async () => {
    const secret = '内部路线-秘密-777';
    const { f, prompts } = await fixture({ decisions: [
      { npc_id: 'npc_lin', status: 'conditional', line: null },
      { npc_id: 'npc_qiao', status: 'conditional', line: null },
    ], sentinel: secret });
    await run(f, '我们先过去看看吧。', toward('街角商店'));
    const prompt = prompts[0] ?? '';
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain('active_goal');
    expect(prompt).not.toContain('gm_state');
    // The player never named the place, so the model is told the move is only an observable next step.
    expect(prompt).toContain('"observed_move_destination":"街角商店"');
    expect(prompt).toContain('"player_public_statement":"我们先过去看看吧。"');
    expect(prompt).toContain('不能假定人物知道最终要去哪里');
    // The public condition lines are the only grounds the people are given.
    expect(prompt).toContain('说不清的话我先不跟着走');
  });

  it('also fires on the bound single-MOVE contract path, not only the open-goal loop', async () => {
    // The real DeepSeek run of "那我们出发去街角商店吧。" reached the plan contract path (stage=contract_plan),
    // so the re-decision must not depend on the open-goal loop alone.
    const { f, decisionCalls } = await fixture({ decisions: [
      { npc_id: 'npc_lin', status: 'willing', line: '好，我跟你去。' },
      { npc_id: 'npc_qiao', status: 'declined', line: '我不去了。' },
    ] });
    vi.spyOn(f.ai, 'planGoals').mockResolvedValue({ goals: [{ goal_id: 'g1', type: 'WORLD_ACTION',
      normalized_goal: '前往街角商店', operation_hint: 'move', referent: '街角商店', depends_on: [], condition: null,
      branch: null, temporal_scope: { scope: 'now', day_offset: 0, window: 'any' },
      target_entities: ['fabricated_model_id'] }] } as never);
    const before = await f.service.current();
    await handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id,
      expected_revision: before.state_revision, input: '我们去街角商店。' }, undefined, null, false,
      { kind: 'world_action', interaction_lane: 'world_transaction' } as never);
    const after = await f.service.current();
    expect(decisionCalls()).toBe(1);
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(loc(after, 'npc_lin')).toBe('market');
    expect(loc(after, 'npc_qiao')).toBe('square');
    expect(after.npc_agent_state!.npc_lin.travel_intent).toMatchObject({ status: 'willing' });
    expect(after.npc_agent_state!.npc_qiao.travel_intent).toMatchObject({ status: 'declined' });
  });

  it('never rewrites a line the person never spoke, and filters unknown or duplicated ids', async () => {
    const { f } = await fixture({ decisions: [
      { npc_id: 'npc_absent', status: 'willing', line: '我来了。' },
      { npc_id: 'npc_lin', status: 'willing', line: '我先想想。' },
      { npc_id: 'npc_lin', status: 'declined', line: '算了。' },
    ] });
    await run(f, '我们一起走吧。', toward('街角商店'));
    const after = await f.service.current();
    expect(after.npc_agent_state!.npc_absent).toBeUndefined();
    expect(after.npc_agent_state!.npc_lin.travel_intent).toMatchObject({ status: 'willing' });
    const events = after.narrative_history?.at(-2)?.speech_events ?? [];
    expect(events.map(event => event.utterance)).toEqual(['我先想想。']);
    expect(loc(after, 'npc_lin')).toBe('market');
    expect(loc(after, 'npc_qiao')).toBe('square');
  });

  it('treats an unavailable re-decision as "nobody changed their mind" and still settles the MOVE', async () => {
    const { f, decisionCalls } = await fixture({ decisions: 'throw' });
    const before = await f.service.current();
    await run(f, '我先过去看看。', toward('街角商店'));
    const after = await f.service.current();
    expect(decisionCalls()).toBe(1);
    expect(kinds(after).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(loc(after, 'npc_lin')).toBe('square');
    expect(after.npc_agent_state!.npc_lin.travel_intent).toMatchObject({ status: 'conditional' });
    expect(after.runtime.time.minute - before.runtime.time.minute).toBe(6);
  });

  it('replays an identical MOVE request without deciding twice or moving twice', async () => {
    const { f, decisionCalls } = await fixture({ decisions: [
      { npc_id: 'npc_lin', status: 'willing', line: '好。' },
    ] });
    const before = await f.service.current();
    const requestId = randomUUID();
    const request = { game_id: before.game_id, request_id: requestId,
      action: { type: 'MOVE', target_id: 'market', parameters: {} } as const,
      player_input: '咱们俩去看看。', player_request_id: randomUUID() };
    await f.service.turn({ ...request, expected_revision: before.state_revision });
    const after = await f.service.current();
    await f.service.turn({ ...request, expected_revision: after.state_revision });
    const replay = await f.service.current();
    expect(decisionCalls()).toBe(1);
    expect(kinds(replay).filter(kind => kind === 'MOVE')).toHaveLength(1);
    expect(loc(replay, 'npc_lin')).toBe('market');
    expect(replay.runtime.time.minute - before.runtime.time.minute).toBe(6);
  });
});

describe('conditional companion candidate eligibility', () => {
  it('only offers people who are still present, still conditional and still fresh', async () => {
    const { f } = await fixture({ decisions: [] });
    const save = await f.service.current();
    expect(conditionalTravelCandidates(save, save.player_state.entity_id).map(candidate => candidate.npc_id).sort())
      .toEqual(['npc_lin', 'npc_qiao']);
    // Someone who already decided is not re-opened.
    save.npc_agent_state!.npc_lin.travel_intent = { status: 'willing', origin_location_id: 'square',
      source_request_id: '22222222-2222-4222-8222-222222222222', recorded_revision: save.state_revision };
    // Someone who has drifted out of the freshness window is stale.
    save.state_revision += 7;
    expect(conditionalTravelCandidates(save, save.player_state.entity_id).map(candidate => candidate.npc_id))
      .toEqual([]);
  });
});

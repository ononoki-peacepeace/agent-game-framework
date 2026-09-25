import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { applyAssistantStyle, behaviorSummary, parseBehaviorRule } from '../src/ai/behavior.js';
import { handleSystemInput } from '../src/system/agent.js';
import { shouldAutoRetry } from '../src/client/retry-policy.js';
import { initialSystemInput, submitFailed, submitStarted, submitSucceeded } from '../src/client/system-input.js';
import { executeFreeform } from '../src/core/freeform.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { createApp } from '../src/server/app.js';
import { configureDefaultLogger, StructuredLogger } from '../src/observability/index.js';
import { fresh, MemoryStore } from './helpers.js';
import type { SavePackage } from '../src/core/schema.js';

const rule = (scope: 'assistant' | 'narration' | 'dialogue', text: string) => parseBehaviorRule(text, scope);
const withRules = (save: SavePackage, rules: ReturnType<typeof parseBehaviorRule>[]) => ({ ...save, behavior_config: rules });

describe('A/B. behaviour affixes are parsed structurally and applied to natural language only', () => {
  it('parses a per-sentence suffix request into op/value/application', () => {
    const parsed = rule('assistant', '你在每句话结尾加个“喵~”');
    expect(parsed).toMatchObject({ scope: 'assistant', op: 'suffix', value: '喵~', application: 'per_sentence' });
    // The scope answer used to be appended to the request text; it must never become part of the value.
    expect(rule('assistant', '你在每句话结尾加个“喵~”｜作用范围：助手').value).toBe('喵~');
  });
  it('applies the suffix to every player-facing sentence and keeps the summary out of the message', () => {
    const save = withRules(fresh(), [rule('assistant', '你在每句话结尾加个“喵~”')]);
    const styled = applyAssistantStyle(save, '你当前在维斯特郡立学舍。\n当前世界时间没有推进。');
    expect(styled).toBe('你当前在维斯特郡立学舍喵~。\n当前世界时间没有推进喵~。');
    expect(styled).not.toContain('作用范围');
    expect(styled).not.toContain('结尾追加');
    // Config summaries stay in the System UI only.
    expect(behaviorSummary(save.behavior_config)).toContain('结尾追加“喵~”');
  });
  it('supports prefixes, other suffixes and per-message scopes without special-casing any word', () => {
    const prefix = rule('narration', '每段前面加“> ”');
    expect(prefix).toMatchObject({ op: 'prefix', value: '> ', application: 'per_paragraph' });

    const ending = rule('assistant', '回答最后加“（完）”');
    expect(ending).toMatchObject({ op: 'suffix', value: '（完）', application: 'per_message' });
    expect(applyAssistantStyle(withRules(fresh(), [ending]), '你当前在维斯特郡立学舍。')).toBe('你当前在维斯特郡立学舍。（完）');
    expect(applyAssistantStyle(withRules(fresh(), [rule('assistant', '每句话结尾加个“呀”')]), '有两件事。')).toBe('有两件事呀。');
    // Tone and constraint requests stay structured directives, never affixes.
    expect(rule('narration', '叙述简洁一点')).toMatchObject({ op: 'tone', value: 'concise' });
    expect(rule('narration', '不要替玩家描写心理活动')).toMatchObject({ op: 'constraint' });
  });
  it('assistant-scope rules never touch story narration or NPC dialogue text', () => {
    const save = withRules(fresh(), [rule('assistant', '每句话结尾加个“喵~”'), rule('narration', '叙述简洁一点')]);
    const narrationFragment = applyAssistantStyle({ ...save, behavior_config: save.behavior_config.filter(r => r.scope !== 'assistant') }, '莉娅走进教室。');
    expect(narrationFragment).toBe('莉娅走进教室。');
  });
});

describe('B2. a style request clarified by the System agent stays structured', () => {
  it('stores the suffix for the chosen scope and never leaks the scope note', async () => {
    const store = new MemoryStore(), save = fresh();
    await store.write(save);
    const service = new GameService(store, new AIRuntime({ name: 'quiet', generate: async () => { throw Error('no AI expected'); } }), save.definition);
    const asked = await handleSystemInput(service, { input: '每句话结尾加个“喵~”' });
    expect(asked.clarification).toBe('behavior_scope');
    expect(asked.session?.status).toBe('waiting_for_clarification');
    const answered = await handleSystemInput(service, { input: '助手', session_id: asked.session!.session_id });
    expect(answered.category).toBe('BEHAVIOR_CONFIGURATION');
    const stored = (await service.current()).behavior_config;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ scope: 'assistant', op: 'suffix', value: '喵~', application: 'per_sentence' });
    const styled = applyAssistantStyle(await service.current(), '你当前在维斯特郡立学舍。\n当前世界时间没有推进。');
    expect(styled).toBe('你当前在维斯特郡立学舍喵~。\n当前世界时间没有推进喵~。');
    expect(styled).not.toContain('作用范围');
    expect(answered.message).toContain('结尾追加“喵~”');
    await handleSystemInput(service, { input: '恢复默认风格配置' });
    expect(applyAssistantStyle(await service.current(), '你当前在维斯特郡立学舍。')).toBe('你当前在维斯特郡立学舍。');
  });
});

describe('C. resetting the style configuration really stops it', () => {
  it('clears the assistant rules so no suffix is applied afterwards', async () => {
    const store = new MemoryStore(), save = fresh();
    await store.write(save);
    const service = new GameService(store, new AIRuntime({ name: 'quiet', generate: async () => { throw Error('no AI expected'); } }), save.definition);
    await service.setBehaviorConfig({ scope: 'assistant', instruction: '你在每句话结尾加个“喵~”' });
    expect(applyAssistantStyle(await service.current(), '你好。')).toBe('你好喵~。');
    await service.clearBehaviorConfig('assistant');
    expect(applyAssistantStyle(await service.current(), '你好。')).toBe('你好。');
    expect(await service.behaviorConfig()).toEqual([]);
  });
});

describe('D. System composer lifecycle', () => {
  it('clears on success (including clarifications) and keeps the text on a failed send', () => {
    const typed = submitStarted(initialSystemInput, '你在每句话结尾加个“喵~”');
    expect(typed.value).toBe('你在每句话结尾加个“喵~”');
    expect(submitSucceeded(typed)).toMatchObject({ value: '', pending: null });
    const failed = submitFailed(typed, '网络中断');
    expect(failed.value).toBe('你在每句话结尾加个“喵~”');
    expect(failed.error).toBe('网络中断');
    // A clarification answer (a second submit) clears as well — the lifecycle is not category specific.
    const answer = submitStarted(submitSucceeded(typed), '助手');
    expect(submitSucceeded(answer).value).toBe('');
  });
});

describe('E. revision conflicts: read-only may auto-retry once, mutations never do', () => {
  async function staleServer() {
    const service = new GameService(new MemoryStore(), new AIRuntime({ name: 'quiet', generate: async () => { throw Error('no AI expected'); } }), fresh().definition);
    const server = createApp(service).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = await (await fetch(`${base}/api/session`)).json() as { token: string };
    const headers = { 'Content-Type': 'application/json', 'X-Game-Token': session.token };
    await fetch(`${base}/api/new`, { method: 'POST', headers, body: '{}' });
    const created = await (await fetch(`${base}/api/state`)).json();
    // Move the world forward so the next request can arrive with a stale revision.
    await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify({ request_id: randomUUID(), game_id: created.game_id, expected_revision: created.revision, action: { type: 'WAIT', parameters: { minutes: 5 } } }) });
    return { service, base, headers, created, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  }
  it('read-only queries are safe to replay automatically', async () => {
    const env = await staleServer();
    try {
      const response = await fetch(`${env.base}/api/input`, { method: 'POST', headers: env.headers, body: JSON.stringify({ request_id: randomUUID(), game_id: env.created.game_id, expected_revision: env.created.revision, input: '我现在在哪？' }) });
      const body = await response.json() as { retry_policy?: string; error?: string };
      expect(response.status).toBe(409);
      expect(body.retry_policy).toBe('safe');
      expect(shouldAutoRetry(body.retry_policy, false)).toBe(true);
      // The retry itself is bounded: a second conflict must not loop.
      expect(shouldAutoRetry(body.retry_policy, true)).toBe(false);
    } finally { await env.close(); }
  });
  it('replays a read-only query successfully once it carries the synced revision', async () => {
    const env = await staleServer();
    try {
      const first = await fetch(`${env.base}/api/input`, { method: 'POST', headers: env.headers, body: JSON.stringify({ request_id: randomUUID(), game_id: env.created.game_id, expected_revision: env.created.revision, input: '我现在在哪？' }) });
      expect(first.status).toBe(409);
      const latest = await (await fetch(`${env.base}/api/state`)).json() as { game_id: string; revision: number };
      const retried = await fetch(`${env.base}/api/input`, { method: 'POST', headers: env.headers, body: JSON.stringify({ request_id: randomUUID(), game_id: latest.game_id, expected_revision: latest.revision, input: '我现在在哪？' }) });
      expect(retried.status).toBe(200);
      const body = await retried.json() as { message: string; time_advanced: number };
      expect(body.time_advanced).toBe(0);
      expect(body.message).not.toContain('状态已更新');
    } finally { await env.close(); }
  });
  it('world actions and management calls stay manual', async () => {
    const env = await staleServer();
    try {
      const action = await fetch(`${env.base}/api/input`, { method: 'POST', headers: env.headers, body: JSON.stringify({ request_id: randomUUID(), game_id: env.created.game_id, expected_revision: env.created.revision, input: '我去找梅芙说话' }) });
      const actionBody = await action.json() as { retry_policy?: string };
      expect(action.status).toBe(409);
      expect(actionBody.retry_policy).toBe('manual');
      expect(shouldAutoRetry(actionBody.retry_policy, false)).toBe(false);
      const management = await fetch(`${env.base}/api/modules/enable`, { method: 'POST', headers: env.headers, body: JSON.stringify({ module: 'quests', confirmed: true, game_id: env.created.game_id, expected_revision: env.created.revision, request_id: randomUUID() }) });
      const managementBody = await management.json() as { retry_policy?: string };
      expect(management.status).toBe(409);
      expect(managementBody.retry_policy).toBe('manual');
    } finally { await env.close(); }
  });
});

describe('F/G. generic world action: unknown relationship enrichment is dropped, internals stay internal', () => {
  let logger: StructuredLogger;
  beforeEach(() => { logger = configureDefaultLogger(new StructuredLogger({ directory: null, level: 'debug' })); });
  afterEach(() => { configureDefaultLogger(new StructuredLogger({ directory: null })); });
  function scenario() {
    const save = fresh(), player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
    const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
    npc.components.identity.name = '梅芙';
    npc.components.location = structuredClone(player.components.location);
    return { save, player, npc };
  }
  const outcome = (target: string, relationship: unknown) => ({ narrative: '你挥出一拳，对方退后捂住脸颊。', minutes: 1, target_id: target, facts: ['发生了一次肢体冲突。'], relationship });
  it('an unknown dimension does not block the action and does not extend the schema', () => {
    const { save, player, npc } = scenario();
    const dimensions = JSON.stringify(save.definition.ruleset.relationship_dimensions);
    const turn = executeFreeform(save, '狠狠揍梅芙一拳', outcome(npc.id, { dimension: 'anger', delta: -1 }), randomUUID());
    const next = turn.save;
    expect(next.last_turn!.narrative).toContain('一拳');
    expect(turn.action.time_cost).toBe(1);
    expect(next.action_facts).toHaveLength(1);
    const relations = (next.entities.find(entity => entity.id === player.id)!.components.relationships?.entries ?? {}) as Record<string, unknown>;
    expect(relations[npc.id]).toBeUndefined();
    expect(JSON.stringify(next.definition.ruleset.relationship_dimensions)).toBe(dimensions);
    const dropped = logger.entries({ event: 'relationship_mutation_dropped' });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].metadata).toMatchObject({ provider_dimension: 'anger', reason: expect.any(String) });
    // The player-facing narrative never contains internal relationship wording.
    expect(String(next.last_turn!.narrative)).not.toContain('未知关系维度');
  });
  it('a canonical dimension is still applied, and a second unknown enrichment is dropped safely', () => {
    const first = scenario();
    const applied = executeFreeform(first.save, '拍拍梅芙的肩', { ...outcome(first.npc.id, { dimension: 'trust', delta: 1 }), narrative: '你拍了拍她的肩。' }, randomUUID()).save;
    const relations = (applied.entities.find(entity => entity.id === first.player.id)!.components.relationships!.entries as Record<string, Record<string, number>>);
    expect(relations[first.npc.id].trust).toBe(1);
    const second = scenario();
    const dropped = executeFreeform(second.save, '狠狠揍梅芙一拳', outcome(second.npc.id, { dimension: 'hostility', delta: -2 }), randomUUID()).save;
    expect(dropped.last_turn!.narrative).toContain('一拳');
    expect(Object.keys((dropped.entities.find(entity => entity.id === second.player.id)!.components.relationships!.entries as Record<string, unknown>))).toEqual([]);
    expect(logger.entries({ event: 'relationship_mutation_dropped' })).toHaveLength(1);
  });
  it('genuine action-level violations still roll back', () => {
    const { save, npc } = scenario();
    npc.components.location = { location_id: 'remote' };
    expect(() => executeFreeform(save, '狠狠揍梅芙一拳', outcome(npc.id, { dimension: 'trust', delta: 1 }), randomUUID())).toThrow();
    expect(save.action_facts).toBeUndefined();
  });
});

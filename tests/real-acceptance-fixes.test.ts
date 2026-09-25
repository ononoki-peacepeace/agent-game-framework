import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { blankWorldIntent, worldCreationIntent } from '../src/shared/world-intent.js';
import { parseFreeformProposal } from '../src/core/freeform.js';
import { playerFacingError } from '../src/server/app.js';
import { handleSystemInput } from '../src/system/agent.js';
import { applyAssistantStyle, parseBehaviorRule } from '../src/ai/behavior.js';
import { createApp } from '../src/server/app.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { GameService } from '../src/server/service.js';
import { fresh, MemoryStore } from './helpers.js';
import type { SavePackage } from '../src/core/schema.js';

async function serverWithCounter() {
  const calls: string[] = [];
  const adapter = { name: 'counting', generate: async (request: { role: string }) => { calls.push(request.role); throw Error('authoring model must not be called'); } };
  const service = new GameService(new MemoryStore(), new AIRuntime(adapter as never), fresh().definition);
  const server = createApp(service).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = await (await fetch(`${base}/api/session`)).json() as { token: string };
  // The system surface needs a loaded world; creating one without a description uses the demo world and calls no model.
  await fetch(`${base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': session.token }, body: '{}' });
  return { service, calls, base, token: session.token, close: () => new Promise<void>(resolve => server.close(() => resolve())) };

}

describe('A. EMPTY_WORLD / FRAMEWORK_TEST semantics', () => {
  it('recognises blank intent from general phrasing, not a fixed sentence list', () => {
    for (const text of [
      '返回空白世界，不需要任何内容，用于检查框架',
      '空世界，不放剧情和人物',
      '完全空白，不需要输出返回任何具体描述，本次目的为检查框架',
      'EMPTY_WORLD',
      'FRAMEWORK_TEST 请只给我框架结构',
      '最小世界，只要框架',
      'blank skeleton world for regression testing',
    ]) expect(blankWorldIntent(text), text).not.toBeNull();
    // Asking for real content is never collapsed into a blank world.
    for (const text of ['繁华都市冒险', '空白背景的海边小镇，有居民和商店', '校园社交世界，有同学和剧情']) {
      expect(worldCreationIntent(text), text).toBe('AUTHORED_WORLD');
    }
  });
  it('the production /api/new route never calls the authoring model for a blank request', async () => {
    const env = await serverWithCounter();
    try {
      const response = await fetch(`${env.base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': env.token }, body: JSON.stringify({ description: '返回空白世界，不需要任何内容，用于检查框架' }) });
      expect(response.status).toBe(200);
      const view = await response.json() as { modules: { id: string; enabled: boolean }[]; entities: { id: string }[]; locations: unknown[]; panels: { id: string }[] };
      expect(env.calls).toEqual([]);
      expect(view.modules.filter(module => module.enabled).map(module => module.id)).toEqual(['core']);
      expect(view.entities).toHaveLength(1);
      expect(view.locations).toEqual([]);
      expect(view.panels.map(panel => panel.id)).not.toContain('map');
      const save = await env.service.current();
      expect(save.definition.map).toBeUndefined();
      expect(save.definition.events).toEqual([]);
      expect(save.definition.ruleset.currencies).toEqual({});
    } finally { await env.close(); }
  });
});

describe('B/C. generic world action robustness and player-safe errors', () => {
  const proposal = (facts: string[]) => ({ narrative: '你挥出一拳。', minutes: 1, target_id: null, facts, relationship: null });
  it('merges an over-long facts array instead of failing the turn', () => {
    const parsed = parseFreeformProposal(proposal(['一', '二', '三', '四', '五', '六']));
    expect(parsed.facts).toHaveLength(4);
    expect(parsed.facts.join('')).toContain('五');
    expect(parseFreeformProposal(proposal(['一'])).facts).toEqual(['一']);
  });
  it('still refuses anything that is not a bounded public outcome', () => {
    expect(() => parseFreeformProposal({ ...proposal(['一']), hp: 0 })).toThrow();
    expect(() => parseFreeformProposal({ ...proposal(['一']), patches: [{ op: 'replace' }] })).toThrow();
    const clamped = parseFreeformProposal({ ...proposal(['一']), minutes: 99 });
    expect(clamped.minutes).toBe(5);
  });
  it('internal schema detail never reaches the player', () => {
    let thrown: unknown;
    try { parseFreeformProposal({ ...proposal(['一']), hp: 0 }); } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/too_big|invalid_type|unrecognized_keys|\{|\}|\[|\]/);
    expect(message).toContain('世界状态没有改变');
    const zod = playerFacingError(Object.assign(new Error('x'), { name: 'ZodError', issues: [{ code: 'too_big', path: ['facts'] }] }));
    expect(zod).not.toContain('too_big');
    expect(playerFacingError(new Error('这次行动的结果没有通过框架校验，世界状态没有改变。'))).toContain('世界状态没有改变');
  });
});

describe('D/E. System behaviour configuration and unknown intents', () => {
  it('parses a style request into a structured, bounded rule', () => {
    expect(parseBehaviorRule('你在每句话结尾加个“喵~”', 'assistant')).toMatchObject({ scope: 'assistant', op: 'suffix', value: '喵~' });
    expect(parseBehaviorRule('叙述简洁一点', 'narration')).toMatchObject({ scope: 'narration', op: 'tone', value: 'concise' });
    expect(parseBehaviorRule('不要替玩家描写心理活动', 'narration')).toMatchObject({ scope: 'narration', op: 'constraint' });
  });
  it('stores a behaviour request as configuration and applies the assistant suffix', async () => {
    const store = new MemoryStore(), save = fresh();
    await store.write(save);
    const service = new GameService(store, new AIRuntime({ name: 'quiet', generate: async () => { throw Error('no AI expected'); } }), save.definition);
    const result = await handleSystemInput(service, { input: '你在每句话结尾加个“喵~”' });
    expect(result.category).toBe('BEHAVIOR_CONFIGURATION');
    expect(result.needs_confirmation).toBe(false);
    const next = await service.current();
    expect(next.behavior_config).toHaveLength(1);
    expect(next.behavior_config[0]).toMatchObject({ scope: 'assistant', op: 'suffix', value: '喵~' });
    expect(next.runtime.time).toEqual(save.runtime.time);
    expect(applyAssistantStyle(next, '你现在有 10 点。')).toBe('你现在有 10 点喵~。');

    const cleared = await handleSystemInput(service, { input: '恢复默认风格配置' });
    expect(cleared.category).toBe('BEHAVIOR_CONFIGURATION');
    expect((await service.current()).behavior_config).toEqual([]);
  });
  it('an unrecognised system request stays waiting for clarification, never completed', async () => {
    const env = await serverWithCounter();
    try {
      const response = await fetch(`${env.base}/api/system`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': env.token }, body: JSON.stringify({ input: '嗯……那个东西你懂的吧' }) });
      expect(response.status).toBe(200);
      const result = await response.json() as { category: string; needs_confirmation: boolean; session?: { status: string } };
      expect(result.session?.status).not.toBe('completed');
      expect(result.session?.status).toBe('waiting_for_clarification');
    } finally { await env.close(); }
  });
});

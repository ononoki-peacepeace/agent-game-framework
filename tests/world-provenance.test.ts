import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { createApp } from '../src/server/app.js';
import { GameService } from '../src/server/service.js';
import { worldSchema } from '../src/core/schema.js';
import { demo, MemoryStore } from './helpers.js';

async function start(service: GameService, assets: string) {
  const server = createApp(service, undefined, undefined, assets).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token as string;
  const headers = { 'Content-Type': 'application/json', 'X-Game-Token': token };
  const post = async (path: string, body: unknown) => { const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  return { server, base, post };
}

describe('world creation provenance', () => {
  it('keeps a player premise through confirm and service reload, while premise is not invented as a concrete fact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agf-world-provenance-'));
    const blueprint = JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8'));
    const store = new MemoryStore(), runtime = new AIRuntime(new MockAIAdapter(blueprint));
    const firstService = new GameService(store, runtime, demo); await firstService.newGame();
    const first = await start(firstService, join(directory, 'assets-one'));
    try {
      const preview = await first.post('world/preview', { idea: '所有人都有秘密的校园世界', inspiration_seed: 42 });
      expect(preview.status).toBe(200);
      const confirmed = await first.post('world/confirm', { preview_id: preview.body.preview_id });
      expect(confirmed.status).toBe(200);
      const canonical = await firstService.current();
      expect(canonical.definition.provenance).toMatchObject({ original_premise: '所有人都有秘密的校园世界', template_source: { kind: 'idea' }, inspiration_seed: 42 });
      expect(canonical.definition.provenance?.generated_canonical_fact_refs.length).toBeGreaterThan(0);
    } finally { await new Promise<void>(resolve => first.server.close(() => resolve())); }

    const reloaded = new GameService(store, runtime, demo), second = await start(reloaded, join(directory, 'assets-two'));
    try {
      const view = await reloaded.view();
      const ask = async (input: string) => second.post('input', { request_id: randomUUID(), game_id: view!.game_id, expected_revision: view!.revision, input });
      const premise = await ask('这个世界是不是设定所有人都有秘密？');
      expect(premise.status).toBe(200); expect(premise.body.awareness_status).toBe('FOUND'); expect(premise.body.message).toContain('创建记录'); expect(premise.body.message).toContain('所有人都有秘密');
      const fact = await ask('我的秘密是什么？');
      expect(fact.status).toBe(200); expect(fact.body.awareness_status).toBe('NOT_DEFINED'); expect(fact.body.message).toContain('创建前提'); expect(fact.body.message).toContain('还没有保存');
      expect(fact.body.message).not.toMatch(/你的秘密是/);
    } finally { await new Promise<void>(resolve => second.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  });

  it('loads an old world with provenance absent instead of manufacturing creation history', () => {
    const legacy = worldSchema.parse(structuredClone(demo));
    expect(legacy.provenance).toBeUndefined();
  });

  it('splits an over-long premise into atomic records instead of failing the whole world creation', async () => {
    const blueprint = JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8'));
    const store = new MemoryStore(), runtime = new AIRuntime(new MockAIAdapter(blueprint));
    const service = new GameService(store, runtime, demo);
    // The world initializer itself succeeds; the reported failure happened in the provenance validation right
    // after it. This is the statement the model returned as one single premise.
    const long = '故事从一个普通人搬进这座小镇开始，他很快发现每条街都有不愿提起的往事。'.repeat(60);
    expect(long.length).toBeGreaterThan(1000);
    const base = {
      version: 1 as const, original_premise: long, declared_themes: [], declared_rules: [], player_role: null, initial_scope: null,
      template_source: { kind: 'legacy' as const, id: null, version: null }, inspiration_seed: null, preview_signature: null,
      explicit_creation_choices: [], explicit_constraints: [], requested_traits: [], generated_canonical_fact_refs: [],
    };
    const provenance = { ...base, records: [{ kind: 'premise' as const, statement: long, source: 'PLAYER_DECLARED' as const, fact_ref: null }] };
    const view = await service.newGame(long, undefined, undefined, provenance);
    const save = await service.current();
    const records = save.definition.provenance!.records;
    expect(records.length).toBeGreaterThan(1);
    expect(records.every(record => record.statement.length <= 1000)).toBe(true);
    expect(records.every(record => record.kind === 'premise' && record.source === 'PLAYER_DECLARED' && record.fact_ref === null)).toBe(true);
    // Nothing is truncated: the atomic records rebuild the original statement character for character.
    expect(records.map(record => record.statement).join('')).toBe(long);
    expect(save.definition.provenance!.original_premise).toBe(long);
    // The world is committed and still validates as a whole.
    expect(worldSchema.parse(JSON.parse(JSON.stringify(save.definition))).meta.id).toBe(save.definition.meta.id);
    expect(view.game_id).toBe(save.game_id);
    expect((await store.read())!.game_id).toBe(save.game_id);
    // A provenance that is genuinely invalid still rolls back and leaves no half-written save.
    const committed = save.game_id;
    const broken = { ...base, records: [{ kind: 'bogus', statement: 'x', source: 'PLAYER_DECLARED', fact_ref: null }] };
    await expect(service.newGame('第二个测试世界', undefined, undefined, broken as never)).rejects.toThrow();
    expect((await service.current()).game_id).toBe(committed);
  });

  it('keeps a long hidden truth returned by the world initializer intact and still unexposed', async () => {
    const blueprint = JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8'));
    const longTruth = '这座小镇真正的原因是地下旧管道在缓慢释放一种改变记忆的气体，少数居民知道并且一直在掩盖它。'.repeat(35);
    expect(longTruth.length).toBeGreaterThan(1000);
    expect(longTruth.length).toBeLessThanOrEqual(2000);
    blueprint.hidden_truths = [{ id: 'secret_origin', commitment: 'HARD_TRUTH', statement: longTruth, seed_constraint: null, evidence: [{ id: 'clipping', description: '旧报纸的边角' }] }];
    const store = new MemoryStore(), runtime = new AIRuntime(new MockAIAdapter(blueprint));
    const service = new GameService(store, runtime, demo);
    const view = await service.newGame('一个安静的临海小镇，表面正常但有些细节对不上。');
    const save = await service.current();
    // Hidden truth semantics are untouched: same statement, same commitment, stored in full.
    const commitment = save.definition.gm_state.hidden_truth!.commitments[0];
    expect(commitment.statement).toBe(longTruth);
    expect(commitment.commitment).toBe('HARD_TRUTH');
    expect(commitment.evidence[0].description).toBe('旧报纸的边角');
    // The creation committed, validates, and never leaks the hidden answer into the player view.
    expect(worldSchema.parse(JSON.parse(JSON.stringify(save.definition))).meta.id).toBe(save.definition.meta.id);
    expect(view.game_id).toBe(save.game_id);
    expect(JSON.stringify(view)).not.toContain('改变记忆的气体');
  });
});

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
});

import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { createApp } from '../src/server/app.js';
import { GameService } from '../src/server/service.js';
import { JsonStore } from '../src/storage/json-store.js';
import { sparseWorld } from './sparse-fixture.js';
import type { ImageGenerationProvider } from '../src/media/image.js';

async function close(server: any) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}

it('confirmed System media goal generates, persists, assigns and serves a visible avatar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agf-media-avatar-'));
  // Valid 1x1 PNG. This is a controlled provider artifact, not a claim about a real external provider.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const generate = vi.fn(async () => ({ bytes: png, mime_type: 'image/png' as const, provider: 'controlled-test-image', model: 'fixture-v1', metadata: { seed: 7 } }));
  const provider: ImageGenerationProvider = { id: 'controlled-test-image', availability: async () => ({ available: true, reason: null }), generate };
  const ai = new AIRuntime(new MockAIAdapter()), service = new GameService(new JsonStore(join(root, 'save')), ai, sparseWorld());
  await service.newGame();
  const server = createApp(service, undefined, undefined, join(root, 'assets'), {}, { imageProvider: provider }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + (server.address() as any).port;
    const token = (await (await fetch(base + '/api/session')).json()).token;
    const headers = { 'Content-Type': 'application/json', 'X-Game-Token': token };
    const before = (await service.view())!;
    const input = '给我的角色生成一张头像并设置上去。';
    const requested: any = await (await fetch(base + '/api/system', { method: 'POST', headers, body: JSON.stringify({ input, request_id: randomUUID(), game_id: before.game_id, expected_revision: before.revision }) })).json();
    expect(requested).toMatchObject({ category: 'MEDIA_GENERATION', needs_confirmation: true });
    expect(generate).not.toHaveBeenCalled();
    expect((await service.view())!.entities.find(entity => entity.id === before.player_id)?.components.identity?.avatar_id ?? null).toBeNull();

    const completed: any = await (await fetch(base + '/api/system', { method: 'POST', headers, body: JSON.stringify({ input, confirmed: true, session_id: requested.session?.session_id, request_id: randomUUID(), game_id: before.game_id, expected_revision: before.revision }) })).json();
    expect(completed).toMatchObject({ category: 'UNIVERSAL_GOAL', needs_confirmation: false, advanced: { provider: 'controlled-test-image', model: 'fixture-v1', provider_metadata: { seed: 7 } } });
    expect(generate).toHaveBeenCalledOnce();
    const player = completed.view.entities.find((entity: any) => entity.id === completed.view.player_id);
    const avatarId = player.components.identity.avatar_id;
    expect(avatarId).toMatch(/^avatar_[a-f0-9]{32}$/);
    const image = await fetch(base + '/api/avatar/' + avatarId);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toMatch(/^image\/png/);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await service.view())!.entities.find(entity => entity.id === before.player_id)?.components.identity?.avatar_id).toBe(avatarId);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

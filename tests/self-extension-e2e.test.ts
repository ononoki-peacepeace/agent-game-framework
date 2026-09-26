import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { GameService } from '../src/server/service.js';
import { capabilityRegistry } from '../src/system/capabilities.js';
import { MemoryStore } from './helpers.js';
import { sparseWorld } from './sparse-fixture.js';

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('timed out waiting for self-extension');
};

describe('true local self-extension', () => {
  it('develops, verifies, builds, installs, registers, and resumes the original natural-language goal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agf-self-extension-'));
    const registry = capabilityRegistry.without(['entity.wallet.balance.set']);
    const ai = new AIRuntime({ name: 'fixture', generate: async () => { throw new Error('ordinary deterministic goal must not require an AI call'); } });
    const service = new GameService(new MemoryStore(), ai, sparseWorld(), [], undefined, registry);
    await service.newGame();
    const before = await service.current(), player = before.entities.find(entity => entity.id === before.player_state.entity_id)!;
    const wallet = player.components.wallet as { balances: Record<string, number> };
    const currency = Object.keys(wallet.balances)[0];
    expect(currency).toBeTruthy();
    wallet.balances[currency] = 30;
    await service.storage.write(before);

    const server = createApp(service, undefined, undefined, join(directory, 'assets')).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const token = (await (await fetch(`${base}/api/session`)).json()).token;
      const requestId = randomUUID();
      const response = await fetch(`${base}/api/system`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': token },
        body: JSON.stringify({ input: '把我身上的钱从30改成3000', request_id: requestId, game_id: before.game_id, expected_revision: before.state_revision }),
      });
      const first = await response.json();
      expect(response.ok, JSON.stringify(first)).toBe(true);
      expect(first.category).toBe('CAPABILITY_GAP');
      expect(first.suspended_goal).toMatchObject({ status: 'developing', external_blocked: false });

      const goalId = first.suspended_goal.goal_id as string;
      const goals = await (await fetch(`${base}/api/system/suspended-goals?game_id=${before.game_id}`)).json();
      const original = goals.find((goal: { goal_id: string }) => goal.goal_id === goalId);
      expect(original).toMatchObject({ request_id: requestId, original_input: '把我身上的钱从30改成3000', status: 'developing' });
      const taskId = original.development_task_id as string;

      const task = await waitFor(
        async () => (await (await fetch(`${base}/api/development/tasks/${taskId}`)).json()),
        value => ['installed', 'failed', 'paused'].includes((value as { status: string }).status),
      ) as any;
      expect(task.status, JSON.stringify(task.test_results)).toBe('installed');
      expect(task.kind).toBe('capability');
      expect(task.installed_version).toBe(task.current_version);
      expect(task.test_results).toEqual(expect.arrayContaining([
        expect.objectContaining({ milestone: 'package', passed: true }),
        expect.objectContaining({ milestone: 'framework_build', passed: true }),
      ]));
      expect(task.capability_artifacts[0].capability_ids).toContain('entity.wallet.balance.set');
      await expect(stat(task.capability_artifacts[0].path)).resolves.toBeTruthy();
      expect(service.systemCapabilities.get('entity.wallet.balance.set')).toBeTruthy();

      const completed = await waitFor(
        async () => ((await (await fetch(`${base}/api/system/suspended-goals?game_id=${before.game_id}`)).json()) as any[]).find(goal => goal.goal_id === goalId),
        value => (value as { status: string }).status === 'completed' || (value as { status: string }).status === 'failed',
      ) as any;
      expect(completed.status, completed.resume?.last_error).toBe('completed');
      expect(completed.resume).toMatchObject({ attempts: 1 });
      expect(completed.resume.last_operation_id).toMatch(/^[0-9a-f-]{36}$/);

      const after = await service.current();
      const afterPlayer = after.entities.find(entity => entity.id === after.player_state.entity_id)!;
      expect((afterPlayer.components.wallet as { balances: Record<string, number> }).balances[currency]).toBe(3000);
      expect(after.state_revision).toBe(before.state_revision + 1);
      expect((await (await fetch(`${base}/api/system/suspended-goals?game_id=${before.game_id}`)).json())).toHaveLength(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 150_000);
});
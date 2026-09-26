import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createApp } from '../src/server/app.js';
import { composeCapabilityPlan, deterministicGoal } from '../src/system/resolver.js';
import { SuspendedGoalStore } from '../src/system/suspended-goals.js';
import { sparseSetup } from './sparse-fixture.js';

function fixture(missing: string[], installed_capabilities: string[] = []) {
  const goal = deterministicGoal('给我生成图片作为头像')!;
  return {
    request_id: randomUUID(), game_id: randomUUID(), original_input: goal.objective, goal,
    plan: composeCapabilityPlan(goal)!, missing_capabilities: missing,
    originating_surface: 'system' as const, created_revision: 4, installed_capabilities,
  };
}

describe('suspended goals', () => {
  it('persists the complete goal and plan outside canonical saves and reloads them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agf-suspended-goal-'));
    try {
      const input = fixture(['asset.persist']);
      const created = await new SuspendedGoalStore(directory).suspend(input);
      const loaded = await new SuspendedGoalStore(directory).get(created.goal_id);
      expect(loaded).toMatchObject({
        request_id: input.request_id, game_id: input.game_id, original_input: input.original_input,
        goal: input.goal, plan: input.plan, missing_capabilities: ['asset.persist'],
        status: 'waiting_for_auto_extension', created_revision: 4,
        resume: { attempts: 0, completed_revision: null },
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('distinguishes a missing external provider from a locally developable implementation gap', async () => {
    const store = new SuspendedGoalStore();
    const external = await store.suspend(fixture(['media.image.generate']));
    const local = await store.suspend(fixture(['asset.persist']));
    expect(external).toMatchObject({ status: 'waiting_for_external_prerequisite', external_prerequisites: ['media.image_generation'] });
    expect(local).toMatchObject({ status: 'waiting_for_auto_extension', external_prerequisites: [] });
  });

  it('uses request receipts so a replay cannot create a duplicate suspended goal', async () => {
    const store = new SuspendedGoalStore(), input = fixture(['asset.persist']);
    const first = await store.suspend(input), replay = await store.suspend(input);
    expect(replay.goal_id).toBe(first.goal_id);
    expect(await store.list(input.game_id)).toHaveLength(1);
  });

  it('persists one idempotent resume receipt and never reopens a completed goal', async () => {
    const store = new SuspendedGoalStore(), input = fixture(['asset.persist']), created = await store.suspend(input);
    const taskId = randomUUID(); await store.attachDevelopmentTask(created.goal_id, taskId); await store.markInstalledReady(created.goal_id);
    await store.beginResume(created.goal_id, 'resume-one'); await store.completeResume(created.goal_id, 9);
    const replay = await store.beginResume(created.goal_id, 'resume-two');
    expect(replay).toMatchObject({ status: 'completed', development_task_id: taskId, resume: { attempts: 1, last_operation_id: 'resume-one', completed_revision: 9 } });
  });

  it('suspends a capability gap reached through the normal System HTTP entry', async () => {
    const fixture = await sparseSetup(), before = await fixture.service.view();
    const directory = await mkdtemp(join(tmpdir(), 'agf-suspended-http-'));
    const server = createApp(fixture.service, undefined, undefined, join(directory, 'assets')).listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const token = (await (await fetch(`${base}/api/session`)).json()).token;
      const response = await fetch(`${base}/api/system`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': token },
        body: JSON.stringify({ input: '让所有老师周一八点去礼堂开会', request_id: randomUUID(), game_id: before!.game_id, expected_revision: before!.revision }),
      });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      expect(result.category).toBe('CAPABILITY_GAP');
      expect(result.suspended_goal).toMatchObject({ status: 'developing', external_blocked: false });
      const listed = await (await fetch(`${base}/api/system/suspended-goals?game_id=${before!.game_id}`)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ goal_id: result.suspended_goal.goal_id, originating_surface: 'system', created_revision: before!.revision, status: 'developing' });
      expect(listed[0].development_task_id).toMatch(/^[0-9a-f-]{36}$/);
      await fetch(`${base}/api/development/tasks/${listed[0].development_task_id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': token }, body: '{}' });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  });
});

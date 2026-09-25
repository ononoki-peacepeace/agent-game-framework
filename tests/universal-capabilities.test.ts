import { describe, expect, it } from 'vitest';
import { handleSystemInput } from '../src/system/agent.js';
import { CapabilityRegistry, capabilityRegistry, validateCapabilityPlan } from '../src/system/capabilities.js';
import { composeCapabilityPlan, deterministicGoal, executeUniversalPlan, resolveUniversalGoal } from '../src/system/resolver.js';
import type { CapabilityPlan } from '../src/system/goals.js';
import { publicView } from '../src/core/state.js';
import { sparseSetup } from './sparse-fixture.js';
import { createApp } from '../src/server/app.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

describe('universal goal to capability resolution', () => {
  it('executes a rename as one canonical capability transaction without entering feature development', async () => {
    const f = await sparseSetup();
    const before = await f.service.current();
    before.entities.find(entity => entity.id === before.player_state.entity_id)!.components.identity.name = '新生';
    await f.store.write(before);
    const result = await handleSystemInput(f.service, { input: '把新生名字改成丽丽' });
    const after = await f.service.current();
    expect(result.category).toBe('UNIVERSAL_GOAL');
    expect(result.directive).toBeUndefined();
    expect(result.advanced).toMatchObject({ resolution_kind: 'EXECUTED' });
    expect(after.entities.find(entity => entity.id === after.player_state.entity_id)!.components.identity.name).toBe('丽丽');
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.last_turn).toEqual(before.last_turn);
    expect(after.state_revision).toBe(before.state_revision + 1);
  });

  it('composes image generation, persistence and avatar assignment before reporting the capability gap', async () => {
    const f = await sparseSetup();
    const goal = deterministicGoal('给新生生成图片作为头像')!;
    const plan = composeCapabilityPlan(goal)!;
    expect(plan.steps.map(step => step.capability_id)).toEqual(['entity.lookup', 'media.image.generate', 'asset.persist', 'character.avatar.assign']);
    const result = await resolveUniversalGoal(f.service, '给新生生成图片作为头像');
    expect(result).toMatchObject({ handled: true, kind: 'CAPABILITY_GAP' });
    if (result.handled && result.kind === 'CAPABILITY_GAP') expect(result.missing).toContain('media.image.generate');
  });

  it('composes entity query, location resolution and recurring schedule assignment', () => {
    const goal = deterministicGoal('让所有老师周一八点去礼堂开会')!;
    const plan = composeCapabilityPlan(goal)!;
    expect(goal.persistence).toBe('recurring');
    expect(plan.steps.map(step => step.capability_id)).toEqual(['entity.query', 'location.resolve', 'routine.schedule.assign']);
    expect(plan.steps.at(-1)?.depends_on).toEqual(['resolve_targets', 'resolve_location']);
  });

  it('classifies an unavailable primitive as CAPABILITY_GAP without development work', async () => {
    const f = await sparseSetup();
    const goal = deterministicGoal('把我的名字改成丽丽')!;
    const plan = composeCapabilityPlan(goal)!;
    const registry = new CapabilityRegistry(capabilityRegistry.all().map(entry => entry.id === 'entity.identity.rename'
      ? { ...entry, provider_requirements: ['missing.rename'] } : entry));
    const checked = validateCapabilityPlan(plan, publicView(await f.service.current()), registry);
    expect(checked).toMatchObject({ ok: false, kind: 'CAPABILITY_GAP' });
    const result = await executeUniversalPlan(f.service, plan, {}, { registry });
    expect(result).toMatchObject({ handled: true, kind: 'CAPABILITY_GAP' });
    expect('directive' in result).toBe(false);
  });

  it('classifies a timeout from an available executor as EXECUTION_FAILURE and leaves state unchanged', async () => {
    const f = await sparseSetup();
    const before = await f.service.current();
    const goal = deterministicGoal('给我生成图片作为头像')!;
    const plan = composeCapabilityPlan(goal)!;
    const registry = new CapabilityRegistry(capabilityRegistry.all().map(entry => ({ ...entry, implemented: true, provider_requirements: [] })));
    const result = await executeUniversalPlan(f.service, plan, {}, { registry, executeExternal: async () => { throw new Error('provider timeout'); } });
    expect(result).toMatchObject({ handled: true, kind: 'EXECUTION_FAILURE', retryable: true });
    expect(await f.service.current()).toEqual(before);
    expect('directive' in result).toBe(false);
  });

  it('classifies an unclear request as USER_AMBIGUITY', async () => {
    const f = await sparseSetup();
    const result = await handleSystemInput(f.service, { input: '把她改一下' });
    expect(result.category).toBe('USER_AMBIGUITY');
    expect(result.clarification).toBe('universal_goal');
    expect(result.session?.status).toBe('waiting_for_clarification');
  });

  it('keeps a feature request in the Feature Guide boundary', async () => {
    const f = await sparseSetup();
    const result = await handleSystemInput(f.service, { input: '我想加个潜力系统' });
    expect(result.category).toBe('EXTENSION_REQUEST');
    expect(result.guide).toBeTruthy();
    expect(result.advanced?.resolution_kind).toBeUndefined();
  });

  it('uses request receipts for idempotent canonical replay', async () => {
    const f = await sparseSetup();
    const save = await f.service.current(), playerId = save.player_state.entity_id;
    const goal = deterministicGoal('把我的名字改成丽丽')!;
    goal.targets[0].entity_id = playerId;
    const plan = composeCapabilityPlan(goal)! as CapabilityPlan;
    const request = { request_id: '2539b635-9ee8-4d8d-bb33-fbf46689f590', expected_revision: save.state_revision };
    const first = await executeUniversalPlan(f.service, plan, request);
    const revision = (await f.service.current()).state_revision;
    const replay = await executeUniversalPlan(f.service, plan, request);
    expect(first.handled && first.kind).toBe('EXECUTED');
    expect(replay.handled && replay.kind).toBe('EXECUTED');
    expect((await f.service.current()).state_revision).toBe(revision);
  });

  it('hands a rename from World input to the same resolver without advancing the world', async () => {
    const f = await sparseSetup(), before = await f.service.current();
    const directory = await mkdtemp(join(tmpdir(), 'agf-universal-handoff-'));
    const server = createApp(f.service, undefined, undefined, join(directory, 'assets')).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const token = (await (await fetch(`${base}/api/session`)).json()).token;
      const response = await fetch(`${base}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': token }, body: JSON.stringify({ request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input: '把我的名字改成习近平' }) });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      expect(result.intent).toBe('SYSTEM_META_INTENT');
      expect(result.system_handoff.result.category).toBe('UNIVERSAL_GOAL');
      expect(result.system_handoff.result.directive).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('capability_digest');
      expect(JSON.stringify(result)).not.toContain('虚构名字');
      const after = await f.service.current();
      expect(after.entities.find(entity => entity.id === after.player_state.entity_id)!.components.identity.name).toBe('习近平');
      expect(after.runtime.time).toEqual(before.runtime.time);
      expect(after.last_turn).toEqual(before.last_turn);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

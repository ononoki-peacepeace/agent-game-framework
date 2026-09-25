import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { panelRegistry } from '../src/client/panels.js';
import { cropFromSubject } from '../src/client/avatar-crop.js';

import { publicView } from '../src/core/state.js';
import type { RoutineJob } from '../src/routine/jobs.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { ProviderError } from '../src/ai/failures.js';
import { RoutineJobs } from '../src/routine/jobs.js';
import { routineOf, sparseStep } from '../src/routine/scheduler.js';
import { migrateInstalledWorld } from '../src/routine/migration.js';
import { configureDefaultLogger, StructuredLogger } from '../src/observability/index.js';
import { MemoryStore, demo } from './helpers.js';
import { sparsePlan, sparseSetup, sparseWorld } from './sparse-fixture.js';
import { newSave } from '../src/core/state.js';
import type { AIRequest } from '../src/ai/contracts.js';
import type { RoutineResult } from '../src/ai/routine.js';

const absolute = (save: { runtime: { time: { day: number; minute: number } } }) => save.runtime.time.day * 1440 + save.runtime.time.minute;
async function finished(jobs: RoutineJobs, id: string) {
  for (let i = 0; i < 2000; i++) {
    const job = (await jobs.get(id))!;
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  throw Error('job did not finish');
}
async function envelope(service: GameService, type = 'START_ROUTINE') {
  const save = await service.current();
  return { request_id: randomUUID(), game_id: save.game_id, expected_revision: save.state_revision, action: { type, parameters: type === 'START_ROUTINE' ? { label: '正常生活', pattern: '每天睡眠、上课、训练和固定兼职' } : {} } };
}

it('enabling routine waits for a safe handoff instead of preempting the foreground turn', async () => {
  let releaseForeground!: () => void;
  const foregroundGate = new Promise<void>(resolve => { releaseForeground = resolve; });
  const store = new MemoryStore();
  const ai = new AIRuntime({ name: 'fixture', generate: async (request: AIRequest) => {
    if (request.role === 'routine_compiler') return { data: sparsePlan };
    if (request.role === 'narrator') { await foregroundGate; return { data: { narrative: '等待结束。', speaker: null, dialogue: null, choices: [], patches: [] } }; }
    throw Error('unexpected AI call');
  } });
  const service = new GameService(store, ai, sparseWorld());
  await service.newGame();
  const start = await service.current();
  const jobs = new RoutineJobs(service);

  const foreground = service.turn({ request_id: randomUUID(), game_id: start.game_id, expected_revision: start.state_revision, action: { type: 'WAIT', parameters: { minutes: 5 } } });
  await new Promise(resolve => setTimeout(resolve, 40));
  const job = await jobs.start(await envelope(service));
  await new Promise(resolve => setTimeout(resolve, 500));

  const waiting = (await jobs.get(job.job_id))!;
  expect(waiting.status).toBe('running');
  expect(waiting.phase).toBe('waiting_for_safe_handoff');
  expect(waiting.message).toContain('等待安全交接');
  // The foreground transaction is untouched and time has not moved for the routine.
  expect(absolute(await service.current())).toBe(absolute(start));

  releaseForeground();
  await foreground;
  const result = await finished(jobs, job.job_id);
  expect(['completed', 'interrupted']).toContain(result.status);
  expect(absolute(await service.current())).toBeGreaterThan(absolute(start));
});

it('a pending player decision arms the routine without taking over', async () => {
  const { service, store } = await sparseSetup();
  const save = await service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  player.components.routine = { ...(player.components.routine as Record<string, unknown>), active: false, enabled: true, status: 'interrupted', interrupted: true, last_interrupt: '导师在等你决定是否接受邀请' };
  await store.write(save);

  const jobs = new RoutineJobs(service);
  const job = await finished(jobs, (await jobs.start(await envelope(service))).job_id);
  expect(job.status).toBe('interrupted');
  expect(job.message).toContain('已中断');
  expect(job.message).toContain('继续日常');
  expect(job.message).toContain('导师在等你决定是否接受邀请');

  expect(absolute(await service.current())).toBe(absolute(save));
  const pending = routineOf(await service.current());
  expect(pending.interrupted).toBe(true);
  expect(pending.active).toBe(false);

});

it('an accepted morning commitment blocks its window without requiring an exact minute', async () => {
  const { service, store, ai } = await sparseSetup();
  const save = await service.current();
  save.routine_meta!.scheduled_tasks = [{ id: 'volunteer', label: '学生安置志愿任务', at: 1440 + 480, window: 'morning', end_at: 1440 + 720, duration_label: '约4小时', status: 'accepted', source: 'test', resolved: false }];
  await store.write(save);
  await service.turn(await envelope(service), undefined, undefined, undefined, true);

  let current = await service.current();
  for (let step = 0; step < 30; step++) {
    const before = absolute(current);
    current = await sparseStep(current, ai, 1440 + 900);
    if (absolute(current) === before) break;
  }
  expect(absolute(current)).toBe(1440 + 480);
  const routine = routineOf(current);
  expect(routine.interrupted).toBe(true);
  expect(String(routine.last_interrupt)).toContain('学生安置志愿任务');
  expect(String(routine.last_interrupt)).toContain('上午');
});

it('a commitment marked done while the world still says accepted becomes a hard constraint again', () => {
  const world = structuredClone(demo);
  world.enabled_modules.push('quests');
  const save = newSave(world);
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  player.components.opportunities = { entries: { volunteer: { title: '学生安置志愿任务', status: 'accepted', summary: '志愿者圈邀请', objectives: [], deadline: null, tags: [], metadata: {} } } };
  save.calendar = { version: 1, anchor_day: 1, anchor_month: 3, anchor_date: 3, anchor_weekday: 3, month_lengths: [31,28,31,30,31,30,31,31,30,31,30,31], source: 'test anchor' };
  save.routine_meta = { version: 1, calendar_issue: null, migration_ids: ['legacy-accepted-tasks-v1'], scheduled_tasks: [{ id: 'volunteer', label: '学生安置志愿任务', at: 3 * 1440 + 300, window: 'morning', end_at: 3 * 1440 + 720, duration_label: '约4小时', status: 'completed', source: 'legacy', resolved: true }] };

  const { save: migrated, changed } = migrateInstalledWorld(save, []);
  expect(changed).toBe(true);
  const task = migrated.routine_meta!.scheduled_tasks[0];
  expect(task.status).toBe('accepted');
  expect(task.resolved).toBe(false);
  expect(task.window).toBe('morning');
  // A second pass is stable: normalisation does not keep rewriting the save.
  expect(migrateInstalledWorld(migrated, []).changed).toBe(false);
});

it('repeating the same plan supplement never duplicates the plan text', async () => {
  const { service } = await sparseSetup();
  const first = await service.current();
  await service.turn({ request_id: randomUUID(), game_id: first.game_id, expected_revision: first.state_revision, action: { type: 'START_ROUTINE', parameters: { label: '日常', pattern: '周一到周五上课', supplement: '周六兼职，周日和朋友玩' } } }, undefined, undefined, undefined, true);
  const second = await service.current();
  await service.turn({ request_id: randomUUID(), game_id: second.game_id, expected_revision: second.state_revision, action: { type: 'START_ROUTINE', parameters: { label: '日常', pattern: '周一到周五上课', supplement: '周六兼职，周日和朋友玩' } } }, undefined, undefined, undefined, true);
  const routine = routineOf(await service.current());
  expect(routine.supplements).toEqual(['周六兼职，周日和朋友玩']);
  expect(routine.pattern).toBe('周一到周五上课');
  expect(String(routine.pattern).split('周六兼职').length - 1).toBe(0);
  expect(routine.pattern_revision).toBe(1);
  expect(routine.plan).toBeTruthy();
});

it('a truncated provider response retries once, then fails readably without committing', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    let attempts = 0;
    const { service } = await sparseSetup(async () => {
      attempts += 1;
      throw new ProviderError('max_output_tokens', 'truncated', 'DeepSeek 响应未完成：输出达到最大 Token 限制（max_output_tokens），响应未完成');
    });
    const before = await service.current();
    const jobs = new RoutineJobs(service);
    const job = await finished(jobs, (await jobs.start(await envelope(service))).job_id);

    expect(job.status).toBe('failed');
    expect(attempts).toBe(2);
    expect(job.message).toContain('最大 Token 限制');
    expect(job.last_ai).toMatchObject({ status: 'failed', reason: 'max_output_tokens', retry_count: 1 });
    expect(logger.entries({ event: 'routine.ai.retry' })).toHaveLength(1);
    expect(logger.entries({ event: 'routine.ai.failed' })[0].metadata).toMatchObject({ reason: 'max_output_tokens' });
    const after = await service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.entities).toEqual(before.entities);
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

it('presentation uploads stay available while a routine job is compiling', async () => {
  let releaseCompiler!: () => void;
  const gate = new Promise<void>(resolve => { releaseCompiler = resolve; });
  const { service } = await sparseSetup(async (request: AIRequest) => {
    if (request.role === 'routine_compiler') { await gate; return { data: sparsePlan }; }
    throw Error('unexpected AI call');
  });
  const before = await service.current();
  const jobs = new RoutineJobs(service);
  const job = await jobs.start(await envelope(service));
  await new Promise(resolve => setTimeout(resolve, 80));
  const target = before.entities.find(entity => entity.id !== before.player_state.entity_id && entity.components.identity)!;

  const uploaded = await service.setAvatar(target.id, 'avatar_test_asset', before.game_id, before.state_revision);
  expect((uploaded.entities.find(entity => entity.id === target.id)!.components.identity as { avatar_id: string }).avatar_id).toBe('avatar_test_asset');
  const visual = await service.setVisualAsset(target.id, 'fullbody', 'visual_test_asset', before.game_id, before.state_revision);
  expect((visual.entities.find(entity => entity.id === target.id)!.components.visual_assets as { images: Record<string, string> }).images.fullbody).toBe('visual_test_asset');

  releaseCompiler();
  const result = await finished(jobs, job.job_id);
  expect(['completed', 'interrupted']).toContain(result.status);
  // The routine commit keeps the media that arrived while it was running.
  const after = await service.current();
  expect((after.entities.find(entity => entity.id === target.id)!.components.identity as { avatar_id: string }).avatar_id).toBe('avatar_test_asset');
});

it('a failed routine job shows a readable reason with retry and log actions', () => {
  const saved = newSave(demo);saved.entities.find(e=>e.id===saved.player_state.entity_id)!.components.routine={pattern:'每天上课',label:'生活计划'};
  const view = publicView(saved);
  const job = {
    job_id: 'job-failed', game_id: view.game_id, request_id: 'req-1', fingerprint: 'x', status: 'failed', phase: 'idle',
    message: 'DeepSeek 响应未完成：输出达到最大 Token 限制（max_output_tokens），响应未完成', created_at: '', updated_at: '',
    start_revision: 1, last_revision: 1, steps: 0,
    last_ai: { role: 'routine_compiler', provider: 'deepseek', model: 'deepseek-flash', status: 'failed', duration_ms: 12345, reason: 'max_output_tokens', usage: null, retry_count: 1 },
    metrics: { ai_requests: 2, compiler_calls: 2, ai_wait_ms: 12000, local_ms: 5, input_tokens: 0, output_tokens: 0, usage_available: false },
  } as RoutineJob;
  const html = renderToStaticMarkup(createElement(panelRegistry.routine, { view, act: () => {}, busy: false, routineJob: job, acknowledgeTask: async () => {}, onOpenLogs: () => {} }));
  expect(html).toContain('本次处理失败');
  expect(html).toContain('最大 Token 限制');
  expect(html).toContain('失败段未提交');
  expect(html).toContain('重试');
  expect(html).toContain('查看日志');
  expect(html).toContain('deepseek');
});

it('the avatar crop frames the head and shoulders instead of the whole figure', () => {
  // A 1024x1536 full-body illustration whose character occupies the middle of the canvas.
  const subject = { x: 300, y: 120, width: 424, height: 1280 };
  const crop = cropFromSubject(subject, 1024, 1536, {});
  const side = crop.size * Math.min(1024, 1536);
  const top = crop.y * 1536, bottom = top + side;
  // Roughly head + shoulders + upper chest: never the whole figure, never a face-only sliver.
  expect(side).toBeGreaterThan(subject.height * 0.3);
  expect(side).toBeLessThan(subject.height * 0.5);
  expect(top).toBeLessThanOrEqual(subject.y);
  expect(top).toBeGreaterThan(subject.y - subject.height * 0.1);
  expect(bottom).toBeLessThan(subject.y + subject.height * 0.45);

  // It is centred on the character, and zooming in shrinks the window.
  expect(crop.x * 1024 + side / 2).toBeCloseTo(subject.x + subject.width / 2, 0);
  expect(cropFromSubject(subject, 1024, 1536, { zoom: 1.4 }).size).toBeLessThan(crop.size);
  // Manual offset moves the window without changing its size.
  const shifted = cropFromSubject(subject, 1024, 1536, { offsetY: 0.15 });
  expect(shifted.size).toBeCloseTo(crop.size, 5);
  expect(shifted.y).toBeGreaterThan(crop.y);
});

it('routine plan compilation only sends compact entity facts', async () => {


  let compilerPrompt = '';
  const { service } = await sparseSetup(async (request: AIRequest) => {
    if (request.role === 'routine_compiler') { compilerPrompt = request.prompt; return { data: sparsePlan }; }
    throw Error('unexpected AI call');
  });
  const save = await service.current();
  const target = save.entities.find(entity => entity.components.identity && entity.id !== save.player_state.entity_id)!;
  target.components.identity.description = 'x'.repeat(1800);

  await (service as unknown as { storage: MemoryStore }).storage.write(save);
  await service.turn(await envelope(service), undefined, undefined, undefined, true);
  expect(compilerPrompt).toContain('优先级');
  expect(compilerPrompt).toContain('applied_assumptions');
  expect(compilerPrompt).not.toContain('x'.repeat(300));
  expect(compilerPrompt.length).toBeLessThan(40000);
});

import { it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { StructuredLogger, configureDefaultLogger } from '../src/observability/index.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { RoutineJobs } from '../src/routine/jobs.js';
import { createApp } from '../src/server/app.js';
import { demo, MemoryStore } from './helpers.js';
import { sparseSetup } from './sparse-fixture.js';

async function finished(jobs: RoutineJobs, id: string) {
  for (let i = 0; i < 1000; i++) {
    const job = (await jobs.get(id))!;
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw Error('job did not finish');
}

it('writes structured JSONL logs, rotates by size and redacts secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agf-logs-'));
  try {
    const logger = new StructuredLogger({ directory, level: 'debug', maxBytes: 600, keepFiles: 2 });
    for (let index = 0; index < 40; index++) {
      logger.info('routine.job.started', { module: 'routine', trace_id: 'tr_test', job_id: 'job-1', metadata: { index, api_key: 'sk-live-supersecret', authorization: 'Bearer abcdefghijklmnop', nested: { token: 'hunter2' } } });
    }
    await logger.flush();
    const files = (await readdir(directory)).filter(name => /\.log$/.test(name));
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
    const content = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8')))).join('');
    expect(content).not.toContain('sk-live-supersecret');
    expect(content).not.toContain('abcdefghijklmnop');
    expect(content).not.toContain('hunter2');
    expect(content).toContain('[redacted]');
    const entry = JSON.parse(content.trim().split('\n')[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'info', event: 'routine.job.started', module: 'routine', trace_id: 'tr_test', job_id: 'job-1' });
    expect(String(entry.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('filters below the configured level and keeps a queryable in-memory buffer', () => {
  const logger = new StructuredLogger({ directory: null, level: 'info' });
  expect(logger.filePath()).toBeNull();
  logger.debug('rng.roll', { module: 'rng', metadata: { expression: '1d20' } });
  logger.warn('display.unresolved', { module: 'display', metadata: { value: 'ghost_id' } });
  expect(logger.entries()).toHaveLength(1);
  expect(logger.entries({ module: 'display' })[0].event).toBe('display.unresolved');
  logger.setLevel('debug');
  logger.debug('rng.roll', { module: 'rng', metadata: { expression: '1d20', total: 7 } });
  expect(logger.entries({ event: 'rng.roll' })).toHaveLength(1);
});

it('correlates one turn into a trace with step spans, AI metadata and save.commit', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    const adapter = {
      name: 'fixture',
      providerInfo: () => ({ provider: 'mock', model: 'fixture-model' }),
      generate: async () => ({ data: { narrative: '你等了一会儿。', speaker: null, dialogue: null, choices: [], patches: [] }, usage: { input_tokens: 12, output_tokens: 7 }, threadId: 'thread-1' }),
    };
    const service = new GameService(new MemoryStore(), new AIRuntime(adapter), demo, [], logger);
    const start = await service.newGame();
    await service.turn({ request_id: randomUUID(), game_id: start.game_id, expected_revision: 0, action: { type: 'WAIT', parameters: { minutes: 10 } } });

    const commits = logger.entries({ event: 'save.commit' });
    expect(commits).toHaveLength(1);
    expect(commits[0].trace_id).toMatch(/^tr_[0-9a-f]{12}$/);
    expect(commits[0].request_id).toBeTruthy();
    expect(commits[0].metadata).toMatchObject({ revision_before: 0, revision_after: 1, validation: 'accepted', action: 'WAIT', source: 'player' });
    expect(commits[0].metadata.modules).toEqual(expect.arrayContaining(['runtime', 'last_turn']));


    const ai = logger.entries({ event: 'routine.ai.response' });
    expect(ai).toHaveLength(1);
    expect(ai[0].metadata).toMatchObject({ provider: 'mock', model: 'fixture-model', role: 'narrator', thread_id: 'thread-1', success: true, usage_available: true, patch_count: 0 });

    const trace = logger.traces().find(item => item.trace_id === commits[0].trace_id)!;
    expect(trace.spans.map(span => span.name)).toEqual(expect.arrayContaining(['patch.validation', 'save.commit']));
    expect(trace.spans.every(span => span.duration_ms >= 0)).toBe(true);
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

it('records routine job lifecycle and explains the selected local activity', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    const { service } = await sparseSetup();
    const jobs = new RoutineJobs(service);
    const before = await service.current();
    const job = await jobs.start({ request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, action: { type: 'START_ROUTINE', parameters: { label: '正常生活', pattern: '每天睡眠、上课、训练和固定兼职' } } });
    const result = await finished(jobs, job.job_id);
    expect(result.status).toBe('completed');

    const started = logger.entries({ event: 'routine.job.started' });
    expect(started).toHaveLength(1);
    expect(started[0].job_id).toBe(job.job_id);
    const completed = logger.entries({ event: 'routine.job.completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].job_id).toBe(job.job_id);
    expect(completed[0].metadata).toMatchObject({ status: 'completed', start_revision: before.state_revision });

    const selection = logger.entries({ event: 'routine.scheduler.local_activity' })[0];
    expect(selection).toBeTruthy();
    expect(selection.metadata).toMatchObject({ selected: 'sleep', ai_call: false, branch: 'local_activity' });
    expect(selection.metadata.reasons).toBeInstanceOf(Array);
    expect(String((selection.metadata.reasons as string[]).join(' '))).toContain('sleep');
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

it('logs migration start and completion without dumping the whole save', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    await sparseSetup();
    const started = logger.entries({ event: 'migration.started' });
    const completed = logger.entries({ event: 'migration.completed' });
    expect(started.length).toBeGreaterThan(0);
    expect(completed.length).toBeGreaterThan(0);
    expect(Object.keys(completed[0].metadata)).not.toContain('save');
    expect(completed[0].metadata).toMatchObject({ world: expect.any(String), changed: expect.any(Boolean) });
    expect(completed[0].duration_ms).toBeGreaterThanOrEqual(0);
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

it('exposes the local log snapshot through the debug endpoint', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  const service = new GameService(new MemoryStore(), new AIRuntime(new MockAIAdapter()), demo, [], logger);
  await service.newGame();
  logger.info('runtime.startup', { module: 'server', metadata: { port: 3100 } });
  const server = createApp(service).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const session = await (await fetch(`${base}/api/session`)).json() as { token: string };
    const response = await fetch(`${base}/api/logs?limit=50`, { headers: { 'X-Game-Token': session.token } });
    expect(response.status).toBe(200);
    const body = await response.json() as { level: string; file: string | null; entries: { event: string }[]; traces: unknown[] };
    expect(body.level).toBe('debug');
    expect(body.file).toBeNull();
    expect(body.entries.map(entry => entry.event)).toContain('runtime.startup');
    expect(Array.isArray(body.traces)).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

import { it, expect } from 'vitest';
import { configureDefaultLogger, reportDisplayUnresolved, StructuredLogger } from '../src/observability/index.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { demo, MemoryStore } from './helpers.js';
import { sparseSetup } from './sparse-fixture.js';

it('an idle session never repeats migration work or migration logs', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    const { service } = await sparseSetup();
    const baseline = logger.entries({ event: 'migration.completed' }).length;
    expect(baseline).toBeGreaterThan(0);
    for (let poll = 0; poll < 40; poll++) await service.view();
    expect(logger.entries({ event: 'migration.completed' })).toHaveLength(baseline);
    expect(logger.entries({ event: 'migration.started' })).toHaveLength(baseline);
    // Reads stay silent: no per-poll events at all.
    expect(logger.entries().filter(entry => entry.event !== 'migration.completed' && entry.event !== 'migration.started')).toHaveLength(0);
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

it('a real migration is logged exactly once per save', async () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    const store = new MemoryStore();
    const world = structuredClone(demo);
    const service = new GameService(store, new AIRuntime({ name: 'quiet', generate: async () => { throw Error('no AI expected'); } }), world, [], logger);
    const started = await service.newGame();
    // The stored save has no routine metadata yet: exactly one normalisation pass is expected.
    await service.current();
    await service.view();
    await service.view();
    expect(logger.entries({ event: 'migration.completed' })).toHaveLength(1);
    expect(logger.entries({ event: 'migration.completed' })[0].metadata.reasons).toContain('missing-routine-meta');
    expect((await service.current()).game_id).toBe(started.game_id);
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

it('identical unresolved references are reported once per window', () => {
  const logger = new StructuredLogger({ directory: null, level: 'debug' });
  configureDefaultLogger(logger);
  try {
    const report = { kind: 'item' as const, key: 'item_id', value: 'ash_practice_wand', path: '$.entities[44].components.identity.description', scope: 'reference' as const };
    for (let repeat = 0; repeat < 25; repeat++) reportDisplayUnresolved(report);
    const entries = logger.entries({ event: 'display.unresolved' });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ kind: 'item', key: 'item_id', value: 'ash_practice_wand', suppressed_since_last_report: 0 });
    // A different reference is still reported.
    reportDisplayUnresolved({ ...report, value: 'other_missing_item' });
    expect(logger.entries({ event: 'display.unresolved' })).toHaveLength(2);
  } finally {
    configureDefaultLogger(new StructuredLogger({ directory: null }));
  }
});

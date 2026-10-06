import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import type { AIRequest } from '../src/ai/contracts.js';
import { GameService } from '../src/server/service.js';
import { newSave, publicView, validateSave } from '../src/core/state.js';
import type { SavePackage } from '../src/core/schema.js';
import type { Calendar } from '../src/routine/schema.js';
import { calendarDay, dateAt } from '../src/routine/calendar.js';
import { ageOf, worldYearLength } from '../src/shared/age.js';
import { calculateClosurePressure, ensureNarrativeState } from '../src/narrative/runtime.js';
import { demo, MemoryStore } from './helpers.js';

const blueprint = async () => JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8'));
const playerOf = (save: SavePackage) => save.entities.find(entity => entity.id === save.player_state.entity_id)!;
const identityOf = (save: SavePackage) => playerOf(save).components.identity as Record<string, unknown>;
const identityOfEntity = (save: SavePackage, id: string) => save.entities.find(entity => entity.id === id)!.components.identity as Record<string, unknown>;

/** An isolated world whose player carries a declared age plus (optionally) the world day it was recorded on. */
function seeded(options: { age: number | null; asOfDay?: number | null; birth?: unknown; calendar?: Calendar; day?: number }): SavePackage {
  const save = newSave(demo);
  const identity = identityOf(save);
  identity.age = options.age;
  if (options.asOfDay !== undefined) identity.age_as_of_day = options.asOfDay;
  if (options.birth !== undefined) identity.birth = options.birth;
  if (options.calendar) { save.calendar = options.calendar; save.definition.calendar = options.calendar; }
  if (options.day !== undefined) save.runtime.time = { day: options.day, minute: 0 };
  return save;
}

describe('age growth with world time', () => {
  it('grows the age only after a full world-calendar year has passed', () => {
    const year = worldYearLength(newSave(demo).calendar)!;
    expect(year).toBe(365);
    const save = seeded({ age: 24, asOfDay: 1 });
    for (const [day, expected] of [[1, 24], [1 + year - 1, 24], [1 + year, 25], [1 + year * 3 - 1, 26], [1 + year * 3, 27], [1 + year * 12, 36]] as const) {
      save.runtime.time.day = day;
      expect(ageOf(playerOf(save), save)).toBe(expected);
    }
    // The recorded reference is when the age was known, never a birthday.
    expect(identityOf(save).birth ?? null).toBeNull();
  });

  it('counts whole years with the world calendar instead of a fixed 365 days', () => {
    const base = newSave(demo).calendar!;
    const thirty = { ...base, month_lengths: Array(12).fill(30), source: '测试历法：12 个月、每月 30 天' };
    const short = { ...base, month_lengths: Array(12).fill(28), source: '测试历法：12 个月、每月 28 天' };
    expect(worldYearLength(thirty)).toBe(360);
    expect(worldYearLength(short)).toBe(336);
    const a = seeded({ age: 30, asOfDay: 1, calendar: thirty });
    a.runtime.time.day = 1 + 359;
    expect(ageOf(playerOf(a), a)).toBe(30);
    a.runtime.time.day = 1 + 360;
    expect(ageOf(playerOf(a), a)).toBe(31);
    a.runtime.time.day = 1 + 365;
    expect(ageOf(playerOf(a), a)).toBe(31);
    const b = seeded({ age: 30, asOfDay: 1, calendar: short });
    b.runtime.time.day = 1 + 335;
    expect(ageOf(playerOf(b), b)).toBe(30);
    b.runtime.time.day = 1 + 336;
    expect(ageOf(playerOf(b), b)).toBe(31);
  });

  it('uses an explicit birth date when one exists and ages on that birthday', () => {
    const calendar = newSave(demo).calendar!;
    const year = worldYearLength(calendar)!;
    const birthday = calendarDay(calendar, 3, 10);
    expect(dateAt(calendar, birthday)).toMatchObject({ month: 3, day: 10, yearOffset: 0 });
    const save = seeded({ age: 0, asOfDay: null, birth: { year_offset: -24, month: 3, day: 10 }, day: birthday });
    expect(ageOf(playerOf(save), save)).toBe(24);
    save.runtime.time.day = birthday + year - 1;
    expect(dateAt(calendar, save.runtime.time.day)).toMatchObject({ month: 3, day: 9, yearOffset: 1 });
    expect(ageOf(playerOf(save), save)).toBe(24);
    save.runtime.time.day = birthday + year;
    expect(ageOf(playerOf(save), save)).toBe(25);
    save.runtime.time.day = birthday + year * 3 + 1;
    expect(ageOf(playerOf(save), save)).toBe(27);
    // A birth date that cannot exist inside this world calendar is not trusted: the declared age stands.
    const invalid = seeded({ age: 24, asOfDay: null, birth: { year_offset: -24, month: 2, day: 30 }, day: 1 + year * 5 });
    expect(ageOf(playerOf(invalid), invalid)).toBe(24);
  });

  it('never invents an age or a birthday, and a reference-less age does not grow', () => {
    const unknown = seeded({ age: null, asOfDay: null, day: 1 + 365 * 40 });
    expect(ageOf(playerOf(unknown), unknown)).toBeNull();
    const declared = seeded({ age: 40, asOfDay: null, day: 1 + 365 * 10 });
    expect(ageOf(playerOf(declared), declared)).toBe(40);
    expect(identityOf(declared).birth ?? null).toBeNull();
    const round = validateSave(JSON.parse(JSON.stringify(declared)));
    expect(identityOfEntity(round, round.player_state.entity_id).birth ?? null).toBeNull();
    expect(identityOfEntity(round, round.player_state.entity_id).age_as_of_day ?? null).toBeNull();
    expect(ageOf(playerOf(round), round)).toBe(40);
  });

  it('derives the same age after a restart and never accumulates on repeated reads', async () => {
    const store = new MemoryStore();
    await store.write(seeded({ age: 24, asOfDay: 1, day: 1 + 365 * 2 }));
    const game = new GameService(store, new AIRuntime(new MockAIAdapter(await blueprint())), demo);
    const first = await game.view();
    expect(first!.entities.find(entity => entity.id === first!.player_id)!.components.identity?.age).toBe(26);
    for (let round = 0; round < 3; round += 1) await game.view();
    const stored = (await store.read())!;
    // Reading derives; it never re-settles, so the stored reference cannot double-count.
    expect(identityOfEntity(stored, stored.player_state.entity_id).age).toBe(24);
    expect(identityOfEntity(stored, stored.player_state.entity_id).age_as_of_day).toBe(1);
    const restarted = new GameService(store, new AIRuntime(new MockAIAdapter(await blueprint())), demo);
    const again = await restarted.view();
    expect(again!.entities.find(entity => entity.id === again!.player_id)!.components.identity?.age).toBe(26);
  });

  it('restores the earlier age on Undo and never ages anyone twice', async () => {
    const store = new MemoryStore(), game = new GameService(store, new AIRuntime(new MockAIAdapter(await blueprint())), demo);
    await game.newGame('一个普通的小镇。');
    const year = worldYearLength((await game.current()).calendar)!;
    const prepared = await game.current();
    const identity = identityOf(prepared);
    identity.age = 24;
    identity.age_as_of_day = 1;
    prepared.runtime.time = { day: 1 + year * 3 - 1, minute: 540 };
    await store.write(prepared);
    const before = await game.current();
    expect(ageOf(playerOf(before), before)).toBe(26);
    await game.turn({ request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, action: { type: 'WAIT', parameters: { minutes: 1440 } } });
    const turned = await game.current();
    expect(turned.runtime.time.day).toBe(before.runtime.time.day + 1);
    expect(ageOf(playerOf(turned), turned)).toBe(27);
    // Re-deriving and re-reading is idempotent.
    expect(ageOf(playerOf(turned), turned)).toBe(27);
    const reread = await game.current();
    expect(ageOf(playerOf(reread), reread)).toBe(27);
    await game.undo({ request_id: randomUUID(), game_id: turned.game_id, expected_revision: turned.state_revision });
    const afterUndo = await game.current();
    expect(afterUndo.runtime.time.day).toBe(before.runtime.time.day);
    expect(ageOf(playerOf(afterUndo), afterUndo)).toBe(26);
  });

  it('hands the same derived age to the lifecycle calculation, without extra model calls', async () => {
    const adapter = new MockAIAdapter(await blueprint());
    let calls = 0;
    const generate = adapter.generate.bind(adapter);
    (adapter as unknown as { generate: (request: AIRequest) => Promise<unknown> }).generate = async (request: AIRequest) => { calls += 1; return generate(request); };
    const store = new MemoryStore(), game = new GameService(store, new AIRuntime(adapter), demo);
    await game.newGame('一个普通的小镇。');
    const written = await game.current();
    const identity = identityOf(written);
    identity.age = 24;
    identity.age_as_of_day = 1;
    written.runtime.time = { day: 1, minute: 540 };
    await store.write(written);
    const young = await game.current();
    const baseline = calls;
    for (let round = 0; round < 5; round += 1) await game.view();
    expect(calls).toBe(baseline);
    expect(calculateClosurePressure(young, ensureNarrativeState(young))).toBe(0);
    const old = structuredClone(young);
    old.runtime.time = { day: 1 + 365 * 80, minute: 540 };
    expect(calculateClosurePressure(old, ensureNarrativeState(old))).toBeGreaterThan(0);
    const view = publicView(old);
    expect((view.entities.find(entity => entity.id === view.player_id)!.components.identity as { age?: unknown }).age).toBe(104);
    expect(ageOf(playerOf(old), old)).toBe(104);
    // The save keeps the reference value; only the projection advances.
    expect(identityOf(old).age).toBe(24);
  });
});

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import type { AIRequest } from '../src/ai/contracts.js';
import { GameService } from '../src/server/service.js';
import { newSave, validateSave } from '../src/core/state.js';
import type { SavePackage } from '../src/core/schema.js';
import { ageLabel, ageOf, isAge, lifeHorizonPressure, UNKNOWN_AGE_PRESSURE } from '../src/shared/age.js';
import { calculateClosurePressure, ensureNarrativeState } from '../src/narrative/runtime.js';
import { defaultRoleplayConfig } from '../src/narrative/policy.js';
import { demo, MemoryStore } from './helpers.js';

const blueprint = async () => JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8'));
const identityOf = (save: SavePackage, id: string) => save.entities.find(entity => entity.id === id)!.components.identity as { age?: unknown };
const service = (store: MemoryStore, adapter: MockAIAdapter) => new GameService(store, new AIRuntime(adapter), demo);

describe('character age and life horizon', () => {
  it('records a structured age for the player and the characters the world defines', async () => {
    const base = await blueprint();
    base.player.age = 24;
    base.characters[0].age = 41;
    const store = new MemoryStore(), game = service(store, new MockAIAdapter(base));
    await game.newGame('一个普通的小镇。');
    const save = await game.current();
    expect(identityOf(save, save.player_state.entity_id).age).toBe(24);
    expect(identityOf(save, base.characters[0].id).age).toBe(41);
    for (const entity of save.entities) {
      const value = (entity.components.identity as { age?: unknown } | undefined)?.age;
      expect(value === null || value === undefined || isAge(value)).toBe(true);
    }
    expect(ageOf(save.entities.find(entity => entity.id === base.characters[0].id), save)).toBe(41);
    expect(identityOf((await store.read())!, base.characters[0].id).age).toBe(41);
  });

  it('keeps a defined age across turns and restarts, and hands it to the narrator', async () => {
    const base = await blueprint();
    base.player.age = 24;
    base.characters[0].age = 41;
    const adapter = new MockAIAdapter(base), narratorPrompts: string[] = [];
    const generate = adapter.generate.bind(adapter);
    (adapter as unknown as { generate: (request: AIRequest) => Promise<unknown> }).generate = async (request: AIRequest) => {
      if (request.role === 'narrator') narratorPrompts.push(request.prompt);
      return generate(request);
    };
    const store = new MemoryStore(), game = service(store, adapter);
    await game.newGame('一个普通的小镇。');
    const created = await game.current();
    const npcId = base.characters[0].id, playerId = created.player_state.entity_id;
    const placed = await game.current();
    placed.entities.find(entity => entity.id === npcId)!.components.location = structuredClone(placed.entities.find(entity => entity.id === playerId)!.components.location);
    await store.write(placed);
    const before = structuredClone(await game.current());
    await game.turn({ request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, action: { type: 'TALK', target_id: npcId, parameters: { topic: '你好' } } });
    const after = await game.current();
    expect(identityOf(after, npcId).age).toBe(41);
    expect(identityOf(after, playerId).age).toBe(24);
    expect(narratorPrompts.length).toBeGreaterThan(0);
    expect(narratorPrompts.at(-1)).toContain('"age":41');
    expect(narratorPrompts.at(-1)).toContain('identity.age 是按世界历法推算的当前年龄');
    const restarted = service(store, new MockAIAdapter(base));
    expect(identityOf(await restarted.current(), npcId).age).toBe(41);
    const shape = (save: SavePackage, id: string) => ({
      identity: { ...identityOf(save, id) },
      character: save.entities.find(entity => entity.id === id)!.components.character,
      relationships: save.entities.find(entity => entity.id === playerId)!.components.relationships,
    });
    expect(shape(after, npcId)).toEqual(shape(before, npcId));
    expect(shape(after, playerId)).toEqual(shape(before, playerId));
  });

  it('never infers an age for a legacy character, and keeps the unknown case explicit', async () => {
    const raw = JSON.parse(await readFile('content/worlds/town.json', 'utf8'));
    expect(JSON.stringify(raw.entities).includes('"age"')).toBe(false);
    const store = new MemoryStore();
    await store.write(newSave(demo));
    const game = service(store, new MockAIAdapter(await blueprint()));
    const view = await game.view();
    expect(view).not.toBeNull();
    const entity = view!.entities.find(item => item.components.character && item.id !== view!.player_id)!;
    expect(entity.components.identity?.age ?? null).toBeNull();
    expect(ageLabel(entity.components.identity?.age)).toBe('未设定');
    const save = await game.current();
    expect(ageOf(save.entities.find(item => item.id === entity.id), save)).toBeNull();
    // A 41-year-old character is still 41 after a save/reload cycle.
    const withAge = newSave(demo);
    withAge.entities.find(item => item.id === entity.id)!.components.identity.age = 41;
    const reloaded = validateSave(JSON.parse(JSON.stringify(withAge)));
    expect(ageOf(reloaded.entities.find(item => item.id === entity.id), reloaded)).toBe(41);
  });

  it('computes life-horizon pressure without NaN and follows the world lifespan reference', () => {
    const human = defaultRoleplayConfig().life_horizon;
    expect(human).toMatchObject({ kind: 'species_normal', target_age_min: 70, target_age_max: 100 });
    // Unknown age (missing, null, wrong type) uses the defined fallback — never NaN.
    for (const unknown of [null, undefined, '24', NaN, {}, []]) expect(lifeHorizonPressure(unknown, human)).toBe(UNKNOWN_AGE_PRESSURE);
    expect(Number.isFinite(lifeHorizonPressure(undefined, human))).toBe(true);
    // Young ages contribute nothing; near the horizon they contribute a bounded amount.
    expect(lifeHorizonPressure(24, human)).toBe(0);
    expect(lifeHorizonPressure(90, human)).toBeCloseTo(0.2, 5);
    expect(lifeHorizonPressure(1000, human)).toBeCloseTo(0.3, 5);
    // Open-ended / immortal worlds never use an age threshold at all.
    expect(lifeHorizonPressure(900, { kind: 'immortal', target_age_max: null })).toBe(0);
    expect(lifeHorizonPressure(null, { kind: 'open_ended', target_age_max: null })).toBe(0);
    // A long-lived setting judges the same age against its own range, not a human one.
    expect(lifeHorizonPressure(180, { kind: 'ai_suggested', target_age_max: 300 })).toBe(0);
    expect(lifeHorizonPressure(290, { kind: 'ai_suggested', target_age_max: 300 })).toBeCloseTo(0.25333, 4);
    // The closed pressure is always finite and inside [0,1] for an age-less and an aged world alike.
    for (const age of [null, 24, 95]) {
      const save = newSave(demo);
      if (age !== null) save.entities.find(entity => entity.id === save.player_state.entity_id)!.components.identity.age = age;
      const pressure = calculateClosurePressure(save, ensureNarrativeState(save));
      expect(Number.isFinite(pressure)).toBe(true);
      expect(pressure).toBeGreaterThanOrEqual(0);
      expect(pressure).toBeLessThanOrEqual(1);
    }
  });

  it('takes the lifespan reference from the world premise and shows the age in the character detail', async () => {
    const longLived = { ...(await blueprint()), description: '一座由精灵守护的森林学院，学生的寿命极长。' };
    const short = { ...(await blueprint()), description: '一个普通的人类现代小镇。' };
    const storeA = new MemoryStore(), storeB = new MemoryStore();
    await service(storeA, new MockAIAdapter(longLived)).newGame(longLived.description);
    await service(storeB, new MockAIAdapter(short)).newGame(short.description);
    expect((await storeA.read())!.definition.roleplay_config!.life_horizon).toMatchObject({ kind: 'ai_suggested', target_age_min: 200, target_age_max: 300 });
    expect((await storeB.read())!.definition.roleplay_config!.life_horizon).toMatchObject({ kind: 'ai_suggested', target_age_min: 70, target_age_max: 100 });
    // Two worlds with different in-world calendars both keep the structured age untouched.
    const other = newSave(demo);
    other.calendar = { ...other.calendar!, month_lengths: [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], source: '测试历法：12 个月、每月 30 天' };
    other.entities.find(entity => entity.id === other.player_state.entity_id)!.components.identity.age = 33;
    const round = validateSave(JSON.parse(JSON.stringify(other)));
    expect(ageOf(round.entities.find(entity => entity.id === round.player_state.entity_id), round)).toBe(33);
    expect(Number.isFinite(calculateClosurePressure(round, ensureNarrativeState(round)))).toBe(true);
    // Display helpers and the detail surface.
    expect(ageLabel(24)).toBe('24 岁');
    expect(ageLabel(0)).toBe('0 岁');
    expect(ageLabel(null)).toBe('未设定');
    expect(ageLabel(undefined)).toBe('未设定');
    expect(ageLabel('24')).toBe('未设定');
    expect(ageLabel(-1)).toBe('未设定');
    const panel = await readFile('src/client/panels.tsx', 'utf8');
    expect(panel).toContain('年龄：{ageLabel(entity.components.identity?.age)}');
  });
});

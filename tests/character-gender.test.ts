import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import type { AIRequest } from '../src/ai/contracts.js';
import { GameService } from '../src/server/service.js';
import { newSave, validateSave } from '../src/core/state.js';
import type { SavePackage } from '../src/core/schema.js';
import { genderLabel, genderValues } from '../src/shared/gender.js';
import { demo, MemoryStore } from './helpers.js';

const blueprint = async () => JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8'));
const identityOf = (save: SavePackage, id: string) => save.entities.find(entity => entity.id === id)!.components.identity as { gender?: unknown };
const service = (store: MemoryStore, adapter: MockAIAdapter) => new GameService(store, new AIRuntime(adapter), demo);

describe('character gender', () => {
  it('records the gender of the player and every new character as a legal value', async () => {
    const base = await blueprint();
    base.player.gender = 'female';
    base.characters[0].gender = 'male';
    const store = new MemoryStore(), game = service(store, new MockAIAdapter(base));
    await game.newGame('一个普通的小镇。');
    const save = await game.current();
    expect(identityOf(save, save.player_state.entity_id).gender).toBe('female');
    expect(identityOf(save, base.characters[0].id).gender).toBe('male');
    for (const entity of save.entities) {
      const value = (entity.components.identity as { gender?: unknown } | undefined)?.gender;
      expect(value === null || value === undefined || (genderValues as readonly unknown[]).includes(value)).toBe(true);
    }
    // The created world persists the field rather than deriving it again on every read.
    const stored = await store.read();
    expect(identityOf(stored!, base.characters[0].id).gender).toBe('male');
  });

  it('keeps a defined gender across turns and restarts, hands it to the narrator, and changes nothing else', async () => {
    const base = await blueprint();
    base.player.gender = 'female';
    base.characters[0].gender = 'male';
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
    // Put the character where the player is so one real turn (with a narrator call) can run.
    const placed = await game.current();
    placed.entities.find(entity => entity.id === npcId)!.components.location = structuredClone(placed.entities.find(entity => entity.id === playerId)!.components.location);
    await store.write(placed);
    const before = structuredClone(await game.current());
    await game.turn({ request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, action: { type: 'TALK', target_id: npcId, parameters: { topic: '你好' } } });
    const after = await game.current();
    expect(identityOf(after, npcId).gender).toBe('male');
    expect(identityOf(after, playerId).gender).toBe('female');
    expect(identityOf((await store.read())!, npcId).gender).toBe('male');
    // The narrator reads the same canonical value, and is told not to change or invent it.
    expect(narratorPrompts.length).toBeGreaterThan(0);
    expect(narratorPrompts.at(-1)).toContain('"gender":"male"');
    expect(narratorPrompts.at(-1)).toContain('identity.gender 是已确定的人物基本资料');
    // A service restart on the same store keeps the same value.
    const restarted = service(store, new MockAIAdapter(base));
    expect(identityOf(await restarted.current(), npcId).gender).toBe('male');
    // Names, identity text, character profile and relationships are untouched by the turn.
    const shape = (save: SavePackage, id: string) => ({
      identity: { ...identityOf(save, id) },
      character: save.entities.find(entity => entity.id === id)!.components.character,
      relationships: save.entities.find(entity => entity.id === playerId)!.components.relationships,
    });
    expect(shape(after, npcId)).toEqual(shape(before, npcId));
    expect(shape(after, playerId)).toEqual(shape(before, playerId));
  });

  it('loads a legacy world without any gender field and never infers one from name or appearance', async () => {
    const raw = JSON.parse(await readFile('content/worlds/town.json', 'utf8'));
    expect(JSON.stringify(raw.entities).includes('gender')).toBe(false);
    const store = new MemoryStore();
    await store.write(newSave(demo));
    const game = service(store, new MockAIAdapter(await blueprint()));
    const view = await game.view();
    expect(view).not.toBeNull();
    const entity = view!.entities.find(item => item.components.character && item.id !== view!.player_id)!;
    expect(entity.components.identity?.gender ?? null).toBeNull();
    expect(genderLabel(entity.components.identity?.gender)).toBe('未设定');
    // Reading, validating and persisting again never fills the field in on its own.
    const reread = validateSave(JSON.parse(JSON.stringify(await game.current())));
    expect(identityOf(reread, entity.id).gender ?? null).toBeNull();
    expect(identityOf(reread, reread.player_state.entity_id).gender ?? null).toBeNull();
  });

  it('initialises a world whose blueprint omits gender entirely, and shows 未设定 for it', async () => {
    const base = await blueprint();
    delete base.player.gender;
    for (const character of base.characters) delete character.gender;
    const store = new MemoryStore(), game = service(store, new MockAIAdapter(base));
    const created = await game.newGame('一个普通的小镇。');
    const save = await game.current();
    expect(identityOf(save, base.characters[0].id).gender ?? null).toBeNull();
    expect(genderLabel(identityOf(save, base.characters[0].id).gender)).toBe('未设定');
    expect(created.game_id).toBe(save.game_id);
    // Player-facing labels are never invented, and the detail surface reads the canonical field.
    expect(genderLabel('male')).toBe('男');
    expect(genderLabel('female')).toBe('女');
    expect(genderLabel('nonbinary')).toBe('其他');
    expect(genderLabel('美咲')).toBe('未设定');
    const panel = await readFile('src/client/panels.tsx', 'utf8');
    expect(panel).toContain('性别：{genderLabel(entity.components.identity?.gender)}');
  });
});

import { it, expect } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { normalizeCharacterCard } from '../src/compat/character-card.js';
import { GameService } from '../src/server/service.js';
import { demo, MemoryStore } from './helpers.js';

it('normalizes Character Card V1, V2 and V3 JSON without discarding unknown raw fields', () => {
  const v1 = normalizeCharacterCard({ name: 'Legacy', description: 'old', personality: 'calm', custom: { keep: true } });
  expect(v1.source_spec).toBe('v1'); expect(v1.name).toBe('Legacy'); expect((v1.raw as any).custom.keep).toBe(true);

  const v2 = normalizeCharacterCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'V2', description: 'desc', personality: 'kind', scenario: 'school', first_mes: 'hi', mes_example: '', tags: ['student'], extensions: { x: 1 } } });
  expect(v2.source_spec).toBe('v2'); expect(v2.tags).toEqual(['student']); expect(v2.extensions).toEqual({ x: 1 });

  const v3 = normalizeCharacterCard({ spec: 'chara_card_v3', spec_version: '3.1', data: { name: 'V3', description: 'desc', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: 'persona hint', post_history_instructions: '', alternate_greetings: ['hey'], tags: [], creator: 'maker', character_version: '1', extensions: {}, future_field: 42 } });
  expect(v3.source_spec).toBe('v3'); expect(v3.spec_version).toBe('3.1'); expect((v3.raw as any).data.future_field).toBe(42);
});

it('imports a character card into the current location without advancing time or calling AI', async () => {
  let aiCalls = 0;
  const adapter = { name: 'counting', generate: async () => { aiCalls++; throw new Error('should not call'); } };
  const service = new GameService(new MemoryStore(), new AIRuntime(adapter), demo);
  const start = await service.newGame();
  const before = await service.current();
  const out = await service.importCharacterCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Imported NPC', description: 'A test NPC.', personality: 'curious', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], tags: ['test'], creator: '', character_version: '', extensions: {}, system_prompt: '', post_history_instructions: '', creator_notes: '' } }, start.game_id, start.revision);
  expect(out.revision).toBe(start.revision + 1);
  expect(out.time).toEqual(before.runtime.time);
  expect(aiCalls).toBe(0);
  const entity = out.entities.find(e => e.components.identity?.name === 'Imported NPC');
  expect(entity?.components.location?.location_id).toBe(before.entities.find(e => e.id === before.player_state.entity_id)?.components.location?.location_id);
  expect(entity?.components.character_card?.source_spec).toBe('v2');
  expect(entity?.components.character_card?.raw).toBeUndefined();
  const stored = await service.current();
  expect((stored.entities.find(e => e.id === entity?.id)?.components.character_card?.raw as any)?.spec).toBe('chara_card_v2');
});

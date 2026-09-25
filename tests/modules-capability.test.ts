import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { newSave, publicView } from '../src/core/state.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { compileWorld } from '../src/ai/authoring.js';
import { readProfile } from '../src/ai/profiles.js';
import { panelRegistry } from '../src/client/panels.js';
import { moduleIntent } from '../src/modules/intent.js';
import { demo, MemoryStore } from './helpers.js';
import type { WorldPackage } from '../src/core/schema.js';

function socialWorld(): WorldPackage {
  const world = structuredClone(demo) as WorldPackage;
  world.enabled_modules = ['core', 'characters', 'relationships'];
  world.entities = world.entities.filter(entity => entity.type === 'character').map(entity => {
    const components = Object.fromEntries(Object.entries(entity.components).filter(([name]) => ['identity', 'character', 'relationships'].includes(name)));
    return { ...entity, components };
  });
  delete (world as { map?: unknown }).map;
  // A world without the map capability cannot keep location-bound world events.
  world.events = world.events.filter(event => !event.location_id && !event.reveal_location_id);
  return world;

}
function inventoryWorld(): WorldPackage {
  const world = socialWorld();
  world.enabled_modules = ['core', 'characters', 'inventory', 'quests'];
  const player = world.entities.find(entity => entity.id === world.player.entity_id)!;
  player.components.inventory = { items: {} };
  player.components.quests = { entries: {} };
  return world;
}
const envelope = async (service: GameService, action: unknown) => {
  const save = await service.current();
  return { game_id: save.game_id, expected_revision: save.state_revision, request_id: randomUUID(), action };
};
const serviceFor = (world: WorldPackage) => new GameService(new MemoryStore(), new AIRuntime(new MockAIAdapter()), world);

it('a minimal social world has no map, inventory, commerce or routine at all', async () => {
  const service = serviceFor(socialWorld());
  const view = await service.newGame();
  const ids = view.panels.map(panel => panel.id);
  expect(ids).toContain('status');
  expect(ids).toContain('characters');
  for (const absent of ['map', 'inventory', 'commerce', 'routine', 'equipment', 'quests']) expect(ids).not.toContain(absent);
  expect(view.locations).toEqual([]);
  expect(view.actions.some(action => action.type === 'MOVE')).toBe(false);
  expect(view.actions.some(action => action.type === 'START_ROUTINE')).toBe(false);
  const save = await service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  expect(player.components.location).toBeUndefined();
  expect(player.components.routine).toBeUndefined();
  expect(player.components.condition).toBeUndefined();
  expect(save.modules.map).toBeUndefined();
  expect(view.modules.find(module => module.id === 'map')?.installed).toBe(false);
  expect(view.capabilities).toContain('character.identity');
  expect(view.capabilities).not.toContain('map.graph');
  // The status surface renders from whatever components exist — it invents nothing.
  const html = renderToStaticMarkup(createElement(panelRegistry.status, { view, act: () => {}, busy: false }));
  expect(html).toContain('新住民');
  expect(html).not.toContain('当前位置');
});

it('an inventory world without a map still runs and validates', async () => {
  const service = serviceFor(inventoryWorld());
  const view = await service.newGame();
  expect(view.panels.map(panel => panel.id)).toEqual(expect.arrayContaining(['inventory', 'quests']));
  expect(view.panels.map(panel => panel.id)).not.toContain('map');
  const turned = await service.turn(await envelope(service, { type: 'WAIT', parameters: { minutes: 10 } }));
  expect(turned.time.minute).toBe(550);
});

it('ENABLE_MODULE map initialises the minimum state and survives reload', async () => {
  const store = new MemoryStore();
  const service = new GameService(store, new AIRuntime(new MockAIAdapter()), socialWorld());
  await service.newGame();
  expect((await service.view())?.panels.map(panel => panel.id)).not.toContain('map');
  const first = await service.current();
  await expect(service.manageModule({ module: 'map', confirmed: false, game_id: first.game_id, expected_revision: first.state_revision, request_id: randomUUID() }, 'enable')).rejects.toThrow('确认');
  const enabled = await service.manageModule({ module: 'map', confirmed: true, game_id: (await service.current()).game_id, expected_revision: (await service.current()).state_revision, request_id: randomUUID() }, 'enable');
  expect(enabled.panels.map(panel => panel.id)).toContain('map');
  expect(enabled.locations.map(location => location.id)).toContain('start');
  expect(enabled.actions.some(action => action.type === 'MOVE')).toBe(true);
  const reloaded = new GameService(store, new AIRuntime(new MockAIAdapter()), socialWorld());
  const view = await reloaded.view();
  expect(view?.panels.map(panel => panel.id)).toContain('map');
  expect((await reloaded.current()).modules.map).toMatchObject({ installed: true, enabled: true });
});

it('DISABLE_MODULE hides panels and actions while data stays dormant for re-enable', async () => {
  const service = serviceFor(structuredClone(demo) as WorldPackage);
  const before = await service.newGame();
  expect(before.panels.map(panel => panel.id)).toContain('map');
  const dormantMap = JSON.stringify((await service.current()).definition.map);
  const disabled = await service.manageModule({ module: 'map', confirmed: true, game_id: before.game_id, expected_revision: before.revision, request_id: randomUUID() }, 'disable');
  expect(disabled.panels.map(panel => panel.id)).not.toContain('map');
  expect(disabled.actions.some(action => action.type === 'MOVE')).toBe(false);
  const dormant = await service.current();
  expect(JSON.stringify(dormant.definition.map)).toBe(dormantMap);
  expect(dormant.modules.map).toMatchObject({ installed: true, enabled: false });
  const again = await service.manageModule({ module: 'map', confirmed: true, game_id: dormant.game_id, expected_revision: dormant.state_revision, request_id: randomUUID() }, 'enable');
  expect(again.panels.map(panel => panel.id)).toContain('map');
  expect(JSON.stringify((await service.current()).definition.map)).toBe(dormantMap);
});

it('dependency rules block removing a module other enabled modules need', async () => {
  const service = serviceFor(structuredClone(demo) as WorldPackage);
  const view = await service.newGame();
  await expect(service.manageModule({ module: 'characters', confirmed: true, game_id: view.game_id, expected_revision: view.revision, request_id: randomUUID() }, 'remove')).rejects.toThrow('依赖');
  await expect(service.manageModule({ module: 'inventory', confirmed: true, game_id: view.game_id, expected_revision: view.revision, request_id: randomUUID() }, 'disable')).rejects.toThrow('依赖');
  const removed = await service.manageModule({ module: 'commerce', confirmed: true, game_id: view.game_id, expected_revision: view.revision, request_id: randomUUID() }, 'remove');
  expect(removed.panels.map(panel => panel.id)).not.toContain('commerce');
  const save = await service.current();
  expect(save.definition.enabled_modules).not.toContain('commerce');
  expect(save.modules.commerce).toMatchObject({ installed: false, enabled: false });

  expect(save.entities.some(entity => entity.components.shop)).toBe(false);
  expect(save.entities.some(entity => entity.components.wallet)).toBe(false);
});

it('the world compiler installs only the capabilities the description selected', async () => {
  const blueprint = {
    id: 'social_school', title: '校园', description: '纯校园社交世界', modules: ['characters', 'relationships'] as const,
    currency: { id: 'credit', name: '点' }, player: { id: 'player', name: '学生', description: '新来的学生', cash: 10 },
    characters: [{ id: 'friend', name: '同学', description: '同班同学', role: '同学' }], items: [], locations: [], routes: [],
    hidden_notes: '无', opening: '开学第一天。',
  };
  const world = compileWorld(blueprint as never, await readProfile('content/profiles/default.json'));
  expect(world.enabled_modules).toEqual(['core', 'characters', 'relationships']);
  expect(world.map).toBeUndefined();
  expect(world.routine_rules).toBeUndefined();
  const save = newSave(world);
  const view = publicView(save);
  expect(view.panels.map(panel => panel.id)).toEqual(expect.arrayContaining(['status', 'characters', 'relationships']));
  expect(view.panels.map(panel => panel.id)).not.toContain('map');
  expect(save.entities.find(entity => entity.id === 'player')!.components.wallet).toBeUndefined();
});

it('module metadata and extensions survive an export/import round trip', async () => {
  const service = serviceFor(structuredClone(demo) as WorldPackage);
  const view = await service.newGame();
  const disabled = await service.manageModule({ module: 'routine', confirmed: true, game_id: view.game_id, expected_revision: view.revision, request_id: randomUUID() }, 'disable');
  expect(disabled.modules.find(module => module.id === 'routine')?.enabled).toBe(false);
  const exported = await service.export();
  const reimported = await service.import(JSON.parse(exported));
  expect(reimported.modules.find(module => module.id === 'routine')).toMatchObject({ installed: true, enabled: false });
  expect(reimported.panels.map(panel => panel.id)).not.toContain('routine');
  const save = await service.current();
  expect(save.modules.routine).toMatchObject({ installed: true, enabled: false });
  expect(save.definition.enabled_modules).not.toContain('routine');

});

it('natural language module management maps to the right lifecycle action', () => {
  expect(moduleIntent('我想给这个世界加地图。')).toMatchObject({ type: 'ENABLE_MODULE', module: 'map', confirmed: false });
  expect(moduleIntent('确认启用地图')).toMatchObject({ type: 'ENABLE_MODULE', module: 'map', confirmed: true });
  expect(moduleIntent('我不需要商店了。')).toMatchObject({ type: 'DISABLE_MODULE', module: 'commerce' });
  expect(moduleIntent('关闭生活模式。')).toMatchObject({ type: 'DISABLE_MODULE', module: 'routine' });
  expect(moduleIntent('彻底移除装备系统')).toMatchObject({ type: 'REMOVE_MODULE', module: 'equipment' });
  expect(moduleIntent('我去广场散步')).toBeNull();
});

import { it, expect } from 'vitest';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { migrationReasons, migrateInstalledWorld, type InstalledWorld } from '../src/routine/migration.js';
import { newSave, validateSave } from '../src/core/state.js';
import { demo, MemoryStore } from './helpers.js';
import type { SavePackage, WorldPackage } from '../src/core/schema.js';

const legacyMarker = '【LEGACY_PUBLIC_CANON_REV43】';

// A v0.1.2-style save: flat map, no routine metadata, an accepted commitment only recorded in the legacy canon.
function legacySave(): SavePackage {
  const current = newSaveForTest();
  const legacy = structuredClone(current);
  const flat = structuredClone(current.definition.map);
  legacy.definition.map = structuredClone(flat);
  legacy.definition.prompt_profile.engine_policy = `你是持续世界引擎。\n${legacyMarker}\n${JSON.stringify({
    opportunities: {
      neighbor_town_student_resettlement: { status: 'accepted', event_time: '3月6日周六上午', time_cost: '约半天', task: '协助接待并安置从邻镇临时分流来的学生' },
      declined_lecture: { status: 'declined_due_to_schedule_conflict', event_time: '3月4日晚上', task: '符文讲座' },
    },
  })}`;
  delete (legacy as { routine_meta?: unknown }).routine_meta;
  legacy.map_state = { known_location_ids: (flat?.locations ?? []).map(location => location.id), dynamic_locations: [], dynamic_routes: [] };
  legacy.calendar = { version: 1, anchor_day: legacy.runtime.time.day, anchor_month: 3, anchor_date: 3, anchor_weekday: 3, month_lengths: [31,28,31,30,31,30,31,31,30,31,30,31], source: '玩家确认当前时间映射' };
  return validateSave(legacy);
}
function newSaveForTest() {
  return newSave(demo);
}

function installedWorld(): InstalledWorld {
  // Use the parsed definition: zod fills schema defaults, and the legacy signature must match byte for byte.
  const world = structuredClone(newSave(demo).definition) as WorldPackage;
  const legacyMaps = [structuredClone(world.map)];
  world.map!.locations.unshift({ id: 'herne_world_map', name: '赫恩谷地', description: '地区根节点', tags: [], parent_id: null, position: { x: 50, y: 10 } });
  world.map!.locations.forEach(location => { if (location.id !== 'herne_world_map') location.parent_id = 'herne_world_map'; });
  return { world, legacy_maps: legacyMaps };
}


it('import normalises a legacy save, and export re-imports without repeating the migration', async () => {
  const installed = installedWorld();
  const service = new GameService(new MemoryStore(), new AIRuntime(new MockAIAdapter()), demo, [installed]);
  const legacy = legacySave();

  const imported = await service.import(legacy);
  const canonical = await service.current();

  // The authoritative map is the current standard map, not the legacy flat map.
  expect(canonical.definition.map!.locations.map(location => location.id)).toEqual(installed.world.map!.locations.map(location => location.id));
  expect(canonical.definition.map!.locations.filter(location => location.parent_id === 'herne_world_map')).toHaveLength(installed.world.map!.locations.length - 1);
  expect(canonical.routine_meta?.migration_ids).toEqual(expect.arrayContaining(['installed-map-v1','legacy-accepted-tasks-v1']));
  expect(canonical.calendar?.anchor_month).toBe(3);
  // Only explicitly accepted commitments become schedule constraints, with a window instead of an invented clock.
  const tasks = canonical.routine_meta!.scheduled_tasks;
  expect(tasks.map(task => task.id)).toEqual(['neighbor_town_student_resettlement']);
  expect(tasks[0]).toMatchObject({ window: 'morning', status: 'accepted', resolved: false, duration_label: '约半天' });

  expect(tasks[0].label).toBe('协助接待并安置从邻镇临时分流来的学生');
  expect(tasks[0].at % 1440).toBe(480);
  expect(imported.revision).toBeGreaterThanOrEqual(0);

  // Canonical gameplay state survives normalisation untouched (only framework routine bookkeeping is added).
  const gameplay = (entities: SavePackage['entities']) => entities.map(entity => ({ id: entity.id, type: entity.type, components: Object.fromEntries(Object.entries(entity.components).filter(([name]) => name !== 'routine')) }));
  expect(gameplay(canonical.entities)).toEqual(gameplay(legacy.entities));
  expect(canonical.gm_state).toEqual(legacy.gm_state);
  expect(canonical.event_state).toEqual(legacy.event_state);
  expect(canonical.runtime.time).toEqual(legacy.runtime.time);

  const exported = await service.export();
  const parsed = JSON.parse(exported) as SavePackage;
  expect(parsed.ai.threads).toEqual({});
  expect(validateSave(parsed).definition.map).toEqual(installed.world.map);

  // Re-importing a standard export triggers no legacy migration at all.
  expect(migrationReasons(parsed, [installed])).toEqual([]);
  expect(migrateInstalledWorld(structuredClone(parsed), [installed]).changed).toBe(false);

  const reimported = await service.import(parsed);
  const again = await service.current();
  expect(again.definition.map).toEqual(parsed.definition.map);
  expect(again.routine_meta).toEqual(parsed.routine_meta);
  expect(gameplay(again.entities)).toEqual(gameplay(parsed.entities));

  expect(reimported.title).toBe(imported.title);
});

it('a world without an installed package still normalises routine state once', () => {
  const legacy = legacySave();
  const { save, changed } = migrateInstalledWorld(legacy, []);
  expect(changed).toBe(true);
  expect(save.routine_meta?.migration_ids).toContain('legacy-accepted-tasks-v1');
  expect(migrationReasons(save, [])).toEqual([]);
});

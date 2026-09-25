import { it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDisplayIndex, displayDiagnostic, displayText, resolvePresentation, setDisplayReporter, type UnresolvedReport } from '../src/shared/display.js';
import { newSave, publicView } from '../src/core/state.js';
import { panelRegistry } from '../src/client/panels.js';
import type { WorldPackage } from '../src/core/schema.js';
import { demo } from './helpers.js';

function collect(run: () => void) {
  const reports: UnresolvedReport[] = [];
  setDisplayReporter(report => reports.push(report));
  try { run(); } finally { setDisplayReporter(null); }
  return reports;
}
function migratedWorld(): WorldPackage {
  const world = structuredClone(demo) as WorldPackage;
  const player = world.entities.find(entity => entity.id === 'player')!;
  player.id = 'lia_lane';
  player.components.identity = { name: '莉娅·莱恩', description: '15岁，学院学生。', avatar_id: null };
  world.player.entity_id = 'lia_lane';
  world.entities.push({
    id: 'maeve_cole', type: 'character',
    components: {
      identity: { name: '梅芙·科尔', description: '面包房帮工，白榆街合租屋室友。', avatar_id: null },
      character: { role: '室友', traits: [] },
      location: { location_id: 'square' },
    },
  });
  return world;
}

it('player-visible prose shows display names and never leaks an internal entity id', () => {
  const save = newSave(migratedWorld());
  save.last_turn = {
    narrative: 'lia_lane回到白榆街合租屋，与maeve_cole聊了几句学院日常。',
    speaker: 'maeve_cole', dialogue: null, choices: ['问问maeve_cole面包房的排班'], context_actions: [],
  };
  const view = publicView(save);
  expect(view.last_turn!.narrative).toContain('莉娅·莱恩');
  expect(view.last_turn!.narrative).toContain('梅芙·科尔');
  expect(view.last_turn!.narrative).not.toContain('lia_lane');
  expect(view.last_turn!.narrative).not.toContain('maeve_cole');
  expect(view.last_turn!.choices[0]).toBe('问问梅芙·科尔面包房的排班');
  // Structured fields keep canonical ids so panels can still look objects up by id.
  expect(view.last_turn!.speaker).toBe('maeve_cole');
  const markup = renderToStaticMarkup(createElement(panelRegistry.characters, { view, act: () => {}, busy: false }));
  expect(markup).toContain('梅芙·科尔');
  expect(markup).not.toContain('maeve_cole');
  expect(markup).not.toContain('lia_lane');
});

it('schema keys, metadata keys, enum values and equipment slots never warn', () => {
  const world = migratedWorld();
  world.enabled_modules.push('equipment', 'quests');
  const person = world.entities.find(entity => entity.id === 'maeve_cole')!;
  person.components.equipment_item = { allowed_slots: ['main_hand', 'accessory_2'], modifiers: {}, effect: '测试用装备' };
  person.components.identity = {
    name: '梅芙·科尔', avatar_id: null,
    description: JSON.stringify({
      student_count: 23, public_reason: '邻镇道路施工', likely_tasks: ['带路'], pay_copper: 0,
      accepted_date: '3月6日', interest_only: true, not_purchased: true, possible_value: ['人脉'],
      equipment: { main_hand: '铜环聚焦魔杖', accessory_2: '小型聚魔坠' },
      known_state: ['与maeve_cole同住白榆街合租屋'],
    }),
  };
  const player = world.entities.find(entity => entity.id === 'lia_lane')!;
  player.components.quests = {
    entries: {
      neighbor_town_student_resettlement: {
        title: '邻镇学生安置', status: 'interest_only', summary: '志愿者圈邀请。', objectives: [], deadline: null, tags: [],
        metadata: { pay_copper: 0, accepted_date: '3月6日', main_hand: 'basket', player_choice_required: true },
      },
    },
  };
  player.components.opportunities = { entries: {} };
  const save = newSave(world);
  expect(collect(() => publicView(save))).toEqual([]);

  const view = publicView(save);
  const description = JSON.parse(String(view.entities.find(entity => entity.id === 'maeve_cole')!.components.identity.description)) as Record<string, unknown>;
  expect(description.pay_copper).toBe(0);
  expect(description.accepted_date).toBe('3月6日');
  expect(description.student_count).toBe(23);
  expect(description.not_purchased).toBe(true);
  expect((description.known_state as string[])[0]).toBe('与梅芙·科尔同住白榆街合租屋');
  const equipment = view.entities.find(entity => entity.id === 'maeve_cole')!.components.equipment_item as { allowed_slots: string[] };
  expect(equipment.allowed_slots).toEqual(['main_hand', 'accessory_2']);
  const quests = (view.entities.find(entity => entity.id === 'lia_lane')!.components.quests as { entries: Record<string, { status: string }> }).entries;
  expect(quests.neighbor_town_student_resettlement.status).toBe('interest_only');
});

it('resolves only explicit reference fields and reports genuinely missing targets', () => {
  const view = publicView(newSave(migratedWorld()));
  expect(collect(() => {
    const resolved = resolvePresentation({ target_id: 'maeve_cole', participant_ids: ['lia_lane', 'maeve_cole'], slot: 'main_hand', pay_copper: 0 }, view.entities, view.locations) as Record<string, unknown>;
    expect(resolved.target_id).toBe('maeve_cole');
    expect(resolved.participant_ids).toEqual(['lia_lane', 'maeve_cole']);
    expect(resolved.slot).toBe('main_hand');
    expect(resolved.pay_copper).toBe(0);
    expect(displayText('与maeve_cole同行', view.entities, view.locations)).toBe('与梅芙·科尔同行');
    expect(displayText('与npc_lin交谈', view.entities, view.locations)).toBe('与林舟交谈');
  })).toEqual([]);

  const missing = collect(() => {
    const resolved = resolvePresentation({ target_id: 'ghost_person', location_id: 'ghost_place', item_id: 'ghost_item' }, view.entities, view.locations) as Record<string, unknown>;
    expect(resolved).toEqual({ target_id: '未知对象', location_id: '未知对象', item_id: '未知对象' });
  });
  expect(missing.map(report => `${report.scope}|${report.kind}|${report.key}|${report.value}`)).toEqual([
    'reference|entity|target_id|ghost_person',
    'reference|location|location_id|ghost_place',
    'reference|item|item_id|ghost_item',
  ]);
  expect(missing.every(report => report.path.startsWith('$'))).toBe(true);

  const prose = collect(() => { expect(displayText('unknown_project尚未公开', view.entities, view.locations)).toBe('未知对象尚未公开'); });
  expect(prose).toHaveLength(1);
  expect(prose[0]).toMatchObject({ scope: 'prose', value: 'unknown_project', kind: 'entity' });
});

it('diagnostic text keeps provider and scheduler tokens instead of masking them', () => {
  const view = publicView(newSave(migratedWorld()));
  const reports = collect(() => {
    expect(displayDiagnostic('DeepSeek 响应未完成: max_output_tokens', view.entities, view.locations)).toBe('DeepSeek 响应未完成: max_output_tokens');
    expect(displayDiagnostic('生活模式生成失败', view.entities, view.locations)).toBe('生活模式生成失败');
    expect(displayText('与maeve_cole同行', view.entities, view.locations)).toBe('与梅芙·科尔同行');
  });
  expect(reports).toEqual([]);
});

it('routine clarifications and inferred assumptions are localised but never masked', () => {
  const view = publicView(newSave(migratedWorld()));
  const reports = collect(() => {
    const resolved = resolvePresentation({ clarification: '学院课程 academy_course 与固定学习组 study_group 时长不一致', plan: { applied_assumptions: ['按默认时段推断 08:00 开始'] } }, view.entities, view.locations) as { clarification: string; plan: { applied_assumptions: string[] } };
    expect(resolved.clarification).toContain('学院课程');
    expect(resolved.clarification).not.toContain('未知对象');
    expect(resolved.plan.applied_assumptions[0]).toContain('08:00');
  });
  expect(reports).toEqual([]);
});

it('treats a JSON document inside a prose field as structured data', () => {

  const view = publicView(newSave(migratedWorld()));
  const reports = collect(() => {
    const rendered = displayText(JSON.stringify({ role: '室友', current_relationship: '普通熟人', known_state: ['与lia_lane同住'], pay_copper: 0 }), view.entities, view.locations);
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(parsed.role).toBe('室友');
    expect(parsed.pay_copper).toBe(0);
    expect((parsed.known_state as string[])[0]).toBe('与莉娅·莱恩同住');
  });
  expect(reports).toEqual([]);
});


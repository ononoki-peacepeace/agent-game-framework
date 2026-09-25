import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { parseDice, rollDice } from '../src/core/dice.js';
import { advanceTime } from '../src/core/time.js';
import { createRegistry, availableModules } from '../src/modules/index.js';
import { EntityStore, Registry, type Module } from '../src/core/registry.js';
import { executeAction, applyPatches } from '../src/core/runtime.js';
import { fresh } from './helpers.js';
import { publicView, validateSave } from '../src/core/state.js';
import { addDynamicLocation, revealLocation } from '../src/core/map.js';
const run = (save: ReturnType<typeof fresh>, type: string, parameters = {}, target_id?: string) => executeAction(save, { type, parameters, ...(target_id ? { target_id } : {}) }, randomUUID());

describe('deterministic primitives', () => {
  it.each(['1d20','3d6','2d6+3','1d100','2d6-2'])('parses %s', expr => expect(parseDice(expr).count).toBeGreaterThan(0));
  it.each(['d20','0d6','1d1','101d6','1d999999','1d6;process.exit()'])('rejects %s', expr => expect(() => parseDice(expr)).toThrow());
  it('uses injected randomness and bounds', () => { expect(rollDice('2d6+3', () => 0).total).toBe(5); expect(rollDice('2d6-1', () => .999).total).toBe(11); expect(() => rollDice('1d6', () => 1)).toThrow(); });
  it('crosses day boundary without Gregorian assumptions', () => expect(advanceTime({ day: 3, minute: 599 }, 62, 600)).toEqual({ day: 4, minute: 61 }));
  it('rejects negative time', () => expect(() => advanceTime({ day: 1, minute: 0 }, -1, 1440)).toThrow());
});
describe('registries and extensions', () => {
  it('rejects duplicates and missing dependencies', () => { const r = new Registry<number>(); r.register('x', 1); expect(() => r.register('x', 2)).toThrow(); expect(() => createRegistry(['core','commerce'])).toThrow(); });
  it('validates component updates', () => { const s = fresh(), reg = createRegistry(s.definition.enabled_modules), store = new EntityStore(s, reg); expect(() => store.update('player', 'wallet', { balances: { credit: -1 } })).toThrow(); expect(() => store.component('ghost','wallet')).toThrow(); });
  it('adds Company component, action and hook without dispatcher edits', () => {
    const company: Module = { id: 'company', version: '0.1.0', requires: ['core'], components: { company: { schema: z.strictObject({ cash: z.number().int().min(0), employees: z.array(z.string()) }) } },
      actions: { HIRE: { parameters: z.strictObject({ employee: z.string() }), execute(c) { c.store.component<{ cash: number; employees: string[] }>('co', 'company').employees.push(String(c.action.parameters.employee)); c.advance(15); } } },
      handlers: { on_action_complete(c) { c.facts.push('company hook'); } } };
    const s = fresh(); s.definition.enabled_modules.push('company'); s.module_versions.company = '0.1.0'; s.entities.push({ id: 'co', type: 'company', components: { company: { cash: 10, employees: [] } } });
    const reg = createRegistry(s.definition.enabled_modules, [...availableModules, company]);
    const result = executeAction(s, { type: 'HIRE', parameters: { employee: 'npc_lin' } }, randomUUID(), 'player', () => .5, reg);
    expect(result.save.entities.find(e => e.id === 'co')!.components.company.employees).toEqual(['npc_lin']); expect(result.facts).toContain('company hook');
  });
});

describe('rpg extension modules', () => {
  it('stores attributes, aptitudes, skills, traits, quests and validates equipment', () => {
    const s = fresh();
    for (const name of ['attributes','aptitudes','skills','traits','equipment','quests']) s.definition.enabled_modules.push(name);
    s.module_versions.attributes = '0.1.0'; s.module_versions.aptitudes = '0.1.0'; s.module_versions.skills = '0.1.0';
    s.module_versions.traits = '0.1.0'; s.module_versions.equipment = '0.1.0'; s.module_versions.quests = '0.1.0';
    const player = s.entities.find(e => e.id === 'player')!;
    player.components.attributes = { values: { physique: 5, intellect: 3 } };
    player.components.aptitudes = { entries: { magic: { name: '魔法', value: 95, tags: [], note: '高适性' } } };
    player.components.skills = { entries: { magic_basics: { name: '魔法基础', level: 1, xp: 78, next_xp: 120, aptitude_ref: 'magic', tags: ['magic'] } } };
    player.components.traits = { entries: { light_sleeper: { name: '浅眠', type: 'persistent', status: 'active', effects: ['更容易被动静惊醒'], tags: [] } } };
    player.components.equipment = { slots: { main_hand: null } };
    player.components.quests = { entries: { welcome: { title: '欢迎任务', status: 'active', summary: '测试任务', objectives: ['完成测试'], deadline: null, tags: [], metadata: {} } } };
    player.components.opportunities = { entries: {} };
    const item = s.entities.find(e => e.id === 'notebook')!;
    item.components.equipment_item = { allowed_slots: ['main_hand'], modifiers: { control: 1 }, effect: '+1 控制' };
    ((player.components.inventory as any).items as Record<string, number>).notebook = 1;
    expect((((validateSave(s).entities.find(e => e.id === 'player')!.components.skills as any).entries.magic_basics.level))).toBe(1);
    let out = run(s, 'EQUIP', { item_id: 'notebook', slot: 'main_hand' });
    expect(((out.save.entities.find(e => e.id === 'player')!.components.equipment as any).slots.main_hand)).toBe('notebook');
    out = run(out.save, 'UNEQUIP', { slot: 'main_hand' });
    expect(((out.save.entities.find(e => e.id === 'player')!.components.equipment as any).slots.main_hand)).toBeNull();
  });
  it('rejects dangling aptitude and equipped item references', () => {
    const s = fresh();
    for (const name of ['aptitudes','skills','equipment']) s.definition.enabled_modules.push(name);
    s.module_versions.aptitudes = '0.1.0'; s.module_versions.skills = '0.1.0'; s.module_versions.equipment = '0.1.0';
    const player = s.entities.find(e => e.id === 'player')!;
    player.components.aptitudes = { entries: {} };
    player.components.skills = { entries: { x: { name: 'X', level: 1, xp: 0, next_xp: 10, aptitude_ref: 'missing', tags: [] } } };
    player.components.equipment = { slots: { hand: 'notebook' } };
    expect(() => validateSave(s)).toThrow();
  });
});

describe('map discovery and routine automation', () => {
  it('initializes baseline map, hides discoverable places, and can add/reveal new locations without Core edits', () => {
    const s = fresh();
    s.definition.map!.locations.push({ id:'hidden_room', name:'隐藏房间', description:'尚未发现', tags:[], parent_id:null, known_by_default:false });
    const validated = validateSave(s);
    expect(publicView(validated).locations.some(l => l.id === 'hidden_room')).toBe(false);
    revealLocation(validated, 'hidden_room');
    expect(publicView(validated).locations.some(l => l.id === 'hidden_room')).toBe(true);
    addDynamicLocation(validated, { id:'new_lane', name:'新发现的小巷', description:'探索中发现', tags:[], parent_id:null, known_by_default:false }, [{ from:'market', to:'new_lane', travel_minutes:4, conditions:[] }, { from:'new_lane', to:'market', travel_minutes:4, conditions:[] }], true);
    expect(publicView(validateSave(validated)).locations.some(l => l.id === 'new_lane')).toBe(true);
  });
  it('records routine intent without advancing unvalidated time', () => {
    const s = fresh();
    s.module_versions.routine = '0.1.0';
    s.definition.events.push({ id:'routine_break', hook:'on_time_advance', location_id:null, probability:1, once:true, public_text:'有人敲门找你。', set_flag:null, interrupt_automation:true });
    const out = run(validateSave(s), 'START_ROUTINE', { label:'普通日常', pattern:'照常生活直到有事发生', activities:[], chunk_minutes:60, max_minutes:1440 });
    const routine = out.save.entities.find(e => e.id === 'player')!.components.routine as any;
    expect(routine.active).toBe(true); expect(routine.interrupted).toBe(false);
    expect(out.action.time_cost).toBe(0); expect(out.save.runtime.time).toEqual(s.runtime.time);
  });
});

describe('actions and canonical mechanics', () => {
  it('uses canonical route duration and emits hooks', () => { const s = fresh(), out = run(s, 'MOVE', {}, 'station'); expect(out.save.runtime.time.minute).toBe(558); expect(out.events.map(e => e.type)).toEqual(['on_action_start','on_location_leave','on_time_advance','on_entity_changed','on_travel_complete','on_location_enter','on_action_complete']); expect(out.save.event_state.fired).toContain('station_arrival'); expect(s.runtime.time.minute).toBe(540); });
  it('rejects teleport and route condition bypass', () => { const s = fresh(); expect(() => run(s,'MOVE',{},'ghost')).toThrow(); s.definition.map!.routes[0].conditions = [{ flag: 'locked', equals: true }]; expect(() => run(s,'MOVE',{},'station')).toThrow(); });
  it('bounds WAIT and emits day change', () => { const s = fresh(); s.runtime.time.minute = 1435; expect(run(s,'WAIT',{ minutes: 10 }).events.some(e => e.type === 'on_day_changed')).toBe(true); expect(() => run(s,'WAIT',{ minutes: 10080 })).toThrow(); });
  it('requires a present interlocutor', () => { expect(run(fresh(),'TALK',{ topic: '你好' },'npc_lin').action.time_cost).toBe(5); expect(() => run(fresh(),'TALK',{ topic: '你好' },'npc_qiao')).toThrow(); });
  it('trades atomically, conserves money and stock', () => {
    let s = run(fresh(),'MOVE',{},'market').save;
    s = run(s,'BUY',{ item_id: 'water', quantity: 2 },'corner_shop').save;
    expect(s.entities.find(e => e.id === 'player')!.components.wallet.balances).toEqual({ credit: 88 });
    expect(s.entities.find(e => e.id === 'player')!.components.inventory.items).toEqual({ water: 2 });
    expect((s.entities.find(e => e.id === 'corner_shop')!.components.shop.stock as Record<string,number>).water).toBe(8);
    s = run(s,'SELL',{ item_id: 'water', quantity: 1 },'corner_shop').save;
    expect(s.entities.find(e => e.id === 'player')!.components.wallet.balances).toEqual({ credit: 91 });
    expect((s.entities.find(e => e.id === 'corner_shop')!.components.wallet.balances as Record<string,number>).credit).toBe(1009);
  });
  it('failed trade leaves input unchanged', () => { const s = run(fresh(),'MOVE',{},'market').save, original = structuredClone(s); expect(() => run(s,'BUY',{ item_id: 'notebook', quantity: 10 },'corner_shop')).toThrow('余额'); expect(s).toEqual(original); expect(() => run(s,'SELL',{ item_id: 'water', quantity: 1 },'corner_shop')).toThrow('数量'); });
  it('rejects forged actor/time and unknown actions', () => { expect(() => executeAction(fresh(), { type: 'WAIT', actor_id: 'npc_lin', time_cost: 0, parameters: { minutes: 1 } }, randomUUID())).toThrow(); expect(() => run(fresh(),'HACK')).toThrow(); });
  it('authorizes and bounds relationship patches', () => {
    const result = run(fresh(),'TALK',{ topic: '你好' },'npc_lin');
    const p = { op: 'relationship_delta', entity_id: 'player', target_id: 'npc_lin', dimension: 'trust', delta: 1 };
    expect(() => applyPatches(result.save,[{ ...p, op: 'set_wallet' }],result.action)).toThrow();
    expect(() => applyPatches(result.save,[{ ...p, delta: 3 }],result.action)).toThrow();
    expect(() => applyPatches(result.save,[{ ...p, target_id: 'npc_qiao' }],result.action)).toThrow();
    expect(() => applyPatches(result.save,[p,p],result.action)).toThrow();
    expect(applyPatches(result.save,[p],result.action).entities.find(e => e.id === 'player')!.components.relationships.entries).toEqual({ npc_lin: { trust: 1 } });
  });
  it('hides GM, AI metadata and event rules', () => { const v = JSON.stringify(publicView(fresh())); for(const hidden of ['GM_PRIVATE_CANARY','gm_state','threads','heard_station_notice']) expect(v).not.toContain(hidden); });
  it('validates references and module versions', () => { const s = fresh(); s.entities[0].components.location.location_id = 'missing'; expect(() => validateSave(s)).toThrow(); const v = fresh(); v.module_versions.core = '9'; expect(() => validateSave(v)).toThrow('版本'); });
});

import { z } from 'zod';
import { assert, id, integer } from '../core/schema.js';
import type { Module } from '../core/registry.js';
import { rollDice } from '../core/dice.js';
import { currentMap } from '../core/map.js';

export const coreModule: Module = {
  id: 'core', version: '0.1.0',
  components: {
    identity: { schema: z.strictObject({ name: z.string().min(1).max(120), description: z.string().max(2000), avatar_id: id.nullable().default(null) }), project: d => d },
    location: { schema: z.strictObject({ location_id: id }), project: d => d },
  },
  panels: [{ id: 'status', label: '状态' }, { id: 'map', label: '地图' }],
  actions: {
    WAIT: { ui: { label: '等待', visibility: 'text' }, parameters: z.strictObject({ minutes: integer.min(1) }), execute(c) {
      const minutes = c.action.parameters.minutes as number;
      assert(minutes <= c.save.definition.ruleset.max_wait_minutes, '等待时间超过此世界允许的单次上限');
      c.advance(minutes); c.facts.push(`等待了 ${minutes} 分钟。`);
    } },
    MOVE: { ui: { label: '前往', visibility: 'contextual' }, parameters: z.strictObject({}), execute(c) {
      const location = c.store.component<{ location_id: string }>(c.action.actor_id, 'location');
      const route = currentMap(c.save).routes.find(r => r.from === location.location_id && r.to === c.action.target_id);
      assert(route, '没有可用的直达路线');
      assert(route.conditions.every(x => c.save.gm_state.flags[x.flag] === x.equals), '这条路线目前不可通行');
      c.emit({ type: 'on_location_leave', location_id: location.location_id });
      c.advance(route.travel_minutes);
      c.store.update(c.action.actor_id, 'location', { location_id: route.to });
      c.emit({ type: 'on_entity_changed', entity_id: c.action.actor_id });
      c.emit({ type: 'on_travel_complete', location_id: route.to });
      c.emit({ type: 'on_location_enter', location_id: route.to });
      c.facts.push(`移动至 ${currentMap(c.save).locations.find(l => l.id === route.to)!.name}，用时 ${route.travel_minutes} 分钟。`);
    } },
    CHECK: { ui: { label: '检定', visibility: 'internal' }, parameters: z.strictObject({}), execute(c) {
      const roll = rollDice(c.save.definition.ruleset.default_check, c.rng);
      c.facts.push(`程序检定 ${roll.expression}: [${roll.rolls.join(', ')}]，修正 ${roll.modifier}，结果 ${roll.total}。`);
    } },
    INSPECT: { ui: { label: '观察', visibility: 'text', target_component: 'identity' }, parameters: z.strictObject({ focus: z.string().max(500).optional() }), execute(c) {
      const target = c.action.target_id ? c.store.entity(c.action.target_id) : null;
      if (target?.components.location) {
        const actorLoc = c.store.component<{ location_id: string }>(c.action.actor_id, 'location').location_id;
        assert(String(target.components.location.location_id) === actorLoc, '目标不在当前位置');
      }
      c.advance(1);
      const name = target ? c.store.component<{ name: string }>(target.id, 'identity').name : '周围环境';
      const focus = typeof c.action.parameters.focus === 'string' && c.action.parameters.focus ? `，关注：${c.action.parameters.focus}` : '';
      c.facts.push(`观察 ${name}${focus}。`);
    } },
  },
  validate(save) {
    const map = currentMap(save), locations = map.locations.map(l => l.id);
    assert(new Set(locations).size === locations.length, '地点 ID 重复');
    for (const location of map.locations) if (location.parent_id) {
      assert(location.parent_id !== location.id && locations.includes(location.parent_id), `地点 ${location.id} 的 parent_id 无效`);
      let cursor: string | null | undefined = location.parent_id; const seen = new Set([location.id]);
      while (cursor) { assert(!seen.has(cursor), '地图层级存在循环'); seen.add(cursor); cursor = map.locations.find(l => l.id === cursor)?.parent_id; }
    }
    for (const route of map.routes) assert(locations.includes(route.from) && locations.includes(route.to), '路线引用未知地点');
    const routeKeys = map.routes.map(r => `${r.from}:${r.to}`);
    assert(new Set(routeKeys).size === routeKeys.length, '路线重复');
    assert(save.entities.some(e => e.id === save.player_state.entity_id && e.components.identity && e.components.location), '玩家必须存在并拥有 identity/location');
    for (const e of save.entities) if (e.components.location) assert(locations.includes(String(e.components.location.location_id)), `实体 ${e.id} 的地点不存在`);
    assert(save.runtime.time.minute < save.definition.ruleset.minutes_per_day, '时间不在当天范围内');
    for (const e of save.definition.events) {
      assert(!e.location_id || locations.includes(e.location_id), '事件地点不存在');
      assert(!e.reveal_location_id || locations.includes(e.reveal_location_id), '事件揭示地点不存在');
    }
  },
};

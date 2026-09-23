import { z } from 'zod';
import { actionSchema, assert, safeParse, type Action, type GameEvent, type SavePackage } from './schema.js';
import { EntityStore, type ActionContext, type ModuleRegistry, type Patch } from './registry.js';
import { createRegistry } from '../modules/index.js';
import { advanceTime } from './time.js';
import { secureRng, type RNG } from './dice.js';
import { validateSave } from './state.js';
import { revealLocation } from './map.js';

export function executeAction(current: SavePackage, input: unknown, requestId: string, source: Action['source'] = 'player', rng: RNG = secureRng, registry: ModuleRegistry = createRegistry(current.definition.enabled_modules)) {
  const save = structuredClone(current), actionInput = safeParse(actionSchema, input);
  const spec = registry.actions.get(actionInput.type);
  const action: Action = { ...actionInput, parameters: safeParse(spec.parameters, actionInput.parameters) as Action['parameters'], id: requestId, actor_id: save.player_state.entity_id, source, time_cost: 0 };
  const events: GameEvent[] = [], facts: string[] = [];
  const ctx: ActionContext = {
    save, action, store: new EntityStore(save, registry), rng, facts,
    emit(event) {
      assert(events.length < 1000, '事件链超出上限'); events.push(event); registry.events.emit(ctx, event);
      for (const def of save.definition.events) {
        if (def.hook !== event.type || (def.once && save.event_state.fired.includes(def.id)) || (def.location_id && def.location_id !== event.location_id)) continue;
        const random = rng(); assert(random >= 0 && random < 1, '无效 RNG');
        if (random >= def.probability) continue;
        if (def.once) save.event_state.fired.push(def.id);
        save.event_state.counts[def.id] = (save.event_state.counts[def.id] ?? 0) + 1;
        if (def.set_flag) save.gm_state.flags[def.set_flag] = true;
        if (def.reveal_location_id) {
          const revealed = revealLocation(save, def.reveal_location_id);
          facts.push(`发现新地点：${revealed.name}。`);
        }
        if (def.public_text) facts.push(def.public_text);
        if (def.interrupt_automation) ctx.emit({ type: 'on_interrupt', event_id: def.id, reason: def.public_text || '发生了需要你处理的事情' });
      }
    },
    advance(minutes) {
      const oldDay = save.runtime.time.day;
      save.runtime.time = advanceTime(save.runtime.time, minutes, save.definition.ruleset.minutes_per_day);
      action.time_cost += minutes; ctx.emit({ type: 'on_time_advance', minutes });
      for (let d = oldDay; d < save.runtime.time.day; d++) ctx.emit({ type: 'on_day_changed' });
    },
  };
  ctx.emit({ type: 'on_action_start' }); spec.execute(ctx); ctx.emit({ type: 'on_action_complete' });
  return { save: validateSave(save, registry), action, facts, events, registry };
}
const patchSchema = z.strictObject({ op: z.string(), entity_id: z.string(), target_id: z.string(), dimension: z.string(), delta: z.number().int() });
export function applyPatches(save: SavePackage, input: unknown, action: Action, registry = createRegistry(save.definition.enabled_modules)) {
  const patches = safeParse(z.array(patchSchema).max(1), input) as Patch[];
  const candidate = structuredClone(save);
  for (const patch of patches) registry.patches.get(patch.op)(candidate, patch, action);
  return validateSave(candidate, registry);
}

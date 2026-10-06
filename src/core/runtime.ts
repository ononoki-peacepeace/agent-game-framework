import { z } from 'zod';
import {settleTaskObjectives} from './task-rules.js';
import { actionSchema, assert, safeParse, type Action, type GameEvent, type SavePackage } from './schema.js';
import { EntityStore, type ActionContext, type ModuleRegistry, type Patch } from './registry.js';
import { createRegistry } from '../modules/index.js';
import { advanceTime } from './time.js';
import { secureRng, type RNG } from './dice.js';
import { validateSave } from './state.js';
import { revealLocation } from './map.js';
import { observe, errorText } from '../observability/index.js';
import {resolutionKindSchema} from './resolution.js';
import {evaluateBackgroundTime,evaluateBackgroundLocation} from '../background/runtime.js';

/** One bounded world tick: registered module handlers, authored events and schedules share the same clock. */
export function advanceWorldSegment(c:ActionContext,minutes:number){
  assert(Number.isInteger(minutes)&&minutes>0,'世界推进时长必须大于零');
  const length=c.save.definition.ruleset.minutes_per_day;
  const now=c.save.runtime.time.day*length+c.save.runtime.time.minute;
  const due=(c.save.routine_meta?.scheduled_tasks??[]).filter(task=>!task.resolved&&task.status==='accepted'&&task.at>=now&&task.at<=now+minutes).sort((a,b)=>a.at-b.at)[0];
  if(due?.at===now){c.save.foreground={blocker:'task',reason:`已到安排时间：${due.label}`};return {elapsed:0,interrupted:true};}
  const step=Math.min(minutes,due?due.at-now:minutes);
  const interruptCounts=new Map(c.save.definition.events.filter(event=>event.interrupt_automation).map(event=>[event.id,c.save.event_state.counts[event.id]??0]));
  c.advance(step); // The existing event bus invokes all installed on_time_advance handlers.
  const interrupted=c.save.definition.events.find(event=>event.interrupt_automation&&(c.save.event_state.counts[event.id]??0)>(interruptCounts.get(event.id)??0));
  if(interrupted)c.save.foreground={blocker:'interrupt',reason:interrupted.public_text||'发生了需要你处理的事情'};
  else if(due)c.save.foreground={blocker:'task',reason:`已到安排时间：${due.label}`};
  return {elapsed:step,interrupted:Boolean(interrupted||due||c.save.foreground?.blocker)};
}

export function executeAction(current: SavePackage, input: unknown, requestId: string, source: Action['source'] = 'player', rng: RNG = secureRng, registry: ModuleRegistry = createRegistry(current.definition.enabled_modules), lifecycle = true) {
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
        save.event_roll_history=[...(save.event_roll_history??[]),{request_id:action.id,event_id:def.id,hook:def.hook,sample:random,probability:def.probability,fired:random<def.probability}].slice(-500);
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
      if(event.type==='on_location_enter')evaluateBackgroundLocation(ctx);
    },
    advance(minutes) {
      const from=structuredClone(save.runtime.time),oldDay=from.day;
      save.runtime.time = advanceTime(save.runtime.time, minutes, save.definition.ruleset.minutes_per_day);
      action.time_cost += minutes; ctx.emit({ type: 'on_time_advance', minutes });
      for (let d = oldDay; d < save.runtime.time.day; d++) ctx.emit({ type: 'on_day_changed' });
      evaluateBackgroundTime(ctx,from,save.runtime.time);
    },
  };
  const settings=['SAVE_ROUTINE','CLEAR_ROUTINE','CANCEL_ROUTINE','PAUSE_ROUTINE'].includes(action.type);
  if (lifecycle&&!settings) ctx.emit({ type: 'on_action_start' });
  spec.execute(ctx);
  if (lifecycle&&!settings) ctx.emit({ type: 'on_action_complete' });
  if(lifecycle&&!settings)settleTaskObjectives(save,action);
  if(lifecycle&&!settings&&spec.resolution_mode!=='self'&&spec.resolution_mode!=='workflow'){
    const check=save.resolution_history?.find(entry=>entry.request_id===requestId);
    const kind=check?resolutionKindSchema.exclude(['EVENT_ROLL']).safeParse(check.spec.resolution_type).data??'SIMPLE_CHECK':'DETERMINISTIC';
    const actorBefore=current.entities.find(entity=>entity.id===current.player_state.entity_id);
    const actorAfter=save.entities.find(entity=>entity.id===save.player_state.entity_id);
    const changed=(key:string)=>JSON.stringify(actorBefore?.components[key]??null)!==JSON.stringify(actorAfter?.components[key]??null);
    const effects:Array<'time'|'position'|'inventory'|'relationship'|'evidence'|'money'|'injury'|'death'|'state'>=[];
    if(action.time_cost)effects.push('time');
    if(changed('location')||changed('scene_position'))effects.push('position');
    if(changed('inventory'))effects.push('inventory');
    if(changed('relationships'))effects.push('relationship');
    if(changed('wallet'))effects.push('money');
    if(changed('condition'))effects.push('injury');
    if(JSON.stringify(current.gm_state.hidden_truth?.commitments.map(truth=>truth.evidence.map(entry=>entry.discovered_by)))!==
      JSON.stringify(save.gm_state.hidden_truth?.commitments.map(truth=>truth.evidence.map(entry=>entry.discovered_by))))effects.push('evidence');
    save.resolution_receipts=[...(save.resolution_receipts??[]),{
      request_id:requestId,action_id:action.id,actor_id:action.actor_id,target_id:action.target_id??null,
      semantic_action:action.type,kind,prerequisites:[{kind:'registered_action',subject_id:action.type,satisfied:true as const}],
      check_id:check?.check_id??'',rolls:check?.rolls??[],outcome:check?.outcome??'success',time_cost:action.time_cost,
      canonical_facts:facts.slice(0,12).map(fact=>fact.slice(0,500)),effects,commit_status:'pending' as const,
    }].slice(-200);
  }
  return { save: validateSave(save, registry), action, facts, events, registry };
}
const patchSchema = z.strictObject({ op: z.string(), entity_id: z.string(), target_id: z.string(), dimension: z.string(), delta: z.number().int() });
export function applyPatches(save: SavePackage, input: unknown, action: Action, registry = createRegistry(save.definition.enabled_modules)) {
  const patches = safeParse(z.array(patchSchema).max(1), input) as Patch[];
  const candidate = structuredClone(save), started = performance.now();
  try {
    for (const patch of patches) registry.patches.get(patch.op)(candidate, patch, action);
    const next = validateSave(candidate, registry);
    observe('debug', 'patch.validation.accepted', { module: 'framework', duration_ms: performance.now() - started, revision: next.state_revision, metadata: { patches: patches.length, operation: action.type } });
    return next;
  } catch (error) {
    observe('warn', 'patch.validation.rejected', { module: 'framework', duration_ms: performance.now() - started, metadata: { patches: patches.length, operation: action.type, reason: errorText(error) } });
    throw error;
  }
}

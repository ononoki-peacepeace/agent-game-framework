import type { SavePackage } from './schema.js';
import type { NpcAgentState } from '../agent/npc-state.js';

/**
 * Deterministic repair for one narrowly-defined class of corrupted uncommitted
 * candidate: an NPC whose state carries more than one active executable plan,
 * where every such plan is actually the same no-condition MOVE departure
 * duplicated with a distinct id. This is the exact failure shape behind the
 * REV433 `NPC 同时存在冲突的可执行计划` commit rejection.
 *
 * The repair never re-executes a world action and never re-rolls dice: it keeps
 * the already-earned progress (time credit) and drops only exact route
 * duplicates. Any mixed or genuinely different destination is left untouched so
 * the conflict still fails loudly rather than silently discarding an
 * independent NPC goal.
 */
type Plan = NpcAgentState['plans'][number];

function routeKey(plan: Plan): string | null {
  if (!plan.activity) return null;
  if (plan.activity.kind !== 'move') return null;
  if (plan.activity.condition) return null;
  return `move:${plan.activity.origin_location_id}:${plan.activity.destination_id}`;
}

function minuteOfDay(plan: Plan): number {
  const at = plan.activity?.last_accounted_at ?? { day: 0, minute: 0 };
  return at.day * 1440 + at.minute;
}

export function reconcileDuplicateActivePlans(
  input: SavePackage,
  preferDropRequestId?: string,
): { save: SavePackage; repaired: boolean } {
  const save = structuredClone(input);
  let repaired = false;
  for (const [npcId, state] of Object.entries(save.npc_agent_state ?? {})) {
    const active = state.plans.filter(plan => plan.status === 'active' && (plan.activity || plan.execution));
    if (active.length <= 1) continue;
    const keys = active.map(routeKey);
    // Refuse to touch conflicts we cannot attribute to the known duplicate shape.
    if (keys.some(key => key === null)) continue;
    if (new Set(keys).size !== 1) continue;
    const sorted = [...active].sort((a, b) => {
      const credit = (b.activity!.time_credit_minutes ?? 0) - (a.activity!.time_credit_minutes ?? 0);
      if (credit !== 0) return credit;
      const fromCurrent = Number((a.activity!.source_request_id === preferDropRequestId) ? 1 : 0)
        - Number((b.activity!.source_request_id === preferDropRequestId) ? 1 : 0);
      if (fromCurrent !== 0) return fromCurrent;
      const earlier = minuteOfDay(a) - minuteOfDay(b);
      if (earlier !== 0) return earlier;
      return a.id.localeCompare(b.id);
    });
    const dropped = sorted.slice(1);
    const droppedPlanIds = new Set(dropped.map(plan => plan.id));
    const droppedGoalIds = new Set(dropped.map(plan => plan.goal_id));
    state.plans = state.plans.filter(plan => !droppedPlanIds.has(plan.id));
    const remainingGoalIds = new Set(state.plans.map(plan => plan.goal_id));
    state.goals = state.goals.filter(goal => !droppedGoalIds.has(goal.id) || remainingGoalIds.has(goal.id));
    save.npc_agent_state![npcId] = state;
    repaired = true;
  }
  return { save, repaired };
}

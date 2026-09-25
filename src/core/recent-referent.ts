import type { SavePackage } from './schema.js';

/**
 * Short-horizon salience for pronoun resolution ("再揍她一拳", "追上去", "她怎么了"). It is derived
 * deterministically from canonical history that already exists in the save, so it survives a reload and needs
 * no schema change: it is not long-term memory, only "who/what was just involved" for the next few turns.
 */
export interface RecentReferent {
  primary: {id: string; name: string} | null;
  last_target: {id: string; name: string} | null;
  conflict_target: {id: string; name: string} | null;
  last_event: string | null;
}
const conflictWords = /(拳|揍|打|踢|推|掐|砸|攻击|冲突|威胁|愤|怒|血|受伤|挥)/;
function named(save: SavePackage, id: string | null | undefined) {
  if (!id) return null;
  const entity = save.entities.find(entry => entry.id === id);
  if (!entity || !entity.components.character) return null;
  return {id: entity.id, name: String(entity.components.identity?.name ?? entity.id)};
}
export function recentReferent(save: SavePackage): RecentReferent {
  const history = save.narrative_history ?? [];
  const recentActions = (save.action_facts ?? []).slice(-3);
  const focus = save.interaction_context?.target_entity_id ?? null;
  const historySpeaker = [...history].reverse().map(entry => entry.speaker).find(id => id) ?? null;
  const actionTarget = [...recentActions].reverse().map(entry => entry.target_id).find(id => id) ?? null;
  const turnSpeaker = save.last_turn?.speaker ?? null;
  const conflictAction = [...recentActions].reverse().find(entry => (entry.facts ?? []).some(fact => conflictWords.test(String(fact))) || conflictWords.test(String(entry.input ?? '')));
  const conflictHistory = [...history].reverse().find(entry => (entry.facts ?? []).some(fact => conflictWords.test(String(fact))) || conflictWords.test(String(entry.narrative ?? '')));
  const lastEvent = conflictAction
    ? String((conflictAction.facts ?? [])[0] ?? conflictAction.input ?? '').slice(0, 120)
    : conflictHistory ? String(conflictHistory.narrative ?? '').slice(0, 120)
    : save.last_turn?.narrative ? String(save.last_turn.narrative).slice(0, 120) : null;
  const primary = named(save, focus) ?? named(save, turnSpeaker) ?? named(save, actionTarget) ?? named(save, historySpeaker);
  return {
    primary,
    last_target: named(save, actionTarget ?? turnSpeaker ?? historySpeaker),
    conflict_target: named(save, conflictAction?.target_id ?? conflictHistory?.speaker ?? null),
    last_event: lastEvent,
  };
}

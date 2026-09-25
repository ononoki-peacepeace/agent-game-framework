import {resolveEntities} from '../agent/entities.js';
import { z } from 'zod';
import { GameError, assert, id, type SavePackage } from './schema.js';
import { observe } from '../observability/index.js';
import { publicView } from './state.js';
import { createRegistry } from '../modules/index.js';
import { executeAction, applyPatches } from './runtime.js';

/** An outcome proposal, never a save patch. Numeric mechanics remain owned by modules. */
export const freeformSchema = z.strictObject({
  narrative: z.string().min(1).max(4000),
  minutes: z.number().int().min(1).max(5),
  target_id: id.nullable(),
  facts: z.array(z.string().min(1).max(300)).max(4),
  relationship: z.strictObject({ dimension: id, delta: z.number().int().min(-2).max(2) }).nullable(),
});
const maxFactCount = 4, maxFactLength = 300;
/**
 * Deterministic robustness for slightly over-sized model proposals: extra facts are merged into the
 * last allowed entry instead of failing the whole turn. Anything else (unknown fields, numeric combat
 * state, patches) still fails validation, and minutes are clamped to the documented 1–5 range.
 */
export function normalizeFreeformProposal(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const proposal = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(proposal.facts)) {
    const cleaned = proposal.facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0).map(fact => fact.trim());
    if (cleaned.length > maxFactCount) {
      const head = cleaned.slice(0, maxFactCount - 1);
      const merged = cleaned.slice(maxFactCount - 1).join('；').slice(0, maxFactLength);
      proposal.facts = [...head, merged];
    } else proposal.facts = cleaned;
  }
  if (typeof proposal.minutes === 'number' && Number.isFinite(proposal.minutes)) proposal.minutes = Math.max(1, Math.min(5, Math.trunc(proposal.minutes)));
  return proposal;
}
export function parseFreeformProposal(raw: unknown) {
  const normalized = normalizeFreeformProposal(raw);
  const parsed = freeformSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;
  // Internal schema detail stays in the log; the player only sees an actionable sentence.
  observe('warn', 'freeform.proposal.rejected', { module: 'framework', metadata: { issues: parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}:${issue.code}`) } });
  throw new GameError('这次行动的结果没有通过框架校验，世界状态没有改变；可以换一种说法再试一次。');
}
export function localDestination(input: string) {
  if (!/出门|出去|走|去|移动|靠近|到/.test(input)) return null;
  return input.match(/屋外街边|屋外|屋内|门口|厨房|窗边|院子|走廊/)?.[0] ?? (/出门/.test(input) ? '屋外' : null);
}
export function knownDestination(save: SavePackage, input: string) {
  return publicView(save).locations.find(place => input.includes(place.name) && /去|到|前往|走向/.test(input));
}
export function needsFreeform(input: string) {
  return /揍|打.{0,15}一拳|挥拳|踢|拥抱|抱住|扔|丢|爬|喊|大叫|出门/.test(input) || !!localDestination(input);
}
export function executeFreeform(current: SavePackage, input: string, raw: unknown, requestId: string) {
  const proposal = parseFreeformProposal(raw), view = publicView(current);

  const player = current.entities.find(e => e.id === current.player_state.entity_id)!;
  assert(!Object.values(current.extensions??{}).some(e=>e.enabled&&e.installed&&e.state&&typeof e.state==='object'&&!Array.isArray(e.state)&&e.state.phase==='playing'),'请先完成当前正在进行的活动。');
  assert(!current.foreground?.blocker, '请先处理眼前尚未结束的事情。');
  assert(Number(player.components.condition?.hp ?? 1) > 0, '你现在的身体状况无法行动。');
  const named=resolveEntities(view,input).matches.filter(e=>e.id!==player.id);
  assert(named.length<2,'请说明这次要接近哪一个对象。');
  if(named.length===1)assert(proposal.target_id===named[0].id,'行动对象尚未确定，请重试。');
  const target = proposal.target_id ? view.entities.find(e => e.id === proposal.target_id) : undefined;
  if (proposal.target_id) {
    assert(target && target.id !== player.id && named.some(e=>e.id===target.id), '请明确你想接近的人或物。');
    const here = player.components.location?.location_id, there = target.components.location?.location_id;
    assert(!here || !there || here === there, '对方不在眼前，你需要先找到对方。');
  }
  const destination = localDestination(input);
  const registry = createRegistry(current.definition.enabled_modules);
  // This action exists only inside this invocation; HTTP action payloads cannot provide outcomes.
  registry.actions.register('FREEFORM_ACTION', { parameters: z.strictObject({}), execute(c) {
    c.advance(destination ? 1 : proposal.minutes);
    if (destination) c.store.entity(c.action.actor_id).components.scene_position = { label: destination };
    c.facts.push(...proposal.facts);
    c.save.action_facts = [...(c.save.action_facts ?? []), { request_id: requestId, actor_id: player.id,
      target_id: proposal.target_id, input, facts: proposal.facts, time: { ...c.save.runtime.time } }].slice(-100);
  } });
  const turn = executeAction(current, { type: 'FREEFORM_ACTION', ...(target ? { target_id: target.id } : {}), parameters: {} }, requestId, 'ai', undefined, registry);
  // A relationship change proposed by the model is optional enrichment for a physical action. A dimension
  // this world does not track (or any other invalid enrichment) is dropped with a structured log — it must
  // never fail the otherwise valid action, and it must never extend the canonical relationship schema.
  if (proposal.relationship) {
    const providerDimension = proposal.relationship.dimension;
    try {
      assert(target, '本次行动没有确定的对象');
      assert(current.definition.enabled_modules.includes('relationships'), 'relationships 模块未启用');
      turn.save = applyPatches(turn.save, [{ op: 'relationship_delta', entity_id: player.id, target_id: target.id, ...proposal.relationship }], turn.action, registry);
    } catch (error) {
      observe('warn', 'relationship_mutation_dropped', { module: 'framework', request_id: requestId, metadata: {
        provider_dimension: providerDimension,
        reason: error instanceof Error ? error.message : String(error),
        target_id: proposal.target_id ?? target?.id ?? null,
        canonical_dimensions: Object.keys(current.definition.ruleset.relationship_dimensions),
      } });
    }
  }
  turn.save.last_turn = { narrative: proposal.narrative, speaker: null, dialogue: null, choices: [], context_actions: [] };
  return turn;
}

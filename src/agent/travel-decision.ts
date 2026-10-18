import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {GameService} from '../server/service.js';
import type {SavePackage} from '../core/schema.js';
import type {PublicView} from '../shared/contracts.js';
import {composeScenePersonaContexts} from '../characters/persona.js';

/**
 * Conditional-companion re-decision.
 *
 * A recorded `travel_intent` is either an explicit *outcome* (willing / declined) or a *conditional* offer that was
 * never satisfied. The map module correctly refuses to carry a purely conditional person, so the missing piece is a
 * bounded, pre-departure chance to re-decide when the world actually changes what the person can hear or see.
 *
 * This is deliberately not a second companion system: it only rewrites the existing `travel_intent`, it uses one
 * model call for all candidates, and the decision is committed inside the departing MOVE's own transaction so the
 * intention, the receipt and the authoritative position can never disagree.
 */

/** Bounds re-decision of an unresolved conditional offer only. Recorded willingness does not expire by revision. */
export const TRAVEL_INTENT_FRESHNESS = 6;
const MAX_TRAVEL_CANDIDATES = 8;

export const travelDecisionSchema = z.strictObject({
  decisions: z.array(z.strictObject({
    npc_id: z.string().min(1).max(80),
    status: z.enum(['willing', 'conditional', 'declined']),
    // Only the person's own words, and only when they really speak; the model must not invent lines for everyone.
    line: z.string().min(1).max(300).nullable().default(null),
  })).max(MAX_TRAVEL_CANDIDATES),
});
export type TravelDecision = z.infer<typeof travelDecisionSchema>['decisions'][number];

export interface ConditionalTravelCandidate {
  npc_id: string;
  name: string;
  status: 'conditional';
  /** The person's own public condition line, if the player ever actually heard it. */
  condition_line: string | null;
}

export interface TravelDecisionApplication {
  save: SavePackage;
  decisions: TravelDecision[];
  lines: {speaker_id: string; utterance: string}[];
  /** Idempotency key + fingerprint the caller stamps into the committing transaction. */
  receiptId: string;
  fingerprint: string;
}

/** Deterministic child id so a replayed request can never decide twice. */
export function travelDecisionRequestId(requestId: string) {
  const hex = createHash('sha256').update(requestId + ':travel-decision').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function publicConditionLine(save: SavePackage, npcId: string, sourceRequestId: string | null): string | null {
  const history = save.narrative_history ?? [];
  const speaks = (entry: (typeof history)[number]) =>
    entry.speech_events?.some(event => event.speaker_id === npcId && event.provenance === 'npc_response');
  const entry = history.find(item => item.request_id === sourceRequestId && speaks(item)) ??
    [...history].reverse().find(speaks);
  const line = entry?.speech_events?.filter(event => event.speaker_id === npcId && event.provenance === 'npc_response').at(-1)?.utterance;
  return line ? String(line).slice(0, 300) : null;
}

/**
 * Eligible candidates: an on-scene person who publicly asked for a condition, who is still standing at the origin,
 * and whose intention is still fresh. Anything already willing/declined is left to the existing authoritative MOVE.
 */
export function conditionalTravelCandidates(save: SavePackage, actorId: string): ConditionalTravelCandidate[] {
  const actor = save.entities.find(entity => entity.id === actorId);
  const raw = actor?.components.location?.location_id;
  if (raw === undefined || raw === null) return [];
  const origin = String(raw);
  const candidates: ConditionalTravelCandidate[] = [];
  for (const entity of save.entities) {
    if (entity.id === actorId || !entity.components.character) continue;
    if (String(entity.components.location?.location_id ?? '') !== origin) continue;
    const intent = save.npc_agent_state?.[entity.id]?.travel_intent;
    if (!intent || intent.status !== 'conditional') continue;
    if (String(intent.origin_location_id) !== origin) continue;
    if (save.state_revision - intent.recorded_revision > TRAVEL_INTENT_FRESHNESS) continue;
    candidates.push({npc_id: entity.id, name: String(entity.components.identity?.name ?? entity.id),
      status: 'conditional', condition_line: publicConditionLine(save, entity.id, intent.source_request_id)});
    if (candidates.length >= MAX_TRAVEL_CANDIDATES) break;
  }
  return candidates;
}

/**
 * One bounded re-decision before the player departs. Returns a new save image (never mutates the input) or null when
 * there is nothing to decide. The caller folds it into the departing transaction; it never throws so a provider
 * failure can only mean "no companion changed their mind", never a lost or repeated move.
 */
export async function applyDepartureTravelDecisions(service: GameService, save: SavePackage, view: PublicView, options: {
  actorId: string;
  requestId: string;
  playerInput: string | null;
  moveDestinationId: string | null;
}): Promise<TravelDecisionApplication | null> {
  const receiptId = travelDecisionRequestId(options.requestId);
  if ((save.runtime.receipts ?? []).some(receipt => receipt.id === receiptId)) return null;
  const candidates = conditionalTravelCandidates(save, options.actorId);
  if (!candidates.length) return null;
  const actor = save.entities.find(entity => entity.id === options.actorId);
  const originId = String(actor?.components.location?.location_id ?? '');
  const locationName = view.locations.find(place => place.id === originId)?.name ?? originId;
  const moveDestinationName = options.moveDestinationId
    ? view.locations.find(place => place.id === options.moveDestinationId)?.name ?? null : null;
  const publicStatement = options.playerInput?.trim() ? options.playerInput.trim().slice(0, 600) : null;
  const decision = await service.ai.systemAgent(travelDecisionSchema, save.definition.prompt_profile, {
    instruction: '你只判断一件事：玩家此刻真正出发时，此前公开提出过同行条件、而且依然站在出发点的在场人物，是否依据他们自己听见、看见的内容改变决定。只输出 JSON，不执行移动、不修改世界状态、不规划路线。candidates 里每个人都曾公开提出同行条件，condition_line 是他们当时说过的原话（可能为空）。player_public_statement 是玩家本轮公开说出的原话；statement_recorded=false 表示玩家这一轮没有公开说什么，绝不能替玩家编造原话、承诺或目的地。observed_move_destination 是玩家此刻实际前往的地点，只是能观察到的下一步；如果玩家没有公开说明最终目的地，这最多是一次方向/其中一站，不能假定人物知道最终要去哪里，也不能假定人物看见了未公开的计划。scene、candidates、player_public_statement 与 observed_move_destination 之外的任何内部计划、路线、隐藏动机或未公开事实都不得使用。对每个候选给出决定：willing 表示条件已经明确满足、现在就愿意同行；conditional 表示条件仍未满足、继续保留附条件；declined 表示现在明确拒绝同行。不得把 conditional 自动升级为 willing；条件没有新依据时保持 conditional；只有确凿的可观察或可听见的依据才改变决定。允许不同人物作出不同决定，也允许无人改变、无人说话。line 只在人物真的开口时填写他们此刻说出的那一句原话，否则为 null；不要给每个人配台词，也不要让人物集体表态。每个 npc_id 至多出现一次，且必须来自 candidates。',
    goal_context: '决定发生在玩家作出移动的瞬间：人物有权留下来，也有权继续跟随；不要为了配合玩家而让所有人都同意。',
    scene: {location: locationName, time: view.time,
      player_public_statement: publicStatement, statement_recorded: publicStatement !== null,
      observed_move_destination: moveDestinationName},
    candidates: candidates.map(candidate => ({
      npc_id: candidate.npc_id,
      name: candidate.name,
      self_condition: candidate.condition_line,
    })),
    persona_contexts: composeScenePersonaContexts(save, candidates.map(candidate => candidate.npc_id)),
    persona_instruction: 'persona_contexts 是每个人物自己的资料，用来决定他们此刻愿不愿意同行；不是要念出的设定，也不要让不同人物说成同一句话。',
  }, {...save, ai: {threads: {}}});
  if (!decision) return null;
  const known = new Set(candidates.map(candidate => candidate.npc_id));
  const seen = new Set<string>();
  const accepted: TravelDecision[] = [];
  for (const entry of decision.decisions) {
    if (!known.has(entry.npc_id) || seen.has(entry.npc_id)) continue;
    seen.add(entry.npc_id);
    accepted.push({npc_id: entry.npc_id, status: entry.status, line: entry.line ? entry.line.slice(0, 300) : null});
  }
  if (!accepted.length) return null;
  const next = structuredClone(save);
  const lines: {speaker_id: string; utterance: string}[] = [];
  for (const entry of accepted) {
    const state = next.npc_agent_state?.[entry.npc_id];
    if (!state) continue;
    // The intention keeps the same origin while the person is still here; the map module owns the actual move.
    state.travel_intent = {status: entry.status, origin_location_id: originId,
      source_request_id: options.requestId, recorded_revision: next.state_revision + 1};
    if (entry.line) lines.push({speaker_id: entry.npc_id, utterance: entry.line});
  }
  // The receipt is stamped by the committing transaction so its revision always equals the committed revision; a
  // pre-incremented revision here would violate the save's own receipt invariant.
  const fingerprint = createHash('sha256').update(JSON.stringify({travel_decision: true, request: options.requestId,
    decisions: accepted.map(entry => [entry.npc_id, entry.status])})).digest('hex');
  service.logger.info('agent.travel_decision', {module: 'agent', request_id: options.requestId,
    revision: next.state_revision + 1, metadata: {
      decisions: accepted.map(entry => ({npc_id: entry.npc_id, status: entry.status})),
      candidate_count: candidates.length, spoke: lines.length}});
  return {save: next, decisions: accepted, lines, receiptId, fingerprint};
}

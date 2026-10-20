# Legacy social policy: data gap and compatible authoring strategy

Read-only assessment on 2026-10-20, product source `b4c018f` (documentation HEAD `6ae2581`). This is an authoring/migration design, not authorization to change any existing world or proof that migration has run.

## Confirmed gap

| Source | Relationship module | Declared dimensions | Explicit receipt-event policies |
|---|---|---|---|
| `content/worlds/town.json` | Enabled | `trust`, `familiarity` | Neither dimension has `event_deltas`. |
| `content/worlds/town-blueprint.json` | Blueprint, before compilation | No compiled dimensions | No compiled policies; authoring supplies them when creating a world. |
| Formal save, read only | Enabled; 13 character entities | `trust`, `familiarity` | Neither dimension has `event_deltas`. |

Only policy structure/counts were inspected in the formal save; no world prose, credentials or save copy is included here. Its SHA256 remained `94109AA75B66ED021619A3A7CC9C2795A714D36B2DADFA109B1C8CEB67455DE9` after the inspection. The original save was not modified.

`src/ai/authoring.ts` deliberately authors policies for newly compiled worlds: trust conflict −1/harmed −2, familiarity contact/conflict/harmed +1. That authoring decision is not automatically applicable to old worlds, even when they use the same dimension names. The optional policy schema is in `src/core/schema.ts`; the consumer is `src/agent/npc-relations.ts`.

`settleRelationshipOutcomes` reads explicit policy values only. Missing policy means no automatic receipt-based numeric relationship change. Current initial values, bounds, existing relationships, authored NPC motivations and private memories do not supply missing event semantics. The absence is therefore a known author-data gap, not a reason to infer positive feelings, trust, agreement, consent or new NPC speech. Existing model-enrichment rules and their actor/target guards retain their separate authority; enabling event policy also makes that dimension reject duplicate model-enrichment writes.

## Proposed compatibility contract

1. **Default for an existing world is preservation.** Reading, restarting, importing an unchanged save, enabling a module or upgrading binaries must not silently add event policies or recompute relationship history. An operator may explicitly choose to retain this legacy policy. That choice is not yet confirmed for the formal world.
2. **The world author selects each delta.** An activation proposal must list the world/game identity, every affected dimension, current min/max/initial, and explicit contact/conflict/harmed values or intentional omissions. Values must pass the existing −2…2 integer schema. Neither familiar dimension names nor their numeric sign/range justifies copying the new-world policy. Omitting one event continues to omit its delta; harmed falls back to conflict only as the existing documented consumer specifies.
3. **Preview from an isolated, authorized source image.** Validate the candidate through the current Save schema without running NPCs, Narrator, action execution or a paid provider. Produce a minimal before/after policy diff, source revision/hash and activation boundary. Keep all entities, inventories, current numeric relationships, memories, time, goal/plan cursors and receipt identities unchanged. Private save contents are not a portable handoff artifact.
4. **Activation is prospective.** Old retained eligible receipts must not gain retroactive relationship effects. A reviewed migration can mark their existing `result_entities.relationship_settlement` as processed under the previous policy using the existing `v1` marker; an existing marker stays unchanged. This is bookkeeping for the prior no-delta policy, without creating contacts or numerical deltas. Never fabricate missing or evicted receipts. The preview must explicitly enumerate any marker changes as well as policy changes. No migration code implementing this proposal has been accepted yet.
5. **Preserve single-image commit/recovery rules.** Recheck the exact source hash/revision immediately before a separately authorized formal mutation; stop on disagreement or unknown commit status. Use the existing save validation, atomic image replacement and recoverable checkpoint workflow. Do not write global configuration, install extensions or claim multi-file atomicity. A migration implementation must provide its own durable request identity and failed-response/restart evidence before it can be used formally; this document does not invent that interface.
6. **Verify offline before activation.** The fixed scenarios are: unchanged legacy load/TALK/physical action; authored-policy activation followed by a new exact Core receipt; a replayed pre-activation receipt; duplicate post-activation settlement; values at both bounds; a harmed fallback versus explicit zero; unchanged NPC cognition/visibility; Undo; invalid candidate/identity conflict; write-before/write-after failure and restart. Compare all non-policy/non-marker fields, requiring unchanged time/resources/cursors. Keep failures. Existing `tests/npc-relationships.test.ts` covers legacy no-change, authored semantics, bounds, receipt identity, replay and Undo, but does not establish this migration matrix.

Formal changes require a concrete policy choice and explicit human authorization for that reviewed candidate. This development session supplies neither. No formal migration, restart, deployment, paid model call or policy selection for the existing formal world occurred.

## Acceptance boundaries

W9.1 now has an explicit, source-grounded old-world policy/data-gap inventory. W9.2 has a reviewable compatibility strategy and a prohibition on default inference. W9.3 remains unverified because the proposed migration path and its entire offline fault matrix have not been implemented/accepted. W9.4 remains unverified pending the human's author-data decision and authorization, or explicit confirmation that the formal world will retain its legacy policy. No other condition is closed by this design.

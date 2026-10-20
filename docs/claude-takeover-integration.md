# Unified takeover and integration — 2026-10-20

Codex now owns all four remediation themes under the user's explicit quota-exhaustion takeover instruction. Work continues in `D:\game` on `codex/claude-takeover-integration`. The previous ownership split remains historical. No other development model is launched.

## Preserved source and provenance

Common ancestor: `a838b11eb9fd8f4a4d92b39282808e88a57baa7e`.
Codex pre-integration HEAD: `5520532fd53e9a1d1bee075a9a5cf450063a0378`.
Claude HEAD remains `bf0ea40114b625c74a2ec4a6a759cffa3a832bca` on `claude/npc-world-narrator` in `D:\game-claude`.

| Claude work | Verified original evidence | Integration state |
|---|---|---|
| Batch 1 audit | Handoff documents; audit is not product acceptance | Original records copied to ignored snapshot |
| Batch 2 sourced hearsay `e5001d5` | Source/tests inspected; original branch reported full offline suite | Product-only patch committed as `976f7c0`; generated QA documents excluded |
| Batch 3 cognition `78a6085` | Original full 172 files / 1695 tests and build reported; commit exists | Cherry-picked as `b8a5069`; focused integrated tests reproduced |
| QA reset `db2ce38` | Generated evidence only | Deliberately excluded; Codex's original QA edits preserved |
| Handoffs `c7ff8f4`, `bf0ea40` | Historical reports, including Batch 4 plan | Preserved verbatim outside tracked product files |
| Batch 4 dirty relationship module and untracked helper | No wiring or tests; bounds incorrectly treated as semantics; direction guard widened | Original bytes/diff preserved; replaced in integration branch with receipt-bound settlement and explicit world policies |
| Batch 5/6 | Investigation and baseline only | Goal adaptation/background variety and expanded long simulation remain unfinished |

Snapshot: `.codex-checkpoints/framework-reliability-handoff/takeover-2026-10-20/`. Includes original Claude WIP, binary patch, handoff records, both initial status records and original Codex dirty files. Claude WIP hashes: relationships `4B1716C8CCBFFA5C94A3ABE7D63346FAAF6AF662C4A5B04889E3BA1169722630`; helper `22D29FAC2EE1212CA36F50E722FADD30008FD9A4C7E277697FD301A80151CF78`. Original Claude working tree was not modified. No destructive Git operation, push or production save write occurred.

## Relationship contract

`ruleset.relationship_dimensions[*].event_deltas` is optional and additive: `contact`, `conflict`, `harmed` each accept integers in [-2,2]. The world author defines semantics; neither numeric bounds nor dimension names determine them. New authored worlds declare policies for their authored trust/familiarity dimensions. Legacy worlds without policies retain their existing behavior; enabling autonomous relationship deltas on those worlds requires an explicit world policy, not an automatic save rewrite.

`settleRelationshipOutcomes` consumes a Core-generated receipt bound to the exact action ID, actor and target. Registered successful TALK/SOCIAL_INTERACT or actual physical contact authorize only those two character endpoints. Harm is read from physical settlement, never a caller assertion. Both directions use the same numeric mutation and world bounds as the external patch. External patches keep the original actor→target identity guard; event-managed dimensions reject model enrichment before and after settlement, preventing duplicate writers.

Settlement runs on a clone inside the existing enclosing world transaction, before persistence. A pending receipt is valid staged Core evidence, not a claim that storage has already committed. Validation failure cannot initialize components in the caller's save. One marker per receipt covers every dimension, avoiding eviction after twenty changes. No receipt means no enrichment; no replay backfill is attempted after receipt eviction. Receipt and relationship components are both in existing world snapshots, persistence and Undo.

An invitation acceptance/refusal or merely reaching a meeting location is not, by itself, evidence of contact with its organizer. No relationship gain is invented for those transitions. Actual relay TALK, NPC plan TALK, registered player interaction and physical settlement share the same Core path. Existing NPC decision/scene contexts read the canonical relationship component; Narrator's private projection also carries bounded own relationships and knowledge provenance. Ordinary narration and expression refinement reuse one cognition projection.

## Validation and remaining scope

- Initial integrated NPC/scene/cognition regression: 5 files / 69 tests passed.
- Relationship/physical/autonomy/Core/recovery intermediate run: 59 passed, one new test fixture failed; retained in session evidence.
- Corrected normalized fixture + actual service Undo + long-world/calendar/System regression: 6 files / 36 tests passed.
- Final relationship/cognition/autonomy regression: 3 files / 24 tests passed. These reports overlap; counts are not additive.
- TypeScript/client/server build passed before the final small patch-authority/projection additions; final build/full suite results are recorded separately when complete.
- Original source of Claude's long metrics is a different branch snapshot. Integrated long-world test passed, but no real Provider or human prose acceptance is claimed.

| Theme | Source/evidence | Still unfinished |
|---|---|---|
| 1 Reliability | Recovery/receipt/background/install/System/calendar; retained Codex commits | Configuration writes, migration/current/view/history exits, wider fault injection, process boundaries |
| 2 Natural-language actions | Existing binding/goal/planner/executor/freeform; retained without broad rewrite | Pronouns, conditional/dependent multi-sentence goals, broad world acceptance |
| 3 NPC/persistent world | Existing plans/time budgets; integrated hearsay; new receipt-based relationship policies | Legacy world policy authoring, long goal adjustment, background variety, expanded simulation |
| 4 Narrator | Shared cognition/provenance and own relationships, physical sight input, existing fact guards | Natural prose/distinct voices, historical QA replay, real model/human acceptance |

Overall estimate stays approximately 45% pending integrated regression and matrix reassessment. Tests and local checkpoint commits do not mean all four themes are complete. Continue from the next concrete high-priority unfinished item.

Use `node scripts/agent-workspace.mjs codex test ...` and `... build`; mock adapter and isolated `.agent-runtime/codex` only. No service startup, production 3100, paid Provider, remote push or production migration is authorized. Future integration should select reviewed commits and inspect dirty files first; never blindly cherry-pick the original mixed QA commits or overwrite either checkout.

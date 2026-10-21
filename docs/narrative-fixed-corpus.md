# Fixed N4 closure corpus

Source before baseline: `2398495`. No product change is part of this inventory. N4.3 still unmet; N4.4 still unverified; 103/160 (64.375%). The frozen N4.3 protocol requires lawful/unsafe pairs for metaphor, retelling, sensory restrictions, absent actors and item state. N4.4 additionally requires the same fixed corpus in three genuinely different world structures and normal/ambiguity/refusal/technical/replay boundaries.

Finite corpus, frozen before execution: the 22 named rows in `tests/narrative-fixed-corpus.test.ts`. It reuses existing metaphor, typed speech occurrence, sightless-subject and absent-subject counterexamples instead of exploring more adjacent grammar. The missing item-state row explicitly compares current `intact`, `damaged`, `destroyed` Core values with present-tense prose; both lawful descriptions and invented destruction/repair are required. Actual INSPECT or physical Core receipts are used; validators must be read-only. Typed utterance rows test the existing presentation speech scope, not truth of the quoted command or newly committed NPC action.

Existing evidence mapping:

| Required category | Existing files | Missing evidence before this run |
| --- | --- | --- |
| Metaphor | `perception-simile-authority`, `perception-audit-authority` | Fixed closure set on current source |
| Retelling | `typed-speech-occurrence-scope`, `scene-presence-quoted-speech` | Same fixed closure set; quoted speech must not mask external assertions |
| Sensory restriction | `perception-subjects`, `perception-joined-pronoun`, `scene-presence-temporal-pronoun` | Same fixed closure set with real event-time sight receipt |
| Absent actors | `scene-presence-subjects`, `movement-presence-authority` | Same fixed closure set, preserving lawful actual presence |
| Item state | `inventory-denial-prose`, `item-action-degraded-prose` cover transfer/receipt prose | Current item condition versus direct narrative assertion not established; code review found no explicit named-item condition comparison, not yet a demonstrated runtime defect |

Run the direct corpus baseline before any product edit. If item-state counterexamples fail, scope one repair to explicit named item condition assertions; do not widen this batch into arbitrary natural-language semantics. Reuse typed speech occurrence masking and current Core item values. Follow with existing selected regressions and strict TypeScript. Keep N4.4 open until three-world evidence is actually present. After two repair batches without closure, review and switch rather than growing the corpus indefinitely.

Actual baseline: fixed22rows **19 passed / 3 failed, 3.349s**, `narrative-fixed-corpus-baseline.json`. Only invented destruction/repair fail. Actual temporary JsonStore service reproduction: **3 lawful controls passed / 3 unsafe cases failed, 5.545s**, `item-condition-narrative-baseline.json`; contradictory prose is retained as normal after one narration despite unchanged canonical items. N4.1 was withdrawn pending verification (102/160,63.75%).

## Verified repair and closure

`validateResolvedNarrative` reuses the existing ordered, single-occurrence typed speech mask, then checks explicit named-item condition statements against public Core item state. It preserves truthful intact/damaged/destroyed descriptions, typed retelling and denial scopes; negative and double-negative assertions cannot silently contradict the item. A different item subject cannot authorize the damaged item. Validation is read-only; it does not create items, apply repairs or change Core receipts. This is a bounded current-condition check, not a universal natural-language or historical-fact verifier.

Actual evidence under `.agent-runtime/codex/`:

- Direct fixed corpus and six disk cases: **2 files / 28 passed, 7.459s**, `narrative-fixed-corpus-fixed.json`.
- First adjacent snapshot: **8 files / 108 passed, 16.758s**, strict exit0/29.236s; preserved as intermediate evidence before negative/public-scope review.
- Final reviewed source: **8 files / 108 passed, zero failed/skipped, 17.341s**, `narrative-fixed-corpus-reviewed.json`; final strict TypeScript **exit0 / 29.023s**, `narrative-fixed-corpus-reviewed-typecheck.json`.
- Six actual JsonStore lawful/unsafe INSPECT cases preserve exact canonical items, one minute and one receipt; unlawful prose degrades after three bounded attempts despite a permissive model audit. Fresh-service original-request replay returns exact saved response/bytes with no new generation.

The original N4.3 protocol's five categories each have explicit lawful/unsafe cases in the fixed22 rows. Original simile, typed speech, sensory, presence, inventory denial and item-action regressions pass together on final source. Restore bounded N4.1 and close **N4.3 only**: **104/160 (65.00%), whole-batch net +1 / +0.625pp**. N4.4 remains unverified: none of these same-world cases substitutes for the required three distinct structures. No full-suite/build, Provider, human-quality, long-horizon or production acceptance claim.

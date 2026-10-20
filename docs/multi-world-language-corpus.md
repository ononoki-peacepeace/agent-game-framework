# Fixed multi-world language corpus, first execution

The original A9 acceptance gap is real: scattered regressions did not provide one enumerated multi-world input set. `multi-world-language-corpus.v1.json` now pins 24 original Chinese inputs and expected effects/refusals across three active structures. `tests/multi-world-language-corpus.test.ts` runs every entry through `/api/input`, OS-assigned HTTP ports and isolated JsonStore storage. Commerce has real travel, stock and prices; the conversational variant removes commerce and authors contact policy; the continuity variant has a calendar, routine rules, a scene-authorized NPC departure and a timed offscreen incident. These are structural variants of existing fixtures, not three new production worlds.

Each structure covers normal, ambiguity/missing binding, world refusal, technical failure before execution, service/HTTP/disk restart replay, true/false conditions and partial completion. The trade partial case injects a technical failure after the actual MOVE; the conversation case has an absent second listener; the continuity case has an accepted appointment due one minute into a requested ten-minute activity. Replay checks exact response, no additional generation and unchanged current-image bytes. Source, original cases, expectations and command were pinned before the first run in ignored `multi-world-corpus-preflight.json`.

Semantic decisions, alignment results, Planner candidates, Freeform proposals and NPC no-action candidates are explicitly controlled offline fixtures. The real Semantic schema boundary, binding, conditions, registered actions, Core effects, fallback narration, HTTP identity and storage/replay code execute. This does not establish actual model understanding, three unrelated authored worlds, arbitrary pronouns, mixed/nested future branches, recovery choice/resumption after every partial outcome, or independent/human review. All four A9 conditions therefore keep their previous statuses; the batch adds no score.

## Retained first-run results

Product source: `b21b28d` (HEAD evidence `7dc3590`), before product changes in this batch. All reports/logs are retained in the ignored takeover checkpoint directory.

| Attempt | Passed / failed | Interpretation |
|---|---:|---|
| `multi-world-corpus-baseline` | 1 / 24 | All HTTP calls blocked by sandbox loopback restriction, not product assertions |
| `multi-world-corpus-loopback-baseline` | 19 / 6 | Original assertions with permitted temporary loopback |
| `multi-world-corpus-diagnostic` | 20 / 5 | Corrected missing TALK fixture; per-case snapshots added |
| `multi-world-corpus-corrected-baseline` | 21 / 4 | Added missing Freeform candidate; technical failure asserted by typed outcome rather than one specific wording |

The initial corpus said HOLD for the continuity activity. Inspection showed that the unguarded typed activity contract legitimately uses Freeform with `receipt.activity`, while the existing conditional lane uses HOLD. Assertions now accept either authoritative timed activity, preserving the original input, required duration, NPC/background effects and interruption requirement. This fixture correction is not a product repair. No original failures were erased. The original JSON expectation is retained as provenance; this paragraph documents its API-specific correction.

The corrected product failures are:

- **T07:** a true conditional MOVE→BUY plan is vetoed before the MOVE because the purchase contract intentionally binds stock/shop only after arrival. T06's false condition stays effect-free, but does not by itself prove condition evaluation when admission stops first.
- **L01/L05:** an actual successful ten-minute activity and NPC departure/background settlement are in Core receipts, but refusal fallback says only `这次尝试已完成。` and omits the activity and elapsed time. Replay assertions for L05 have not yet run because the earlier prose assertion fails.
- **L08:** ordinary Freeform advances the full ten minutes past an accepted one-minute appointment, resolving the remote incident too. No partial completion is established. This is distinct from the already-fixed HOLD interruption path.

Technical failures are checked before effects in all three structures. Passing cases do not close the failed combinations. Per-case snapshots of this run are retained as ignored `multi-world-corpus-initial-cases/*.json`; they contain only synthetic fixtures.

Next: repair grounded generic-activity degradation first, then conditional trade admission and the Freeform appointment boundary, with original failure reports retained. Re-run every fixed entry after fixes. Broader A9 coverage and independent review remain required.

Initial builds also exposed test-only generic-JSON component typing errors and an unknown action payload access. Those logs are retained; fixture helpers now state their component shapes and narrow the injected action check. No production schema changed.

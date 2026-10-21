# Independent Narrator program

Baseline verified from remote main on 2026-10-21: `23083b3a8cb0a9ddb4c66d9a24b2b4a8798fdf7b`, v0.1.20.
Branch `codex/cloud-narrator-quality-program`. Fixed ledger: 109/160, 22 unmet,
29 unverified. Only N5.3/4, N7.3/4, N8.2/4 and N9.1/2/3/4 belong to this program.
N4 PR #1 is separate and is not a dependency. No frozen file or shared score is edited.

## Audited task matrix

| Condition | Existing implementation/evidence | Independent offline work | Remaining acceptance boundary |
|---|---|---|---|
| N5.3 unmet | Persona, per-character cognition, dialogue continuity policy; npc-dialogue-style only checks injected context | Fixed different-character and same-character memory/relationship contrasts; preserve prompts, actual output, attributable utterances and sample-copy controls | Context injection is not voice differentiation; evaluate actual paired outputs, keep model provenance explicit |
| N5.4 unverified | Same short offline tests | Prepare the fixed multi-person review packets without calling a Provider | Authorized real model plus per-person personality, memory, relationship and naturalness review |
| N7.3 unmet | Bounded recent history, cognition, continuity tests | Repair demonstrated history provenance loss; fixed before/after position, commitment, event, own memory/relationship checks | Long expression and recall must be evaluated on actual text, not context presence alone |
| N7.4 unverified | Short continuity/restart tests; separate NPC adaptation72 evidence is not Narrator acceptance | Three existing distinct causal structures, 72h, fixed readbacks, real temporary persistence/restart/replay; capture each paragraph and authority | Offline controlled output cannot establish long model narrative experience; retain unreviewed real-model/quality cells |
| N8.2 unmet | Grounded item/HOLD/physical/compound fallbacks and historical samples | Read actual fallback outputs, preserve defects and minimally repair shared presentation causes; expose unfinished versus settled meaning | Naturalness is evaluated alongside facts; no closure merely from more passing assertions |
| N8.4 unverified | Offline refusal/schema/contradiction fallback | Fixed same-case normal-candidate/fallback contrasts with explicit provenance and review | Authorized current model side plus text review still required |
| N9.1 unmet | 18-case capture baseline, anchored rubric, blank ratings | Complete inspectable benchmark contract including voice/memory contrasts, missing-output/failure accounting and a review table | Do not replace missing quality judgments with automatic lexical scores |
| N9.2 unmet | Five anchored dimensions but no real voice/paired-memory cases | Cover voice, rhythm, perception, naturalness, continuity and explicit pair judgments in the same benchmark | Applicable unreviewed dimensions remain open, N/A needs a reason |
| N9.3 unverified | Historical 18-case capture on older source | Run current-source complete offline capture, pin inputs, list every missing/failed/unreviewed result | Offline completeness is not a complete authorized-model benchmark |
| N9.4 unverified | No independent review | Prepare version/hash-bound reviewer import and reject incomplete/contradictory verdicts | Independent/human review must actually occur; developer self-review cannot satisfy it |

## Batch 1 frozen investigation

Main Narrator uses location/time-attributed scene history with remote descriptive
paragraphs omitted. `refineNarrative` instead receives the earlier raw
`characterContext.recent_turns`, which drops location/time/speaker attribution
and reintroduces those remote paragraphs. This is a code observation until the
baseline reproduces it. It is shared history projection, not a new memory store.

Freeze 12 controlled prompt cases: existing commerce / relationships / autonomy
structures, local versus remote prior scene, successful versus refused refinement.
Force refinement through an exact repeated first candidate; compare the complete
ordinary/refinement history frames and preserve source state. No candidate is
claimed to be actual model voice or historical truth. Later 72h tests must remain
separate from these prompt contract cases. Modify only the Narrator history handoff
if reproduced; do not change settlement, NPC memory or other owners' conditions.

Shared conflict surface: `src/ai/runtime.ts` Narrator context construction; any
Windows edits to this area require review before integration. Other planned
benchmark helpers/tests/docs should be new files to avoid shared ledger conflicts.

## Observed fixes and retained failures

- History baseline `narrator-program-history-baseline.json`: 12 failures because
  the first fixture did not actually trigger refinement (dialogue changed the
  repetition comparison). Fixture-only correction, no expectation relaxation.
  Corrected baseline: 12/12 fail the differing history-frame assertion. One
  shared `narratorHistory` projection now feeds ordinary and refined narration,
  retaining historical speaker/time, legacy dialogue and typed utterances while
  omitting remote descriptive paragraphs.
- N8 item baseline `narrator-program-item-baseline.json`: all 15 fixed real
  MOVE_ITEM/TRANSFER_ITEM cases in three structures return the generic
  `这次尝试已完成。已登记物品的位置随之更新。`. A presentation-only helper now
  requires exact built-in receipt facts, action/actor identity and actual item
  placement before using names. It does not execute or authorize any item action,
  infer NPC consent, modify Core or claim N6 acceptance.
- Initial 72h capture with an otherwise quiet one-memory fixture passed. The
  stronger predeclared readback adds real daily exchanges; all three structures
  then fail because the important original memory persists in canonical storage
  but disappears from the latest-three Narrator projection. The projector now
  selects one canonically salient memory plus two recent others, maximum three;
  equal importance retains latest-three behavior. Original `at` times remain.
  This changes presentation selection only, not NPC memory/goal ownership.
- Two strict build attempts failed on new test Action/speech-event fields, then
  on the helper's incorrect Action type import. Both were corrected without
  weakening assertions or changing contracts. Failed logs/reports are retained.

Interim verification: 41/41 selected history/item/HTTP/adjacent tests passed;
21/21 long-history/voice/cognition/dialogue tests passed (including all three
actual 72h runs, three fresh-store/service replays per structure); subsequent
reviewed typecheck/frontend/server build passed. Final source inventory and
all current-source results are recorded below after the program capture.

## Quality evidence contract

The additive `narrator-quality-program.v1.json` reuses the original 18-case
baseline and five anchored dimensions; it does not replace frozen acceptance.
It adds 12 explicit person/memory/relationship controls, three actual 72h
readback cases, 15 real fallback item cases, and eight existing partial-plan
failure cases without changing their implementation or assertions: 56 cases.
Nine fixed pair comparisons distinguish different-person and same-person
contrasts. Scripted controls are labelled, not advertised as actual model voice.

`node scripts/narrator-quality-program.mjs` runs all selected fixtures in the
isolated wrapper, pins source/config/content/fixture/criteria hashes, retains
original test failures and all raw texts, and writes a per-case Markdown review
table plus blank per-dimension and pair judgments. No automatic quality rating,
fixed-condition credit, normal-provider call or human verdict is produced.

After a reviewer actually supplies judgments, run:

```sh
npx --no-install tsx scripts/narrator-quality-review.ts <capture/review.json> <reviewer-file.json>
```

The checker verifies manifest/output bytes, inventories, anchored 0–3 ratings,
N/A explanations, all factual hard gates, pair evidence and reviewer metadata.
A fact failure or a dimension below 2 cannot be averaged away. A declared human
role is not authenticated; the report still requires external identity and
authorization verification and never awards conditions. Controlled samples
remain controlled even if somebody supplies high ratings.

Shared conflict surfaces additionally include the `narrationFallback` return
branch in `src/server/service.ts` and the bounded projection in
`src/narrative/character-cognition.ts`. Windows should review those exact hunks;
the registered actions, schema, transaction protocol and N3 executor are untouched.

## Subsequent review and baseline refresh

Remote main advanced to `dc3ac77725c88903972dc75a1b37aeb4faa92533` by merging
the separate N4 PR #1. The program checkpoint was rebased onto that inspected
main; N4 was inherited, not reimplemented. Stable checkpoints were pushed as
`c1b77a3` (presentation/history fixes) and `4aeaefb` (frozen benchmark/review
infrastructure). First full capture on `4aeaefb`: 56/56 cases, 103 assertions,
zero failures/skips, 564 unchanged hashes, zero ratings/provider calls. This is
retained at `2026-10-21T14-57-42-850Z`, not retroactively called the final run.

Developer text inspection identified two remaining offline preparation gaps:
the initial long-readback table showed only WAIT text, and the captured fallback
fixtures did not retain a usable ordinary-model request. The same three long
cases now include actual daily exchanges, Core moves with alternating readback
locations, commerce purchases, and declared contact-relationship changes.
The original high-importance statement remains a memory of words, not a claim
of fulfilled promises. All three run exactly 72h and recreate/replay three times.

The read-only capture hook now copies the exact arguments at the application's
Narrator boundary, then uses a separate offline adapter on that copy solely to
construct a request envelope. The probe's text is discarded. Direct voice
controls retain their actual request too. Queue selection excludes world setup
witnesses and uses the selected case's actual receipt identities. No thread,
credential, callback or live game-state handle enters the request handoff.

`narrator-candidate-queue.ts` defaults to dry-run and binds an execution plan to
the exact queue hash, explicit call/output budgets and an authorization reference.
Its tested execution path uses only injected offline adapters here; a reference
is not proof of actual user permission. Every returned or failed candidate stays
unreviewed. Actual human authorization and provider selection are still required.

```sh
npx --no-install tsx scripts/narrator-candidate-plan.ts <capture/candidate-queue.json>
node scripts/narrator-review-template.mjs <capture/review.json> <new-reviewer-file.json>
```

The template contains null identity, gates, dimensions and pair judgments; it
fails review validation until a person actually fills them. Never populate it
with fabricated human ratings or infer a model pass from scripted voice controls.

## N8 compound presentation review

The first capture's T05/R05/R06 prose was a numbered receipt-style list. A real
compound Core/service baseline fails the explicit non-list prose check (one
failure, preserved in `narrator-program-compound-style-baseline.json`). The
shared Narrator renderer now has an additive presentation option: internal
callers retain the original receipt list by default; the application's fallback
selects prose paragraphs. No string-stripping heuristic changes quoted content.
All facts and order are identical. The service-level format expectation in two
existing tests changes accordingly; positive fact/order, time, resource,
degradation, retry and replay assertions remain. No N3 execution/status rule or
executor source changed. The resulting five-file regression passes 49 tests.

Conflict surface for Windows additionally includes the optional fourth argument
to `canonicalCompoundNarrative`, its one service call, and the two display-format
expectations. Review these presentation-only hunks against any unmerged N3 work;
do not overwrite that work. This program does not claim N3 or N4 condition credit.

## Capture integrity and remaining clock-label defect

The first request-envelope run on `918663d` passed its 103 application assertions
and generated 100 receipt-filtered jobs, but a post-run identity audit found 95
action IDs labelled by more than one test. New fixtures without mock cleanup
allowed old capture wrappers to survive into later cases. These were offline
construction probes, not provider calls. Preserve that run and its
`postrun-attribution-audit.json`; it is not the final capture evidence.
The capture hook now restores mocks after every case and the runner rejects
any cross-case action identity. A full run on `90a39a4` then passed 103/103,
captured 56/56, pinned 647 unchanged hashes and had zero cross-case identities.

Reading those actual texts also found Core clock labels copied verbatim into
interrupted activity prose. A stricter real-HOLD baseline produced 4 failures /
5 controls: the story contained `已到安排时间：已经接受的会面`. The new read-only
`foregroundNarrative` renders only that registered task-clock format as
`「已经接受的会面」的时间到了。`; the original foreground reason remains exactly
unchanged, and no attendance or fulfilment is claimed. Unknown/natural event
reasons are preserved. Directed HOLD/WAIT/long-HOLD/format regression: four
files / 24 passed. Raw failure/fixed reports are retained. This is N8
presentation work, not a change to time, scheduling or interruption rules.

## Next external breakpoint, by condition

The fixed ledger is left unchanged. These are evidence/readiness assessments,
not new acceptance conditions and not a claim of ten completed items.

| Condition / existing ledger | Delivered independent work | What is still needed |
|---|---|---|
| N5.3 unmet | Twelve reproducible same-question controls, nine pair comparisons, current persona/own-memory/directional-relationship inputs, raw requests and no literal sample copying | Actual generated voice/relationship contrasts; authored response controls do not establish them. Authorize the selected real Provider, then review outputs |
| N5.4 unverified | Fixed multi-character cases, source-bound review packet and explicit dimensions | Authorized actual-model dialogue plus the specified personality/memory/relationship/naturalness judgments |
| N7.3 unmet | Repaired history attribution and salient-memory retention; real daily exchanges, moves, commerce and relationship before/after evidence; memories stay memories, pending goals stay pending | Current-model long expression/recall samples and their evaluation; clock/field correctness alone is not narrative consistency |
| N7.4 unverified | Three structural worlds ×72h, fixed 24/48/72h readbacks, nine fresh JsonStore/GameService recreations and exact original-request replay | Actual multi-world long-text experience/readback evaluation; these are service/store recreations, not OS process-kill evidence |
| N8.2 unmet | Exact item/unfinished interval facts, paragraph-form compound prose and clock-label rendering; original partial-failure stories, Agent status and receipts retained together | Textual naturalness/unfinished-expression verdict on the published samples, coordinated with Windows' parent-status/body boundary; no N3 execution change is proposed. Offline samples can be reviewed without a Provider call |
| N8.4 unverified | Actual offline fallback cases and raw same-source ordinary-request envelopes | Authorized current-model half of the contrast and a textual verdict on both; no current-model pass is claimed |
| N9.1 unmet | Fixed56 benchmark, five anchored dimensions, nine pair judgments, blank usable review template, immutable inputs/outputs and complete per-case table | Windows can review this as a benchmark/readiness candidate under the original wording; no self-awarded score or claim that blank ratings are completed reviews |
| N9.2 unmet | Explicit coverage of voice, rhythm, perception, naturalness and continuity with factual hard gates | Voice controls still need generated counterparts and actual anchored judgments; N/A must be justified |
| N9.3 unverified | Full current-source offline execution and every failed/missing/unreviewed result, plus a dry-run candidate plan | Full authorized normal-model counterpart and publication of its actual failures/unmet ratings; offline completeness is not that run |
| N9.4 unverified | Hash/identity/inventory/budget checks and an intentionally invalid unfilled review template | An actual independent/human reviewer; validator unit fixtures are not real human judgments |

No additional known reproducible implementation counterexample in this fixed
offline corpus is left knowingly unresolved. The remaining generated-text and
review gates above cannot be manufactured by adding more deterministic passing
assertions. This statement does not assert that arbitrary language is bug-free.

The next execution needs a chosen Provider/model, actual authorization, explicit
call/output or monetary bounds, and a reviewer. Existing bindings may be used
after authorization; no API/credential configuration was changed here. No secret
values belong in this handoff. All outputs, including refusals/truncations and
low ratings, must be retained. Independent identity/authorization remains an
external verification even when a JSON file declares a reviewer role.


## Final current-source evidence before external quality gates

Source `80e2ac91a68a6e4e61b791632c004ba7e0573bd0`, capture `2026-10-21T15-36-56-589Z`: 56/56 cases, 103 passed,
zero failures/skips, 649 unchanged hashes, zero cross-case identities.
Strict root/client/server build exit0 (133.954s; concurrent capture).
Dry-run queue: 100 calls, 2596716 input characters,
maximum 600000 output tokens. Actual calls/ratings/condition credit are all zero.
The generated blank human review was actually rejected by the review CLI as expected.
Full primary texts and separate partial-plan statuses are published in
`narrator-program-offline-results.md`; raw manifests, JSON/logs and failures
remain in the evidence bundle/ignored runtime directory. The final docs commit
does not change the tested product, fixtures or scripts.

Reproduce from `/workspace/game` with Node.js 24.19.0 / npm 11.9.0:

```sh
node scripts/narrator-quality-program.mjs
node scripts/agent-workspace.mjs codex build
node scripts/four-theme-progress.mjs --check
```

No GitHub PR API permission was available (`Forbidden` on GraphQL); stable
checkpoints are pushed to `codex/cloud-narrator-quality-program`. Create/review
the PR in GitHub and let Windows integrate only at a safe checkpoint. Do not
merge automatically. This handoff is an external authorization/review breakpoint,
not a claim that the ten-condition program has passed.


Evidence archive supplied with this handoff: `narrator-quality-evidence-80e2ac9.zip`
(23,861,390 bytes; includes retained raw failures, old attribution probes and final
capture). SHA-256: `2051eceae3ea57cdfd02f1b67c19cd0c23efc5b65ac0d142a1835c23565af7b1`.
The archive has been CRC-checked. It contains only the program's synthetic test
artifacts and documentation, not production data or credential files.

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

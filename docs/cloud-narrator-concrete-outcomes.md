# Concrete Narrator outcomes (independent continuation)

Base: remote main `7cd0c8a4665831acc0b52faf646ddf9062b2d874`, verified 2026-10-22.
Branch: `codex/cloud-narrator-concrete-outcomes`. PR #2 is included in main.
PR #3–#7 heads were confirmed through Git refs; none is an ancestor of this main.
GitHub GraphQL returns Forbidden. No assumptions about Windows' local integration.
This branch does not depend on or modify the delivered consumption/transfer branches.

## First stable checkpoint

The existing Core already records authorized physical forms, contact, control and
harm. The fallback discarded these distinctions. A read-only shared presentation
projection now supplies them to the Narrator and renders each recorded attempt.
It explicitly leaves the cause unknown: an opposed roll failing does not prove
evasion, blocking, a counterattack, a wound type or a fall. No probability, body,
clock, item or resource settlement changes. Old receipts without action forms
retain a less specific attempt. Hidden outcomes remain uncertain.

Actual offline examples (authored inputs, genuine Core results):
- Before: `你对林舟发起了尝试，这一次未能建立接触。`
  After, authorized strike: `你向林舟击去，但没能碰到对方。`
- Before: `你的动作触及了林舟。但接下来的动作没有达到预期；本次没有新增已确认的伤害。`
  After, authorized push: `你推向林舟，碰到了对方，但这次接触没有造成伤害。`
- A successful strike is rendered as a hit and harm; successful control is
  rendered separately. Neither asserts an invented reaction or injury detail.

Expression-only regeneration formerly adopted the new body but retained old
scene beats. It could also silently accept a changed speaker or omitted speech.
It now accepts a complete performance together, requiring the original ordered
speech identities and utterances. Otherwise it retains the original candidate;
there is still only one optional refinement and the service's existing bounded
validation retries. No Core action is rerun to repair prose.

Provider refusal detection previously scanned NPC dialogue as assistant prose.
Only exact, quoted utterances with an explicitly known NPC identity are exempted
from the generic assistant-refusal scan. Provider self-identification and policy
refusal remain prohibited, including inside dialogue. Unbound speech and
assistant prose outside the quote remain subject to the original check.

The persistent presentation status/reasons are retained. Technical downgrade
notices no longer dominate the story: the UI has a closed `叙事说明` disclosure.
A duplicate transient notice also made initial and replayed responses differ;
removing it makes the tested full responses identical, with unchanged save bytes.

## Reproduction and evidence

All tests use offline adapters and synthetic data. Commerce, relationship-only
and autonomous world fixtures run their genuinely different causal setup first.
No authored sample is claimed to be current-model output or a human quality score.
Raw files are in ignored `.agent-runtime/codex/` for packaging at delivery.

- Initial outcome baseline: 9 actual lost-form failures and 3 fixture field-name
  errors. Corrected baseline retains all 12 failures (missing presentation
  projection plus lost forms); the first report is retained, not reclassified.
- Expression baseline: 12 failures across all three structures, including three
  NPC refusals falsely treated as Provider refusals.
- First adjacent run: 60 passed / 8 failed. Four intentional prose snapshots and
  one legacy literal assertion needed updating; three actual initial/replay
  differences came from the transient technical notice. Original reports and
  differing response bytes are retained.
- Corrected physical/service/HTTP adjacent run: 70 passed, 0 failed/skipped.
  Three worlds × refusal / repaired candidate / exhausted retries use actual
  JsonStore commits, fresh service/store replay, revision and byte checks, and
  one Core execution. The normal candidate is explicitly authored offline text.
- Expression/history/dialogue/continuity adjacent run: 53 passed, 0 failed/skipped.
- Strict root/client/server build completed, with existing Zod annotation and
  bundle size warnings. Final pinned-source verification follows later batches.

## Integration and acceptance boundaries

Shared conflict surfaces: AI runtime and narrative-health, narrative-firewall,
public-view notice construction, service's one duplicate notice, SceneStory.
PR #3–#7 add other functionality in several of these files; integrate hunks,
not whole-file replacement. No new schema or storage dependency is introduced.
Physical projection adds an optional prompt field, not a new authoritative event.

N8.2 and N3.4 gain inspectable prose fixes; N8.4 still requires actual current-model
and quality assessment. N5/N7/N9 quality gates remain open. No frozen definition,
formal ledger, denominator or score is modified. General naturalness and arbitrary
language correctness are not established by these finite offline checks.

## Focus and refinement checkpoint

Six crowd cases reproduce the target falling outside the original eight-character
slice. NPC context now excludes the player, prioritizes the explicit interlocutor,
and carries public `location_id` and `present`. It does not recover hidden remote
locations. Own relationship selection keeps the player's and present participants'
directional entries before unrelated entries, preserving the existing cap of six.
No relationship value, NPC decision, memory or goal is changed.

The first corrected crowd run exposed three *fixture* errors demanding a remote
location that publicView intentionally hides; expected location is null with
present=false. Five refusal-boundary tests initially expected ProviderError's
private detail as its public message; their assertion was corrected to the error
type. These original reports are retained. The next seven-file run passed 47/48;
an unchanged NPC-owner test produced STACK_TRACE_ERROR at 8.27 seconds. Its
isolated unchanged recheck passed 2/2 in 7.29 seconds total (260ms test execution).
The JSON reporter did not expand the cause. This failure is retained; the final affected run must still be green.

Three actual partial-contact Core cases further show that expression refinement
received flat facts and a previous paragraph, but lost the ordinary generation's
structured receipt, compound steps and physical reactions. Both calls now share
one receipt projection and the same significant incidents. This reduces missing
information during correction, without changing retry limits or granting facts
from the rejected candidate. Baseline 0/3, corrected refinement/expression/history
run 28/28. Prompt equality is a context guarantee, not real-model quality evidence.

Named control prose also retains the target's identity. Additional boundaries
cover legacy receipts, hidden outcomes, unbound quotations, genuine assistant
refusals and refusal text outside an otherwise valid NPC quotation. Compatibility
assertions admit the new grounded no-contact wording while keeping all original
receipt, damage, time, ordering, invalid-claim and replay checks.

## Independent integration preview

`git merge-tree --write-tree --name-only 50eb563 codex/cloud-item-stack-transfer`
computed a temporary merge tree only; no checkout, branch or PR was merged.
Conflicts: `CLAUDE-HANDOFF.md`, `src/ai/runtime.ts`, `src/client/SceneStory.tsx`,
`src/core/narrative-firewall.ts`. Integration must preserve:

1. Both sets of imports in runtime/firewall.
2. PR #5/#6's `item_operation`, privacy-projected `consumption`, and
   `item_entities` fields in the shared `resolutionReceipt` object, including
   each child step. Both initial generation and refinement must receive it.
3. PR #3's `props.turns` loop and snapshot speaker list in SceneStory, together
   with this branch's closed disclosure. Do not replace the loop with the older
   single-turn render call.
4. Both handoff sections. This preview does not verify Windows' unknown changes.

The first existing 56-case capture on `50eb563` retained all 56 records and 100
request envelopes without cross-case identities, but failed 8/103 assertions:
`compound-failure-corpus` still required the exact older words `接触`/`触及`.
Actual new outputs use `碰到`. All receipt, stamina, HP, timing and order inputs
are retained in that failed capture. Two text patterns are updated to admit the
same factual result; their non-text settlement and replay assertions remain.
This failed capture is not represented as a passing quality benchmark.

## Remaining fourteen-condition matrix (no score changes)

| Condition | Frozen ledger | Actual boundary |
|---|---|---|
| A8.3 | unmet | Prior consumption delivery only; no Core/resource work repeated here. Windows integration remains external. |
| N3.4 | unmet | Concrete physical forms and coherent refinement improve bounded samples; general long-action naturalness is not established. |
| N6.3 | unmet | Prior item PRs remain separate. This main-based branch does not have PR #5 consumption. |
| N6.4 | unverified | Prior real item/replay evidence remains on PR #5–#7; combined integration and consumption regression still needed. |
| N5.3 | unmet | Crowded focus and directional relationship loss repaired; context correctness is not differentiated generated voice. |
| N5.4 | unverified | Authorized actual-model dialogue and independent personality/relationship/memory review still absent. |
| N7.3 | unmet | Preserved absence boundaries and refinement settlement/history; generated long-term expression still needs assessment. |
| N7.4 | unverified | Existing three-world 72h offline readbacks are re-executed for regression; real long-text quality remains unverified. |
| N8.2 | unmet | Specific result rendering, bounded recovery and quieter UI implemented; published samples still require quality judgment. |
| N8.4 | unverified | Current actual-model comparison absent. Offline failures and controlled outputs cannot satisfy this condition. |
| N9.1 | unmet | Existing 56-case program reused, with this batch’s raw-output supplement and blank review fields. |
| N9.2 | unmet | Existing anchored dimensions/pairs retained. No automatic naturalness or voice score assigned. |
| N9.3 | unverified | Current-source offline execution provided with retained failures; no authorized normal-model counterpart. |
| N9.4 | unverified | No independent/human verdict; all quality ratings remain blank. |

For receipts that only record a failed check, the cause remains unknown. This
branch does not invent dodge/block/counterattack events or modify Windows' Core
rules to produce them. Old receipts without action forms retain less specific
prose. Finite Chinese regression samples do not prove arbitrary language or every
world configuration. Technical transaction failures still retain actionable Agent
status messages; they are not silently converted into successful story outcomes.

The product code at `50eb563` passed the exact 37-file inventory: **465 passed,
0 failed, 0 skipped**, 634.31 seconds, 657 unchanged input hashes. Strict root,
client and server build exited 0. Existing Zod-comment/bundle-size warnings remain.
The test runner used `--testTimeout=30000` for this broad isolated environment run;
assertions were unchanged. The later commit `684a6a6` changes only two text
patterns in a separate corpus test and this document; all product source is
byte-identical. The full-run source snapshot is preserved independently.

Final quality capture on `684a6a610faf6f55b34759c2b1f9d8018df7b129`:
`2026-10-22T12-09-08-714Z`, **56/56 cases, 103 passed, 0 failed/skipped**,
656 unchanged hashes, 100 offline request envelopes, zero cross-case identities.
The preceding `2026-10-22T12-02-57-093Z` failed capture remains in the archive.
These test counts overlap the 37-file regression; do not sum them into coverage.
No real-provider calls, human ratings or acceptance credits were created.

Evidence bundle: `/workspace/scratch/narrator-concrete-outcomes-50eb563.zip`,
with adjacent `.manifest.json` and `.zip.sha256`. It includes the exact full-run
source snapshot, both quality captures, original failures, current raw contexts
and text, byte replay checks, and an unscored 39-record supplement (nine of these
records concern context contracts, not generated quality). The bundle contains
only synthetic development artifacts. Current voice/naturalness judgments remain
external. The original review packet can be processed by the existing
`scripts/narrator-quality-review.ts`; do not submit the separate supplement to
that original fixed-56 schema or fabricate a reviewer identity.

Reproduce from a checkout named `game` with Node 24 / npm 11:

```sh
npm ci --ignore-scripts
node scripts/agent-workspace.mjs codex test <files from docs/cloud-narrator-outcomes-tests.json> --testTimeout=30000
node scripts/agent-workspace.mjs codex build
node scripts/narrator-quality-program.mjs
node scripts/four-theme-progress.mjs --check
```

The placeholder above means the explicit 37 file paths in the inventory, not a
shell glob or all repository tests. On this cloud environment installation used
`--offline --cache /workspace/.npm-cache`; no provider configuration was copied.
The user-facing story samples and empty quality judgments are in the archive's
`evidence/outcomes-review-supplement.md/json` and both `quality-program` runs.

Final delivery: all checkpoints pushed to `codex/cloud-narrator-concrete-outcomes`.
An actual `gh pr create --base main --head codex/cloud-narrator-concrete-outcomes`
request returned `Post https://api.github.com/graphql: Forbidden`; no PR number is
claimed. Create it at:
https://github.com/ononoki-peacepeace/agent-game-framework/compare/main...codex/cloud-narrator-concrete-outcomes?expand=1

Evidence ZIP: 13,739,062 bytes, SHA-256
`d15e9207b71a84979b2474a06f8f37c5a240c30ad061bc4f9e6237707bc4a610`.
CRC verified. Archive handoff snapshot precedes this final API-result note;
its product/test evidence and source hashes are unchanged. Windows may integrate
this independent PR after reviewing PR #3–#7, using the conflict notes above.
No PR or main branch was merged here.

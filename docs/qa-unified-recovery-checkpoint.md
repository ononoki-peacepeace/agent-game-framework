# Unified QA recovery checkpoint

Task source: attachment `487205ae-0e7c-44a7-a595-8537ef103c52/已粘贴的文本.txt`.
Actual package version: 0.1.19. Preserve the existing dirty working tree.
Production save is read-only; no production request was submitted or cancelled.

## Recovered interrupted work

The active previous task was (1) stale pending-input recovery after server restart
and (2) profiling and reducing 13–16 seconds of local HTTP turn overhead.
The older snapshot projection/disk read cache work is baseline, not reimplemented.

- Implemented: typed missing-status handling, abortable bounded refresh recovery,
  scoped pending-marker cleanup, auxiliary durable HTTP request records, restart
  deduplication, and conservative committed-progress recovery from existing receipts.
- New records do not become world authority. If the exact response was lost, a
  receipt proves only committed progress, never completion of all requested steps.
- Implemented: one-use validation proof for an isolated JsonStore read, consumed
  immediately by service normalization. Any actual migration still validates;
  modified writes still fully validate. Final JsonStore validation was retained;
  one identical pre-write pass in agentTransaction was removed only for a storage
  adapter explicitly guaranteeing complete write validation.
- Before profile: 16.586 seconds HTTP; save Schema 13 calls / 9.730 seconds;
  clones 527 / 5.205 seconds; ensureBaseFeatures 8 / 5.619 seconds inclusive.
- After single profile: 7.894 seconds HTTP; save Schema 4 calls / 2.638 seconds;
  clones 527 / 3.816 seconds; ensureBaseFeatures 8 / 1 ms inclusive.
  Single samples are not a production P50/P95 or a real-model speed claim.
- Profiles: `.tmp/turn-http-cache-1792104517000/report.json` (before),
  `.tmp/turn-http-cache-1792115286021/report.json` (after).
- Passed after these changes: 5 files / 29 targeted tests (restart, 404, idempotency,
  validation proof, migrations, final writes, Save roundtrip, physical regression).
- Build passed (TypeScript, Vite, server compilation). Desktop 1366 and mobile 390
  browser scenarios passed: typed missing record and manual marker deletion stop
  polling, release the UI and produce zero input POSTs. Screenshots and report:
  `.tmp/request-recovery-browser-1792115795885`.
- Paired validation-reuse A/B (3 requests per arm, cached storage in both):
  baseline 13903/13107/13373 ms, optimized 7641/8552/7784 ms.
  Median 13.373 -> 7.784 seconds, 5.589 seconds / 41.8% lower.
  All samples retained 3 fixture model calls, one revision increment, same position
  and zero minute delta. Small samples are not production P95. Report:
  `.tmp/turn-http-cache-1792115491557/report.json`.
- Real DeepSeek HTTP greeting passed: 16.269 seconds, HTTP 200, revision 0 -> 1,
  exactly 3 calls (4394/2252/9325 ms), 12886 input / 2183 output tokens, no retry.
  Report: `.tmp/turn-latency-1792116274636/report.json`. This is a small fixture,
  not a real-model acceptance of all physical/environment/continuous-action paths.
- Fresh-process targeted gates passed: 65 tests for escape/control/query evidence;
  then 70 for environmental stage blocking and resolution compatibility; then 50
  for semantic conditional ownership and minimal-world compatibility.
- Two full runs overlapped new changes and therefore are NOT clean final gates.
  They caught a real over-strict actor-character requirement (fixed: general actor
  existence suffices), and stale-module/new-test mismatches. Never relabel either
  as a complete pass. A subsequent frozen-source run PASSED: 125 files / 1156
  tests, 381.04 seconds, original timeouts and one worker. Final build and
  diff-check also passed. Production hash remains unchanged at revision 285.
- The older 123-file / 1134-test full pass predates these current changes.

Automatic approval was temporarily unavailable due to account usage, not an unsafe
action verdict. No workaround was used. After its stated 09:43 reset time passed,
the original isolated profiling command was approved once and completed.

## Formal read-only evidence

- Request `f092ba80-7155-4f53-a926-8f0cbd1616ac`: typed 404 unknown, no matching
  current receipts/history or available log trace. Original execution stage is
  unproven; do not claim it never reached the server.
- Separate request `574e1564-858e-4b96-a54e-a087d1fe4b42` was observed running,
  then independently completed after about 280 seconds, committing revision 273.
  Those observations were GETs only, not replay or cancellation.
- Latest audited snapshot is revision 285, day 1 minute 802 (13:22), boiler room.
  SHA-256: `bb961a6f3a7e1feaa5fabe86c38941807d7c13b40026a33682ee6a08d05707a9`.
  Production progressed independently since the prior task; never restore old hashes.
- Revision-285 harm receipt exists and is committed: request
  `81cf59a1-5293-4422-a193-5c382447f745`, contact and injury stages passed,
  damage 20; target current HP 80. The claim that damage is only prose is disproven.
- Target has memories, active goals and reaction plans; current restraint also
  exists. Neither "no memory" nor "no plan" is supported by the save evidence.
- Non-spoiler inventory of mystery structure: 1 Macro Arc, 2 incidents, 3 hidden
  truth commitments, 6 evidence records, all 6 with placement. This is not proof
  of a complete, coherent, playable deductive evidence chain.

## Confirmed defects / remaining investigations

1. Recovery original cause: in-memory request Map lost on restart; typed 404 was
   thrown as a generic fetch error; refresh catch rescheduled polling without a
   terminal bound. Storage deletion alone did not cancel the captured React marker.
2. Fixed physical control defect: partial contact no longer creates sustained
   control if a later hold stage fails. New optional receipt control_established
   preserves old-save compatibility; fallback uses full outcome for old receipts.
   Initial contact/control tests passed; subsequent escape tests await execution.
3. Added Core BREAK_FREE using existing opposed RNG, actor-aware prepareCheck,
   state validation, receipt and experience recording. Existing bounded physical
   reaction can choose it inside the already-paid action interval; no extra LLM
   call or automatic escape/MOVE. New tests and final type/build gate still pending.
4. Added priority for related condition/physical_state fields in bounded public
   query evidence. Large profiles/maps must not displace canonical HP/control.
   This is a demonstrated projection risk; its role in the precise formal System
   misanswer remains unproven. Regression passed.
5. Fixed environment evidence absence: distinct independent contact stages may run;
   unknown environmental injury is an explicitly blocked stage with no injury RNG
   or damage. Forged source quotes still require repair. Existing location prose
   may ground a source without a standalone object. Unknown is not confirmed safe.
6. Reduced duplicate planning for already interpreted single immediate attempts;
   this does not create an activity receipt or completion guarantee. Recovery,
   compound, ambiguous and scheduled goals retain model planning. The alignment
   audit explicitly distinguishes attempting from guaranteeing success.
7. Removed legacy sentence-based condition insertion/deletion from GoalSpec-owned
   calls. Compatibility callers without GoalSpec retain it. This fixes a concrete
   competing-authority defect; historical REV-277 raw model output is not recovered.
8. Tagged storage reads by bounded caller category (current/view/semantic/recovery/
   commit check) for subsequent attribution. No logs or audit records removed.
4. `tr_df67ba4c2809`: schema-compatible HTTP body, then a 4000-token truncation
   (27.56 s), compact retry (17.86 s), final transaction_failure/plan_step with no
   receipts at revision 283. Do not call the revision field a commit.
5. `tr_431e804fe03c`: alignment incomplete → replan → two target-binding attempts
   → transaction_failure at revision 280, no receipts, about 92 seconds total.
   This supports a planner/binding contract problem, not a Provider refusal claim.
6. Still pending: exact historical comparative semantics for immediate/conditional/continuous
   action cases, real-model environmental-property vs independent-contact acceptance, missing
   dialogue in revision-285 narrative, System query projection completeness,
   mystery/evidence mutation and Undo tests, background NPC fairness/goal progress,
   save.read source aggregation and precise development planning cost. Cancelled
   task c9496629 remains cancelled, with 6 max-output-token failures in its test
   history and 2 aborted history entries; no task was restarted.

## Next steps in required order

Previous recovery/performance gates and browser checks are complete. Additional
P0 action/control/escape/condition ownership fixes passed regression. Continue the
new attachment's remaining phases: full physical/continuous-action real-model
acceptance → evidence mutation/Undo → long-period NPC fairness and cost. No new independent router,
parallel state authority, guaranteed combat result, forced NPC movement, or
world-specific keywords. Real-provider checks must have explicit bounded calls.

The 44 questions now have an explicit evidence/status response in
docs/qa-unified-recovery-results.md. Several are evidence gaps or incomplete
acceptance, not successes. Do not mark the overall unified task complete.

## Follow-up closure on 2026-10-16

The user's explicit remaining three stages have now been implemented/tested:
evidence lifecycle (following held anchors, real INSPECT checks, per-NPC knowledge,
item damage/transfer, source-preserving destruction refs, deduplication, disk
reload/Undo); persistent least-recently-scheduled NPC opportunities and actor-aware
item actions; bounded real DeepSeek action acceptance.

Real artifacts: `.tmp/unified-physical-real-1792119865470/report.json` (two fresh
HTTP input turns, 6/7 calls, 39.629/64.088 sec, real random failures, one commit/minute
each) and `.tmp/recorded-partial-real-1792120241350/report.json` (recorded real plan,
controlled isolated partial RNG, 3 new real NPC/Narrator calls, 48.198 sec, HTTP
pending recovery/commit, exact retry has zero extra calls). Total 16 of 18 budgeted
calls, input 96427/output 22173 tokens. Do not imply the third is a fresh semantic
entry or natural random success.

Real-output local replay found negative movement prose falsely rejected by the
pattern firewall. Fixed without changing prose, with positive-counterexample tests.
Also stopped same-scene NPC private search results leaking into player narration.

One full run passed 127 files / 1167 cases. Final source after the last two fixes
PASSED build, targeted tests and final full suite: 127 files / 1169 tests, 384.01
seconds, original timeouts, one worker. Session 13120 completed successfully.
No product source was edited during that final gate. Diff-check passed.

Formal read-only full Schema compatibility passed at REV 285/minute 802; same
SHA-256 as above. No production actions, migration, rollback, task restart or Git
publication. No new human browser QA claimed. The result report's new closing
section supersedes the old 70% stage list; remaining limits are explicitly listed.
The remaining three engineering stages are closed at their stated acceptance
level. Do not restart the overall audit or another paid run automatically. Next
work should follow concrete human QA evidence, not chase exhaustive language or
random-outcome coverage. No human browser acceptance is claimed.

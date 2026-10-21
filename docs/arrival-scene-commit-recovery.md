# Arrival-scene commit recovery and classification

Parent `c6d30a1`. Actual temporary JsonStore baseline: **6 failed / 2 normal controls passed, 5.794s** (`arrival-scene-commit-recovery-baseline.json`). Both natural-scene effects and open-goal travel report every arrival failure as Provider failure. A successful arrival write followed by lost acknowledgement remains durably committed, but the runner incorrectly reports failure. Rejected scene effects are also mislabeled as Provider failure.

The arrival helper now distinguishes rejected candidates, Provider failures and transaction failures. Following a failed write acknowledgement, it resumes only when the same game, exact next revision, deterministic transaction identity/fingerprint and matching committed history are observable. It never regenerates or rewrites that arrival. Unreadable authority remains uncertain and flows through the existing caller read boundary, without candidate speech or stale view. Open-goal arrival failures also retain the actual nested departure-scene receipt alongside the MOVE receipt.

Reports under `.agent-runtime/codex/`:

- Baseline: 6 failed / 2 passed, 5.794s; retained.
- First repair: 4 files / 36 passed / 2 failed, 17.152s. The expanded receipt assertion exposes the missing nested departure receipt in open-goal failure results.
- Expanded run: 4 files / 41 passed / 3 failed, 21.045s. The first receipt fix used the narrative request ID instead of the actual nested transaction ID; these are real remaining failures, retained.
- Final: **4 files / 44 passed / zero failed or skipped, 22.746s**, `arrival-scene-commit-recovery-verified.json`. Fourteen direct cases cover both lanes with before/after-write failure, unreadable before/after-write recovery, normal response, invalid arrival effects and Provider refusal. Adjacent compound travel, scene-effect reads and open-goal unreadable-state tests pass in the same run.
- Final strict TypeScript: exit 0, **28.871s**, recorded in `arrival-scene-commit-recovery-final-typecheck.json`; `git diff --check` passes.

Direct cases verify actual location/revision, a single MOVE, presence or absence of committed NPC speech, exact same-ID cached result with zero extra writes/model calls, fresh-service current state and unchanged canonical bytes. Unknown commits do not imply that NPC speech happened or did not happen. No public interfaces, schemas or Core settlement semantics change.

R5.3 remains unmet: **103/160 (64.375%), delta zero**. The complete failure-exit matrix, general nested effects and multiprocess/OS boundaries remain open. No new full suite/build, paid Provider, formal-save/3100 change, deployment or human acceptance claim. Original six dirty files remain excluded from the checkpoint. Next: audit whether a MOVE that reaches only an intermediate route stop incorrectly completes a natural-scene effect, and continue the original four-theme Goal.

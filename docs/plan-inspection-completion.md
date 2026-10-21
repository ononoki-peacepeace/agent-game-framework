# Ordinary-plan per-item inspection completion

Parent `9ebbcff`. The existing single-perception repair does not cover the ordinary `executePlan` path. Actual temporary JsonStore/Core baseline with eight fixed status/acknowledgement variants: first run 7 failed / 1 passed, 6.411s (`plan-inspection-completion-baseline.json`). Three normal-response cases already prove partial/world-blocked/not-executed inspections incorrectly authorize a dependent WAIT. Complete inspection lost-ack retry initially had an incorrect test expectation: explicit user retry may execute the still-pending WAIT, while never repeating the committed inspection. The first report is retained, and that fixture expectation is corrected before product changes. Incomplete lost-ack retry must not authorize the WAIT.

The eight variants and commands are fixed in `four-theme-remaining-evidence-2026-10-21.md`. Corrected pre-repair baseline: **6 failed / 2 passed, 6.015s** (`plan-inspection-completion-corrected-baseline.json`). Both complete controls pass. The six incomplete cases prove unauthorized dependent WAIT both on normal response and explicit recovery after a lost acknowledgement. A4.2 was withdrawn to 102/160 (63.75%) before repair.

Minimal repair: `incompleteInspectionOutcome` in the existing Agent outcome module reads Core's structured inspection status; both ordinary plans and single perception use this pure classification. Partial checks remain partial, world blocks remain blocked, unexecuted lists remain unresolved, and technical inspection failure is an engine failure. Ordinary plans preserve saved narrative/receipt/actual changes and skip the dependent action. No Core settlement, schema or service boundary changes; no model inference of completion.

Actual final-source evidence, all under `.agent-runtime/codex/`:

- Direct file: **8 passed, 7.506s**, `plan-inspection-completion-fixed.json`.
- Final adjacent run: **6 files / 39 passed, zero failed/skipped, 19.199s**, `plan-inspection-completion-final.json`. Includes single-perception completion/evidence and plan handoff, unreadable-state and post-commit failure summary.
- Final strict TypeScript: **exit 0, 29.430s**, `plan-inspection-completion-final-typecheck.json`.
- Each direct variant uses actual Core/temporary JsonStore, checks revision/time and immutable inspection receipt, no repeated inspection generation, lawful pending WAIT only after complete inspection, and fresh-service state/bytes. Complete-lost-ack explicit retry may perform the pending WAIT once; incomplete retry performs no world write.

Restore only bounded A4.2 after final verification: **103/160 (64.375%), whole-batch net zero**. R5.3 remains unmet: its original exit matrix is incomplete. Receiptless/unrelated ordinary-turn response controls remain separately identified, not evidence that the production Core writer omits receipts. No full-suite/build, paid Provider, production, process-kill or human QA claim. Original dirty files and safety boundaries are preserved.

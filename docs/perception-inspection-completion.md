# Per-item perception completion

Parent f798823. Actual temporary JsonStore/Core baseline: **3 failed / 1 complete control passed, 3.841s**. The receipt already records partial/world_blocked/not_executed named inspection results but the single-perception shortcut reports completed. A4.2 was withdrawn to102/160 (63.75%) during repair.

The shortcut now maps the existing receipt's inspection state to completed, partial_progress, blocked_by_world or unresolved_goal. Incomplete item lists never claim the full perception_check completed. On lost write acknowledgement the receipt remains commit evidence but only a complete inspection may enter the completed-step list. No Core effects, schema or authority change; no extra model calls, automatic retries or writes.

Actual reports under .agent-runtime/codex/:

- Baseline:3failed/1passed,3.841s, retained.
- First repair:5files38passed,12.161s, before adding four lost-acknowledgement controls.
- Expanded:5files38passed/4failed,13.135s. New engine_failure assertions used the game outcome field completed_steps instead of the existing committed_steps contract.
- Corrected direct run:4passed/4failed,5.094s. The reused write spy still counted the first intentionally committed write. Clear its history immediately before checking replay; production behavior was not relaxed.
- Final: **5files42passed/zero failed or skipped,13.471s**, perception-inspection-completion-verified.json. Eight direct disk cases cover all four receipt states with normal/lost acknowledgement, exact cached response, zero extra calls/writes, fresh-service state and unchanged save bytes. Adjacent perception evidence, original Core enumerated inspection, investigation and contract completion pass together.
- Final strict TypeScript:exit0, **29.006s**, perception-inspection-completion-final-typecheck.json; git diff --check passed.

A4.2 restored: **103/160 (64.375%)**, +1condition/+0.625pp from withdrawal, wholebatch net0. Broad A4.3 language acceptance remains open. No fullsuite/build/paidProvider/human acceptance claim. Originalsixdirt/formal save/frozen criteria/3100/Claude checkout preserved. Next inspect remaining fixed reliability matrices, reproduce first, continue originalGoal.

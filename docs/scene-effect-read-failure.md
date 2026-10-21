# Scene-effect canonical read recovery

Parent `62fed34`. Offline baseline `scene-effect-read-failure-baseline.json`: **7 failures / 1 normal control passed, 4.155s**. Six actual temporary JsonStore cases expose raw read errors before an effect, after before/after-write failure, after an acknowledged turn, and at finalization with/without effects. A seventh case shows that a turn returning a view without an effect receipt is incorrectly reported as completed.

The scene runner now keeps its last successful canonical observation and uses a narrow read-error boundary for effect preparation, recovery, arrival refresh and finalization. Unavailable or replaced authority returns uncertain `transaction_failure/natural_scene_effect_refresh`, known scene/observed effect receipts and committed story, without a stale current view. Later unobserved writes are neither claimed nor denied. A returned turn view alone is not proof of a particular effect; the runner waits for its committed resolution receipt. Readable lost-response recovery can confirm that receipt. WAIT summaries use the receipt's actual time cost. Missing receipts stop later effects with explicit partial progress.

Verification:

- Baseline: 7 failed / 1 passed, 4.155s; retained.
- First repaired run: 3 files, 13 passed / 3 failed, 7.885s. The three residual assertions assumed absent `resolution_receipts` was an empty array. Corrected only that optional-array assertion; all preceding product assertions passed. This report remains a failed run.
- Final: **5 files / 67 passed / zero failed or skipped, 15.799s** (`scene-effect-read-failure-final.json`). Includes 11 direct cases, generation/commit recovery, cross-stage recovery and the existing scene suite. The direct cases cover two effects with the first confirmed and the second durable but unreadable, readable before/after-write controls, same-ID cache/no new calls or writes, disk bytes and fresh-service reads.
- Strict root TypeScript: exit 0, **28.916s**; `git diff --check` passed.

R5.3 remains unmet: **103/160 (64.375%), delta zero**. This does not close the full failure-exit matrix, general arrival-stage recovery, interrupted/multi-hop effects or the broader composite completion contract. No new full suite/build, process-kill or real-provider claim. Public interfaces, Core commit behavior, formal save, 3100, frozen criteria and original dirty files remain unchanged. Next: reproduce whether interrupted WAIT or intermediate MOVE receipts falsely complete the requested scene effect.

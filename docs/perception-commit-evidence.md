# Single-perception commit evidence

Parent `6baf819`. Actual temporary JsonStore baseline: **7 failed / 1 normal control passed, 4.014s**, `perception-commit-evidence-baseline.json`. The single-perception shortcut lets write-before, lost write acknowledgement and failed canonical refresh escape as raw exceptions. It also declares completion when a turn returns a view without its own resolution receipt, even if only an unrelated transaction advanced the revision. The missing/unrelated receipt cases explicitly substitute the turn response; they do not demonstrate a production Core writer omitting its receipt.

The shortcut now reads canonical state after failures and reports the precise Provider/transaction boundary, retaining only its own committed player receipt. It declares completion only with that receipt, returns invariant failure for missing evidence, and preserves a real world refusal as `blocked_by_world`. Unavailable or replaced authority produces uncertain refresh failure without a stale view or candidate story. Readable lost acknowledgement keeps committed perception progress and the request's own history. A second service's later WAIT must not replace that story or become this request's completion evidence. No retry or additional world write is introduced.

Actual reports under `.agent-runtime/codex/`:

- Baseline: 7 failed / 1 passed, 4.014s; retained.
- First repair: **5 files / 37 passed**, zero failures/skips, **12.208s**, `perception-commit-evidence-fixed.json`. Investigation, live Core observation, HTTP replay and Agent recovery pass. Strict TypeScript exit 0, 28.383s.
- Following review, history attribution was narrowed to the own request. A real second-service WAIT control was added. Affected **2 files / 13 passed**, zero failures/skips, **7.069s**, `perception-commit-evidence-final.json`; strict TypeScript exit 0, 28.207s.
- Provider refusal and world-refusal controls then extend only the direct file: **11 passed, 6.024s**; final strict TypeScript exit 0, **28.927s**, recorded in `perception-commit-evidence-controls{,-typecheck}.json`.

Reports overlap and span the initial/final implementation; they are not one combined full-suite run. Every direct case checks disk revision/time and own receipt presence, cached same-ID response with no extra calls/writes, fresh-service state and identical canonical bytes. Unknown post-write state is neither claimed committed nor claimed unchanged.

R5.3 remains unmet: **103/160 (64.375%), delta zero**. The full exit matrix and broader action completion contracts remain open. No Core/schema/public-interface change, full build/suite, real Provider or human acceptance is claimed. Formal save, frozen criteria, port 3100 and the original six dirty files are preserved. Next: inspect remaining fixed R7.4 process termination or R5.3 entry/read boundaries, reproduce before changing code, and continue the original Goal.

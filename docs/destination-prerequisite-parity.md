# Destination prerequisite parity with registered MOVE

Parent `2b7a87e`. Actual baseline `destination-prerequisite-baseline.json`: **5 failures/1 open-route control, 5.051s**. The shared destination predicate previously accepted routes whose flags were false, closed destinations, unknown route endpoints and closed transit nodes; registered MOVE refused all four. A route-dependent Freeform action also continued after a time hook closed its only route.

The prerequisite predicate now filters edges by existing flag conditions, known player endpoints and closed-place lifecycle, and rejects a closed destination. Existing same-location and implicit parent-child transitions remain. No route, terrain permission or location is invented. This changes prerequisite/choice evaluation, not MOVE execution or Core commit semantics. Unknown names outside the public map retain conditional exploration semantics; their text does not promise a known route.

Actual `.agent-runtime/codex/` evidence:

- `destination-prerequisite-fixed.json`: 4 files, 30 passed/25 fetch failures, 14.975s. All failures are the existing action-capability-routing HTTP file under sandbox loopback restrictions.
- `destination-prerequisite-http-recheck.json`: only affected HTTP file rerun with ephemeral-loopback permission, 25/25 passed, zero skips, 11.389s. The original failure report remains.
- `destination-prerequisite-expanded.json`: 3 files, **47/47 passed**, zero skips, **8.870s**, including nine direct parity cases: valid alternative route, implicit hierarchy and actual JsonStore/service recreation refusal with unchanged bytes/state and no Narrator/live generation.
- Strict TypeScript exit 0, **48.420s**, `destination-prerequisite-typecheck.json`.

Selected passing union: six files/96 distinct cases, not one complete suite/build. A8.3 remains unmet pending other dynamic object/capability breadth; 103/160 (64.375%), delta zero. Formal save/3100/frozen acceptance/original dirty work untouched.

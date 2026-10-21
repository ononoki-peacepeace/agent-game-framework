# Freeform prerequisites after world-time hooks

Parent `f350814`. Only physical actions previously rechecked prerequisites after time advancement. Actual EventBus time-hook fixtures demonstrate that playing a newly destroyed/moved instrument still produced an activity result and picking up an item pulled it back from a remote location. These are canonical mutations inside the real isolated action lifecycle; no model or production state is involved.

Baseline `freeform-time-prerequisites-baseline.json`: 3 failures/1 control, 4.331s. The pickup fixture initially omitted required `position_label`, so it failed before reaching its hook; this report is retained. Correcting that fixture produced **3 actual failures/1 control, 4.497s**, in `freeform-time-prerequisites-baseline-valid.json`.

All Freeform attempts now re-evaluate existing world prerequisites and environmental activity availability after time hooks, before action-result RNG and effects. Physical actions retain their existing live check preparation. An invalid candidate raises the existing WorldBlockedError and the original save remains unchanged; this does not commit the simulated time or hook mutations. No schema, service API or commit protocol changes.

Verification in `.agent-runtime/codex/`:

- `freeform-time-prerequisites-fixed.json`: 3 files, 30/30 passed, 9.043s.
- `freeform-time-prerequisites-expanded.json`: 4 files, 38 passed/4 HTTP fetch failures, 18.326s. All seven new tests passed, including sealed ancestry, NPC departure and real JsonStore/service recreation with byte equality, zero narration and no live generation.
- `freeform-time-http-permission-recheck.json`: only four affected ephemeral-loopback HTTP tests rerun with permission, 4 passed/11 excluded, 7.985s. Original failures retained.
- `freeform-time-physical-adjacent.json`: 3 files, 51/51 passed, 9.728s, covering physical, character capability and storage behavior.
- Initial strict TypeScript: exit 2, 52.097s; new test lacked explicit EventBus `this` and Inventory types. Test annotations corrected without product/assertion changes. Final strict TypeScript: exit 0, 54.467s (`freeform-time-typecheck-final.json`).
- Final direct test after annotations: 7/7 passed, 8.030s (`freeform-time-prerequisites-final.json`).

Selected passing union: nine files/119 distinct cases across reports, not one complete green run. No full build/suite rerun. A8.3 remains unmet pending the broader dynamic body, terrain, capability and multi-world matrix. Fixed acceptance stays 103/160 (64.375%), delta zero. Formal save/3100/frozen acceptance/paid providers remain untouched.

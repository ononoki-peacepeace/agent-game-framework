# Settlement-time Freeform check facts

Parent `cd51062`. Actual baseline `freeform-live-check-baseline.json` has **3 failures/1 control, 4.267s**. Nonphysical checks prepare capability modifiers and evidence candidates before time hooks but previously retained that snapshot at settlement. Fatigue 20→19 incorrectly retained modifier 0; recovery 19→20 retained -2. A perception action discovered evidence whose authoritative placement had moved to another location in the time hook. The unchanged reachable-evidence control passes.

These use the real EventBus/action/resolveCheck lifecycle and synthetic authority changes, with no model. N4.1 is withdrawn from met to unmet because the resulting discovery and facts allow inaccessible evidence into public narration. A8.3 already remains unmet. Temporary progress: 102/160 (63.75%), -1/-0.625 percentage points. Further repair verification will be appended here; no pass is claimed yet.

Repair: all Freeform checks are now prepared again from the isolated settlement state after prerequisite revalidation, extending the existing physical-action behavior. This reads current ability, fatigue and eligible evidence without adding RNG, time, costs or retries. Exact original preflight validation remains. No public schema, API or Core commit change.

Actual reports under `.agent-runtime/codex/`:

- `freeform-live-check-fixed.json`: 5 files, 47/47 passed, zero skips, 13.883s (original four cases plus time prerequisite, capability, evidence lifecycle/access regressions).
- `freeform-live-check-resolution.json`: 3 files, 43/43 passed, zero skips, 10.536s, including a positive newly accessible evidence case and existing resolution profiles/stages.
- `freeform-live-check-disk-final.json`: expanded six direct cases, 6/6 passed, 5.473s. Actual JsonStore/service recreation preserves exact committed bytes/response and one observation interval/check, with no replay generation. Inaccessible evidence is absent from public facts and degraded narration; no live Provider calls.
- Initial strict TypeScript failed, exit 2, 48.210s: synthetic location JSONType and optional public known-evidence fields required explicit narrowing. Fixed test annotations/optional defaults only. Final strict TypeScript exit 0, 51.222s (`freeform-live-check-typecheck-final.json`). Final six direct cases after typing: 6/6 passed, 8.452s (`freeform-live-check-typed-final.json`).

Passing union: seven files/87 distinct cases across reports, not a current complete full-suite/build result. N4.1 restored only after this verification: 103/160 (64.375%), +1 from temporary withdrawal, net zero from parent. A8.3's broader matrix remains unmet. Original failure reports and fixed160 criteria remain intact.

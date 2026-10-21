# Environmental hazard source at settlement

Parent `a1eff81`. Two actual source-invalidating time-hook cases (5.046s) show stale preflight hazard authority: a local place no longer describes the source, or the source entity moves elsewhere, but Freeform still executes the hazard attempt. Expanded positive controls initially failed only a dice-count assertion because the fixture's default uses multiple dice (4.807s); the fixture now explicitly selects classic_d20. All reports remain under `.agent-runtime/codex/freeform-live-hazard-*`.

A8.2 is withdrawn pending live-source repair/verification: 102/160 (63.75%). No full-condition or passing-result claim is made yet.

The corrected classic_d20 baseline has **2 failures/2 valid-source controls, 4.389s** (`freeform-live-hazard-d20-baseline.json`). The source validator now reads the current actor location and current public entity/place description both at preflight and after time hooks. A source that disappears or moves away raises WorldBlockedError before contact/injury RNG. Unknown-source independent-contact behavior remains on the existing blocked-injury-stage path; no hazard is invented from input.

Actual verification: `freeform-live-hazard-fixed.json` **4 files/33 passed**, zero skips, **10.423s**; expanded `freeform-live-hazard-disk.json` **5/5 passed, 5.252s**. Real JsonStore/service recreation verifies repeated refusal leaves original bytes, time, HP and receipts unchanged and invokes no Narrator/live Provider. Positive controls retain ordered successful physical settlement and four d20 RNG calls. Selected union: four files/34 distinct cases. Final strict TypeScript exit 0, **42.264s** (`freeform-live-hazard-typecheck.json`). No full build/suite claim.

A8.2 restored after verification: 103/160 (64.375%), +1 from withdrawal/net zero from parent. A8.3 broader dynamic terrain/capability/object acceptance remains open. Frozen criteria, original dirty work, formal save, 3100 and other checkout remain unchanged.

# Actor availability after time hooks

Parent `eb550f6`. Actual baseline: **2 failures/2 HP=1 controls, 4.303s**, `freeform-live-actor-baseline.json`. Both an ordinary activity and a physical strike continue after a canonical time hook lowers the actor's HP to zero. The preflight HP guard reads the original state only. A8.2 is withdrawn from met to unmet: 102/160 (63.75%), -1/-0.625 percentage points. The paired tests require refusal before action RNG with the original save unchanged; verification is pending.

The action now repeats its existing actor-existence/positive-HP precondition against the isolated state after time advancement. Invalid candidates throw WorldBlockedError before result RNG, receipts or effects. Initial validation and HP=1 valid behavior remain; no new body threshold, schema, API or commit semantics.

Reports in `.agent-runtime/codex/`: `freeform-live-actor-fixed.json` has **6 files/72 passed**, zero skips, **21.701s**. It covers physical scenes, ability, repetition, live evidence and resource prerequisites. Expanded direct test `freeform-live-actor-disk.json` has **5/5 passed, 7.615s**, including actual JsonStore/service recreation with unchanged original bytes/state, zero narration and no live generation. Passing union: six files/73 distinct cases, not one complete green full-suite run.

First strict TypeScript exit 0, 55.652s, preceded the disk-test addition. Final strict on the expanded file: exit 0, **47.738s**, `freeform-live-actor-typecheck-final.json`. No full build rerun. A8.2 restored after verification: 103/160 (64.375%), +1 from withdrawal, net zero from parent; A8.3 remains unmet. Formal save, frozen criteria, original dirty work, 3100 and other checkout untouched.

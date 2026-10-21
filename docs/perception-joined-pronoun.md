# Joined pronoun subjects retain event-time perception authority

Parent `c6c7449`. Reproduction uses a real Core physical action and its sight-blocked receipt, with offline deterministic dice. `perception-joined-pronoun-baseline.json` records **4 failures / 4 passing controls, 3.439s**. “林舟只听到了声音。随后他和乔宁都看清了动作。” loses 林舟 from the joined subject because only 乔宁 is explicitly named. Both sentence and comma continuations escape the receipt guard. No source correction was present in this baseline.

N4.1 is withdrawn pending focused repair; N4.3 remains unmet. Raw reports stay in `.agent-runtime/codex/`. Do not exempt all quoted perception statements: typed speech from a sightless speaker must remain constrained by its receipt. This batch changes presentation validation only, with no authority to invent NPC reactions or world results.

The repair substitutes a uniquely established prior subject only at a leading joined pronoun, optionally after one existing temporal connective. The existing literal joint-subject validator then checks every member against the receipt. Negative claims, a separately named sighted observer and player clauses retain their original handling. Typed sightless own-speech claims remain rejected.

Verification reports:

- `perception-joined-pronoun-first-fix.json`: three files / 28 passed, **8.081s**.
- `perception-joined-pronoun-expanded.json`: four files / 33 passed, three failures, **15.625s**. One is the recurring sandbox HTTP fetch failure; two are test expectations incorrectly requiring the direct `GameService.turn` first-call transient notices on a reconstructed `publicView`. The verbose single-case diagnostic is retained in `perception-joined-pronoun-replay-diff.log`. This is not evidence of exact direct response replay.
- `perception-joined-pronoun-final-direct.json`: all 12 direct/service cases passed, **5.563s**. Both synthetic JsonStore/new-service physical cases verify one Core call, one minute, one revision, one receipt/check, three bounded Narrator attempts, no invented NPC speech, exact committed disk bytes and unchanged generation count on replay. They compare the replay to the saved public projection exactly and separately assert the first-call transient notice difference. No production save or live Provider is used.
- Only the affected HTTP file is rerun with local loopback access: `perception-joined-pronoun-http-permitted.json`, one passed, **5.875s**. It retains actual authoritative NPC speech and physical continuity checks.
- Final strict root TypeScript: exit 0, **41.932s** (`perception-joined-pronoun-typecheck-final.json`); earlier pre-final strict 35.321s is preserved.

Selected passing union: **six files / 56 distinct tests**, not one complete suite or build. N4.1 restored to 103/160 (64.375%), +1 from withdrawal / zero net change from parent. N4.3 stays unmet. No schema/API/Core commit semantics or service implementation changes. Next: continue fixed acceptance gaps, including the analogous temporal joined-pronoun scene-presence boundary.

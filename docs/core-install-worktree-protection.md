# Failed core installation preserves the checkout

Baseline `546a5ff` plus the preserved diagnostic WIP unconditionally called `restoreBase` even when admission rejected an already dirty repository. That helper ran `reset --hard` at the candidate base. Five actual temporary-repository cases failed in 12.307s: existing staged/unstaged tracked edits, and candidate-path/other-path/index writes during a failing build. Production checkout was never passed to the installer in these tests.

The failure handler now retains HEAD, index, worktree and candidate artifacts. It never resets, reverses the uncommitted patch, or automatically reverts a commit on this path. Its original stage/exit/output diagnostics remain intact. A failure before or after apply is a safe stop requiring inspection; it is not proof that installation had no effect. DevelopmentTask wording and durable restart evidence reflect this. Explicit rollback of a known clean installed revision remains the existing guarded auditable revert.

Validation:

- First correction: 3 files / 9 passed, zero skips, 41.279s.
- Expanded run: 13 cases / 10 passed / 3 fixture failures, 40.264s. Two synthetic task plans had only one milestone and did not enter core approval; one exact byte expectation assumed LF despite inherited Git autocrlf. The fixture now supplies two milestones and sets local `core.autocrlf=false` only in its temp repository. Original failure report retained.
- Only affected cases rerun: 3 passed, 8 excluded by explicit name filter. Together with the expanded run's passing cases this establishes all 13 selected cases; it is not a single all-green expanded run. Includes actual commit-response loss, failed build without external writes, dirty/build task persistence and fresh DevelopmentTasks recreation without reexecution.
- Strict root `tsc --noEmit`: exit 0, 43.537s on final product source (subsequent edits only correct fixture data).
- Earlier preserved diagnostic WIP: 8 files / 55 passed / zero skips, 103.634s. Earlier real local self-extension: 1 passed, 77.621s; observed nested Framework build 62.87s. Neither was rerun for this failure-handler-only change. No current complete offline snapshot claim.

Reports: `.agent-runtime/codex/core-install-worktree-protection-{baseline,fixed,expanded}.json`, `core-protection-fixture-correction.json`, `core-protection-typecheck.json`; earlier reports remain under the ignored `official-resume-2026-10-21` checkpoint directory.

R7.1 diagnostic coverage can be restored using the prior complete affected diagnostic matrix plus current install/runtime/restart checks and strict compilation. R7.3 remains open: next inspect late writes during a successful build before Git commit, then complete the original bounded side-effect matrix. R7.4 process-kill/restart acceptance remains separate. No schema/Core save/3100/frozen protocol/paid-provider change.

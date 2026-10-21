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

## Validated candidate Git tree and final ownership

The next temporary-repository batch reproduced three passing-build failures (3 failed / 7 excluded, 8.289s): a changed worktree/index was still committed, and an externally advanced HEAD lacked the precise ownership refusal. A fourth pre-capture index replacement also passed as a candidate (1 failed / 12 excluded, 3.783s). Both original reports are retained.

Installation now pins the immutable candidate tree and compares its full binary diff with the prepared, hashed patch. After build it checks original HEAD, tree, unstaged changes and path inventory. Git `commit-tree` creates a commit for that exact tree, and `update-ref HEAD <candidate> <base>` updates the branch only while the base still matches. These operations do not check out files or rewrite the index. A late staged writer's bytes cannot enter the candidate commit; its local edits remain and prevent runtime registration. A late HEAD writer wins the compare-and-swap and installation stops. Temporary-repository tests inject writes at both sides of the final check, before tree capture, and after actual HEAD update with lost response. No destructive Git command runs on the live development checkout.

This changes managed installation's Git implementation: explicit Framework gates validate the candidate; Git commit hooks are not invoked by `commit-tree`. Normal commits still have the Framework identity, original parent, candidate message and reflog entry; explicit rollback remains an auditable guarded revert. No game Core commit semantics, required schema or wire contract changed. An interrupted operation can leave a candidate commit object or a real installed HEAD without an acknowledged record; the failure retains artifacts and stops for inspection.

Final current-product evidence:

- 4 files / **22 passed**, zero skips, **88.235s**: installer normal/rollback/reload, 13 protection cases, diagnostics, durable task stops.
- Adjacent 4 files / **26 passed, 4 failed**, 11.923s. Failures were local Git `sh.exe` named-object access denied and directory junction `EPERM` under the sandbox; no source change was made. Only those 4 were rerun with the necessary local subprocess/junction permissions: **4 passed**, 4 excluded, **4.280s Vitest duration / 5.908s command wall time**. Original failed report retained.
- Selected passing union: **8 files / 52 distinct cases**, all 12 original side-effect rows matched by exact test file/name. This is assembled from three reports, not a single all-green run. Twelve affected source/test hashes match. Strict `tsc --noEmit`: exit 0, **40.045s**. Current reports: `core-install-ownership-final.json`, `development-ownership-adjacent.json`, `development-ownership-permission-recheck.json`, `development-ownership-matrix-audit.json`, `core-ownership-typecheck.json` under `.agent-runtime/codex/`.

The original R7.3 classes—workspace creation, partial file writes, build outputs, approval/install and registration—now each have explicit before/after identity and verified recovery or safe stop. R7.3 can close for this bounded offline scope. Process-kill/restart acceptance remains R7.4 and receives no credit here. Earlier actual capability self-extension/nested build evidence remains historical; no unnecessary full build or full framework snapshot was repeated.

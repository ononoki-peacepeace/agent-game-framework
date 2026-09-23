# Public release preparation · v0.1.7

Verified on 2026-09-23, Windows, Node.js 24.15.0 / npm 11.12.1.

## Scope

Publication preparation only. Core gameplay, provider implementations, schema versions and save compatibility were retained. Changes are public documentation, ignore rules, safe environment example, audit tooling, generic UI wording, stale test/smoke fixtures, and one trailing-space cleanup.

## Executed checks

| Check | Result |
|---|---|
| Working-tree typecheck | PASS |
| Offline tests | PASS: 43 tests across 3 files |
| Production frontend/server build | PASS |
| Mock HTTP demo smoke | PASS: actions, health, export/import, checkpoint and real process restart |
| Desktop browser smoke | PASS: public-world import, movement, trade, conversation, refresh and saves |
| Clean public-only copy: npm ci | PASS |
| Clean public-only copy: npm install | PASS |
| Clean public-only copy: typecheck/tests/build/smoke | PASS: 43 tests; no private files copied |
| Clean public-only copy: npm start | PASS |
| Started service /api/health | PASS: ok=true, version=0.1.7 |
| Started service web route | PASS: HTTP 200 |
| Public file / Git object heuristic audit | PASS: no findings |
| Staged diff whitespace check | PASS |
| Read-only existing-save compatibility check | PASS: four local saves validated, bytes unchanged during check |
| Live AI provider requests | NOT RUN for this publication task |

The initial baseline had two stale tests: the authoring fixture had only three locations while the current AI schema requires at least four; the disk-failure test activated before the existing routine upgrade completed. Fixtures were corrected without weakening current schemas or changing mechanics.

The optional browser script was updated to match the existing launcher/composer. It checks desktop only; no mobile development was performed. The public screenshot was generated from the bundled fictional example with Mock, not from a personal game.

## Privacy / Git evidence

Before staging, the index, commit history and object database were empty. There was no retained evidence of previous private-file staging or commits.

Personal saves, migration inputs, profile imports, uploaded avatars, local overlay instructions, logs and smoke output remain local and ignored. They were not deleted and are not in the public staged baseline. The public example's GM notes are authored fictional test data, including the isolation-test canary.

Audit patterns cover common credential formats, private-key headers, credential-bearing URLs, home-directory paths and prohibited runtime paths. Manual review also covered public documents, generic content and the screenshot. This does not prove the absence of every possible secret or vulnerability.

## Outstanding publication gates

- **License has not been selected.** No LICENSE was added.
- **Git author name/email are unset.** Reviewed public files are staged; no commit was fabricated.
- **GitHub CLI is not installed.** No GitHub login could be checked.
- **No public repository was created and no push was executed.**
- Repository creation and push require the owner's explicit confirmation.

Do not announce this as an open-source release until a license is chosen.

## Next steps after owner decisions

1. Choose and add a license.
2. Configure the intended author for this repository only; do not change global Git config.
3. Re-run public audit, inspect staged files and create the baseline:
   `git commit -m "release: prepare Agent Game Framework for public GitHub release"`
4. Install/authenticate GitHub CLI if using it.
5. Only after explicit publication approval, run:
   `gh repo create agent-game-framework --public --source=. --remote=origin --push`

If Git reports ownership mismatch for this existing workspace, use a command-scoped `-c safe.directory=<absolute-repository-path>` after confirming the directory is yours; no global exception was written during preparation. A normal fresh clone owned by its user does not need that exception.

Repository name/description/topics and release text are in [RELEASE_NOTES.md](RELEASE_NOTES.md).

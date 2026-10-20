# Parallel development agreement

Read `docs/parallel-development.md` before working in either checkout.

- Codex works in `D:\game`: (1) end-to-end reliability and (2) natural-language actions.
- Claude Code works in `D:\game-claude`: (3) autonomous NPCs and a persistent world and (4) natural Narrator prose.
- Never discard another agent's edits. Do not use reset --hard, clean, force checkout or force push.
- Never write `D:\game\data\current.json`, deploy, or start/restart port 3100 without explicit human authorization. Do not copy production saves or credentials into the parallel checkout.
- Use `node scripts/agent-workspace.mjs <codex|claude> <check|test|build|server|client>` for isolated development. Server/client modes are manual only; tests/builds do not start them. Use offline providers unless the user explicitly authorizes paid calls.
- Shared schemas/contracts, Core commit semantics and service boundaries require additive compatible changes and documented dependencies. Neither agent may silently assume the other's unmerged interfaces exist.
- Keep changes on your own branch; integration and conflict resolution happen in Codex's checkout after review. Claude never modifies the Codex checkout or its branch.
- Before stopping, save a local checkpoint commit of reviewed source only, plus `CLAUDE-HANDOFF.md` with branch/commit, status, unfinished changes, tests and interface dependencies. Never include data, secrets, logs or caches. Uncommitted changes remain recoverable in the worktree; do not remove it.
- Do not launch another development agent or consume another agent's model quota automatically. The human starts Claude Code separately.

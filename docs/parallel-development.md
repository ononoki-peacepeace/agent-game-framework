# Codex / Claude Code parallel development

2026-10-20 takeover: Claude quota is exhausted. The user's later instruction transfers all four themes to Codex. Current integration branch is `codex/claude-takeover-integration` in `D:\game`; `D:\game-claude` and its dirty interruption state are preserved. See `docs/claude-takeover-integration.md` for commit provenance, public policy additions and remaining dependencies. The ownership table below describes the earlier parallel phase.

Common base: the local WIP checkpoint commit that first adds this document (the exact hash and per-file manifest are in the local `parallel-workspaces` handoff record). It includes the reviewed current `src/`, tests, build configuration and reliability audit scripts, including the latest public Schema. Existing generated QA JSON, private save/checkpoint directories, credentials, runtime logs, node_modules and dist are excluded from that checkpoint. No remote push is part of setup.

| Owner | Checkout | Branch | Responsibility | HTTP / Vite |
|---|---|---|---|---|
| Codex | `D:\game` | `codex/integrated-world-human-qa-snapshot` | Reliability and natural-language actions | 3111 / 5181 |
| Claude Code | `D:\game-claude` | `claude/npc-world-narrator` | Autonomous NPCs, persistent world and Narrator prose | 3112 / 5182 |

Start Claude Code from `D:\game-claude`. Read `AGENTS.md`, this agreement and `CLAUDE-HANDOFF.md`. This setup does not launch Claude or call a model.

Run `node scripts/agent-workspace.mjs claude check` in Claude's checkout, or use the `codex` profile in Codex's checkout. `test [test paths/options]` and `build` run with checkout-local data, logs and temporary directories under `.agent-runtime/<owner>/`. Dependencies are separate physical copies, not a shared junction. Test-generated docs/build output remain in the owner's checkout. Tests that create temporary HTTP listeners use OS-assigned ports; do not hard-code another agent's port. Do not use production smoke scripts whose defaults target 3100. For manual local servers, `server` uses the offline mock provider and the owner's HTTP port; `client` uses its matching Vite proxy/port. Neither starts during workspace preparation.

Do not copy `.env`, provider configuration, formal saves, uploads, history or `.codex` into Claude's checkout. The process environment is not a portable credential handoff. Using the isolated wrapper selects an empty development data directory and mock adapter. Real paid provider calls still require human authorization.

## Public interfaces and ownership

Both agents start with the same current Core/AI/Agent/shared schemas and source. No known unmerged interface is needed to compile this base. Remaining product behavior is unfinished; successful build is not full acceptance. Codex owns `src/agent/executor.ts`, Semantic/Goal/Binding/Planner changes, `src/recovery/`, storage and request transaction behavior. Claude owns NPC planning/personality/background behavior and Narrator style/continuity. Likely shared files include `src/core/schema.ts`, `src/ai/contracts.ts`, `src/ai/runtime.ts`, `src/server/service.ts`, `src/agent/contracts.ts` and NPC call sites. Prefer separate modules, optional fields and focused tests. Record shared-file changes and their dependency commits in the handoff before integration; preserve receipt, revision, budget, cancellation, perception and factual validation semantics.

## Integration and takeover

Claude makes small local commits on `claude/npc-world-narrator`, never pushes, merges into Codex, or edits `D:\game`. Record commit IDs, changed public interfaces, validation and unfinished work in `CLAUDE-HANDOFF.md`. Do not hide unfinished edits with stash. At quota exhaustion leave the worktree and branch intact; a fresh handoff commit is preferable when files have been reviewed for privacy.

Codex can read the branch directly because both worktrees share one Git object database. Before takeover inspect `git -C D:\game-claude status --short` and the handoff; do not switch or remove Claude's worktree while it has changes. Review `git diff <common-base>...claude/npc-world-narrator`, then cherry-pick selected Claude commits into a clean checkpoint on the Codex branch, resolve conflicts in Codex, and run both owners' affected tests. For unpublished unfinished work, make a reviewed checkpoint commit in Claude's worktree first; never overwrite those edits with a branch checkout. Integration is explicit and does not happen automatically during setup.

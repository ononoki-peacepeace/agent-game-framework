# Claude Code starting handoff

Status: parallel workspace prepared from the reviewed latest local source baseline. Exact baseline hash, synced-file hashes and setup validation are recorded locally under `D:\game\.codex-checkpoints\framework-reliability-handoff\parallel-workspaces\` and copied into Claude's ignored `.agent-runtime/claude/handoff/` directory after setup.

Work only in `D:\game-claude` on `claude/npc-world-narrator`. Responsibilities: (3) autonomous NPCs and persistent world; (4) natural Narrator prose. Read `AGENTS.md` and `docs/parallel-development.md` first.

The base includes prior NPC plans, time-credit continuity, transient perception/body state, factual narration guards and request/background recovery changes. Preserve those safeguards. Remaining priorities include NPC autonomy/relationships/long-running events and natural, distinct Narrator/NPC prose without invented canonical facts. Do not weaken validation to improve prose or re-execute settled actions for presentation failures.

No formal data or credentials are supplied. Use `node scripts/agent-workspace.mjs claude test ...` and `... build`. Do not call paid coding/game/image providers, deploy, or start port 3100 without human authorization. No Claude model has been launched by this setup.

Before quota exhaustion update this file with completed commits, changed public interfaces, remaining work, exact test results and any uncommitted files. Keep the worktree intact so Codex can take over.

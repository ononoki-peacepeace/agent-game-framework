# Claude Code workspace instructions

Read `AGENTS.md`, `docs/parallel-development.md` and `CLAUDE-HANDOFF.md` before doing any work.

Use `D:\game-claude` on `claude/npc-world-narrator`. If started in `D:\game`, stop before editing and move to the Claude checkout. Codex owns that other checkout and its branch.

The independent workspace is prepared, but do not begin product development until the human supplies the formal development assignment. Do not launch another model, deploy or start any server automatically.

Run isolated checks with `node scripts/agent-workspace.mjs claude check`, tests with `... claude test <paths/options>`, and builds with `... claude build`. These use offline adapters and Claude-only data/log/temp directories. Never touch the formal save or port 3100.

Keep your branch, worktree and unfinished edits recoverable. Update `CLAUDE-HANDOFF.md` with commit IDs, public interface changes, tests, known failures and remaining work before stopping or running out of quota. Never add private runtime files or credentials to Git.

# Claude Code starting handoff

Status: parallel workspace prepared from the reviewed latest local source baseline. Exact baseline hash, synced-file hashes and setup validation are recorded locally under `D:\game\.codex-checkpoints\framework-reliability-handoff\parallel-workspaces\` and copied into Claude's ignored `.agent-runtime/claude/handoff/` directory after setup.

Work only in `D:\game-claude` on `claude/npc-world-narrator`. Responsibilities: (3) autonomous NPCs and persistent world; (4) natural Narrator prose. Read `AGENTS.md` and `docs/parallel-development.md` first.

The base includes prior NPC plans, time-credit continuity, transient perception/body state, factual narration guards and request/background recovery changes. Preserve those safeguards. Remaining priorities include NPC autonomy/relationships/long-running events and natural, distinct Narrator/NPC prose without invented canonical facts. Do not weaken validation to improve prose or re-execute settled actions for presentation failures.

No formal data or credentials are supplied. Use `node scripts/agent-workspace.mjs claude test ...` and `... build`. Do not call paid coding/game/image providers, deploy, or start port 3100 without human authorization. No Claude model has been launched by this setup.

Before quota exhaustion update this file with completed commits, changed public interfaces, remaining work, exact test results and any uncommitted files. Keep the worktree intact so Codex can take over.

## Codex reliability checkpoints after the shared base

Codex remains active in `D:\game` on `codex/integrated-world-human-qa-snapshot`.
The shared base and Claude checkout are unchanged by these Codex-only commits:

- `0d8752b01369a256908273d62fba3835db9dc2b8`: durable extension candidate/task
  installation identity, authoritative receipt recovery and callback replay guards.
  Full offline snapshot: 170 files / 1705 tests passed; build passed.
- `40f1d92d5315f366eed80296550022901c69e140`: propagate System module and session
  exceptions to existing HTTP receipt recovery. Subsequent tests: 2 files / 37
  tests and broader System 6 files / 54 tests passed (overlapping reports);
  TypeScript passed. The full suite above precedes this second commit.
- `d78015d4eb43a2653a2315ae0b72dc57273339b5`: optional calendar request UUID,
  existing Core receipt and parent prepare, with UI/HTTP forwarding. Calendar,
  routine and continuity regression: 4 files / 58 tests passed; input/calendar
  regression: 2 files / 38 tests passed (overlapping). Build and latest TypeScript
  passed. No latest combined full-suite run is claimed.

Public dependencies: the optional `DevelopmentTask.extension_install` field and
`ExtensionDevelopment.recoverInstallation` method must be integrated together.
No Core/Save Schema change or new receipt protocol is required. Existing Claude
work can continue from the shared base without these commits. See
`docs/extension-install-recovery.md` and `docs/system-error-recovery.md` after
reviewed integration; do not silently assume these Codex-only methods exist.
Calendar's optional fourth `configureCalendar` parameter and optional HTTP
`request_id` are compatible with older callers; those older callers cannot
identify duplicate submissions. Integrate service, route and UI changes together.
See `docs/calendar-request-recovery.md` for remaining migration/receipt limits.

Remaining Codex work includes configuration request identity, migration/history
boundaries, further workspace failures and natural-language goal dependencies.
No new Claude work is reviewed or taken over by this record. Original QA JSON
and audit notes remain uncommitted in Codex; generated evidence, private runtime
and formal saves are excluded from commits. No push or deployment occurred.
Overall four-theme estimate remains about 45%; this is not an acceptance rate.

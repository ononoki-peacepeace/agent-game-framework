# Local position anchors at settlement

Parent `faea6e4`. Initial actual baseline: one moved-anchor failure/one stationary control, 4.530s. Expanded baseline: **2 failures/2 controls, 4.243s**. Non-item entity movement and an existing environment record changing to absent during a time hook both left a stale preflight destination, so the action still wrote a position beside an unavailable anchor.

Before setting a prebound destination, Freeform now resolves it again in the isolated settlement state. A changed/missing anchor raises the existing WorldBlockedError before action-result RNG/effects. New local-scene adjudication retains its existing separate path. No schema/API/Core commit changes.

Actual `.agent-runtime/codex/` reports:

- `freeform-live-anchor-fixed.json`: 4 files, 53 passed/1 temporary HTTP fetch failure, 15.077s. Covers existing materialization, public/private local anchors, capabilities and time prerequisites.
- `freeform-live-anchor-http-recheck.json`: only affected ephemeral-loopback test rerun with permission, 1 passed/9 excluded, 5.729s. Original failure retained.
- `freeform-live-anchor-disk.json`: expanded 5/5 direct cases passed, 6.962s; actual JsonStore/service recreation refuses the stale position, keeps original file bytes/state, zero narration/live generation.
- Strict TypeScript on expanded final source: exit 0, 47.785s (`freeform-live-anchor-typecheck.json`).

Passing union: four files/55 distinct cases across reports, not a new complete suite/build. A8.3 remains unmet: broader body, distance, terrain, capabilities and multi-world acceptance remains open. Fixed progress 103/160 (64.375%), delta zero; formal save, 3100, frozen acceptance and original dirty files unchanged.

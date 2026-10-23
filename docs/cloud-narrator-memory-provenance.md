# Narrator memory provenance continuation

Remote main remains `7cd0c8a`. The preceding concrete-outcomes branch now has a
GitHub PR #8 head at `dc18a7209e53ff1ac166a8bdebb500a1db2ed691`; the head is not
in main. GitHub API reads still return Forbidden. This independent branch,
`codex/cloud-narrator-memory-provenance`, is explicitly stacked on that PR #8
head and should target `codex/cloud-narrator-concrete-outcomes`. No delivered
branch is overwritten. PR #3–#7 remain Windows' integration responsibility.

## Reproduced defects and product change

The bounded Narrator cognition projection retained only kind, summary and time.
It lost the canonical memory's event reference and participants. Its salient-plus-
latest-two rule could exclude the older interaction with the player after unrelated
recent events. When a clarification displaced an older promise, neither the
clarification nor its participant attribution was reliably available to narration.

Nine fixed positive/negative cases across the existing commerce, relationships
and autonomy worlds fail before the change: six lose the player-related memory,
three retain the expected unrelated memories but lose their provenance. The
unchanged world setup witnesses and full synthetic states are retained.
A separate valid imported memory-array counterexample shows reversed event order;
its focused baseline fails once (other tests intentionally filtered, not passed).

The first checkpoint `e5cde57` passed 13 files / 102 tests and strict build.
Further investigation exposed another real loss: a low-importance player greeting
(or a later clarification) displaces an older important player promise when an
unrelated event has the highest importance. Both fixed inputs fail before the
second change: expected `major, promise, latest`, actual `major, latest, ordinary`.
The two failed runs and original states remain in `memory-priority-baseline.json`
and `memory-priority-before/`; ten other cases were filtered, not passed.

Only `src/narrative/character-cognition.ts` changes product behavior:
- Keep the most important event overall, the most important player-participation
  event and the latest player-participation event. Deduplicate, then fill remaining
  slots with recent other events, still at most three.
- Order by recorded day/minute on a copy, with stable insertion order for ties.
  Do not infer relevance from words or matching names in summaries.
- Preserve event_ref, participant_ids and at, explicitly mark historical records.
- State that participant sets identify neither speaker nor promise recipient;
  memories are not world truth and a recorded promise is not proof of fulfilment.

No canonical memories, importance scores, NPC goals/decisions, relationships,
body state, time or inventory are modified. This is a context selection/provenance
fix; it is not a new memory or settlement system. The original salient/latest
controls without player relevance still pass unchanged.

## Verification scope

New service cases cover all three structural worlds, ordinary authored narration
and genuine offline Provider refusal. They commit through actual JsonStore and
GameService, retain original memory records, check one minute/revision and committed
receipt, recreate both service and store, replay the same request, and compare
exact saved bytes and generation counts. Context-only fixtures are not evidence
of generated personality or independently rated prose. No paid model calls.

Original reports and outputs are retained under ignored `.agent-runtime/codex/`
with prefixes `memory-`. Final pinned regression and build results follow below.
The older 72h program tests are adjacent regression, not newly invented long-model
quality evidence. No acceptance definition, denominator or formal score changes.

## Integration and remaining gates

Integrate PR #8 first, then this delta. The only product conflict surface is the
memory selection/projection in `src/narrative/character-cognition.ts`. Preserve
PR #8's directional relationship prioritization and all PR #2 perception/history
boundaries. The additive prompt fields have no persisted schema dependency.

N5.3/N7.3 gain bounded input evidence; generated personality, recalling or revising
promises in actual prose still needs the frozen quality review. N5.4/N7.4 and
N9.3/N9.4 are not satisfied by these tests. N8/N3 prior results remain on PR #8;
consumption remains on earlier independent branches. No condition is closed here.

## Recovered final verification, 2026-10-23 UTC

The original worktree, both checkpoints and ignored raw evidence survived the
cloud disconnection. HEAD/source `1f09f2831b6658e1978b9c1a96b8313c4260306c` was
clean on recovery. The interrupted client did not interrupt the jobs: retained
final reports show 13 files / 104 passed / 0 failed / 0 skipped, and build exit 0
(root strict TypeScript, Vite frontend and server TypeScript). All 659 pinned
input hashes still match. No redundant rerun was required. Existing Rollup
annotation/chunk-size warnings remain; no type or build failure occurred.

Archive: `/workspace/scratch/narrator-memory-provenance-1f09f28.zip`, 2,865,337
bytes; SHA-256 `5d483ca5a2bfb9f665fa6092177717cec507efc4bc59a339e22c02b4278fc6cc`.
It contains original failures, repaired outputs, both stage reports, final source
manifest, tested public source and delta patch. It contains synthetic fixtures,
not formal saves or credentials. ZIP integrity checked. Archive handoff reflects
the tested checkpoint; this recovery addendum follows it.

Remote main `7cd0c8a` and PR #8 head/base branch `dc18a72` remain unchanged.
PR metadata read still returns GraphQL Forbidden; the observed head is not in
main. The formal ledger check remains 109/160. Delivery targets PR #8's branch.

Delivery: branch pushed successfully at recovery checkpoint `1bd3783`.
`gh pr create --draft --base codex/cloud-narrator-concrete-outcomes --head
codex/cloud-narrator-memory-provenance` returned GraphQL Forbidden. No PR creation
is claimed. Manual comparison (select Draft when creating):
https://github.com/ononoki-peacepeace/agent-game-framework/compare/codex/cloud-narrator-concrete-outcomes...codex/cloud-narrator-memory-provenance?expand=1

# PR #3 independent cloud integration review

Review target: remote PR #3 at `7d6bafd3f7c6c1ef9bbe3f503a19d476818fc107`, latest fetched main `7cd0c8a4665831acc0b52faf646ddf9062b2d874`. This cloud workspace cannot inspect `D:\game` or its dirty Windows development branch. Do not describe the cloud merge probe as Windows integration or merge remote main on that basis. Preserve the original cloud checkout and all Windows edits.

The original PR merges into fetched main without a source conflict and already includes PR #1/#2. Isolated checkout `/workspace/review-pr3/game`, independent branch `codex/review-pr3-integration`. Dependencies installed from lockfile with separate physical node_modules. All commands use the isolated offline wrapper; no server/deployment/formal data/credentials/provider configuration was touched.

## Independently discovered defect

P2: `itemPossessionIssues` requires every canonical entity with the same display name to individually support the sentence. After Core gives the player one paper and Lin another paper with the identical name, both legal holding sentences are rejected. Two separate paper entities held by one actor also incorrectly reject the truthful quantity two. This is a real false rejection at the Narrator gate; three-world service checks show normal legal prose degraded to a generic summary. It blocks unconditional approval of the original PR and condition scoring.

Fixed inputs in `tests/pr3-item-name-possession.test.ts`: real Core pickup/transfer with two tracked paper IDs; player/NPC split ownership; quantity one/two/three and direct denial controls; earlier stage vs explicit current assertion; distinct inventory images that never contain both items; service INSPECT, retained exact prose, committed receipt/revision and fresh JsonStore replay with identical save bytes, response and zero extra generation. These are offline authored candidates, not model quality judgments.

Preserve raw baseline `.agent-runtime/codex/pr3-name-before.json` (six direct failures) and `pr3-name-before-complete.json` (all nine direct/service failures), full canonical input/output captures `pr3-name-split-*` and `pr3-name-service-*`. The source repair sums same-name item quantities within ONE actor and ONE settled state, then compares each legal event-time image separately. It never sums across time or actors, modifies Core, or permits a false count.

## Frozen condition review

| Condition | Independent disposition |
| --- | --- |
| N3.4 | Keep unmet: repeated attributed speech and poll race have actual committed evidence, but fixed prose review still fails rhythm/perception/naturalness. |
| N6.3 | Keep unmet: substantial container/environment/temporary/transfer evidence, but new same-name false rejection needs repaired verification. The protocol's consumption before/after matrix has only an unsupported-capability refusal, not a successful consumption lifecycle. Do not shrink it silently. |
| N6.4 | Keep unverified: committed three-world canonical state/reload/replay/later action evidence is useful and independently rerun; it is bounded, and the new actual false rejection precludes accepting the original matrix as complete. Review repairs and outstanding consumption evidence in Windows before uniform scoring. |

Frozen requirements, verification protocol and progress ledger are byte-identical to fetched main; score remains109/160 (68.125%). These condition dispositions are conservative review conclusions, not edits to frozen requirements or independent model/human sign-off.

## Review evidence and reproducibility

Original archive CRC verified, SHA256 `d447f88e8afd8fb22cc5323512cc02225fb348b55becb2942169c18e6b27d82b`. All568 manifest inputs match the fetched PR head. The original332 count is an effective union of complete-file reruns; it was not one full-suite invocation. Independently rerun the exact32-file inventory in one invocation before repairing the source, then run the complete affected inventory plus the review cases against the repaired source. Do not add overlapping counts.

Original PR independent run:32files332passed/0failed/0skipped,411.018s. New complete counterexample run:0passed/9failed/0skipped. Minimal repair targeted run (new9 + existing player6/NPC3):3files18passed/0failed/0skipped. Final affected run and strict build follow the source checkpoint; do not claim them complete yet.

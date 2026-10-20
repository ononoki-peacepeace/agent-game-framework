# Current offline verification snapshot — 2026-10-20

Fixed source checkpoint: `6ae2581` (product source `b4c018f`); later policy-design-only checkpoints do not change the tested source. Manifest: 190 distinct test files, 488 tracked source/test/build-configuration files pinned by SHA256. All source hashes matched after the final report. The exact manifest, commands, raw per-file results and failures are retained under the ignored takeover checkpoint directory.

| Run | Files | Tests | Passed | Failed |
|---|---:|---:|---:|---:|
| Shard 1 | 48 | 484 | 484 | 0 |
| Shard 2a | 24 | 224 | 224 | 0 |
| Shard 2b | 24 | 249 | 249 | 0 |
| Shard 3 | 47 | 502 | 502 | 0 |
| Shard 4 | 47 | 468 | 467 | 1 |
| Total | 190 | 1927 | 1926 | 1 |

Original shard 2 (48 files) exited `0xC0000409` without a JSON report. Cause is unestablished; it remains a failed attempt. The two replacement runs use its exact file list split in half. Final coverage audit found no missing or duplicated test file. Test/setup generation was offline, using the isolated workspace wrapper and temporary HTTP ports. Paid providers and production 3100 were not used. Generated QA outputs were copied into ignored evidence and the original two dirty QA JSON files restored byte-for-byte.

The one test failure was `tests/observability-idle.test.ts` → “a real migration is logged exactly once per save”: expected one `migration.completed`, received two. Single-file rerun reproduced it. Idle-read normalization ran migration on a discarded initial snapshot and again after the required lock/re-read. The follow-up repair performs only the existing pure `migrationReasons` precheck on the initial image, and runs actual normalization on the locked latest image. Routine setup still causes lock acquisition. Existing active-mutation/lease projections retain their behavior; stale snapshots never regain write authority. No schema or public storage interface change.

The snapshot above remains failed even after the targeted repair. Focused follow-up: 7 files / 49 passed, complete isolated build passed. These are separate evidence. R5.4 stays unverified until a complete current-source run passes. Earlier 179-file/1745-test failure and subsequent self-extension success remain historical records, not overwritten by these results.

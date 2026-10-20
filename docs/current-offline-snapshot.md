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

## Repaired-source full run

Product source `486bd2f` completed a fresh full run with the same 190-file coverage and 488 pinned source/configuration hashes. All 1927 tests passed across five sequential fresh-process partitions (48/24/24/47/47 files; 484/224/249/502/468 tests). Reports and manifest use the separate `repaired-offline-*` names; the earlier failed attempt is preserved. Post-run audit confirmed every expected file once, zero failures, every pinned source hash unchanged, both original QA JSON byte images restored, all 27 prior frozen acceptance hashes matching and formal-save SHA256 unchanged. Complete isolated strict/client/server build also passed on this source before the run.

This meets R5.4's fixed current-source complete offline snapshot requirement for `486bd2f`; it does not establish R5.3's every-exit audit, cross-process crash semantics, real-provider behavior, deployment or human acceptance. Later product-source changes need new evidence; this is a versioned snapshot, not a blanket claim about future edits.

## Current takeover-source full run

Product source `9917459`, ledger checkpoint `6be22bb`, now has a fresh complete snapshot: 195 test files, 494 source/test/configuration hashes, **1957/1957 tests passed**. Partitions 1/2/3/4/5a/5b/6/7/8/9 contain 24/24/24/24/12/12/24/24/24/3 files and 244/287/242/205/121/173/235/260/175/15 tests. Coverage audit confirms every fixed file exactly once and every pinned hash unchanged. Full isolated strict/client/server build passed before the run. Separate `current-offline-*` reports preserve these results.

Original current shard 5 (24 files) exited `3221226505` / `0xC0000409` without final JSON. Its cause is unestablished and the failure is retained. Replacements 5a/5b split its exact original file list, on identical source, and passed. Original and replacement files are not double-counted. This supports the complete test coverage result; it does not establish native-process stability or explain the crash.

Both preexisting dirty QA JSON byte images were restored after every partition and verified after the final one. All 27 earlier frozen acceptance digests match; formal-save SHA256 is unchanged. No manual server, production 3100, paid Provider, deployment or push was used. R5.4 remains met with newer versioned offline evidence, earning no additional score; every-exit, crash/multi-process and real-model/human gates remain open.

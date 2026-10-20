# Bounded build diagnosis — 2026-10-20

The same-toolchain comparison did **not reproduce a new-source TypeScript performance regression or a 9 GB physical/private-memory process**. No type checking was weakened and no performance-driven product rewrite was made.

## Comparable compiler runs

Baseline: reviewed common-base `a838b11`, exported to an isolated directory without production data. Current: `a9a5d46` plus the preserved atomic-configuration and build-diagnostic fixes. Both used `C:\Program Files\nodejs\node.exe` v24.15.0 and the same installed TypeScript 5.9.3 and dependency paths. `package.json`, lockfile and both tsconfig hashes match. Exact command for both: the same absolute TypeScript executable with `--noEmit --extendedDiagnostics --project tsconfig.json`. Runs were sequential on the same machine, with no test/build concurrently running. Compiler-only runs inherited the isolated offline workspace profile. Each run had a 120-second / 2 GiB private-byte ceiling; neither limit was reached.

| Metric | Baseline | Current |
|---|---:|---:|
| Wall time | 25.82 s | 25.73 s |
| Sampled process CPU time | 40.47 s | 41.59 s |
| Observed kernel peak working set | 1.112 GiB | 1.139 GiB |
| Peak sampled private bytes | 1.119 GiB | 1.143 GiB |
| TypeScript reported memory | 1,015,388 K | 1,035,210 K |
| Compiler files | 840 | 852 |
| TypeScript lines | 55,255 | 56,753 |
| Definition lines | 185,490 | 185,490 |
| Type instantiations | 876,728 | 913,629 |
| Type-check time | 19.62 s | 19.67 s |
| Exit | 0 | 0 |

Instantiations increased about 4.2%, consistent with additional implementation/tests; check time was effectively unchanged. This is not evidence of recursive-generic explosion. Both versions take about 26 seconds here. The historical “about 5 seconds” claim has no comparable same-environment measurement in the retained evidence, so this diagnosis cannot identify when or why that earlier duration changed.

Current tsconfig parsing selects 456 roots: 207 source, 182 test/fixture, 66 script files and Vite config. No root comes from `.agent-runtime`, node_modules, dist, checkpoints or the benchmark export. Normal imported library/declaration files account for the larger compiler graph. Server config selects 87 source roots and their transitive imports. Git diff shows no dependency/config expansion between the compared snapshots.

## Full build and process-tree memory

A single monitored `node scripts/agent-workspace.mjs codex build` passed in **47.60 seconds**. Its tree had a 180-second / 3 GiB simultaneous private-byte ceiling, not reached. The command already performs three sequential stages: `tsc --noEmit`, Vite, then `tsc -p tsconfig.server.json`. The second compiler checks overlapping server dependencies again; it is not concurrent with the first compiler. No duplicate background build was present during measurement.

| Process / simultaneous tree | Peak working set | Sampled CPU time |
|---|---:|---:|
| TypeScript noEmit | 1.137 GiB | 40.97 s |
| TypeScript server emit | 0.786 GiB | 25.92 s |
| Vite | 0.355 GiB | 6.14 s |
| Whole tree, simultaneous RSS sum | 1.235 GiB | — |
| Whole tree, simultaneous private-byte sum | 1.266 GiB | — |

CPU seconds may exceed wall seconds because the process has multiple threads. CPU/private-byte maxima are sampled lower bounds; peak-working-set counters were read while processes were alive. Summing RSS includes shared pages and is not a measurement of unique physical pages. Summing each process's historical peak would also overstate simultaneous use, especially across sequential compiler stages.

Virtual address-space reservation is a different metric: compiler peaks were about 6.2 GiB virtual, Vite about 14.5 GiB virtual while using only 0.36 GiB working set. Windows shell processes also reserve very large virtual ranges. These values must not be presented as RAM consumption. The machine reported 6.94 GiB visible physical RAM and 1.75 GiB free at the initial check. No retained historical sample proves whether the reported 9 GB meant virtual address space, committed memory, one process, or an aggregate. This run does not establish that historical interpretation, nor does it rule out a past transient failure.

## Self-extension failure

The original 179-file manifest completed with 1744/1745 passes. Its sole self-extension failure said that `npm run build` failed, but its old error handler discarded stdout/stderr and labelled the failed stage `package`. It provides no compiler diagnostic, exit/signal or memory sample proving a connection to resource use. A new regression reproduced this diagnostic-loss defect before its minimal fix. The handler now records the correct failed stage, exit/signal when available, and bounded stdout/stderr tails, without registering the capability or repeating the build.

The subsequent real local self-extension test passed in **51.59 seconds**, together with development/registration regressions: **4 files / 63 tests passed**. This is evidence that the failure was not reproducible in that run, not proof of its historical cause and not permission to relabel the earlier snapshot green. The old fixed test manifest was retained; a newly added fault-test file was outside that manifest but could be seen by its nested tsconfig build. The source snapshot metadata tracked existing files, so that limitation is recorded rather than hidden.

No further high-memory compile loops, trace generation, cache changes or type-check relaxation were justified by these results. Any later recurrence should be diagnosed from the newly retained compiler output before retrying. Existing two-stage type checking is left intact. The atomic configuration fix remains in place: all original 11 test names pass in the latest report; one original prefix fixture had needed wording correction to enter the existing legacy router. The final surrounding configuration regression is 11 files / 82 passes.

Exact commands, environment hashes, source diff, per-process samples, extendedDiagnostics and JSON reports are retained under the existing ignored `.codex-checkpoints/framework-reliability-handoff/takeover-2026-10-20/` directory. This diagnosis did not touch production saves, port 3100, credentials, frozen specifications or the Claude worktree.

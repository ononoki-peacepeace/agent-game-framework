# Four-theme acceptance ledger — 2026-10-20

This ledger groups the handoff requirements into the original 40 work packages. It does not replace or edit frozen acceptance v1–v23. Current scoring uses [160 fixed conditions and their evidence](four-theme-progress.md), with machine-readable definitions, states and batch deltas. The old estimates below are retired historical estimates, not current progress. A **completed** row means bounded offline developer evidence (C/D), not real-provider, production or human acceptance. The original row classifications are preserved for comparison; the condition report independently derives current classifications.

| Theme | Completed | Partial | Unfinished | Existing development estimate |
|---|---:|---:|---:|---:|
| ① Reliability | 4 | 6 | 0 | ~61% |
| ② Natural-language actions | 3 | 5 | 2 | ~50% |
| ③ Autonomous persistent world | 3 | 5 | 2 | ~42% |
| ④ Narrator and experience | 2 | 5 | 3 | ~31% |
| Total | 12 | 21 | 7 | ~46% |

Do not reuse the historical 46% as a current estimate. The first reproducible condition baseline is 56.25% (90 met / 32 unmet / 38 unverified), with zero repair credit for changing the accounting method. Shared final gates—latest complete offline snapshot, broader multi-world tests, process-kill/multi-process acceptance, authorized real-provider tests, deployment and human QA—remain open. Historical passes do not establish those gates for later edits.

## ① Reliability

| ID | Package | Status | Evidence / remaining boundary |
|---|---|---|---|
| R1 | Identified HTTP requests: persistent replay/status within retained receipt history | Completed | request-restart-recovery, input-recovery; bounded retention remains explicit |
| R2 | One-image JsonStore save and commit-response failure handling | Completed | storage-service, existing atomic-json fault tests; excludes OS/disk crash |
| R3 | Undo/history original-request preparation and committed receipt replay | Completed | p0a-history-request-recovery plus configuration/Undo regression |
| R4 | Legacy multi-scope style edit and contextual move as one transaction | Completed | p0a-behavior-config-recovery; HTTP restart, before/after faults, concurrent conflict |
| R5 | Every Semantic/Planner/Goal/Executor/Freeform technical failure exit | Partial | existing recovery matrix; not every nested exit reviewed |
| R6 | Pending/background jobs and asynchronous restart continuation | Partial | restart/routine tests; interrupted prepared work still conservatively stops |
| R7 | Extension development/install and external workspace effects | Partial | installation/registration fault tests; remaining workspace/kill boundaries |
| R8 | Frontend synchronization and all System/media mutation paths | Partial | 19 media/canonical race failures fixed; HTTP restart and 134-test expanded regression passed; external writers/GC/provider identities remain |
| R9 | Read-time current/view migration race acceptance | Partial | stale-read/failed-parent cases and media-queue crossing fixed; single-service regressions passed; cross-instance/process/OS boundaries remain |
| R10 | World/global/session behavior-guidance cross-store removal/replay acceptance | Partial | world receipts and scoped enable/remove; ambiguous legacy IDs stop before writing; global cache reconciles after saved response loss; durable global/session identity and scope moves remain open |

## ② Natural-language actions

| ID | Package | Status | Evidence / remaining boundary |
|---|---|---|---|
| A1 | Compound speech stages bind their own uniquely authorized named recipient | Completed | goal-stage-person-binding; true stage ambiguity remains clarification |
| A2 | Repeated physical attempts retain Core outcomes with one aggregate social consequence | Completed | npc-relationship-repetition; separate real events remain independent |
| A3 | Declared result references and explicit dependency ordering in bounded plans | Completed | goal-contract batches and game-outcome-continuation |
| A4 | General intent understanding and original-goal completion | Partial | semantic/alignment/completion tests; broad real-language acceptance open |
| A5 | NPC/item/place/scene-object binding across worlds | Partial | source-owned speech recipients now precede a wrong Planner referent; actual TALK/dependency tests pass; wide-world coverage open |
| A6 | Pronouns and contextual references | Partial | conversation focus/real ambiguity and named-topic roles protected against Planner guesses; 144-test contract/Semantic/scene regression passes; arbitrary sentence-level coreference open |
| A7 | Composite/conditional goals and partial completion | Partial | dependency/conditional tests; broad mixed clauses and dynamic intent open |
| A8 | Freeform physical interaction and dynamic body/distance/environment prerequisites | Partial | physical/environment capability tests; open interaction breadth remains |
| A9 | Broad multi-world natural-language acceptance corpus | Unfinished | no complete representative corpus acceptance |
| A10 | Current-source real-provider open-action acceptance | Unfinished | requires explicit paid-call authorization; old model evidence is historical |

## ③ Autonomous persistent world

| ID | Package | Status | Evidence / remaining boundary |
|---|---|---|---|
| W1 | Sourced NPC knowledge and multi-hop hearsay in declared policy worlds | Completed | npc-information-propagation; provenance/persistence/replay |
| W2 | Per-character private cognition projection | Completed | narrator-character-cognition; no omniscient projection |
| W3 | Authored social events settle from authoritative receipts once | Completed | npc-relationships and repetition; Undo/persistence tested |
| W4 | Autonomous routines and time-credit continuity | Partial | npc-physical-plan-continuity/scheduling; broad lives remain limited |
| W5 | Persistent long/short goals, executable plans and blocked-plan revision | Partial | npc-persistent-plans/immediate-plan; long-term adjustment remains |
| W6 | Body/resources and transient perception continuity | Partial | body/capability tests; multi-world long-duration breadth open |
| W7 | Memory, NPC interactions and long-term relationship causality | Partial | integrated experience/social tests; broader society unaccepted |
| W8 | Background incidents, macro arcs and player absence | Partial | 48-hour simulation: 39 actions, 12 resolved incidents, no offscreen leaks; variety remains |
| W9 | Explicit policy/data decisions for legacy-world social authoring | Unfinished | no automatic production-save authoring or migration authorized |
| W10 | Multi-world extended-duration and future multiplayer acceptance | Unfinished | no multiplayer/multi-process society acceptance |

## ④ Narrator and experience

| ID | Package | Status | Evidence / remaining boundary |
|---|---|---|---|
| N1 | Ordinary/refine Narrator share private cognition projection | Completed | narrator-character-cognition/runtime integration |
| N2 | Technical narration repair does not replay committed world effects | Completed | narrative-bounded-retry, turn-failure-progress and request recovery |
| N3 | Multi-step physical/speech presentation retains settled steps | Partial | compound aggregation and physical receipts; broad prose acceptance remains |
| N4 | Facts, presence, perception and legal-description false rejection balance | Partial | firewall/perception tests; wider legal prose cases open |
| N5 | NPC speech reflects personality, memory and relationships | Partial | cognition integration exists; voice distinction not broadly accepted |
| N6 | Inventory/object grounding and no invented usable assets | Partial | possession/materialization/firewall tests; open-world breadth remains |
| N7 | Long-term continuity and contradictory expression prevention | Partial | continuity/cognition tests; long-duration experience unaccepted |
| N8 | Natural degraded narration quality across scene types | Unfinished | factual fallbacks exist; no broad naturalness acceptance |
| N9 | Broad multi-world differentiated prose benchmark | Unfinished | no representative quality benchmark passed |
| N10 | Current-source real-provider and human play acceptance | Unfinished | authorization/human participation required |

Historical evidence: the original 179-file manifest ran 1745 tests, 1744 passed and self-extension nested build failed with insufficient old diagnostics. Do not mark that snapshot green. Later configuration regression: 11 files / 82 passed. Development/registration plus real local self-extension recheck: 4 files / 63 passed; self-extension took 51.59 seconds.

Latest continuation checkpoints: `37b2741` guidance mutation scope/identity (12 files / 116 passed, complete build and strict TypeScript passed); `7f94529` media/canonical coordination (14 files / 134 passed, adjacent Core/Narrator 10 files / 67 passed, strict TypeScript 25.88 seconds); `b255d17` source-recipient/topic-role protection (9 files / 144 passed, final strict TypeScript 25.70 seconds). Intermediate failures remain preserved. These suites overlap and are not additive full-suite counts. The complete guidance build precedes later server/contract changes; no newest complete-suite or deployment claim is made. Detailed reports and performance samples remain in the existing ignored takeover checkpoint directory.

# Conditional pronoun listener authority

Source baseline: db1fd51 (ledger checkpoint 98783fe). Original scope A6.2.

The actual executed counterexample `如果我和林舟熟悉，就向他询问乔宁今天的安排` addresses the existing public conversation focus. A guard name and discussion topic cannot authorize the Planner's different listener. Without focus and with two people present, the same pronoun must remain ambiguous without writing a save. Repeating a topic name in the guard must not change this rule.

`tests/conditional-pronoun-topic-binding.test.ts` executed actual plans before inspecting TALK receipts or exact unchanged saves. Baseline: 5 failures, 3 passing controls, one exact file, 4.960 seconds. Typed `speech_recipients` and ordinary referents both reproduce the error. Explicit named listeners with pronouns only in guard/topic and a false-branch control pass. Raw failure report and timing remain in the ignored official-resume-2026-10-21 checkpoint directory (`conditional-pronoun-baseline`).

A6.2 is withdrawn pending repair and affected regression. Fixed 160 conditions and their weights are unchanged. No live game Provider, production save, or port 3100 was used.

## Repair and verification

The private contract compiler now proves an addressed pronoun from directive clauses, using the existing public conversation-focus/unique-present resolver before any model recipient hints. Guard/topic pronouns cannot displace a proved named listener. The whole-request pronoun override applies only to one speech stage, and preserves result references, conditional authorization and the existing ambiguity state. No schema, Core, service, Provider or build configuration changed.

The first focused selection passed34 assertions. A broader14-file selection passed170/171; its only failure was a new fixture incorrectly feeding compiled snapshot-only fields into the strict Planner input schema. Removing those fields exposed a second fixture mistake (missing direct conditional dependency). Both failed reports remain. After correcting only the fixture, its entire10-case file passed. The other13 files were not rerun: their product source/config fingerprints match the corrected selection and final build. This yields171 selected passing assertions across14 files from the latest passing file reports, zero skipped; it is not a single all-green run or a full project snapshot.

The final coverage includes actual TALK targets, genuine ambiguity/no-save writes, repeated guard/topic names, no-comma directive, unique-present person, multiple-stage recipient isolation, both conditional branches, and4 actual HTTP JsonStore/service-recreation cases. Pronoun then/else HTTP cases preserve exact response and current-file bytes on replay without generation/writes; changed same-ID requests return409. The unchanged strict full isolated build ran once on stable source and passed in50.543 seconds. A6.2 can be restored; A6.3/4 broader cross-sentence and three-world corpus remain open.

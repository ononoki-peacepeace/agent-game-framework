# Conditional pronoun listener authority

Source baseline: db1fd51 (ledger checkpoint 98783fe). Original scope A6.2.

The actual executed counterexample `如果我和林舟熟悉，就向他询问乔宁今天的安排` addresses the existing public conversation focus. A guard name and discussion topic cannot authorize the Planner's different listener. Without focus and with two people present, the same pronoun must remain ambiguous without writing a save. Repeating a topic name in the guard must not change this rule.

`tests/conditional-pronoun-topic-binding.test.ts` executed actual plans before inspecting TALK receipts or exact unchanged saves. Baseline: 5 failures, 3 passing controls, one exact file, 4.960 seconds. Typed `speech_recipients` and ordinary referents both reproduce the error. Explicit named listeners with pronouns only in guard/topic and a false-branch control pass. Raw failure report and timing remain in the ignored official-resume-2026-10-21 checkpoint directory (`conditional-pronoun-baseline`).

A6.2 is withdrawn pending repair and affected regression. Fixed 160 conditions and their weights are unchanged. No live game Provider, production save, or port 3100 was used.

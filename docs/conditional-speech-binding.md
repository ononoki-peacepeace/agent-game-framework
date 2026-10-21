# Conditional speech recipient authority

At `acd56ad`, conditional speech bypasses the typed contract runner. With an original request to ask 林舟, a Planner paraphrase naming 乔宁 is reinterpreted at execution and produces a real TALK receipt for 乔宁. Both matching then and else guards reproduce this. A separate repeated-name case first mentions 林舟 in the relationship guard, then explicitly asks 林舟; the binding helper only inspects the first occurrence and incorrectly retains the Planner's 乔宁 referent.

`tests/conditional-speech-binding.test.ts` uses actual GameService/Core execution and offline controlled interpretation. Expanded baseline: **4 failures, 3 passing controls**. Two failures reach the wrong actual TALK receipt despite the contract naming 林舟; two stop at wrong compiled binding. Nonmatching branches and aligned speech are controls. Initial five-case greeting drafts also failed twice and passed three controls; their assertions stopped before execution in the first run, then actual wrong-person settlement was verified in a second run. All raw reports remain under `.agent-runtime/codex/conditional-speech-binding-*-baseline.json` (the first report is `conditional-speech-binding-baseline.json`).

A1.1, A1.2, A1.4 and A5.2 are withdrawn pending repair and verification. A1.3 is unchanged: this counterexample does not show loss of earlier stage identity. The fixed 160-condition denominator and frozen acceptance protocol are unchanged. Overall: 96/160, 60.00%.

No paid Provider, production save, port 3100, deployment, schema or Core settlement changes.

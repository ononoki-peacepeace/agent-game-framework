# Conditional speech recipient authority

At `acd56ad`, conditional speech bypasses the typed contract runner. With an original request to ask 林舟, a Planner paraphrase naming 乔宁 is reinterpreted at execution and produces a real TALK receipt for 乔宁. Both matching then and else guards reproduce this. A separate repeated-name case first mentions 林舟 in the relationship guard, then explicitly asks 林舟; the binding helper only inspects the first occurrence and incorrectly retains the Planner's 乔宁 referent.

`tests/conditional-speech-binding.test.ts` uses actual GameService/Core execution and offline controlled interpretation. Expanded baseline: **4 failures, 3 passing controls**. Two failures reach the wrong actual TALK receipt despite the contract naming 林舟; two stop at wrong compiled binding. Nonmatching branches and aligned speech are controls. Initial five-case greeting drafts also failed twice and passed three controls; their assertions stopped before execution in the first run, then actual wrong-person settlement was verified in a second run. All raw reports remain under `.agent-runtime/codex/conditional-speech-binding-*-baseline.json` (the first report is `conditional-speech-binding-baseline.json`).

A1.1, A1.2, A1.4 and A5.2 are withdrawn pending repair and verification. A1.3 is unchanged: this counterexample does not show loss of earlier stage identity. The fixed 160-condition denominator and frozen acceptance protocol are unchanged. Overall: 96/160, 60.00%.

No paid Provider, production save, port 3100, deployment, schema or Core settlement changes.

## Official-account continuation, 2026-10-21

Recovery found HEAD `0c60ea4` plus interrupted edits in `goal-contract.ts` and `executor.ts`. Both were copied byte-for-byte into the ignored official-resume checkpoint before editing. The inherited repair already passed the original7 cases. It was retained, not reverted or redeveloped. The latest complete251-file/2538-selected-pass snapshot still belongs to the earlier product `e9ea62a`; no current full-suite claim is made.

Further bounded tests found4 additional role/hint failures and3 unpunctuated-condition failures. Source address proof now examines each occurrence in the actual directive clause, keeps guard/topic names separate from listeners, and lets an explicit address frame such as “向林舟询问乔宁” outrank the question's subject. It considers frames per clause, without collapsing coordinated listeners or resolving genuine same-name/alternative ambiguity by guessing. Conditional speech uses the existing verified contract step after branch/dependency checks, including a speech contract labeled WORLD_ACTION. Trade rebinding remains limited to actual trade; no extra interpretation/model retry is introduced.

One old test called “询问林舟关于乔宁的安排” a no-addressee ambiguity, although 林舟 is explicitly the object of “询问”. The original sentence is retained as a positive case; a new original sentence without an addressee remains a negative ambiguity case. Duplicate names and explicit alternatives also remain no-write controls. The original failing report is preserved; no frozen condition or threshold was edited to make a failure pass.

Final affected regression:17 exact files/188 passed/zero skipped,45.684s. Two new actual HTTP cases cover then/else, real JsonStore persistence, service recreation, exact original response and current-file byte replay, changed-request rejection, and zero generation/writes on replay. One same-source complete isolated build passed in54.329s; this includes the existing strict noEmit/Vite/server stages. Intermediate7-failure and3-failure reports remain intact. Evidence and per-run reasons/times are under `official-resume-2026-10-21` in the existing takeover checkpoint; see [timing record](development-timing-2026-10-21.md).

Only original A1.1/A1.2/A1.4/A5.2 may be restored by this evidence. General mixed-language understanding, clause/coreference breadth, prose quality and the remaining four-theme conditions stay open. This is a bounded source-recipient/verified-execution repair, not universal natural-language acceptance.

# Ordinary Freeform respects actual foreground time

Fixed corpus L08 and seven focused failures reproduced a pure ordinary Freeform activity advancing the full requested ten minutes past an accepted appointment one minute away. A 120-minute activity also crossed a real interrupt event at sixty minutes. The old path used a single direct clock advance; two normal/full-interval controls passed. All original reports are retained as ignored `generic-activity-interruption-baseline.*` alongside the fixed corpus baseline.

Only an untargeted, generic, deterministic `general` activity without physical/item/storage/relationship effects, resource requirements, explicit completion quote, discovery, local movement query or check stages uses the existing `advanceWorldSegment` boundaries, with HOLD's bounded segment size. Targeted, mechanical, perceptual, resource-dependent and uncertain attempts keep their existing settlement paths. The ordinary interval may stop at zero, partway through, or exactly at its requested end. Its Core receipt records actual time; a positive partial interval records an occurred activity, while zero records no activity occurrence/effect. Exact-end intervals can complete even though the appointment now needs attention.

An additive Core fact identifies an interrupted ordinary interval; no save/receipt field is added. The fact and positive activity fact are retained ahead of the existing canonical-fact truncation boundary. The shared completion predicate distinguishes an occurred partial interval from a completed goal. The existing goal commit hook accepts that partial result in the same transaction, records the goal as blocked and prevents dependent action execution. The outcome remains a game interruption/progress with the actual receipt ID, rather than an engine invariant failure. Zero minutes is unresolved/interrupted; positive elapsed time is partial. Original request identity, retry budget, service signature, Core commit semantics and authored rewards are unchanged.

Narration uses only the Core interval, matching activity fact and actual foreground reason. An interrupted label drops its trailing requested duration so that ten requested minutes cannot look like ten completed minutes. Reviewed exact L08 output:

> 你进行着「留在广场整理值班记录」这段活动，过了1分钟便停了下来。  
> 已到安排时间：已接受的值班会面

The remote incident has not resolved after that minute; no remote notice or NPC reaction is invented. L08's actual HTTP/service/JsonStore recreation replays the identical response, keeps current-image bytes unchanged and performs no generation. All three worlds' partial-completion cases and true-condition cases now get that replay check.

## Validation

- Baseline: 7 focused failures / 2 full-interval controls passed. First fix: 15 assertions across interruption and activity prose passed.
- Twelve-file regression before the final status correction: 131/131 passed, zero skips; isolated build passed (session 33215). Includes Core activity prerequisites, declared activities, physical-plan continuity, sustained world behavior, item/compound prose and all 24 fixed HTTP inputs.
- A subsequent explicit status assertion exposed one positive-interval `goal_status: unresolved` mismatch (8 passed / 1 failed). The interval and effects were already correct; that report is retained.
- Final current-source regression: 7 files, 89/89 passed, zero skips, including all 25 corpus assertions, nine focused interruption cases, typed completion, declared activities, conditional trade and bounded Narrator retries. Final complete isolated build passed (session 65857).

No full-current-suite claim is made here. The earlier complete 228-file/2252-test snapshot is still `80f9084`. Integrate `freeform.ts`, `completion-evidence.ts`, `affordances.ts`, `narrative-firewall.ts` and `service.ts` together: the optional fact writer, reader, partial commit and prose depend on each other. Old receipts retain their previous interpretation.

A7.3/N3.3/N8.2 and all broad A9 conditions remain open. All 24 controlled offline inputs now pass, but this bounded set does not establish representative real-model understanding, arbitrary language combinations or independent review. Overall stays 97/160 (60.625%, displayed 60.63%), net zero. Next: pin the new source and refresh complete offline coverage before choosing the next remaining four-theme matrix.

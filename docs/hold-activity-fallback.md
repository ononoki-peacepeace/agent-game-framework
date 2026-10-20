# Interrupted HOLD narration uses actual elapsed Core facts

Parent `e35c5b2`, preceding product `42fcb15`. Nine actual baseline cases failed: an activity interrupted before any time passed, after one minute, or by an event still became `这次尝试已完成。`; full activities lost their name/time, and compound children retained mechanical fact wording. Original baseline/source hashes remain in ignored `hold-activity-fallback-*` evidence.

The existing canonical renderer recognizes the exact Core HOLD activity fact only when its elapsed value agrees with the receipt's actual `time_cost`. It distinguishes zero-time stop, interrupted interval and full interval, without certifying a larger goal. When a long activity fact is truncated, it describes only known elapsed time. Single-action service fallback also retains the actual foreground reason; compound child rendering uses the same activity sentence. No Core settlement, schema, receipt, retry or provider-budget changes. Integrate `narrative-firewall.ts` and `service.ts` together.

The final built-code review emitted these exact outputs (also retained in ignored `hold-activity-prose-reviewed.json`):

| Actual elapsed | Reviewed prose |
|---|---|
| 0 | 你停了下来，尚未继续「整理手头的资料」。 / 已到安排时间：已经接受的会面 |
| 1 | 你留在原处继续「整理手头的资料」，过了1分钟便停了下来。 / 已到安排时间：已经接受的会面 |
| 5, full | 你留在原处继续「整理手头的资料」，这段活动持续了5分钟。 |

The slash denotes the actual line break. The sentences state the authorized activity and actual duration; they do not add rewards, completed objectives, NPC reactions or unseen events. The event-interrupted 120-minute request reports the actual 60-minute interval and saved invitation reason, with one actual event roll.

Final isolated regression: 6 files, 63/63 tests, zero skips; full isolated build passed (session 68842). Nine focused cases cover refusal/content-filter at 0/1 minute, ordinary full duration, real interrupt event, long fact truncation, ordered actual HOLD→TALK compound settlement, and actual JsonStore/service recreation where original-request replay preserves saved prose/state/disk bytes with zero generation. Not a new HTTP restart test. Existing WAIT, four-scene degraded prose, item prose, physical/speech compound and activity settlement regressions passed.

N8.2/N3.3 full naturalness and failed/unexecuted multi-goal matrices remain open. Overall stays 60.625% (display 60.63%), 97/160, net zero. The latest complete 228-file/2252-test snapshot still belongs to earlier `80f9084`; this source has targeted evidence. Original dirt, formal save, frozen criteria, production service, paid-provider and Claude boundaries remain preserved.

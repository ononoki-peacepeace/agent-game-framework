# Independent cloud compound and item batch

Delivery branch `codex/cloud-narrator-compound-items` now includes latest checked remote main `7cd0c8a4665831acc0b52faf646ddf9062b2d874` (PR #2) through merge `4f4a15a`. Original independent start was fetched/verified `dc3ac77725c88903972dc75a1b37aeb4faa92533`; the first checkpoints did not copy unmerged PR #2 work. Frozen criteria/protocol/ledger retained verbatim: 109/160. No paid provider, formal save, port 3100, credentials or Release operation.

| Condition | Existing evidence | This batch | Honest remaining gate |
| --- | --- | --- | --- |
| N3.4 unmet | Windows actual 30-case three-world long corpus; duplicate action identity repaired; style review fails rhythm/perception and authored candidate tool language | Reproduce and fix actual attributed speech composition; retain exact repeated turns, NPC ownership, failure/partial/unexecuted boundaries | Long prose naturalness still unmet; authored offline samples and developer inspection do not establish current-model or independent human quality |
| N6.3 unmet | Existing contained/sealed movement/damage/equipment, sale and materialization tests | Scene/held/container projection and present possession counterexamples; combined real item lifecycle in progress | Fixed combined matrix must pass before recommending engineering closure; consumption capability absent, refusal must stay explicit |
| N6.4 unverified | Prior individual item tests, no complete three-world sequence | Three structurally different worlds, actual Core receipts and disk replay/later actions in progress | Never claim all generated prose is verified by a finite offline set |

## N3 checkpoint

Root cause: `AgentResult.story` is plain text while the UI protects latest attributed speech by ignoring a text override. Earlier committed turns, including earlier real NPC speech, disappear. This is separate from PR #2's numbered fallback prose repair.

Add optional `story_turns`: public committed performance snapshots with request identity and only public speaker identity components. Capture each matching new committed child before bounded history eviction, including persisted acknowledgement loss. Never capture stale turns, rejected stages or unexecuted tails. Publish snapshots only when they cover the complete assembled sequence. UI renders each saved performance through the existing attributed renderer in order. Legacy results retain their existing speech protection. No Core settlement/schema/storage changes.

`tests/compound-attributed-sequence.test.ts` fixes actual inputs: miss → wait → same miss, NPC-owned reaction, three distinct module/map/causal worlds. Checks actual Core contact/HP, rendered step and speech multiplicity/order, recreated JsonStore and exact byte replay/no new RNG/generation. The existing 30-case corpus additionally checks snapshot identity/count against actual receipts across normal/missing prerequisite/world refusal/partial activity/write-after acknowledgement loss.

Retained runtime evidence:

- `compound-attributed-before.json`: 0 pass/3 fail; rendered missing first miss/wait. Original capture `attributed-b33c9887-*`.
- `compound-attributed-after.json`: 50 pass/3 fail; diagnostic fixture generated the same response for BOTH Lin and Qiao. Raw `attributed-50868067-*` proves four genuine utterances, not duplicate rendering. Fixture now fixes Qiao elsewhere, preserving Lin-only input and explicit count. This failed expectation is retained.
- `compound-final.json`: four files, 73 pass/0 fail/0 skip (20 presentation, 3 attributed, 20 failure, 30 long corpus). The CLI also contained nonexistent `scene-story.test.tsx`; it selected no such file and supplies no evidence for it.
- `compound-types.log`: strict root TypeScript exit0. `compound-items-build.log`: isolated root/client/server build exit0, normal existing zod annotation and chunk size warnings.

Final broad regression and item evidence will be appended below. No fixed condition is awarded here.

## N6 implementation and fixed matrix

The raw projection counterexample puts the canonical paper at the player's scene with `owner_id=player` but zero player inventory. Before repair, `unknown` placement and ownership provenance put it in `authoritative_inventory`. The three-world baseline `item-projection-before.json` is 0 pass/3 fail. After repair, current quantity and canonical placement determine scene/held/container/worn membership. Scene-container contents stay scene items. Added holder, condition and open/sealed/unknown ancestor context; this context never grants access or mutates Core.

The raw possession counterexample genuinely picks up and transfers the same paper through Core. The player has zero and Lin one, but `你仍然拿着纸片。` passed the old validator. `possession-before.json` is 0 pass/3 fail. A read-only check now constrains bounded explicit current possession and explicit quantities of canonical named items. It distinguishes hand-held from packed items, current assertions from earlier settled states, direct denial/intention from completed assertions, and actual typed speech from independent external narration. A masked quote retains a clause boundary, so identical words immediately after the quote remain checked. This is bounded Chinese assertion coverage, not a universal natural-language proof or permission to materialize assets.

Local compound candidates retain their actual per-stage player inventory images for validation. Optional `PendingTurn.narration_item_states` persists these small images with the existing pending candidate, so an actual narration interruption/recreated service can accept the truthful earlier-held clause after final transfer without rerunning Core. Old pending records remain readable; absent temporal evidence never invents an intermediate state. No SavePackage/frozen schema or Core settlement implementation changes.

A genuine transfer removes the item from PublicView. Narrator now receives the player's own receipt-referenced item name and transfer recipient, instead of losing the reference. It receives no private NPC inventory or later private item condition. The actual NPC subsequent DAMAGE_ITEM control demonstrates that a private change does not alter this receipt projection.

| Fixed scenario | Authority and positive control | Negative/control and subsequent execution |
| --- | --- | --- |
| Open/closed, scene/held containers | Actual MOVE_ITEM through scene → held → open scene container → held; explicit authored text normally commits | Sealed source and destination refuse with unchanged disk bytes and no narration; player-packed source context exposes sealed ancestry |
| Environment vs usable asset | Actual Core environmental desk observation creates an environmental fact; no inventory entity | Attempting to move an unmaterialized desk refuses; its observation never becomes a carried asset |
| Temporary ordinary object | Core environment admission materializes one ruler in an open box; observation alone does not grant possession | Later pickup, drop and repeated pickup use that same ID; no clone; actual NPC transfer and return preserve identity |
| Failure/partial/unexecuted tail | Actual failed pickup check leaves scene asset available; successful later retry really holds it | Actual staged pickup → sealed storage → transfer keeps only committed pickup; blocked storage and skipped transfer are distinguished; no extra receipt/generation |
| Player/NPC transfer | Actual source/recipient inventories and ownership checked; NPC returns the identical item through executeAction | Player's repeated transfer after loss refuses; fabricated present possession is rejected/degraded; legal transfer text commits normally |
| Quantity | Commerce structure actually BUYs two and SELLs one; public quantity matches actual inventory | Bounded explicit `持有2张纸片` is rejected when canonical quantity is one; one/zero and denial controls retained |
| Reload/replay | Every supported lifecycle service step reloads a fresh JsonStore/service and replays original request with stale original revision | Exact current.json bytes, canonical state and generation count must stay unchanged; pending compound interruption resumes without another interpretation/Core execution |
| Consumption | Actual named-asset consumption request is refused by existing Core capability guard | No fake consumption success; save bytes and inventory remain unchanged. Adding a consumption capability belongs to Core, outside this Narrator repair |

These run in commerce/relationships/autonomy with actual different modules, map graphs and relationship/autonomy causal witness receipts from `prepareNarrativeWorld`, not renamed scenery. Authored candidates are deliberately identified as offline authored samples. Legal item text must normally commit, rather than obtaining a vacuous pass by always returning generic fallback. Invalid current holding text must not survive. No candidate is real-model or independent-human quality evidence.

Development failures are retained, not silently replaced:

- `item-lifecycle-first.json`: three 60-second timeouts under concurrent build; no product success claim. Per-case budget increased to180s, assertions retained.
- `item-lifecycle-second.json`: 0/3; new `compoundItemStates` was accidentally scoped inside action preparation. `compound-items-adjacent.json`:44pass/27fail from the same introduced regression. `items-types-current.log` records two TS2552 errors. Hoisted and restored for pending resumes.
- `items-recovery-regression.json`:50pass/3fail; a typed quote's closing boundary was entirely masked, so a following possession assertion inherited the speaker prefix. Length-preserving boundary repair closes it; original quote remains legal.
- `item-lifecycle-third.json`:3pass; actual fallback lifecycle, not yet positive explicit item prose coverage.
- `item-lifecycle-authored.json`:0/3 at the capture audit, after action assertions; expression-only rewrite requests have `fixed_outcome`, not the main `authoritative_inventory` envelope. The audit now checks these two real envelopes separately and preserves both.
- `compound-items-final-new-tests.json` is a development iteration with source changing during the visibility review and capture correction; it is excluded from final source claims. Final source is separately pinned in `compound-items-verified-input-hashes.json` and checked after the completed run.

Shared integration surfaces: `src/ai/action-context.ts`, Narrator runtime context imports/projection, `validateResolvedNarrative` optional final argument and speech mask, local compound/pending handling in service, and the additive optional PendingTurn field. Preserve PR #2's independent history, memory and fallback prose changes. Remote main advanced during this batch to `7cd0c8a4665831acc0b52faf646ddf9062b2d874` (PR #2 merged); this does not change the tested original base. Final compatibility check and precise final test evidence follow below.

## N6 stable checkpoint validation

Pinned final inputs:554files,zero changed hashes. Final two nonoverlapping reports: `compound-items-verified-new-tests.json` six files24pass and `compound-items-verified-adjacent.json`21files269pass. Audit: **27files293 distinct passing test cases,0failed/0skipped**. This is the selected affected regression, not a full repository-suite claim. `compound-items-verified-build.log`: isolated strict root TypeScript + Vite client + server TypeScript build exit0. Existing zod annotation/chunk size warnings only. All fixtures offline; no real provider or independent quality scores.

N6.3/N6.4 now have the fixed offline implementation/lifecycle evidence described above, available for Windows review. Formal statuses remain unmet/unverified and109/160 unchanged. N3.4 remains unmet for prose quality. Successful consumption is unavailable in current Core and is not fabricated. Remote latest main is7cd0c8a; tested source base in this checkpoint isdc3ac77, with explicit PR #2 compatibility check still to follow.


## Latest-main NPC possession and committed lifecycle checkpoint

Additional actual N6.4 counterexample: after player pickup, NPC Lin has zero paper but `林舟仍然拿着纸片。` passed. `npc-possession-before.json`:0pass/3fail across all worlds. Generalized the same possession checker to explicitly named visible current-scene actors, retaining actual per-actor inventory, quantity, denial/intention and quoted-speech controls. Player event-time inventory snapshots are never silently treated as NPC snapshots; unmarked multi-stage NPC clauses are not forced into a final-now reading. `npc-possession-after.json`:29pass,0fail; actual latest-main wider regression follows.

`compound-items-raw-counterexamples.json` retains exact input states, prose, actual decisions and original source hashes. Historical03bd Narrator accepts both false player/NPC assertions; b3 rejects the player one but still accepts the NPC one; final rejects both. Legal player transfer and true NPC holding remain accepted. This explicitly re-executes historical Narrator functions on the same current Core-generated candidates, not a claim of an entire historical product run or committed-state replay from those candidate snapshots.

Evidence audit found a fixture limitation: early lifecycle variants directly persisted Core candidates for materialization, failed pickup and NPC return. Their relevant receipts were still `pending`. This is retained as candidate-state evidence and is **not used as the final committed lifecycle proof**. The final lifecycle instead uses actual GameService turns for both environment admission and failed pickup, and a controlled NPC Core action through actual framework `agentTransaction` for returns, with framework-owned commit metadata, revision/checkpoint/atomic disk write and fresh-service identified replay. It asserts committed receipts, one execution, identical bytes and no repeated generation. The NPC operation is a fixed Core actor input, not evidence that a real model autonomously decided to transfer. No Core facts are overridden.

Final materialization receipts, failed pickup and both NPC returns are all `committed` in commerce/relationships/autonomy captures `item-lifecycle-4a2ffb0e-*`. The subsequent actual player operations and stock quantity changes still succeed or refuse as expected. All assessments/prose/audits are explicitly fixed offline adapters, not real model/human quality ratings.

Latest-main validation:

- `compound-items-latest-main-tests.json`:32files,331pass/1fail/0skip,568 unchanged source/config/test input hashes. Sole failure is an old Phase3 assertion requiring1、2、, inconsistent with PR #2 paragraph fallback. Preserve paragraph prose; updated assertion requires both actual activities in order and no mechanical numbering.
- `compound-items-transaction-proof.json`:20pass/1fail; the strengthened three-world lifecycle passes. Its Phase3 module had already loaded the old assertion before the edit. Original failure retained.
- `compound-phase3-prose-final.json`: complete updated Phase3 file18pass/0fail/0skip.
- `compound-items-latest-main-audit.json`: selects the full newer lifecycle and Phase3 file results over those two old files, yielding **32files332 distinct test cases passed,0failed/0skipped**. All production source hashes stayed unchanged; only the two test files changed and were fully rerun. This is a bounded affected regression, not a full-suite claim or an inflated sum of overlapping reports. Vitest assertionResults rows here mean test cases, not individual expect calls.
- `compound-items-latest-main-build.log`: strict root/client/server isolated build exit0. `compound-items-delivery-types.log`: final strict root TypeScript exit0 after the evidence/test updates.

Production modules merged latest main automatically. The sole merge conflict was append-only CLAUDE-HANDOFF.md; both complete sections were retained. PR #2 history/memory/fallback improvements remain present. Frozen specs/statuses/109-of160 were not changed. N6.3/N6.4 now have the described bounded fixed evidence for Windows condition review; N3.4 prose quality remains unmet. Remaining outside evidence: real model/human quality; successful consumption is not supported by current Core and remains a refusal. Next bounded check is whether a composite performance survives a state poll reaching the same revision before its input response.

## Final N3 same-revision polling repair and delivery audit

The last bounded N3 check proved a second presentation omission: if a state poll already showed the final committed revision before the composite input response, `freshNarrative` was false. The UI discarded the assembled performance and showed only the final turn. Three actual worlds reproduce0pass/3fail in `compound-polled-before.json`, with both normal and polled HTML retained in the attributed captures.

Minimal repair recognizes a multi-turn structured sequence at the same game/revision using its actual outcome receipt IDs. It renders the complete validated performance even when the final turn is already visible. Legacy speech protection is retained. No Core, request replay or provider changes. `compound-polled-final.json`: complete four-file N3 regression73pass/0fail/0skip, including actual Core miss → wait → identical miss/NPC speech, equal normal-vs-polled HTML and fresh-store child replay.

`compound-items-delivery-audit.json` replaces the complete affected file results, without adding overlapping counts: **32files332 distinct test cases passed,0failed/0skipped**. Final568 source/config/test hashes unchanged in `compound-items-delivery-inputs.json`. `compound-polled-final-build.log`: final isolated strict root/client/server build exit0. The old331pass/1failure and20pass/1failure reports remain raw development/integration evidence; their stale numbering assertion is not hidden or counted as final success. This affected matrix is not a full repository test-suite claim.

Formal ledger remains exactly109/160 (68.125%), N3.4unmet/N6.3unmet/N6.4unverified. N3 factual omissions and polling loss are repaired; original long-prose style quality is not awarded. N6 fixed offline evidence is ready for Windows review against the frozen conditions, including committed temporary-item admission, player/NPC inventory transitions, failure/partial/unexecuted tails, receipt identity/quantity, private state exclusion, disk restart and no-reexecution replay. No real-model or human quality result is fabricated. Named-item consumption remains an explicit unsupported Core refusal. No further independent evidenced implementation defect remains in this bounded batch; Windows/user integration and remaining external quality review are the next breakpoint.

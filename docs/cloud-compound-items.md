# Independent cloud compound and item batch

Base: remote `main` verified by fetch and ls-remote at `dc3ac77725c88903972dc75a1b37aeb4faa92533`. Independent branch `codex/cloud-narrator-compound-items`; PR #2 is not in that base and is not copied. Frozen criteria/protocol/ledger retained verbatim: 109/160. No paid provider, formal save, port 3100, credentials or Release operation.

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

Pinned final inputs:554files,zero changed hashes. Final two nonoverlapping reports: `compound-items-verified-new-tests.json` six files24pass and `compound-items-verified-adjacent.json`21files269pass. Audit: **27files293 distinct passing assertions,0failed/0skipped**. This is the selected affected regression, not a full repository-suite claim. `compound-items-verified-build.log`: isolated strict root TypeScript + Vite client + server TypeScript build exit0. Existing zod annotation/chunk size warnings only. All fixtures offline; no real provider or independent quality scores.

N6.3/N6.4 now have the fixed offline implementation/lifecycle evidence described above, available for Windows review. Formal statuses remain unmet/unverified and109/160 unchanged. N3.4 remains unmet for prose quality. Successful consumption is unavailable in current Core and is not fabricated. Remote latest main is7cd0c8a; tested source base in this checkpoint isdc3ac77, with explicit PR #2 compatibility check still to follow.

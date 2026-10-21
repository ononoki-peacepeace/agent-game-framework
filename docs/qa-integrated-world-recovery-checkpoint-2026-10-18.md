# Integrated world and recovery checkpoint (2026-10-18)

Task source: user-provided requirements supplied during local QA; local attachment paths are omitted.
This is an implementation checkpoint, not an acceptance report. The earlier checkpoint was at 84%; the current continuation is approximately 98%.

## Safety and takeover

- Reused the existing dirty working tree at `D:\game`, HEAD `c9596d6f103c342667e99ed17dc09304ac94a1c2`. No reset, clean, commit, push, production action, paid Provider call, or deployment.
- The formal save `data/current.json` was not edited. Initial SHA-256: `119585428F0739A55865F97A1372879007BFDFC6893E10EDB42179F42B60B75C`; recheck before final reporting.
- Offline dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund`.
- The takeover's eight targeted regression files began at 97 passed, 12 failed. The failures covered local scene anchors, referent binding, pending MOVE, Narrator goal focus, and sparse NPC budget. See current test output for the final count; the full suite is still running as this checkpoint is written.

## Implemented or corrected in this continuation

- `presence_query`: explicit person reference pronouns retain the binding requirement; ambient “who is here” queries remain ambient.
- Pending MOVE: resuming an active goal no longer commits a separate revision before retrying its persisted candidate. The original resume request gets an atomic receipt alias when the first real step commits, including restart replay protection.
- Narrator receives legacy narrative history entries without `location_id` as historical prose when no movement occurred.
- Sparse NPC routine admits one autonomous candidate per turn, while reserving two model calls for that candidate's schema repair. An isolated 7-day profile used 63 fixture calls and 45.8 seconds; no paid provider call was made.
- Local movement now reuses the existing World Gap assessment and Core candidate. A plausible present scene detail creates a stable environment resolution and position in one transaction; an absent detail yields a normal failed attempt with elapsed time. An unadjudicated detail cannot silently become a position.
- The player projection hides remote item positions, undiscovered hidden evidence, private environment details and generated ordinary items, remote NPC live locations, and truth-linked narrative arcs/sagas until the player knows the referenced truth. The ordinary narrative diagnostic route uses that same projection. Local shop stock remains visible for buying. Environment records have optional `known_by`; legacy records remain player-known. Unknown or duplicate observer IDs are rejected. Private `same_as` references are rejected.
- Updated old local-position test fixtures to use explicit authoritative indoor or outdoor anchors. A building exit is not treated as a free scene-position label. These fixture changes preserve assertions about transaction count, rollback, Undo, and actual movement.
- A walk-and-sit phrase is split into movement and activity only inside a bounded compound plan; a single unsplit phrase does not set a durable scene position by prose alone.
- A single player request now carries a shared provider-attempt budget across nested plan steps, Core turns, schema repair, and truncation retries: 24 calls, 320,000 conservative character-based token estimates, and an eight-minute wall-clock limit. Actual provider usage replaces estimates when available. Direct new-world initialization also gets this boundary. The initial 160,000 estimate interrupted legitimate multi-stage HTTP turns during Narrator; the 320,000 limit passed the affected 39/39 focused cases. This is not a guarantee that every auxiliary background entry shares the same boundary yet.
- The existing World Gap is now actor-scoped. NPC autonomous INSPECT can carry a quoted ordinary environment query; the same assessor and Core admission create one objective item or an authoritative absence, charge from a separate two-call environment budget, and write a private NPC knowledge entry. A later distinct Core MOVE_ITEM is required to acquire a found item. A negative result is visible in the NPC's next decision context and can lead to a different route. The player's ordinary projection stays unaware; a later explicit same-scene search can reveal the same ordinary item without duplicating it. The NPC's private discovery does not overwrite `last_turn` or charge the player's world clock again.
- Broad player observation now asks the existing environment assessor for at most three obvious ordinary scene features. Core uses the same admission record, commits one location survey with stable record IDs and one receipt, and charges one minute. Repeated observation or another actor's later broad look reuses the first survey; the player cannot see an NPC's survey until the player looks. Survey alone never grants inventory. A service replay and Undo were verified.
- New-world candidate validation now returns a concrete repair issue when an explicit current/opening possession clause names an item but omits its structured initial possession; if no matching item definition exists it asks the initializer to create one. It does not infer current possession from career or past use. Existing long-lived saves still require a separate evidence-based repair path.
- Character-card adaptation preview now passes its direct adapter call through the same provider-attempt boundary and request scope.
- NPC `physical_state` (including private alert targets) is no longer projected into the ordinary player view; authoritative NPC state remains intact.
- A same-scene NPC's visibly alert state remains available to Semantic while `alert_to_ids` is redacted; remote NPC physical state is hidden. A 1505/1506 full-suite run exposed the overbroad first version; the corrected projection passed its 18 focused tests.
- An older absent room check no longer masks a later real item arrival. Cross-scene NPC-founded ordinary items retain their original objective resolution and stay private through Core pickup, travel and drop; an explicit player check in the destination adds the player to `known_by` without cloning the item. Focused local scene cases passed 17/17.

## Verification obtained so far

- Local scene materialization, actor-scoped discovery, broad survey, service replay and Undo: 13/13 in the latest focused file.
- Initial possessions candidate and authoritative compilation: 6/6.
- The narrowed overview route, existing ambient observation route, and initial possessions validation passed together: 45/45. Character-card and request-budget focus: 6/6.
- A first complete run after broad survey integration passed 1493/1505. Twelve failures were caused by the initial broad-intent matcher intercepting pre-existing ambient observations, plus two new tests read by the run before their fixes landed. The matcher now requires an explicit "this/whole room" phrase. The affected action-capability/local-survey/initial-possession group passed 45/45; the formerly intercepted Narrator, goal-contract, and scene-lane group passed 36/36. The second complete run passed 1505/1506; the one remaining semantic evidence failure was caused by hiding same-scene visible awareness. Its fix passed 18/18 focused tests. Final post-fix full run remains required.
- Final complete one-worker run: **1508/1508 passed in 277 files**, JSON evidence at `.tmp/integrated-full-final-confirmed-2026-10-18.json`. Final `npm run build` passed TypeScript, Vite client, and server compilation. `git diff --check` produced no whitespace errors; only existing CRLF normalization warnings. Formal `data/current.json` SHA-256 remained `119585428F0739A55865F97A1372879007BFDFC6893E10EDB42179F42B60B75C`.
- Phase 3 local compound: 15/15.
- Framework behavior: 23/23.
- Continuity and Undo: 26/26.
- Daily QA batch: 13/13.
- Earlier focused suites: QA29/30 5/5; Narrator goal focus 3/3; NPC autonomy/scheduling/sparse routine 35/35 in an isolated run; selected environment and recovery 50/50; selected presentation 53/53.
- `npm run build` passed TypeScript, Vite, and server compilation after correcting test fixture ID types. Vite reported only a bundle size warning.
- First complete one-worker run after the regression repairs: 1487/1489 passed. The two failures were the same compound walk-and-sit split expectation; the split was corrected and its 15 focused tests passed. The second full run had 1489/1496 passing: 3 legitimate compound HTTP requests were stopped by the too-small initial token estimate; 2 development-task tests hit a temporary-directory/runner error; 1 self-extension test timed out; 1 long world-continuity test reported a runner stack-trace error. After raising the token estimate, the affected HTTP cases passed 39/39. Development-task and self-extension files passed 32/32 in isolation. The world-continuity file passed 8/8 in isolation with 48 turns, 39 NPC actions, 128 synthetic calls, and no real provider calls. The post-fix complete suite is in progress.
- Narrative/environment/compound focus: 44/44. Budget/recovery/narrative/environment/compound focus: 82/82 before the final small accounting test. Build passed TypeScript, client, and server checks after the shared budget integration; the last new-world wrapper and token accounting edits still need a final build.

## Substantial work still required

- Remaining auxiliary/background entry points must be audited for shared request-budget coverage and exact cancellation behavior. The core provider boundary is now bounded for player requests, but the recovery exit matrix and fault injection are not complete.
- Staged container contents, scoped completeness records, and temporal provenance remain. Broad first-look scene surveys now work, but one survey deliberately fixes only obvious features and does not enumerate hidden contents.
- NPC search is wired for one named ordinary object in a world-event INSPECT, with separate later acquisition and negative-result replanning. General resource category search, container scopes, search breadth, and larger autonomous plans still need work; no automatic inventory grants are allowed.
- Initial equipment inconsistency diagnosis and evidence-based Core repair, followed by retry of the original action.
- Broader privacy audit of ordinary API, map, character panels, Narrator, event and relationship data.
- End-to-end acceptance cases A–O, especially temporal history, NPC stale beliefs, concurrent discovery, save/reload/undo, and multi-step recovery after partial commits.
- Real-provider minimal acceptance, full initial-equipment action recovery for old saves, temporal provenance and staged container scopes, broader privacy audit, and remaining A–O end-to-end cases. Offline suite and build pass, but these missing product gates mean deployment remains prohibited.

## Acceptance-case audit (A–O)

| Case | Current evidence | Remaining gap |
| --- | --- | --- |
| A ordinary first room survey | `local-scene-materialization` Core and service cases | One bounded obvious-feature survey works; model quality and deeper staged contents remain. |
| B/C absent/present local window | `local-scene-materialization` | Targeted adjudication works; needs broader scene survey. |
| D NPC private new item | Actor-scoped Core World Gap plus private knowledge and projection test | Container-specific search, later discovery rules for hidden details, and full HTTP path remain. |
| E historical exclusion | Existing name/location deduplication | No complete-search scope or valid-time exclusion record. |
| F/G NPC resource search, acquire, negative replanning | Synthetic autonomous INSPECT → World Gap → knowledge → later MOVE_ITEM or alternate MOVE tests | General resource categories, realistic container content, multi-step execution and access rules need more cases. |
| H player hypothesis cannot alter hard truth | Existing truth commitment tests and protected World Gap admission | Broader adversarial end-to-end injection still needed. |
| I initial equipment repair and replay | Authored new-world possessions compile correctly | Existing mismatched saves do not yet have evidence-based repair and action replay. |
| J partial multi-NPC composite recovery | Existing pending goal/receipt recovery and 12-regression closure | Exact three-recipient fault sequence still needs an end-to-end test. |
| K/L null normalization and targeted candidate repair | `provider-schema`, `ai-targeted-recovery`, related suites | Remaining exits in the recovery matrix need injection. |
| M stale NPC knowledge | Separate knowledge and objective state exist | Item-move belief invalidation and stale-view test absent. |
| N private player projection | Remote position/item, generated item, truth-linked arc/saga and diagnostic filtering now tested | Character-card prose, other auxiliary routes and Narrator audit remain. |
| O Save/reload/Undo/retry/concurrency | Existing targeted transaction tests | Concurrent private materialization and temporal provenance test absent. |

This matrix marks unimplemented cases explicitly; passing the full existing suite cannot replace A–O acceptance.

## Continuation from 84% (2026-10-18)

- Implemented conservative opening possession repair in the original player turn transaction. An intact revision-zero structured initial world or a valid last-turn Undo before-image plus item-free new receipts can prove a missing membership. It restores the matching item entity and nested placement, appends a receipt fact, and retains replay/Undo behavior. It refuses a long-lived save with incomplete provenance and duplicate names. The formal camera/film save remains unmodified and cannot be proven safe from retained short history.
- Explicit new-world possession detection now flags a single omitted item definition even when other items in the same sentence are present.
- World Gap and broad surveys now distinguish room and named container scope. Scene container contents use one generated entity with `container_id`; a later pickup clears that placement. A targeted negative check remains a historical fact; only a later Core placement sequence supersedes it. An unexplained conflicting current item returns unresolved. Assessor context and same-as references are scope-bound.
- An explicitly exhaustive empty-container inspection can persist a `complete_empty` survey only if Core sees no contents, present scoped fact, or same-location hidden evidence. Subsequent searches cannot retroactively invent an item that was always inside. A later actual placement changes the current contents while keeping the old empty observation intact; repeated inspection reports the new item. Ordinary at-most-three feature overviews never claim to exhaust a nonempty container.
- Added a partial-commit three-NPC sequence: the notice commits, reading times out, continuation runs reading once without repeating the notice or time. Added an NPC stale-location cognition test after another actor's Core pickup/travel/drop.
- Focused validations: latest container/materialization file 24/24; legacy repair + three-NPC files 21/21; HTTP World Gap 35/35. Stable-code final full suite: **1520/1520 passed in 148 files**. Final `npm run build` passed TypeScript, Vite client and server compilation; `git diff --check` found no whitespace error. These establish the offline quality gate, not the production deployment gate.

### Updated A–O audit

| Case | Continuation evidence and remaining limit |
| --- | --- |
| A–D | Earlier isolated survey, window and NPC private search tests remain; container scope is now separate and staged. |
| E | Explicit complete-empty container check, no retroactive content, later real placement and repeated view have Core tests. Other full nonempty search scopes remain limited. |
| F–G | Earlier autonomous search/acquire/replan tests remain; broad resource-category and longer plans remain. |
| H | Protected object and truth checks remain unchanged; validation has not been relaxed. |
| I | Structured revision-zero and valid last-turn evidence repair plus original action/replay/Undo tested. Formal long-lived save lacks sufficient evidence. |
| J | Partial three-recipient notice followed by reading timeout/resume tested with one notice and 15 minutes total. |
| K–L | Existing schema and bounded candidate-repair suites remain; not every auxiliary outlet has separate injection. |
| M | NPC old observation persists as historical knowledge while Core moves the item and current scene visibility updates. |
| N | Existing player projection tests remain; broader auxiliary endpoint audit remains. |
| O | Scoped record, real arrival, service replay and Undo cases added; simultaneous cross-request search stress remains limited. |

The formal save was read-only inspected at revision 389: no matching camera/film/coat item entity in current state, embedded initial world, or latest Undo before-image; both player inventories have zero entries. Its SHA-256 remained `119585428F0739A55865F97A1372879007BFDFC6893E10EDB42179F42B60B75C`. No paid game Provider call or deployment was made.

## 2026-10-19 continuation checkpoint

- Added an evidence-bearing `empty_assessment` to complete-empty container survey proposals. The AI validates the assessment against the current authority and retries once with targeted feedback; Core validates it again before accepting the complete scope. Existing checks for current contents, prior present records and hidden evidence remain unchanged. A plain container overview still records only bounded visible features.
- Added an actual Core `MOVE_ITEM` destination for putting a held item into a reachable scene container. This writes the ordering evidence required to supersede a historical empty check. The freeform storage path now keeps a scene container in place for an ordinary put action, and retains its existing carry-away result when the player explicitly prepares to leave with it.
- Focused container and storage suites passed 42/42. The final full offline run passed 1522/1522 across 148 files; TypeScript and client/server build passed. Formal save SHA-256 stayed `119585428F0739A55865F97A1372879007BFDFC6893E10EDB42179F42B60B75C`.
- A–O: E and O now use a genuine Core container placement rather than a test-only container reference edit. I remains safely unresolved for the formal revision-389 save because no retained authority proves continued possession. The other outstanding acceptance limits in the updated table still apply. Deployment remains gated.

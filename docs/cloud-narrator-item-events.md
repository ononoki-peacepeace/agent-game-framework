# Narrator item event continuity follow-up

Independent branch `codex/cloud-narrator-item-events` starts at consumption source626e4f5, which depends on PR #3 then PR #4head841a516. Main last inspected7cd0c8a does not contain those heads. This PR targets `codex/cloud-consumption-authority`, not main. Preserve Windows work; integrate PR3→PR4→consumption→this delta at a clean checkpoint. No frozen criteria or score changes, paid call, formal save/service/config or Release operation.

## Actual gaps and changes

Three actual structural worlds reuse commerce/movement, relationships/dialogue and autonomy/background witnesses. Fixed four-stage action: scene bread pickup→put into an open scene box→retrieve→consume. Expected authoritative per-stage inventories1→0→1→0, all child receipts committed, one consumption and one revision, five elapsed minutes, unrelated NPC same-name stock2 unchanged; fresh service raw-body replay preserves disk bytes and does not call AI again. Both ordinary authored text and refusal fallback use the same action.

Original `item-event-prose-before.json`:0pass6fail; the entire atomic action is blocked. Root cause: open-action completion evidence only recognized carried-container freeform storage, rejecting the real registered scene-container MOVE_ITEM. In addition, Core movement/handover receipts lacked event-time operation detail and fallback exposed generic field-update facts; final depleted inventory cannot reconstruct earlier pickup/container/handover events.

Add optional Core `item_operation` on registered MOVE_ITEM/TRANSFER_ITEM after existing mutation checks succeed. It snapshots actor/item names, destination/container and prior held/container origin, or actual recipient. Core quantity, ownership, permissions and time settlement are unchanged. A separate completion check compares that operation with the immediate authoritative state; missing/inconsistent facts, result entity or placement still reject. Aggregate receipts clear child-only metadata. Narrator projects child events in order and renders grounded operation prose without inferring current holdings from past actions; legacy records retain prior guarded fallbacks.

Corrected four-stage tests6/6 pass. Separate evidence guards3/3 reject missing/contradictory authority. Additional actual service transfer→wait→NPC own consumption, normal/refusal variants in each structure, pass6/6: player and NPC roll both0 after settlement, other stocks unchanged, the past transfer remains expressible, and byte-exact restart replay does not rerun AI. These are offline decision inputs, not real-model NPC motivation or prose-quality evidence.

Repeated consumption counterexample `repeated-consumption-before.json`:0pass3fail on the N3 worktree before the count-matching correction. Two real quantity-one steps were wrongly compared with their summed quantity on every sentence, so legal separately narrated actions degraded. The validator now matches each assertion to a consecutive group of actual events, retaining event count/order and allowing either separate or aggregate expression. It rejects overcounting, a third invented event and splitting a single quantity-two operation into invented quantity-one steps. Body and structured narration are independently checked presentation views, so duplicate rendering anchors do not charge an event twice. Initial combined targeted report21pass0fail0skip; additional transfer6pass, not a broad final-suite claim.

## Verification and acceptance boundary

Final exact rerun inventory: `docs/cloud-narrator-item-events-tests.json`. Use:

```sh
python - <<'PY'
import json,subprocess
subprocess.run(['node','scripts/agent-workspace.mjs','codex','test',*json.load(open('docs/cloud-narrator-item-events-tests.json')),'--testTimeout=30000'],check=True)
PY
node scripts/agent-workspace.mjs codex build
```

Old item prose/guard and new sequence compatibility selection43pass0fail0skip; separate transfer6pass. Initial strict build passed before the final small argument/wording guards; final build follows. Source-pinned broad regression/build result follows in the delivery record. Preserve before/after reports and synthetic raw requests, canonical states, receipts, prompts and replay assertions. No previous332/440 count stands in for these new paths.

N3.4 remains unmet: these changes remove mechanical update wording and supply event facts, but fixed offline prose and a safe canonical fallback do not prove multiworld long-action naturalness, voice, rhythm or experience. N6.3/N6.4 gain additional event-time/consumption evidence, requiring independent Windows review against their entire frozen matrix; no automatic closure. N8.2 gains an actual fallback correction without claiming a quality verdict. The existing N5/N7/N8/N9 matrix in `docs/narrator-cloud-program.md` remains applicable; no new concrete defect is presumed merely to repeat its completed offline benchmark. Actual model/human cells remain unmet/unverified.

Shared review surfaces: optional receipt/context field (schema/registry/runtime), inventory operation metadata, freeform completion evidence, Narrator context/firewall/fallback, sequence matching and one aggregate clear in service. Preserve consumption recovery, PR3 speech/poll ownership, PR4 same-name stock, and Windows Core/action work during integration. No W6 physiology/resources/daily-schedule redesign.

## Broad run and late dependency correction

Full70file inventory696pass0fail0skip in1029.743s on source7052842,594 unchanged pinned inputs, strict root/client/server build exit0. Own consumption delivery notes were merged during the run; only the non-input handoff append conflicted, and both complete sections were preserved. No tested source/input changed. This broad report predates the newly demonstrated NPC private-count projection defect.

Consumed dependency55ef9f3 fixes that actual leak with7file33pass and fresh strict build; original3normal failures/3fallback controls retained in the consumption supplement. Merging it into this Narrator branch required one context-construction conflict: preserved BOTH item_operation fields and projectConsumptionForNarrator on primary/child records. Sequence validator and Core settlement are unchanged by the privacy correction. Latest22-file affected inventory is docs/cloud-narrator-item-events-delta-tests.json, encompassing all consumption paths, new event/transfer/repetition tests, existing projection/possession/speech/history guards. Its current-source manifest/report and fresh strict build follow. Earlier696 is not relabelled as a single run of the newer source or added to overlapping target counts.

## Delivery record

Latest source `34f377ebdea6473d2a3cfe89b849a533bc02d6fd`: all22 affected files169pass0fail0skip in353.211s,595 pinned inputs unchanged. Fresh strict root/client/server build exit0; nonfatal dependency annotation/chunk-size notices only. Earlier full70file696case report remains bound7052842 (594 unchanged hashes); reports are never summed or relabelled. Both exact inventories, complete raw failed/corrected requests/states/receipts/prompts and source snapshots: ZIP `/workspace/scratch/narrator-item-events-evidence-34f377e.zip` (17012130bytes), SHA256`0365d68af633dfc774a2b6a973a5b3b05860f75ddb17f7c39a869c7e49d697cd`, CRC verified. Contains broad-source and latest-source separately, and pre-delivery handoff snapshots. Consumption dependency and private-stock supplement archives remain separate and immutable.

Independent branch codex/cloud-narrator-item-events pushed through34f377e. Actual `gh pr create --base codex/cloud-consumption-authority --head codex/cloud-narrator-item-events` returned `Post "https://api.github.com/graphql": Forbidden`. No PR number is claimed. Manual stacked PR: https://github.com/ononoki-peacepeace/agent-game-framework/compare/codex/cloud-consumption-authority...codex/cloud-narrator-item-events?expand=1 . Proposed title: Preserve event-time item operations and repeated consumption in compound narration. Latest checked main7cd0c8a, PR3head7d6bafd/PR4head841a516 unchanged; PR APIs cannot confirm webpage status. Integrate PR3→PR4→consumption44f670e→this delta at a clean Windows checkpoint, resolving shared hunks and rerunning exact inventories/build; no auto-merge or formal credit.

N3.4 remains unmet. A8.3 item feature is implemented, whole original dynamic-prerequisite matrix still needs independent review; N6.3/N6.4 have additional positive/fault/replay candidates, not automatic passes. N5.3/4,N7.3/4,N8.2/4,N9.1–4 retain the explicit real-text/model/quality/independent-review boundaries in the existing program matrix. New fallback/event fixes do not supply those missing judgments. Frozen109/160 untouched. No formal save/service, secrets/config, paid Provider, deployment or Release operation.

Next concrete check: same canonical stack ID already held by the recipient may be overwritten by the existing TRANSFER_ITEM assignment. Reproduce in a new isolated follow-up branch before any fix; do not call the finite preceding matrix complete for every inventory configuration.

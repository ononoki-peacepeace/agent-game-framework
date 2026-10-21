# 四大主题可复核进度

计分版本 v1；评估源代码：50ccb02 + reviewed turn-qualified denial and fixed three-world Freeform corpus。整体 **66.25%**（106/160 个固定条件满足）。未满足 23，待验证 31。

四主题各25%，原40项各2.5%，每项预先固定4个条件、各0.625个百分点。未满足与待验证均不计分；不代表它们没有任何代码。该数值表示已获证据的验收条件权重，不是工时、风险或上线成功概率。

| 主题 | 满足 | 未满足 | 待验证 | 完成/部分/未完成项 | 主题进度 |
|---|---:|---:|---:|---|---:|
| ① 可靠性 | 33 | 4 | 3 | 5/5/0 | 82.5% |
| ② 自然语言行动 | 23 | 7 | 10 | 3/5/2 | 57.5% |
| ③ 自主持续世界 | 28 | 5 | 7 | 4/6/0 | 70.0% |
| ④ Narrator 与体验 | 22 | 7 | 11 | 3/5/2 | 55.0% |
| 合计 | 106 | 23 | 31 | 15/21/4 | 66.25% |

旧台账的12/21/7是工作包人工分类，保留作历史。这里的完成/部分/未完成由4个条件满足数推导，不能与旧分类混用。旧46%为退役估计；首次建立口径不是产品进展，不计算相对46%的提升。

条件冻结于 [criteria v1](four-theme-acceptance-criteria.v1.json)，21个部分完成包的具体场景和关闭标准见 [验收细则](four-theme-verification-protocol.v1.md)；逐条状态、依据及批次变化见 [progress JSON](four-theme-progress.json)。运行 `node scripts/four-theme-progress.mjs` 验证并重建本文。历史局部回归不等于最新全套通过；各 met 的依据注明证据时点。真实 Provider、正式数据、部署及人工验收没有证据时均不计分，也不因此阻塞其他离线开发。

规则：不得通过拆条件、改变分母、降低通过条件抬高分数；若发现原范围缺陷，撤回对应 met 并记录负向变化；新增范围风险单列，不能增加原范围得分。确需变更范围时另建版本，保留旧口径和桥接对照，不能覆盖 v1。各包等权是固定、可复算的管理约定，并不声称复杂度相同。

本口径建立后登记的原范围缺陷：72 已修复，18 开放；新增范围风险 0。这些记录不增加分母，也不自动获得完整条件分数。

| 批次 | 类型 | 实际条件变化 | 加权变化 |
|---|---|---|---:|
| baseline-v1 | accounting_baseline | 0（只建立基线） | +0.000 pp |
| guidance-durable-identity | repair | R10.3: unmet → met | +0.625 pp |
| conditional-owner | repair | A7.3: 修复条件归属及执行前校验；19个直接用例、相邻140项通过；完整条件保持开放 | +0.000 pp |
| future-condition-authority | repair | A7.3: 修复未来条件对象与外层条件持久化；11个直接用例、相邻165项通过；完整条件保持开放 | +0.000 pp |
| npc-objective-projection | repair | W5.3: 修复受阻计划与所属长期目标的上下文错位；7个直接用例、相邻91项通过；完整条件保持开放 | +0.000 pp |
| grounded-degraded-prose | repair | N8.1: unmet → met; N8.3: unverified → met | +1.250 pp |
| compound-degraded-prose | repair | N3.3: Settled compound speech/physical order retained across refusal, timeout and fact-conflict; general failed/unexecuted goal presentation remains open；完整条件保持开放; N8.2: Concrete inherited-last-step omission repaired; broad naturalness and incomplete-goal prose remain open；完整条件保持开放 | +0.000 pp |
| legacy-social-policy-strategy | repair | W9.1: unmet → met; W9.2: unmet → met | +1.250 pp |
| complete-offline-snapshot-1927 | repair | R5.4: All190 fixed files executed,1926/1927pass; migration log failure and original process crash retained. Repair49pass/build passed; no full-condition closure.；完整条件保持开放 | +0.000 pp |
| repaired-complete-offline-snapshot | repair | R5.4: unverified → met | +0.625 pp |
| source-recipient-topic-authority | repair | A5.3: Explicit source listener overrides named topic and all model recipient hints; absent/same-name/alternative controls pass; wider object/alias matrices remain open；完整条件保持开放; A6.3: Single-clause topic/listener roles fixed; arbitrary cross-sentence coreference remains open；完整条件保持开放 | +0.000 pp |
| npc-own-resource-context | repair | W5.3: Owner balances/held quantities now support bounded resource-aware blocked-plan revision; long goal and single Core execution preserved; full long-term matrix remains open；完整条件保持开放 | +0.000 pp |
| npc-legacy-long-goal | repair | W5.3: Legacy arrival completes the travel plan but preserves long goals and short goals with other active work; broader revision matrix remains open；完整条件保持开放 | +0.000 pp |
| npc-ended-goal-execution | repair | W5.3: Ended goals cannot authorize lingering legacy/typed plans after reload; stale plans abandoned without MOVE or goal mutation; full adaptive matrix remains open；完整条件保持开放 | +0.000 pp |
| partial-plan-visible-status | repair | N3.3: Earlier settled story no longer hides blocked/unexecuted later stages; client preserves explicit feedback; complete compound matrix remains open；完整条件保持开放; R5.3: Later technical failure carries earlier committed receipts and truthful partial-failure message; every-exit audit remains open；完整条件保持开放 | +0.000 pp |
| current-complete-offline-snapshot-1957 | repair | R5.4: Refreshed already-met versioned complete offline evidence:195files1957pass,494unchanged hashes; native failed attempt preserved；完整条件保持开放 | +0.000 pp |
| compound-physical-firewall-counterexample | evidence_correction | N4.1: met → unmet | -0.625 pp |
| compound-physical-firewall-repair | repair | N4.1: unmet → met | +0.625 pp |
| repeated-physical-scope-counterexample | evidence_correction | N4.2: met → unmet | -0.625 pp |
| repeated-physical-scope-repair | repair | N4.2: unmet → met | +0.625 pp |
| compound-reaction-ownership | repair | N3.3: Actual child speech, shared two-generation stage, pending budget/replay verified; broader failed/unexecuted multi-world prose remains open；完整条件保持开放; N8.2: Actual child speech, shared two-generation stage, pending budget/replay verified; broader failed/unexecuted multi-world prose remains open；完整条件保持开放 | +0.000 pp |
| settled-reaction-speech-counterexample | evidence_correction | N4.1: met → unmet | -0.625 pp |
| settled-reaction-speech-repair | repair | N4.1: unmet → met | +0.625 pp |
| injury-denial-subject-counterexample | evidence_correction | N4.2: met → unmet | -0.625 pp |
| injury-denial-subject-repair | repair | N4.2: unmet → met | +0.625 pp |
| post-reaction-complete-offline-snapshot | repair | R5.4: Fresh199files1992pass on502pinned hashes, exact coverage once; refresh existing met only, historical native crash retained；完整条件保持开放 | +0.000 pp |
| compound-reaction-disk-recovery-verification | repair | R6.3: New JsonStore/service resumes disk pending seal without extra reaction calls/Core;9case matrix and adjacent6distinctfiles54pass/build; no product change or full-matrix closure；完整条件保持开放 | +0.000 pp |
| npc-legacy-plan-recovery | repair | W5.3: Legacy currently blocked route receives recovery priority with owner goal; actual replacement/HOLD/long-goal/reload and prerequisite controls pass. Whole adaptive matrix remains open；完整条件保持开放 | +0.000 pp |
| npc-conditional-plan-context | repair | W5.3: Both formats expose pending conditions and owner goals without auto-confirming; actual replacement or continued wait verified. Wider newfact/relationship/repeatedfailure matrix open；完整条件保持开放 | +0.000 pp |
| npc-legacy-failure-diagnostic | repair | W5.3: Legacy real rejection/system/unknown-cause distinction retained through reload and current context; reopened-route timing and success cleanup pass. Full adaptive adjustment matrix remains open；完整条件保持开放 | +0.000 pp |
| npc-active-plan-revision | repair | W5.3: Real relationship and witnessed new statements inform owner revision or retention before failure; bounded context, one replacement and long motive verified. Full repeatedfailure/location/long-duration matrix remains open；完整条件保持开放 | +0.000 pp |
| npc-repeated-plan-failure-evidence | repair | W5.3: Actual closed-destination/listener-absent repeated blocks preserve successful prefix/zero blocked credit, owner revision adds one HOLD and preserves long motive. Evidence only; full matrix remains open；完整条件保持开放 | +0.000 pp |
| plan-handoff-failure | repair | 无条件状态变化 | +0.000 pp |
| plan-unreadable-state | repair | 无条件状态变化 | +0.000 pp |
| scene-presence-negation-counterexample | evidence_correction | N4.1: met → unmet | -0.625 pp |
| scene-presence-negation-repair | repair | N4.1: unmet → met | +0.625 pp |
| scene-presence-subjects-counterexample | evidence_correction | N4.1: met → unmet | -0.625 pp |
| scene-presence-subjects-repair | repair | N4.1: unmet → met | +0.625 pp |
| post-context-offline-snapshot | evidence_correction | 无条件状态变化 | +0.000 pp |
| plan-committed-failure-summary | repair | 无条件状态变化 | +0.000 pp |
| future-cancel-window | repair | 无条件状态变化 | +0.000 pp |
| input-process-kill | evidence_correction | 无条件状态变化 | +0.000 pp |
| scene-presence-groups-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| scene-presence-groups | repair | N4.1: unmet → met | +0.625 pp |
| perception-subjects-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| perception-subjects | repair | N4.1: unmet → met | +0.625 pp |
| post-subject-offline-snapshot | evidence_correction | R5.4: Fresh complete212files2118pass,521hashes unchanged, exact coverage once,16shards exit0/build; existing met evidence refreshed；完整条件保持开放 | +0.000 pp |
| open-goal-completion-withdrawal | evidence_correction | A4.2: met → unmet | -0.625 pp |
| open-goal-completion-repair | repair | A4.2: unmet → met | +0.625 pp |
| declared-activity-interruption-withdrawal | evidence_correction | A4.2: met → unmet | -0.625 pp |
| declared-activity-interruption-repair | repair | A4.2: unmet → met | +0.625 pp |
| routine-partial-interruption | repair | 无条件状态变化 | +0.000 pp |
| routine-local-elapsed | repair | 无条件状态变化 | +0.000 pp |
| post-routine-offline-snapshot | evidence_correction | 无条件状态变化 | +0.000 pp |
| routine-unreachable-location | repair | 无条件状态变化 | +0.000 pp |
| wait-interruption-fallback-withdrawal | evidence_correction | N8.3: met → unmet | -0.625 pp |
| wait-interruption-fallback-repair | repair | N8.3: unmet → met | +0.625 pp |
| schedule-label-migration | repair | 无条件状态变化 | +0.000 pp |
| routine-world-block-withdrawal | evidence_correction | R5.1: met → unmet | -0.625 pp |
| routine-world-block-repair | repair | R5.1: unmet → met | +0.625 pp |
| future-execute-window | repair | 无条件状态变化 | +0.000 pp |
| npc-notification-credit-withdrawal | evidence_correction | W4.2: met → unmet | -0.625 pp |
| npc-notification-credit-repair | repair | W4.2: unmet → met | +0.625 pp |
| future-control-condition | repair | 无条件状态变化 | +0.000 pp |
| post-control-complete-offline | repair | 无条件状态变化 | +0.000 pp |
| contained-evidence-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| contained-evidence-repair | repair | N4.1: unmet → met | +0.625 pp |
| sealed-item-movement | repair | 无条件状态变化 | +0.000 pp |
| sealed-item-damage | repair | 无条件状态变化 | +0.000 pp |
| tracked-item-sale | repair | A8.3: Tracked sale lifecycle and sealed/filled-container prerequisites repaired;equipped/consumption/full matrix open；完整条件保持开放; N6.3: Tracked sale lifecycle and sealed/filled-container prerequisites repaired;equipped/consumption/full matrix open；完整条件保持开放 | +0.000 pp |
| equipped-item-sale | repair | A8.3: Equipped SELL now requires explicit UNEQUIP before settlement;complete dynamic item matrix remains open；完整条件保持开放; N6.3: Equipped SELL now requires explicit UNEQUIP before settlement;complete dynamic item matrix remains open；完整条件保持开放 | +0.000 pp |
| item-action-degraded-prose | repair | N8.2: Four item-action fallbacks and compound child prose retain actual item/quantity/payment;full failed/unexecuted multi-goal naturalness remains open；完整条件保持开放; N3.3: Four item-action fallbacks and compound child prose retain actual item/quantity/payment;full failed/unexecuted multi-goal naturalness remains open；完整条件保持开放 | +0.000 pp |
| post-item-complete-offline-snapshot | repair | R5.4: Current228-file2252pass exact coverage on538fixed hashes;initial native failure retained,30passing reports/31attempts;no root-cause stability claim；完整条件保持开放 | +0.000 pp |
| sealed-equipment-access | repair | A8.3: EQUIP sealed source/nested access repaired with player/NPC/exterior controls;full dynamic item/multi-world matrix remains open；完整条件保持开放; N6.3: EQUIP sealed source/nested access repaired with player/NPC/exterior controls;full dynamic item/multi-world matrix remains open；完整条件保持开放 | +0.000 pp |
| legacy-policy-offline-activation | repair | W9.3: unverified → met | +0.625 pp |
| hold-activity-degraded-prose | repair | N8.2: HOLD actual0/partial/full intervals and handoff prose repaired;full naturalness/failed-unexecuted matrix remains open；完整条件保持开放; N3.3: HOLD actual0/partial/full intervals and handoff prose repaired;full naturalness/failed-unexecuted matrix remains open；完整条件保持开放 | +0.000 pp |
| fixed-multi-world-corpus-first-execution | evidence_correction | A9.3: All24 fixed inputs executed with controlled offline candidates:21pass/4fail including corpus-integrity case;three product gaps retained;whole broad corpus/independent acceptance stays open；完整条件保持开放 | +0.000 pp |
| generic-activity-degraded-prose | repair | N8.2: Exact Core activity interval prose and ordered children repaired;6files67pass;fixed corpus23pass2fail retains conditional trade/appointment gaps;full condition open；完整条件保持开放; N3.3: Exact Core activity interval prose and ordered children repaired;6files67pass;fixed corpus23pass2fail retains conditional trade/appointment gaps;full condition open；完整条件保持开放 | +0.000 pp |
| conditional-trade-after-arrival | repair | A7.3: True/false/unknown guarded MOVE-purchase uses actual post-arrival binding;10focused pass;8files120pass1knownL08fail;fixed25assertion corpus24pass1fail with true-condition HTTP disk replay;full condition open；完整条件保持开放; A9.3: True/false/unknown guarded MOVE-purchase uses actual post-arrival binding;10focused pass;8files120pass1knownL08fail;fixed25assertion corpus24pass1fail with true-condition HTTP disk replay;full condition open；完整条件保持开放 | +0.000 pp |
| generic-activity-actual-foreground-boundary | repair | A7.3: Pure generic deterministic activity now stops at actual authored foreground/event boundary;zero/partial/full typed receipts,blocked dependent steps,grounded fallback and real replay verified. Broad condition remains open.；完整条件保持开放; N3.3: Pure generic deterministic activity now stops at actual authored foreground/event boundary;zero/partial/full typed receipts,blocked dependent steps,grounded fallback and real replay verified. Broad condition remains open.；完整条件保持开放; N8.2: Pure generic deterministic activity now stops at actual authored foreground/event boundary;zero/partial/full typed receipts,blocked dependent steps,grounded fallback and real replay verified. Broad condition remains open.；完整条件保持开放; A9.3: Pure generic deterministic activity now stops at actual authored foreground/event boundary;zero/partial/full typed receipts,blocked dependent steps,grounded fallback and real replay verified. Broad condition remains open.；完整条件保持开放 | +0.000 pp |
| post-corpus-complete-offline-snapshot | repair | R5.4: Refreshed already-met versioned full offline evidence:235files2340pass,547unchanged hashes,exact coverage once;20fresh process exit0;historical native failures retained.；完整条件保持开放 | +0.000 pp |
| conditional-activity-interruption | repair | A7.3: Conditional HOLD/Freeform actual0/partial/full intervals preserve unfinished activity,skip dependents,retain earlier settled story and real replay.15focused;8files113pass/build;prior2fetchfail report retained. Full condition open.；完整条件保持开放; N3.3: Conditional HOLD/Freeform actual0/partial/full intervals preserve unfinished activity,skip dependents,retain earlier settled story and real replay.15focused;8files113pass/build;prior2fetchfail report retained. Full condition open.；完整条件保持开放 | +0.000 pp |
| long-hold-interruption | repair | A7.3: Short Core HOLD interruption fact survives long-label truncation;actual0/1minute goals unfinished/dependents skipped,grounded prose;first/replay notice consistency repaired. Baseline4fail2controls,expanded2noticefail retained;final8files94pass/build,2actual disk/service exact-response replays. Full matrix open.；完整条件保持开放; N3.3: Short Core HOLD interruption fact survives long-label truncation;actual0/1minute goals unfinished/dependents skipped,grounded prose;first/replay notice consistency repaired. Baseline4fail2controls,expanded2noticefail retained;final8files94pass/build,2actual disk/service exact-response replays. Full matrix open.；完整条件保持开放; N8.2: Short Core HOLD interruption fact survives long-label truncation;actual0/1minute goals unfinished/dependents skipped,grounded prose;first/replay notice consistency repaired. Baseline4fail2controls,expanded2noticefail retained;final8files94pass/build,2actual disk/service exact-response replays. Full matrix open.；完整条件保持开放 | +0.000 pp |
| conditional-wait-interruption | repair | A7.3: Core explicit WAIT actual interruption fact keeps conditional duration incomplete and dependent skipped,actual-time grounded prose;baseline2fail2controls,final8files87pass/build,2actual HTTP/disk/service exact-response replays. Existing handoff already prevented real dependent TALK;full matrix open.；完整条件保持开放; N3.3: Core explicit WAIT actual interruption fact keeps conditional duration incomplete and dependent skipped,actual-time grounded prose;baseline2fail2controls,final8files87pass/build,2actual HTTP/disk/service exact-response replays. Existing handoff already prevented real dependent TALK;full matrix open.；完整条件保持开放 | +0.000 pp |
| post-wait-complete-offline-snapshot | repair | R5.4: Refresh already-met full offline evidence:238files2371pass/zero skip,550unchanged hashes,exact coverage once;20fresh isolated process exit0,build61704 passed. Historical failures and separate real R9.3 two-service preflight failure retained.；完整条件保持开放 | +0.000 pp |
| migration-two-service | repair | R9.3: Same-process same-path JsonStore migration guarded against other instances canonical/media/same-revision writes;full-image compare,entry snapshots,3conflict safe stop/fault recovery. Formal2fail6controls,queued8pass1fail retained;final7files57pass/build. Cross-process half of full condition remains open.；完整条件保持开放 | +0.000 pp |
| image-existing-content | repair | R8.3: Existing content-addressed image EEXIST now verifies bytes before binding;corrupt/truncated assets stop without overwriting/deleting/save mutation or retry. Baseline2fail2controls,final5files42pass/build. Full request-identity/GC/external writer gate remains open.；完整条件保持开放 | +0.000 pp |
| npc-long-route-plan | repair | W4.3: Typed MOVE multi-edge route above240credit cap makes actual first-edge progress;original destination/cursor retained until arrival,matching time boundary,dependent work/long motive/disk restart/closed route controls. Baseline2fail1control,final7files59pass/build. Singleedge>240 and full matrices remain open.；完整条件保持开放; W5.3: Typed MOVE multi-edge route above240credit cap makes actual first-edge progress;original destination/cursor retained until arrival,matching time boundary,dependent work/long motive/disk restart/closed route controls. Baseline2fail1control,final7files59pass/build. Singleedge>240 and full matrices remain open.；完整条件保持开放 | +0.000 pp |
| npc-long-edge-credit | repair | W4.3: Typed current declared travel edge can store actual paid credit through1440-minute map limit;no accrual before schedule/conditions or duplicated world time. Numeric reader dependency documented;legacy cap unchanged. Baseline2fail7controls;final8files80pass/build,actual270credit disk/service restart. Full matrices open.；完整条件保持开放; W5.3: Typed current declared travel edge can store actual paid credit through1440-minute map limit;no accrual before schedule/conditions or duplicated world time. Numeric reader dependency documented;legacy cap unchanged. Baseline2fail7controls;final8files80pass/build,actual270credit disk/service restart. Full matrices open.；完整条件保持开放 | +0.000 pp |
| npc-legacy-long-edge-credit | repair | W4.3: Legacy current known firstedge paid-credit limit through1440 matches actual time;prior knowledge boundary,guards and Core settlement retained. Numeric reader dependency documented;baseline3fail13controls,final9files93pass/build,actual270credit disk/service restart/oneMOVE. Full matrices/process migration remain open.；完整条件保持开放; W5.3: Legacy current known firstedge paid-credit limit through1440 matches actual time;prior knowledge boundary,guards and Core settlement retained. Numeric reader dependency documented;baseline3fail13controls,final9files93pass/build,actual270credit disk/service restart/oneMOVE. Full matrices/process migration remain open.；完整条件保持开放 | +0.000 pp |
| post-long-route-complete-offline-snapshot | repair | R5.4: Refresh already-met complete offline evidence:241files2403pass,553pinned hashes,exact coverage once,20processes exit0/build; separate independent-process migration failure retained.；完整条件保持开放 | +0.000 pp |
| migration-process-write-guard | repair | R9.3: Repair independent-process migration overwrite with bounded crash-releasing cooperative write guard;baseline2fail8controls,final9files84pass/build. Full interleaving matrix remains open.；完整条件保持开放; R9.4: Strict SIGKILL/timeout/corruptguard/requestreplay evidence only;full preparation/external replacement matrix remains open;all failures retained.；完整条件保持开放 | +0.000 pp |
| migration-interleaving-matrix | repair | R9.3: Completed bounded cooperative current/view write interleavings,3files30pass;initial26pass4wrongIPCfail retained/fixed in tests only. Current fullsnapshot/finalbuild pending;no score yet.；完整条件保持开放 | +0.000 pp |
| scene-count-counterexample | evidence_correction | N4.1: met → unmet; N4.2: met → unmet | -1.250 pp |
| post-process-complete-offline-snapshot | repair | R9.3: unmet → met | +0.625 pp |
| scene-count-authority-repair | repair | N4.1: unmet → met; N4.2: unmet → met | +1.250 pp |
| migration-external-image | repair | R9.4: Actualatomicrenamekill/externalreplacement/recovery/errorclassificationevidence;correctedbaseline2fail6controls,final8files106pass/zeroskip/build. Preparationkill/fullmatrixremainopen.；完整条件保持开放 | +0.000 pp |
| migration-preparation-matrix | repair | R9.4: Fullboundedpreparation/replacementkill/externalimage/error/no-replaymatrix54pass/build;currentfullsnapshot/safetyauditpending,no score yet.；完整条件保持开放 | +0.000 pp |
| post-migration-complete-offline-snapshot | repair | R9.4: unverified → met | +0.625 pp |
| fetchable-loopback-fixture | evidence_correction | R5.4: Original3Fetch bad-port failures retained;bounded listener selection and deterministic cleanup/bind-error controls38pass/build. Latest full coverage predates this test-only checkpoint; no status change.；完整条件保持开放 | +0.000 pp |
| fixed-three-structure72h-scenarios | repair | W10.1: unmet → met | +0.625 pp |
| perception-inspect-authority-counterexample | evidence_correction | N4.1: met → unmet | -0.625 pp |
| actual-npc-movement-prose-counterexample | evidence_correction | N4.2: met → unmet | -0.625 pp |
| complete-narration-authority-snapshot | repair | N4.1: unmet → met; N4.2: unmet → met | +1.250 pp |
| runnable-offline-prose-capture | repair | N9.1: Fixed18casecaptureandrubricexist;representativedifferentiatedvoice/memory/normalcontrastsremainincomplete.；完整条件保持开放; N9.2: Fiveanchorsdefined;actualqualityratingsblank,modelvoice/memorycontrastsnotestablished.；完整条件保持开放; N9.3: Captured18existingofflinefallbackcases/47pass/486hashes;notcompleteoriginalqualitybenchmark.；完整条件保持开放 | +0.000 pp |
| conditional-speech-binding-counterexample | evidence_correction | A1.1: met → unmet; A1.2: met → unmet; A1.4: met → unmet; A5.2: met → unmet | -2.500 pp |
| official-conditional-speech-binding-recovery | repair | A1.1: unmet → met; A1.2: unmet → met; A1.4: unmet → met; A5.2: unmet → met | +2.500 pp |
| conditional-pronoun-topic-counterexample | evidence_correction | A6.2: met → unmet | -0.625 pp |
| conditional-pronoun-topic-repair | repair | A6.2: unmet → met | +0.625 pp |
| npc-adaptation-five-trigger-acceptance | repair | W5.3: unmet → met | +0.625 pp |
| npc-adaptation72-three-structure-acceptance | repair | W5.4: unverified → met | +0.625 pp |
| extension-development-failure-identity | repair | R7.3: 5166f52: creation/file-write/compiler failures retain precise phases, durable terminal identity and bounded stdout/stderr/exit/signal; full text redacted before tail to preserve final diagnostics and avoid credential-prefix truncation. Baseline3fail1control plus long-output1fail; latest passing46assertions/7files selected union and one standard build49.043s. Old exact journal-message expectation updated to assert precise phase/prefix with all safety checks retained. Full install/registration before/after matrix and R7.4 kill boundaries remain open; no condition closure.；完整条件保持开放 | +0.000 pp |
| extension-installation-failure-identity | repair | R7.3: a82afe2: four before/after approval/canonical-install diagnostic counterexamples repaired. Preparation failure restores preview intent and logs exact stage; unconfirmed results retain stage across restart and stop; actual committed receipts alone reconcile installed, original installing failure retained in logs.9direct pass and3files35pass/zero skip, strict root noEmit27.845s; no redundant Vite/server build, no changed receipt/Core/required-schema semantics. Wider core-candidate runtime registration and before/after workspace matrix still open; R7.4 kill tests separate.；完整条件保持开放 | +0.000 pp |
| core-build-diagnostic-coverage-correction | evidence_correction | R7.1: met → unmet | -0.625 pp |
| core-install-checkout-preservation | repair | R7.1: unmet → met | +0.625 pp |
| core-install-immutable-tree-ownership | repair | R7.3: unmet → met | +0.625 pp |
| owned-development-tool-kill-evidence | repair | R7.4: TwoactualOSstrongkill/independentworkerrestartcasespass10.820s;precisegates,zeroautomaticreexecution/registration,preservedartifacts.Onlylocalexecutablefixtures;actualfullcompiler/installchild/serviceownercrashmatrixstillopen.Strict34.218sexit0.；完整条件保持开放 | +0.000 pp |
| owned-core-install-kill-evidence | repair | R7.4: FouractualOStoolkill/independentworkerrestartcasespass25.136s;addedrealtempGitinstallfailurepreservationandnewbootruntimefailure/auditablerevert.Noactualfullcompilerorserviceownercrashcleanupclaim.Strict51.098sexit0.；完整条件保持开放 | +0.000 pp |
| registered-activity-resource-validity | repair | A8.3: Destroyed/sealed registered instrument refusal and intact/damaged/scenery controls verified; final8directpass4.520s,strict40.891sexit0. Earlier3files26pass and adjacent5files77pass precede canonical lookup type fix; full dynamic matrix open.；完整条件保持开放 | +0.000 pp |
| freeform-time-prerequisites | repair | A8.3: Actual3counterexamples fixed; final7directpass8.030s/strict54.467sexit0; selected9files119distinctpassingunion, original4HTTPpermissionfailures retained and affected4pass on permission rerun. Full dynamic matrix open.；完整条件保持开放 | +0.000 pp |
| freeform-live-check-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| freeform-live-check-repair | repair | N4.1: unmet → met | +0.625 pp |
| freeform-live-actor-withdrawal | evidence_correction | A8.2: met → unmet | -0.625 pp |
| freeform-live-actor-repair | repair | A8.2: unmet → met | +0.625 pp |
| freeform-live-local-anchor | repair | A8.3: 2actualfail2controls repaired;4files55distinctpassingunion/final5direct6.962s/strict47.785sexit0; single HTTP permission failure retained and only affected test rerun pass. Full dynamic matrix remains open.；完整条件保持开放 | +0.000 pp |
| freeform-live-hazard-withdrawal | evidence_correction | A8.2: met → unmet | -0.625 pp |
| freeform-live-hazard-repair | repair | A8.2: unmet → met | +0.625 pp |
| destination-prerequisite-parity | repair | A8.3: 5fail1control5.051s repaired;6files96distinctpassingunion/expanded9direct/strict48.420sexit0. Original25HTTPpermissionfailures retained and only affectedfile25pass11.389s. Full dynamic matrix open.；完整条件保持开放 | +0.000 pp |
| freeform-live-item-operation-contract | repair | A8.3: 2fail4controls4.829s repaired;4files52distinctpassingunion/final9direct6.840s/strict47.923sexit0; actualdiskrecreatedrefusals unchangedbytes/state zeroNarrator/livegeneration. Full dynamic/consumption breadth remains open.；完整条件保持开放 | +0.000 pp |
| sealed-storage-choice-binding | repair | A8.3: 4fail6controls5.518s repaired;5files65distinctpasses/finalexpanded21pass8.437s/strict49.386sexit0; realdiskchoicefiltering unchangedbytes and legal exterior movecontrols. Full matrix open.；完整条件保持开放 | +0.000 pp |
| scene-presence-local-step-wording | repair | N4.3: 5fail6controls4.924s repaired;5files65distinctpassingunion/strict68.187sexit0;actualWAIT normalexactprose/oncegeneration/replay. Original1HTTPfetchfailure retained/affected1pass9excluded9.092s; full prose matrix open.；完整条件保持开放 | +0.000 pp |
| scene-presence-ascii-speech-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| scene-presence-ascii-speech-repair | repair | N4.1: unmet → met | +0.625 pp |
| perception-joined-pronoun-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| perception-joined-pronoun-repair | repair | N4.1: unmet → met | +0.625 pp |
| scene-presence-temporal-pronoun-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| scene-presence-temporal-pronoun-repair | repair | N4.1: unmet → met | +0.625 pp |
| image-late-binding-ownership | repair | R8.3: Late generated avatar no longer overwrites newer replace/clear/recrop; queuedmanual/newgame/unrelatedrevision/diskrecreation controls pass;5files40pass16.938s/strict37.355sexit0. Full Provider identity/external writers/GC stay open.；完整条件保持开放 | +0.000 pp |
| open-goal-unreadable-state | repair | R5.3: Open-goal persistent recovery reads no longer escape structured failure;knownprefix kept,unseencommit not denied,staleview omitted.6files47pass16.118s/strict44.237sexit0. Other nested exits remainopen.；完整条件保持开放 | +0.000 pp |
| scene-unreadable-commit | repair | R5.3: Natural-scene commit/read uncertainty distinguished from acknowledgedcommit refreshfailure;5actualdiskfault/controlcases,6files98distinctpassingunion/strict27.410sexit0. Initialexpandedprocess exit1 noJSON,causeunknown,not countedgreen;othernestedexitsopen.；完整条件保持开放 | +0.000 pp |
| scene-generation-read-failure-interrupted | evidence_correction | R5.3: Twoactual baselinefailures remainunverified after WIP repair;fixedtests0executed becauseapprovalreviewfailed/sandboxspawnEPERM.Strictonly27.023sexit0.Not closed.；完整条件保持开放 | +0.000 pp |
| scene-generation-read-failure-verified | repair | R5.3: Authorized fixed run4files56pass11.235s; strict27.023sexit0. Two reproduced read failures repaired with readable control and cached same-request protection; scene-effect/finalizer matrix remains open.；完整条件保持开放 | +0.000 pp |
| scene-effect-read-failure | repair | R5.3: Baseline7fail1control4.155s; final5files67pass15.799s/strict28.916sexit0.11directcases with actual JsonStore effects, lost response, cached request and fresh-service bytes. Every-exit matrix remains open.；完整条件保持开放 | +0.000 pp |
| scene-wait-completion | repair | A7.3: Actual2interruptedfails2completecontrols4.186s; minimal existing Core receipt check.4files67pass20.382s/strict30.581sexit0, sameID no reexecution and actual disk recreation. Full matrix remains open.；完整条件保持开放; N3.3: Actual2interruptedfails2completecontrols4.186s; minimal existing Core receipt check.4files67pass20.382s/strict30.581sexit0, sameID no reexecution and actual disk recreation. Full matrix remains open.；完整条件保持开放 | +0.000 pp |
| open-goal-wait-completion | repair | A7.3: Correctedbaseline3fail2controls4.016s;6files32pass14.150s/strict27.892sexit0. Five direct JsonStore cases; full mixedgoal/prose matrix open.；完整条件保持开放; N3.3: Correctedbaseline3fail2controls4.016s;6files32pass14.150s/strict27.892sexit0. Five direct JsonStore cases; full mixedgoal/prose matrix open.；完整条件保持开放 | +0.000 pp |
| development-actual-compiler-kill | repair | R7.4: Actual full-project TypeScript component kill and independent terminal replay verified; selected5distinctcaseunion/strict28.118sexit0. Complete npm/install pipeline/service-owner crash/descendant matrix stays unverified.；完整条件保持开放 | +0.000 pp |
| perception-simile-authority | repair | N4.3: Baseline5fail5controls3.548s; final5files67pass15.379s/strict33.298sexit0.11directpairedcases,actualdisknormal/degradedINSPECTandfreshserviceexactreplay. Broad corpus remains open.；完整条件保持开放 | +0.000 pp |
| inventory-denial-prose | repair | N4.3: Correctedbaseline7fail8controls3.607s; first5files66pass16.029s/finalnarrow2files20pass5.830s,finalstrict29.303sexit0.17directcases with actual disk INSPECT/recreation. Full corpus remains open.；完整条件保持开放 | +0.000 pp |
| typed-speech-occurrence-counterexample | evidence_correction | N4.1: met → unmet | -0.625 pp |
| typed-speech-occurrence-repair | repair | N4.1: unmet → met | +0.625 pp |
| arrival-scene-commit-recovery | repair | R5.3: Baseline6fail2controls5.794s; final4files44pass22.746s/strict28.871sexit0;14directactualdiskpairedcases incl unreadable/provider/invalid controls and exactcachedreplay. Full exit matrix remains open.；完整条件保持开放 | +0.000 pp |
| perception-commit-evidence | repair | R5.3: Baseline7fail1control4.014s;initial5files37pass12.208s;finalhistory2files13pass7.069s and expanded11direct6.024s/strict28.927sexit0. Selected5files40distinctpassingunion acrossinitial/final source,notoneallgreenrun; fullmatrixopen.；完整条件保持开放 | +0.000 pp |
| perception-inspection-completion-withdrawal | evidence_correction | A4.2: met → unmet | -0.625 pp |
| perception-inspection-completion-repair | repair | A4.2: unmet → met | +0.625 pp |
| plan-inspection-completion-withdrawal | evidence_correction | A4.2: met → unmet | -0.625 pp |
| plan-inspection-completion-repair | repair | A4.2: unmet → met | +0.625 pp |
| narrative-item-condition-withdrawal | evidence_correction | N4.1: met → unmet | -0.625 pp |
| narrative-fixed-corpus-closure | repair | N4.1: unmet → met; N4.3: unmet → met | +1.250 pp |
| narrative-three-structure-corpus | evidence_correction | N4.4: unverified → met | +0.625 pp |
| freeform-consumption-authority | repair | A8.3: Concrete false consumption completion repaired through existing structured unavailable result;canonical quantity operation and complete dynamic prerequisite evidence remain open.；完整条件保持开放 | +0.000 pp |
| development-real-pipeline-kill | evidence_correction | R7.4: Real npm/TypeScript/Vite failure propagation and independent query verified in two fixed build/install boundaries;ownercrash and complete descendant configurations remain unverified.；完整条件保持开放 | +0.000 pp |
| inventory-turn-denial-withdrawal | evidence_correction | N4.2: met → unmet | -0.625 pp |
| freeform-three-world-corpus | repair | N4.2: unmet → met; A8.4: unverified → met | +1.250 pp |

## R1 Identified HTTP requests: persistent replay/status within retained receipt history

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R1.1 | 相同请求与参数在保留期内返回原结果；不得再次提交 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R1.2 | 相同 ID 不同参数被拒绝，游戏隔离不串线 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R1.3 | 重启后可查询已提交请求并复用原响应 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R1.4 | 保留期边界显式说明，过期记录不冒充可无限重放 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |

## R2 One-image JsonStore save and commit-response failure handling

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R2.1 | 单次世界修改只提交完整且通过校验的存档镜像 | 满足 | [storage-service.test.ts](../tests/storage-service.test.ts), [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |
| R2.2 | 原子替换前失败保留旧镜像，不留下半份 JSON | 满足 | [storage-service.test.ts](../tests/storage-service.test.ts), [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |
| R2.3 | 替换后响应丢失能根据凭据识别已经提交 | 满足 | [storage-service.test.ts](../tests/storage-service.test.ts), [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |
| R2.4 | 故障注入验证旧存档与新存档二选一；不宣称 OS 断电保证 | 满足 | [storage-service.test.ts](../tests/storage-service.test.ts), [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |

## R3 Undo/history original-request preparation and committed receipt replay

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R3.1 | Undo 与历史修改提交前准备原请求身份 | 满足 | [p0a-history-request-recovery.test.ts](../tests/p0a-history-request-recovery.test.ts) |
| R3.2 | 保存后响应丢失可查到原修改凭据 | 满足 | [p0a-history-request-recovery.test.ts](../tests/p0a-history-request-recovery.test.ts) |
| R3.3 | 重放不重复 Undo、不重复推进版本和历史 | 满足 | [p0a-history-request-recovery.test.ts](../tests/p0a-history-request-recovery.test.ts) |
| R3.4 | 恢复准备失败时不写存档，配置与 Undo 相邻回归通过 | 满足 | [p0a-history-request-recovery.test.ts](../tests/p0a-history-request-recovery.test.ts) |

## R4 Legacy multi-scope style edit and contextual move as one transaction

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R4.1 | 多范围旧风格配置与移动只写一次完整镜像 | 满足 | [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |
| R4.2 | 前后写故障覆盖原有11个故障注入条件 | 满足 | [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |
| R4.3 | 原始文本重启重放不重新解释上下文、不重复写 | 满足 | [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |
| R4.4 | 移动只修改指定范围及操作，其他规则保留并拒绝并发冲突 | 满足 | [p0a-behavior-config-recovery.test.ts](../tests/p0a-behavior-config-recovery.test.ts) |

## R5 Every Semantic/Planner/Goal/Executor/Freeform technical failure exit

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R5.1 | 已有故障矩阵区分技术失败与游戏内失败，保留已提交步骤 | 满足 | [qa-ai-recovery-coverage.md](../docs/qa-ai-recovery-coverage.md), [routine-world-block-outcome.test.ts](../tests/routine-world-block-outcome.test.ts), [routine-world-block-outcome.md](../docs/routine-world-block-outcome.md) |
| R5.2 | 已有分层修复与安全停止测试验证不重复 Core 副作用 | 满足 | [qa-ai-recovery-coverage.md](../docs/qa-ai-recovery-coverage.md) |
| R5.3 | 逐条关闭矩阵中仍未核验的嵌套故障出口 | 未满足 | [qa-ai-recovery-coverage.md](../docs/qa-ai-recovery-coverage.md), [partial-plan-visible-status.test.ts](../tests/partial-plan-visible-status.test.ts), [partial-plan-visible-status.md](../docs/partial-plan-visible-status.md), [plan-handoff-failure.test.ts](../tests/plan-handoff-failure.test.ts), [plan-handoff-failure.md](../docs/plan-handoff-failure.md), [plan-unreadable-state.test.ts](../tests/plan-unreadable-state.test.ts), [plan-unreadable-state.md](../docs/plan-unreadable-state.md), [plan-committed-failure-summary.test.ts](../tests/plan-committed-failure-summary.test.ts), [plan-committed-failure-summary.md](../docs/plan-committed-failure-summary.md), [open-goal-unreadable-state.md](../docs/open-goal-unreadable-state.md), [open-goal-unreadable-state.test.ts](../tests/open-goal-unreadable-state.test.ts), [scene-unreadable-commit.md](../docs/scene-unreadable-commit.md), [scene-unreadable-commit.test.ts](../tests/scene-unreadable-commit.test.ts), [scene-generation-read-failure.md](../docs/scene-generation-read-failure.md), [scene-generation-read-failure.test.ts](../tests/scene-generation-read-failure.test.ts), [scene-effect-read-failure.md](../docs/scene-effect-read-failure.md), [scene-effect-read-failure.test.ts](../tests/scene-effect-read-failure.test.ts), [arrival-scene-commit-recovery.md](../docs/arrival-scene-commit-recovery.md), [arrival-scene-commit-recovery.test.ts](../tests/arrival-scene-commit-recovery.test.ts), [perception-commit-evidence.md](../docs/perception-commit-evidence.md), [perception-commit-evidence.test.ts](../tests/perception-commit-evidence.test.ts), [plan-inspection-completion.md](../docs/plan-inspection-completion.md), [plan-inspection-completion.test.ts](../tests/plan-inspection-completion.test.ts) |
| R5.4 | 最新完整离线代码快照全套通过，旧失败不得改写为通过 | 满足 | [current-offline-snapshot.md](../docs/current-offline-snapshot.md), [post-reaction-offline-snapshot.md](../docs/post-reaction-offline-snapshot.md), [agent-workspace.mjs](../scripts/agent-workspace.mjs), [post-context-offline-snapshot.md](../docs/post-context-offline-snapshot.md), [post-subject-offline-snapshot.md](../docs/post-subject-offline-snapshot.md), [post-routine-offline-snapshot.md](../docs/post-routine-offline-snapshot.md), [post-control-offline-snapshot.md](../docs/post-control-offline-snapshot.md), [post-item-offline-snapshot.md](../docs/post-item-offline-snapshot.md), [post-corpus-offline-snapshot.md](../docs/post-corpus-offline-snapshot.md), [post-long-route-offline-snapshot.md](../docs/post-long-route-offline-snapshot.md), [post-process-offline-snapshot.md](../docs/post-process-offline-snapshot.md), [post-migration-offline-snapshot.md](../docs/post-migration-offline-snapshot.md), [fetchable-loopback-fixture.md](../docs/fetchable-loopback-fixture.md), [post-presence-offline-snapshot.md](../docs/post-presence-offline-snapshot.md) |

## R6 Pending/background jobs and asynchronous restart continuation

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R6.1 | 持久请求和后台任务可识别中断且保留进度 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R6.2 | 未证实提交的 prepared 工作保守停止且不自动重复 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts), [input-process-kill.test.ts](../tests/input-process-kill.test.ts), [input-kill-worker.ts](../tests/fixtures/input-kill-worker.ts), [input-process-kill.md](../docs/input-process-kill.md) |
| R6.3 | 可恢复的异步工作重启后继续未提交部分并准确结算 | 未满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts), [compound-reaction-budget.test.ts](../tests/compound-reaction-budget.test.ts), [compound-reaction-disk-recovery.md](../docs/compound-reaction-disk-recovery.md) |
| R6.4 | 进程强杀覆盖关键准备、提交、终结窗口且查询结果一致 | 待验证 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts), [input-process-kill.test.ts](../tests/input-process-kill.test.ts), [input-kill-worker.ts](../tests/fixtures/input-kill-worker.ts), [input-process-kill.md](../docs/input-process-kill.md) |

## R7 Extension development/install and external workspace effects

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R7.1 | 开发安装失败保留明确阶段、退出码及构建输出 | 满足 | [core-install-worktree-protection.md](../docs/core-install-worktree-protection.md), [core-install-worktree-protection.test.ts](../tests/core-install-worktree-protection.test.ts), [core-install-failure-diagnostics.test.ts](../tests/core-install-failure-diagnostics.test.ts), [coding-agent-failure-diagnostics.test.ts](../tests/coding-agent-failure-diagnostics.test.ts), [development-side-effect-matrix.v1.json](../docs/development-side-effect-matrix.v1.json) |
| R7.2 | 注册和安装受影响回归及真实本地自扩展重新验收通过 | 满足 | [build-performance-diagnosis-2026-10-20.md](../docs/build-performance-diagnosis-2026-10-20.md) |
| R7.3 | 外部工作区每类副作用具有恢复身份及安全撤回或停止 | 满足 | [core-install-worktree-protection.md](../docs/core-install-worktree-protection.md), [development-side-effect-matrix.v1.json](../docs/development-side-effect-matrix.v1.json), [core-install-worktree-protection.test.ts](../tests/core-install-worktree-protection.test.ts), [extension-development-failure-identity.test.ts](../tests/extension-development-failure-identity.test.ts), [core-install-lifecycle.test.ts](../tests/core-install-lifecycle.test.ts) |
| R7.4 | 强杀外部工具与嵌套构建后重启验收通过 | 待验证 | [build-performance-diagnosis-2026-10-20.md](../docs/build-performance-diagnosis-2026-10-20.md), [development-process-kill.md](../docs/development-process-kill.md), [development-process-kill.test.ts](../tests/development-process-kill.test.ts), [development-kill-worker.ts](../tests/fixtures/development-kill-worker.ts), [development-kill-tool.mjs](../tests/fixtures/development-kill-tool.mjs), [development-compiler-deadline.mjs](../tests/fixtures/development-compiler-deadline.mjs), [development-real-pipeline-kill.md](../docs/development-real-pipeline-kill.md), [development-real-pipeline-kill.test.ts](../tests/development-real-pipeline-kill.test.ts), [development-pipeline-deadline.mjs](../tests/fixtures/development-pipeline-deadline.mjs) |

## R8 Frontend synchronization and all System/media mutation paths

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R8.1 | 同实例 System 与媒体写协调，19个已复现覆盖写故障消失 | 满足 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |
| R8.2 | 长回合图片可写且最终凭据、HTTP 重启重放不重复行动 | 满足 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |
| R8.3 | 图片 Provider 身份、外部写者、资产 GC 不遗失权威修改 | 未满足 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md), [image-existing-content.test.ts](../tests/image-existing-content.test.ts), [image-existing-content.md](../docs/image-existing-content.md), [image-late-binding.md](../docs/image-late-binding.md), [image-late-binding.test.ts](../tests/image-late-binding.test.ts) |
| R8.4 | 前端所有写路径在断连、迟到响应、多客户端下同步正确 | 待验证 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |

## R9 Read-time current/view migration race acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R9.1 | 空闲 current/view 迁移在现有锁内重读后写 | 满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts) |
| R9.2 | 父请求准备失败不先迁移，媒体交叉不覆盖新凭据 | 满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts) |
| R9.3 | 多个服务实例或进程读迁移竞争不覆盖新提交 | 满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts), [migration-two-service.test.ts](../tests/migration-two-service.test.ts), [migration-two-service.md](../docs/migration-two-service.md), [migration-two-process.test.ts](../tests/migration-two-process.test.ts), [current-write-guard.test.ts](../tests/current-write-guard.test.ts), [migration-process-write-guard.md](../docs/migration-process-write-guard.md), [migration-interleaving-matrix.md](../docs/migration-interleaving-matrix.md), [post-process-offline-snapshot.md](../docs/post-process-offline-snapshot.md) |
| R9.4 | 进程强杀及外部替换时迁移结果和错误分类可验证 | 满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts), [migration-two-process.test.ts](../tests/migration-two-process.test.ts), [current-write-guard.test.ts](../tests/current-write-guard.test.ts), [migration-process-write-guard.md](../docs/migration-process-write-guard.md), [migration-external-image.md](../docs/migration-external-image.md), [migration-external-image.test.ts](../tests/migration-external-image.test.ts), [migration-preparation-matrix.md](../docs/migration-preparation-matrix.md), [post-migration-offline-snapshot.md](../docs/post-migration-offline-snapshot.md) |

## R10 World/global/session behavior-guidance cross-store removal/replay acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R10.1 | world 指导写入、启停、删除均准备请求并保存原凭据 | 满足 | [behavior-guidance-recovery.md](../docs/behavior-guidance-recovery.md) |
| R10.2 | 范围冲突先拒绝；全局写后丢响应从磁盘恢复缓存 | 满足 | [behavior-guidance-recovery.md](../docs/behavior-guidance-recovery.md) |
| R10.3 | global/session 删除或重启后仍识别原请求且不重新执行 | 满足 | [p0a-guidance-durable-identity.test.ts](../tests/p0a-guidance-durable-identity.test.ts), [behavior-guidance-recovery.md](../docs/behavior-guidance-recovery.md) |
| R10.4 | 明确范围移动的跨存储失败恢复与竞争策略通过验收 | 未满足 | [behavior-guidance-recovery.md](../docs/behavior-guidance-recovery.md) |

## A1 Compound speech stages bind their own uniquely authorized named recipient

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A1.1 | 各复合发言阶段绑定原文授权的唯一姓名 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts), [conditional-speech-binding.test.ts](../tests/conditional-speech-binding.test.ts), [conditional-speech-binding.md](../docs/conditional-speech-binding.md), [conditional-speech-authority-edges.test.ts](../tests/conditional-speech-authority-edges.test.ts), [conditional-speech-http-recovery.test.ts](../tests/conditional-speech-http-recovery.test.ts), [source-recipient-topic-authority.test.ts](../tests/source-recipient-topic-authority.test.ts) |
| A1.2 | 上游猜测不能覆盖原文直接收件人 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts), [conditional-speech-binding.test.ts](../tests/conditional-speech-binding.test.ts), [conditional-speech-binding.md](../docs/conditional-speech-binding.md), [conditional-speech-authority-edges.test.ts](../tests/conditional-speech-authority-edges.test.ts), [conditional-speech-http-recovery.test.ts](../tests/conditional-speech-http-recovery.test.ts), [source-recipient-topic-authority.test.ts](../tests/source-recipient-topic-authority.test.ts) |
| A1.3 | 依赖结果保留先前收件人与阶段身份 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A1.4 | 真实歧义要求澄清，实际 TALK 命中正确人物且重放不重复 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts), [conditional-speech-binding.test.ts](../tests/conditional-speech-binding.test.ts), [conditional-speech-binding.md](../docs/conditional-speech-binding.md), [conditional-speech-authority-edges.test.ts](../tests/conditional-speech-authority-edges.test.ts), [conditional-speech-http-recovery.test.ts](../tests/conditional-speech-http-recovery.test.ts), [source-recipient-topic-authority.test.ts](../tests/source-recipient-topic-authority.test.ts) |

## A2 Repeated physical attempts retain Core outcomes with one aggregate social consequence

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A2.1 | 重复身体尝试分别保留 Core 结果 | 满足 | [npc-relationship-repetition.test.ts](../tests/npc-relationship-repetition.test.ts) |
| A2.2 | 同一有界请求的社交后果只聚合一次 | 满足 | [npc-relationship-repetition.test.ts](../tests/npc-relationship-repetition.test.ts) |
| A2.3 | 不同真实事件保持独立结算 | 满足 | [npc-relationship-repetition.test.ts](../tests/npc-relationship-repetition.test.ts) |
| A2.4 | 持久化、重放与 Undo 不重复关系或丢失原始失败 | 满足 | [npc-relationship-repetition.test.ts](../tests/npc-relationship-repetition.test.ts) |

## A3 Declared result references and explicit dependency ordering in bounded plans

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A3.1 | 声明结果引用只使用已经证实的先前结果 | 满足 | [goal-contract-batch3.test.ts](../tests/goal-contract-batch3.test.ts) |
| A3.2 | 显式依赖按顺序执行且不跳过前提 | 满足 | [goal-contract-batch3.test.ts](../tests/goal-contract-batch3.test.ts) |
| A3.3 | 失败或不成立依赖保留真实部分完成状态 | 满足 | [goal-contract-batch3.test.ts](../tests/goal-contract-batch3.test.ts) |
| A3.4 | 已完成子目标恢复时不再执行 | 满足 | [goal-contract-batch3.test.ts](../tests/goal-contract-batch3.test.ts) |

## A4 General intent understanding and original-goal completion

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A4.1 | 已有 Semantic 对齐和目标契约拒绝替换最终目标 | 满足 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts) |
| A4.2 | 已实现完成证据核验，准备动作不冒充目标完成 | 满足 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts), [open-goal-completion-evidence.test.ts](../tests/open-goal-completion-evidence.test.ts), [open-goal-completion-evidence.md](../docs/open-goal-completion-evidence.md), [declared-activity-interruption.test.ts](../tests/declared-activity-interruption.test.ts), [declared-activity-interruption.md](../docs/declared-activity-interruption.md), [perception-inspection-completion.md](../docs/perception-inspection-completion.md), [perception-inspection-completion.test.ts](../tests/perception-inspection-completion.test.ts), [plan-inspection-completion.md](../docs/plan-inspection-completion.md), [plan-inspection-completion.test.ts](../tests/plan-inspection-completion.test.ts) |
| A4.3 | 开放表达的意图、边界、原目标完成有代表性离线覆盖 | 未满足 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts) |
| A4.4 | 当前模型在代表性多世界原始语句上通过目标完成验收 | 待验证 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts) |

## A5 NPC/item/place/scene-object binding across worlds

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A5.1 | NPC/item/place/scene-object 的现有候选绑定受公开场景约束 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A5.2 | 原文收件人优先于 Planner 错人，依赖执行命中正确实体 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts), [conditional-speech-binding.test.ts](../tests/conditional-speech-binding.test.ts), [conditional-speech-binding.md](../docs/conditional-speech-binding.md), [conditional-speech-authority-edges.test.ts](../tests/conditional-speech-authority-edges.test.ts), [conditional-speech-http-recovery.test.ts](../tests/conditional-speech-http-recovery.test.ts), [source-recipient-topic-authority.test.ts](../tests/source-recipient-topic-authority.test.ts) |
| A5.3 | 跨世界别名、同名、缺席和混合角色覆盖所有对象类别 | 未满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A5.4 | 固定多世界绑定语料通过，歧义不猜测 | 待验证 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |

## A6 Pronouns and contextual references

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A6.1 | 公开对话焦点与唯一在场候选支持已有代词绑定 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A6.2 | 话题人物不当收件人，真实歧义不能被 Planner 猜测解除 | 满足 | [conditional-pronoun-topic-binding.test.ts](../tests/conditional-pronoun-topic-binding.test.ts), [conditional-speech-http-recovery.test.ts](../tests/conditional-speech-http-recovery.test.ts), [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts), [source-recipient-topic-authority.test.ts](../tests/source-recipient-topic-authority.test.ts), [conditional-pronoun-topic-binding.md](../docs/conditional-pronoun-topic-binding.md) |
| A6.3 | 跨句代词、多个动作角色及上下文切换有确定验收 | 未满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A6.4 | 固定多世界指代语料通过且无过度澄清回退 | 待验证 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |

## A7 Composite/conditional goals and partial completion

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A7.1 | 已有复合与条件契约表达依赖及部分完成 | 满足 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |
| A7.2 | 条件不成立或被世界拒绝不触发技术重试翻盘 | 满足 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |
| A7.3 | 混合条件、动态目标和中途改变意图保留原授权边界 | 未满足 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts), [plan-handoff-failure.test.ts](../tests/plan-handoff-failure.test.ts), [plan-handoff-failure.md](../docs/plan-handoff-failure.md), [future-cancel-window.test.ts](../tests/future-cancel-window.test.ts), [future-cancel-window.md](../docs/future-cancel-window.md), [future-execute-window.test.ts](../tests/future-execute-window.test.ts), [future-execute-window.md](../docs/future-execute-window.md), [future-control-condition.test.ts](../tests/future-control-condition.test.ts), [future-control-condition.md](../docs/future-control-condition.md), [scene-wait-completion.md](../docs/scene-wait-completion.md), [scene-wait-completion.test.ts](../tests/scene-wait-completion.test.ts), [open-goal-wait-completion.md](../docs/open-goal-wait-completion.md), [open-goal-wait-completion.test.ts](../tests/open-goal-wait-completion.test.ts) |
| A7.4 | 固定组合语料及重启后续执行全部通过 | 待验证 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |

## A8 Freeform physical interaction and dynamic body/distance/environment prerequisites

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A8.1 | 已有 Freeform 身体动作及环境能力可结算 | 满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts) |
| A8.2 | 距离、身体和环境前提不能由描写虚构满足 | 满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts), [freeform-live-actor.md](../docs/freeform-live-actor.md), [freeform-live-actor.test.ts](../tests/freeform-live-actor.test.ts), [freeform-live-hazard.md](../docs/freeform-live-hazard.md), [freeform-live-hazard.test.ts](../tests/freeform-live-hazard.test.ts) |
| A8.3 | 开放交互涵盖各类物品、地形及能力的动态前提 | 未满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts), [sealed-item-movement.test.ts](../tests/sealed-item-movement.test.ts), [sealed-item-movement.md](../docs/sealed-item-movement.md), [sealed-item-damage.test.ts](../tests/sealed-item-damage.test.ts), [sealed-item-damage.md](../docs/sealed-item-damage.md), [tracked-item-sale.test.ts](../tests/tracked-item-sale.test.ts), [tracked-item-sale.md](../docs/tracked-item-sale.md), [equipped-item-sale.test.ts](../tests/equipped-item-sale.test.ts), [equipped-item-sale.md](../docs/equipped-item-sale.md), [sealed-equipment-access.test.ts](../tests/sealed-equipment-access.test.ts), [sealed-equipment-access.md](../docs/sealed-equipment-access.md), [destroyed-activity-resource.md](../docs/destroyed-activity-resource.md), [destroyed-activity-resource.test.ts](../tests/destroyed-activity-resource.test.ts), [freeform-time-prerequisites.md](../docs/freeform-time-prerequisites.md), [freeform-time-prerequisites.test.ts](../tests/freeform-time-prerequisites.test.ts), [freeform-live-check.md](../docs/freeform-live-check.md), [freeform-live-check.test.ts](../tests/freeform-live-check.test.ts), [freeform-live-anchor.md](../docs/freeform-live-anchor.md), [freeform-live-anchor.test.ts](../tests/freeform-live-anchor.test.ts), [destination-prerequisite-parity.md](../docs/destination-prerequisite-parity.md), [destination-prerequisite-parity.test.ts](../tests/destination-prerequisite-parity.test.ts), [freeform-live-item-contract.md](../docs/freeform-live-item-contract.md), [freeform-live-item-contract.test.ts](../tests/freeform-live-item-contract.test.ts), [sealed-storage-binding.md](../docs/sealed-storage-binding.md), [sealed-storage-binding.test.ts](../tests/sealed-storage-binding.test.ts), [freeform-consumption-authority.md](../docs/freeform-consumption-authority.md), [freeform-consumption-authority.test.ts](../tests/freeform-consumption-authority.test.ts) |
| A8.4 | 多世界自由动作语料通过，游戏内失败原样保留 | 满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts), [freeform-three-world-corpus.md](../docs/freeform-three-world-corpus.md), [freeform-three-world-corpus.test.ts](../tests/freeform-three-world-corpus.test.ts), [freeform-fixed-corpus.ts](../tests/fixtures/freeform-fixed-corpus.ts), [narrative-worlds.ts](../tests/fixtures/narrative-worlds.ts), [inventory-turn-denial.test.ts](../tests/inventory-turn-denial.test.ts) |

## A9 Broad multi-world natural-language acceptance corpus

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A9.1 | 建立固定且代表性的多世界自然语言验收集及明确期望 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [multi-world-language-corpus.md](../docs/multi-world-language-corpus.md) |
| A9.2 | 覆盖意图、绑定、条件、前提、部分完成与恢复的组合 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [multi-world-language-corpus.md](../docs/multi-world-language-corpus.md) |
| A9.3 | 在当前源代码上运行完整离线语料并保留逐项结果 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [multi-world-language-corpus.md](../docs/multi-world-language-corpus.md) |
| A9.4 | 独立复核遗漏与失败，不能只用历史或挑选样例宣布通过 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [multi-world-language-corpus.md](../docs/multi-world-language-corpus.md) |

## A10 Current-source real-provider open-action acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A10.1 | 经授权在当前代码与明确模型版本上跑开放行动 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| A10.2 | 保留原始输入、输出、Core 证据与失败，不只人工摘要 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| A10.3 | 真实模型的多世界组合语句满足固定原目标验收 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| A10.4 | 真实模型重试不重复副作用且成本与失败预算有记录 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

## W1 Sourced NPC knowledge and multi-hop hearsay in declared policy worlds

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W1.1 | NPC 知识具有直接来源或合法传递来源 | 满足 | [npc-information-propagation.test.ts](../tests/npc-information-propagation.test.ts) |
| W1.2 | 多跳传闻保留来源链和可区分置信 | 满足 | [npc-information-propagation.test.ts](../tests/npc-information-propagation.test.ts) |
| W1.3 | 私密与不在场信息不通过传播规则泄漏 | 满足 | [npc-information-propagation.test.ts](../tests/npc-information-propagation.test.ts) |
| W1.4 | 声明政策世界的传播持久化与重放保持一致 | 满足 | [npc-information-propagation.test.ts](../tests/npc-information-propagation.test.ts) |

## W2 Per-character private cognition projection

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W2.1 | 各人物私有认知按角色独立形成投影 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |
| W2.2 | 记忆、目标、关系只投影允许内容 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |
| W2.3 | 其他人物不可读到无来源私密认知 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |
| W2.4 | 投影验证和持久化回归通过且不引入全知 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |

## W3 Authored social events settle from authoritative receipts once

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W3.1 | 作者社交事件来自权威行动凭据 | 满足 | [npc-relationships.test.ts](../tests/npc-relationships.test.ts) |
| W3.2 | 相同凭据只结算一次且不同事件独立 | 满足 | [npc-relationships.test.ts](../tests/npc-relationships.test.ts) |
| W3.3 | 重复身体尝试聚合社交反应不改写物理结果 | 满足 | [npc-relationships.test.ts](../tests/npc-relationships.test.ts) |
| W3.4 | 关系持久化、重放及 Undo 验收通过 | 满足 | [npc-relationships.test.ts](../tests/npc-relationships.test.ts) |

## W4 Autonomous routines and time-credit continuity

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W4.1 | 自主生活调度保留已有物理行动连续性 | 满足 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts) |
| W4.2 | 时间额度与欠账连续且不重复推进 | 满足 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts), [npc-social-notification-credit.test.ts](../tests/npc-social-notification-credit.test.ts), [npc-notification-credit.md](../docs/npc-notification-credit.md) |
| W4.3 | 日程、旅行、突发中断与资源变化协调调整 | 未满足 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts), [routine.test.ts](../tests/routine.test.ts), [routine-partial-interruption.md](../docs/routine-partial-interruption.md), [routine-local-elapsed.test.ts](../tests/routine-local-elapsed.test.ts), [routine-local-elapsed.md](../docs/routine-local-elapsed.md), [routine-unreachable-location.test.ts](../tests/routine-unreachable-location.test.ts), [routine-unreachable-location.md](../docs/routine-unreachable-location.md), [schedule-label-migration.test.ts](../tests/schedule-label-migration.test.ts), [schedule-label-migration.md](../docs/schedule-label-migration.md) |
| W4.4 | 多世界长时间生活行为丰富且持续可执行 | 待验证 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts) |

## W5 Persistent long/short goals, executable plans and blocked-plan revision

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W5.1 | 短期和长期目标及计划已有持久结构 | 满足 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts) |
| W5.2 | 即时执行计划和阻塞计划有已验证修订路径 | 满足 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts) |
| W5.3 | 长期目标根据新事实、关系与失败作持续调整 | 满足 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts), [npc-own-resource-context.test.ts](../tests/npc-own-resource-context.test.ts), [npc-own-resource-context.md](../docs/npc-own-resource-context.md), [npc-legacy-long-goal.test.ts](../tests/npc-legacy-long-goal.test.ts), [npc-legacy-long-goal.md](../docs/npc-legacy-long-goal.md), [npc-ended-goal-execution.test.ts](../tests/npc-ended-goal-execution.test.ts), [npc-ended-goal-execution.md](../docs/npc-ended-goal-execution.md), [npc-legacy-plan-recovery.test.ts](../tests/npc-legacy-plan-recovery.test.ts), [npc-legacy-plan-recovery.md](../docs/npc-legacy-plan-recovery.md), [npc-conditional-plan-context.test.ts](../tests/npc-conditional-plan-context.test.ts), [npc-conditional-plan-context.md](../docs/npc-conditional-plan-context.md), [npc-legacy-failure-diagnostic.md](../docs/npc-legacy-failure-diagnostic.md), [npc-active-plan-revision.test.ts](../tests/npc-active-plan-revision.test.ts), [npc-active-plan-revision.md](../docs/npc-active-plan-revision.md), [npc-repeated-plan-failure.test.ts](../tests/npc-repeated-plan-failure.test.ts), [npc-repeated-plan-failure.md](../docs/npc-repeated-plan-failure.md), [npc-adaptation-trigger-matrix.test.ts](../tests/npc-adaptation-trigger-matrix.test.ts), [npc-adaptation-trigger-matrix.md](../docs/npc-adaptation-trigger-matrix.md) |
| W5.4 | 跨重启多世界长过程计划执行和修订均验收通过 | 满足 | [npc-adaptation72-scenarios.v1.json](../docs/npc-adaptation72-scenarios.v1.json), [npc-adaptation72-background-extension.v1.json](../docs/npc-adaptation72-background-extension.v1.json), [npc-adaptation72.md](../docs/npc-adaptation72.md), [npc-adaptation72.test.ts](../tests/npc-adaptation72.test.ts), [npc-replacement-transaction.test.ts](../tests/npc-replacement-transaction.test.ts) |

## W6 Body/resources and transient perception continuity

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W6.1 | 身体和资源变化由程序事实控制 | 满足 | [perception-transient-continuity.test.ts](../tests/perception-transient-continuity.test.ts) |
| W6.2 | 瞬时感知与现场连续性已有回归保护 | 满足 | [perception-transient-continuity.test.ts](../tests/perception-transient-continuity.test.ts) |
| W6.3 | 多世界长时资源消耗、恢复、行动前提保持因果 | 未满足 | [perception-transient-continuity.test.ts](../tests/perception-transient-continuity.test.ts) |
| W6.4 | 压力及重启模拟无体力、位置、感知漂移 | 待验证 | [perception-transient-continuity.test.ts](../tests/perception-transient-continuity.test.ts) |

## W7 Memory, NPC interactions and long-term relationship causality

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W7.1 | 既有经历记忆影响 NPC 决策 | 满足 | [npc-experience.test.ts](../tests/npc-experience.test.ts) |
| W7.2 | 已有关系与自主交互因果回归通过 | 满足 | [npc-experience.test.ts](../tests/npc-experience.test.ts) |
| W7.3 | 多个 NPC 的长期互动、记忆矛盾和关系变化可解释 | 未满足 | [npc-experience.test.ts](../tests/npc-experience.test.ts) |
| W7.4 | 多世界长期社会模拟保持持久且不重复结算 | 待验证 | [npc-experience.test.ts](../tests/npc-experience.test.ts) |

## W8 Background incidents, macro arcs and player absence

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W8.1 | 玩家缺席时背景事件按既有规则推进 | 满足 | [npc-long-world.test.ts](../tests/npc-long-world.test.ts) |
| W8.2 | 既有48小时模拟行动、事件结算无离屏信息泄漏 | 满足 | [npc-long-world.test.ts](../tests/npc-long-world.test.ts) |
| W8.3 | 宏观事件与角色行为有多种因果路径而非固定重复 | 未满足 | [npc-long-world.test.ts](../tests/npc-long-world.test.ts) |
| W8.4 | 扩展多世界长期模拟验证事件变化与回归稳定 | 待验证 | [npc-long-world.test.ts](../tests/npc-long-world.test.ts) |

## W9 Explicit policy/data decisions for legacy-world social authoring

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W9.1 | 明确旧世界社交政策与作者数据缺口 | 满足 | [legacy-social-policy-strategy.md](../docs/legacy-social-policy-strategy.md), [npc-relations.ts](../src/agent/npc-relations.ts), [authoring.ts](../src/ai/authoring.ts) |
| W9.2 | 制定可审查的兼容数据策略及禁止默认虚构原则 | 满足 | [legacy-social-policy-strategy.md](../docs/legacy-social-policy-strategy.md), [npc-relations.ts](../src/agent/npc-relations.ts), [authoring.ts](../src/ai/authoring.ts) |
| W9.3 | 离线副本验证政策缺失、启用与迁移的行为 | 满足 | [legacy-relationship-policy.test.ts](../tests/legacy-relationship-policy.test.ts), [legacy-relationship-policy-activation.md](../docs/legacy-relationship-policy-activation.md), [legacy-social-policy-strategy.md](../docs/legacy-social-policy-strategy.md) |
| W9.4 | 经明确授权后执行所需正式数据变更或确认无需迁移 | 待验证 | [claude-takeover-integration.md](../docs/claude-takeover-integration.md) |

## W10 Multi-world extended-duration and future multiplayer acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W10.1 | 建立固定多世界长期模拟场景与失败标准 | 满足 | [fixed-world72-evidence.md](../docs/fixed-world72-evidence.md), [fixed-world72-scenarios.v1.json](../docs/fixed-world72-scenarios.v1.json), [fixed-world72.test.ts](../tests/fixed-world72.test.ts) |
| W10.2 | 定义未来多人共享权威、竞争和重连语义 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| W10.3 | 离线长时多实例或多进程场景通过 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| W10.4 | 多人目标按既定范围通过独立验收 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

## N1 Ordinary/refine Narrator share private cognition projection

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N1.1 | 普通 Narrator 使用私有认知投影 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |
| N1.2 | refine 使用同样投影和权限边界 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |
| N1.3 | 人物在场与感知限制不因 refine 被绕过 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |
| N1.4 | 运行时集成回归证明无全知泄漏 | 满足 | [narrator-character-cognition.test.ts](../tests/narrator-character-cognition.test.ts) |

## N2 Technical narration repair does not replay committed world effects

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N2.1 | 叙述技术修复使用已结算事实 | 满足 | [narrative-bounded-retry.test.ts](../tests/narrative-bounded-retry.test.ts) |
| N2.2 | 已提交行动不因重述再次执行 | 满足 | [narrative-bounded-retry.test.ts](../tests/narrative-bounded-retry.test.ts) |
| N2.3 | 局部失败保留已完成步骤及原请求凭据 | 满足 | [narrative-bounded-retry.test.ts](../tests/narrative-bounded-retry.test.ts) |
| N2.4 | 有界重试、回退与重启恢复回归通过 | 满足 | [narrative-bounded-retry.test.ts](../tests/narrative-bounded-retry.test.ts) |

## N3 Multi-step physical/speech presentation retains settled steps

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N3.1 | 复合行动叙述聚合已结算步骤 | 满足 | [compound-narration-aggregation.test.ts](../tests/compound-narration-aggregation.test.ts) |
| N3.2 | 身体和发言结果以凭据为准不重演 | 满足 | [compound-narration-aggregation.test.ts](../tests/compound-narration-aggregation.test.ts) |
| N3.3 | 多步叙述完整表达成功、失败与未执行的区别 | 未满足 | [compound-narration-aggregation.test.ts](../tests/compound-narration-aggregation.test.ts), [compound-degraded-prose.test.ts](../tests/compound-degraded-prose.test.ts), [compound-degraded-prose.md](../docs/compound-degraded-prose.md), [partial-plan-visible-status.test.ts](../tests/partial-plan-visible-status.test.ts), [partial-plan-visible-status.md](../docs/partial-plan-visible-status.md), [compound-reaction-budget.test.ts](../tests/compound-reaction-budget.test.ts), [compound-reaction-ownership.md](../docs/compound-reaction-ownership.md), [item-action-degraded-prose.test.ts](../tests/item-action-degraded-prose.test.ts), [item-action-degraded-prose.md](../docs/item-action-degraded-prose.md), [hold-activity-fallback.test.ts](../tests/hold-activity-fallback.test.ts), [hold-activity-fallback.md](../docs/hold-activity-fallback.md), [scene-wait-completion.md](../docs/scene-wait-completion.md), [scene-wait-completion.test.ts](../tests/scene-wait-completion.test.ts), [open-goal-wait-completion.md](../docs/open-goal-wait-completion.md), [open-goal-wait-completion.test.ts](../tests/open-goal-wait-completion.test.ts) |
| N3.4 | 多世界长复合动作描写自然且不漏步骤 | 待验证 | [compound-narration-aggregation.test.ts](../tests/compound-narration-aggregation.test.ts) |

## N4 Facts, presence, perception and legal-description false rejection balance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N4.1 | 已有事实、在场和感知校验阻止越权描写 | 满足 | [post-presence-offline-snapshot.md](../docs/post-presence-offline-snapshot.md), [perception-audit-authority.md](../docs/perception-audit-authority.md), [builtin-narration-authority.md](../docs/builtin-narration-authority.md), [movement-presence-authority.md](../docs/movement-presence-authority.md), [perception-audit-authority.test.ts](../tests/perception-audit-authority.test.ts), [builtin-narration-authority.test.ts](../tests/builtin-narration-authority.test.ts), [movement-presence-authority.test.ts](../tests/movement-presence-authority.test.ts), [freeform-live-check.md](../docs/freeform-live-check.md), [freeform-live-check.test.ts](../tests/freeform-live-check.test.ts), [scene-presence-quoted-speech.md](../docs/scene-presence-quoted-speech.md), [scene-presence-quoted-speech.test.ts](../tests/scene-presence-quoted-speech.test.ts), [perception-joined-pronoun.md](../docs/perception-joined-pronoun.md), [perception-joined-pronoun.test.ts](../tests/perception-joined-pronoun.test.ts), [scene-presence-temporal-pronoun.md](../docs/scene-presence-temporal-pronoun.md), [scene-presence-temporal-pronoun.test.ts](../tests/scene-presence-temporal-pronoun.test.ts), [typed-speech-occurrence-scope.md](../docs/typed-speech-occurrence-scope.md), [typed-speech-occurrence-scope.test.ts](../tests/typed-speech-occurrence-scope.test.ts), [narrative-fixed-corpus.md](../docs/narrative-fixed-corpus.md), [narrative-fixed-corpus.test.ts](../tests/narrative-fixed-corpus.test.ts), [item-condition-narrative.test.ts](../tests/item-condition-narrative.test.ts) |
| N4.2 | 已知合法描写及误拒边界有回归证据 | 满足 | [post-presence-offline-snapshot.md](../docs/post-presence-offline-snapshot.md), [npc-movement-narration-authority.md](../docs/npc-movement-narration-authority.md), [movement-presence-authority.md](../docs/movement-presence-authority.md), [npc-movement-narration-authority.test.ts](../tests/npc-movement-narration-authority.test.ts), [movement-presence-authority.test.ts](../tests/movement-presence-authority.test.ts), [freeform-three-world-corpus.md](../docs/freeform-three-world-corpus.md), [freeform-three-world-corpus.test.ts](../tests/freeform-three-world-corpus.test.ts), [inventory-turn-denial.test.ts](../tests/inventory-turn-denial.test.ts) |
| N4.3 | 扩大合法比喻、转述和场景表述语料降低误拒 | 满足 | [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts), [scene-presence-negation.test.ts](../tests/scene-presence-negation.test.ts), [scene-presence-negation.md](../docs/scene-presence-negation.md), [scene-presence-subjects.test.ts](../tests/scene-presence-subjects.test.ts), [scene-presence-subjects.md](../docs/scene-presence-subjects.md), [scene-presence-groups.test.ts](../tests/scene-presence-groups.test.ts), [scene-presence-groups.md](../docs/scene-presence-groups.md), [perception-subjects.test.ts](../tests/perception-subjects.test.ts), [perception-subjects.md](../docs/perception-subjects.md), [scene-presence-local-steps.md](../docs/scene-presence-local-steps.md), [scene-presence-local-steps.test.ts](../tests/scene-presence-local-steps.test.ts), [scene-presence-quoted-speech.md](../docs/scene-presence-quoted-speech.md), [scene-presence-quoted-speech.test.ts](../tests/scene-presence-quoted-speech.test.ts), [perception-joined-pronoun.md](../docs/perception-joined-pronoun.md), [perception-joined-pronoun.test.ts](../tests/perception-joined-pronoun.test.ts), [scene-presence-temporal-pronoun.md](../docs/scene-presence-temporal-pronoun.md), [scene-presence-temporal-pronoun.test.ts](../tests/scene-presence-temporal-pronoun.test.ts), [perception-simile-authority.md](../docs/perception-simile-authority.md), [perception-simile-authority.test.ts](../tests/perception-simile-authority.test.ts), [inventory-denial-prose.md](../docs/inventory-denial-prose.md), [inventory-denial-prose.test.ts](../tests/inventory-denial-prose.test.ts), [narrative-fixed-corpus.md](../docs/narrative-fixed-corpus.md), [narrative-fixed-corpus.test.ts](../tests/narrative-fixed-corpus.test.ts), [item-condition-narrative.test.ts](../tests/item-condition-narrative.test.ts) |
| N4.4 | 多世界误放与误拒均按固定期望验收 | 满足 | [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts), [narrative-fixed-corpus.md](../docs/narrative-fixed-corpus.md), [narrative-three-worlds.md](../docs/narrative-three-worlds.md), [narrative-fixed-corpus.ts](../tests/fixtures/narrative-fixed-corpus.ts), [narrative-worlds.ts](../tests/fixtures/narrative-worlds.ts), [narrative-three-worlds.test.ts](../tests/narrative-three-worlds.test.ts), [narrative-three-world-boundaries.test.ts](../tests/narrative-three-world-boundaries.test.ts) |

## N5 NPC speech reflects personality, memory and relationships

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N5.1 | 人物发言可获得受限人格与记忆上下文 | 满足 | [npc-dialogue-style.test.ts](../tests/npc-dialogue-style.test.ts) |
| N5.2 | 关系与私有认知已经接入叙述路径 | 满足 | [npc-dialogue-style.test.ts](../tests/npc-dialogue-style.test.ts) |
| N5.3 | 固定盲评或可复核样例区分人物声线和关系变化 | 未满足 | [npc-dialogue-style.test.ts](../tests/npc-dialogue-style.test.ts) |
| N5.4 | 真实模型多人物对话质量经授权验收 | 待验证 | [npc-dialogue-style.test.ts](../tests/npc-dialogue-style.test.ts) |

## N6 Inventory/object grounding and no invented usable assets

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N6.1 | 物品与可用资产的存在受权威事实限制 | 满足 | [initial-possessions.test.ts](../tests/initial-possessions.test.ts), [local-scene-materialization.test.ts](../tests/local-scene-materialization.test.ts), [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts) |
| N6.2 | 已有持有与 materialization/firewall 回归阻止虚构可用物 | 满足 | [initial-possessions.test.ts](../tests/initial-possessions.test.ts), [local-scene-materialization.test.ts](../tests/local-scene-materialization.test.ts), [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts) |
| N6.3 | 开放容器、环境物、临时物与转交组合有固定覆盖 | 未满足 | [initial-possessions.test.ts](../tests/initial-possessions.test.ts), [local-scene-materialization.test.ts](../tests/local-scene-materialization.test.ts), [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts), [contained-evidence-access.test.ts](../tests/contained-evidence-access.test.ts), [contained-evidence-access.md](../docs/contained-evidence-access.md), [sealed-item-movement.test.ts](../tests/sealed-item-movement.test.ts), [sealed-item-movement.md](../docs/sealed-item-movement.md), [sealed-item-damage.test.ts](../tests/sealed-item-damage.test.ts), [sealed-item-damage.md](../docs/sealed-item-damage.md), [tracked-item-sale.test.ts](../tests/tracked-item-sale.test.ts), [tracked-item-sale.md](../docs/tracked-item-sale.md), [equipped-item-sale.test.ts](../tests/equipped-item-sale.test.ts), [equipped-item-sale.md](../docs/equipped-item-sale.md), [sealed-equipment-access.test.ts](../tests/sealed-equipment-access.test.ts), [sealed-equipment-access.md](../docs/sealed-equipment-access.md) |
| N6.4 | 多世界物品描写与后续可用性完全一致 | 待验证 | [initial-possessions.test.ts](../tests/initial-possessions.test.ts), [local-scene-materialization.test.ts](../tests/local-scene-materialization.test.ts), [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts) |

## N7 Long-term continuity and contradictory expression prevention

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N7.1 | 已有短期场景及事件连续性验证 | 满足 | [continuity.test.ts](../tests/continuity.test.ts) |
| N7.2 | 记忆与私有认知投影不会直接自相矛盾 | 满足 | [continuity.test.ts](../tests/continuity.test.ts) |
| N7.3 | 长时角色表达、位置、承诺及事件回忆保持一致 | 未满足 | [continuity.test.ts](../tests/continuity.test.ts) |
| N7.4 | 多世界长过程读写重启后的叙事连续性验收通过 | 待验证 | [continuity.test.ts](../tests/continuity.test.ts) |

## N8 Natural degraded narration quality across scene types

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N8.1 | 固定各类场景降级描写质量标准与样例 | 满足 | [degraded-prose-acceptance.v1.json](../docs/degraded-prose-acceptance.v1.json), [degraded-prose-grounding.md](../docs/degraded-prose-grounding.md), [degraded-prose-grounding.test.ts](../tests/degraded-prose-grounding.test.ts), [degraded-prose-grounding.test.ts.snap](../tests/__snapshots__/degraded-prose-grounding.test.ts.snap) |
| N8.2 | 降级文本自然表达已结算事实及未完成部分 | 未满足 | [narration-degradation-http.test.ts](../tests/narration-degradation-http.test.ts), [compound-degraded-prose.test.ts](../tests/compound-degraded-prose.test.ts), [compound-degraded-prose.md](../docs/compound-degraded-prose.md), [compound-reaction-budget.test.ts](../tests/compound-reaction-budget.test.ts), [compound-reaction-ownership.md](../docs/compound-reaction-ownership.md), [item-action-degraded-prose.test.ts](../tests/item-action-degraded-prose.test.ts), [item-action-degraded-prose.md](../docs/item-action-degraded-prose.md), [hold-activity-fallback.test.ts](../tests/hold-activity-fallback.test.ts), [hold-activity-fallback.md](../docs/hold-activity-fallback.md) |
| N8.3 | 身体、对话、观察、移动的降级文本逐项验收通过 | 满足 | [degraded-prose-acceptance.v1.json](../docs/degraded-prose-acceptance.v1.json), [degraded-prose-grounding.md](../docs/degraded-prose-grounding.md), [degraded-prose-grounding.test.ts](../tests/degraded-prose-grounding.test.ts), [degraded-prose-grounding.test.ts.snap](../tests/__snapshots__/degraded-prose-grounding.test.ts.snap), [wait-interruption-fallback.test.ts](../tests/wait-interruption-fallback.test.ts), [wait-interruption-fallback.md](../docs/wait-interruption-fallback.md) |
| N8.4 | 当前模型与离线回退组合均不输出工具式总结 | 待验证 | [narration-degradation-http.test.ts](../tests/narration-degradation-http.test.ts) |

## N9 Broad multi-world differentiated prose benchmark

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N9.1 | 固定多世界差异化文本基准和可复核评分表 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [narrator-prose-benchmark.md](../docs/narrator-prose-benchmark.md), [narrator-prose-benchmark.v1.json](../docs/narrator-prose-benchmark.v1.json), [narrator-prose-benchmark.mjs](../scripts/narrator-prose-benchmark.mjs), [narrator-prose-benchmark-capture.ts](../scripts/narrator-prose-benchmark-capture.ts) |
| N9.2 | 覆盖人物声音、节奏、感知、自然度和连续性 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [narrator-prose-benchmark.md](../docs/narrator-prose-benchmark.md), [narrator-prose-benchmark.v1.json](../docs/narrator-prose-benchmark.v1.json), [narrator-prose-benchmark.mjs](../scripts/narrator-prose-benchmark.mjs), [narrator-prose-benchmark-capture.ts](../scripts/narrator-prose-benchmark-capture.ts) |
| N9.3 | 当前源代码跑完整基准并公开逐项未达标结果 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md), [narrator-prose-benchmark.md](../docs/narrator-prose-benchmark.md), [narrator-prose-benchmark.v1.json](../docs/narrator-prose-benchmark.v1.json), [narrator-prose-benchmark.mjs](../scripts/narrator-prose-benchmark.mjs), [narrator-prose-benchmark-capture.ts](../scripts/narrator-prose-benchmark-capture.ts) |
| N9.4 | 独立或人工复核通过，不能用事实测试替代质量验收 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

## N10 Current-source real-provider and human play acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N10.1 | 经授权使用当前代码及真实 Provider 进行叙述验收 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N10.2 | 多世界真实游戏长会话有人类体验证据 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N10.3 | 用户验收叙述自然度、行动感与事实一致性 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N10.4 | 授权部署后的正式环境验收与回退方案完成 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

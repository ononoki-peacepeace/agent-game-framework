# 四大主题可复核进度

计分版本 v1；评估源代码：7ecc07b。整体 **60.00%**（96/160 个固定条件满足）。未满足 28，待验证 36。

四主题各25%，原40项各2.5%，每项预先固定4个条件、各0.625个百分点。未满足与待验证均不计分；不代表它们没有任何代码。该数值表示已获证据的验收条件权重，不是工时、风险或上线成功概率。

| 主题 | 满足 | 未满足 | 待验证 | 完成/部分/未完成项 | 主题进度 |
|---|---:|---:|---:|---|---:|
| ① 可靠性 | 30 | 6 | 4 | 4/6/0 | 75.0% |
| ② 自然语言行动 | 22 | 7 | 11 | 3/5/2 | 55.0% |
| ③ 自主持续世界 | 24 | 7 | 9 | 3/6/1 | 60.0% |
| ④ Narrator 与体验 | 20 | 8 | 12 | 2/6/2 | 50.0% |
| 合计 | 96 | 28 | 36 | 12/23/5 | 60.00% |

旧台账的12/21/7是工作包人工分类，保留作历史。这里的完成/部分/未完成由4个条件满足数推导，不能与旧分类混用。旧46%为退役估计；首次建立口径不是产品进展，不计算相对46%的提升。

条件冻结于 [criteria v1](four-theme-acceptance-criteria.v1.json)，21个部分完成包的具体场景和关闭标准见 [验收细则](four-theme-verification-protocol.v1.md)；逐条状态、依据及批次变化见 [progress JSON](four-theme-progress.json)。运行 `node scripts/four-theme-progress.mjs` 验证并重建本文。历史局部回归不等于最新全套通过；各 met 的依据注明证据时点。真实 Provider、正式数据、部署及人工验收没有证据时均不计分，也不因此阻塞其他离线开发。

规则：不得通过拆条件、改变分母、降低通过条件抬高分数；若发现原范围缺陷，撤回对应 met 并记录负向变化；新增范围风险单列，不能增加原范围得分。确需变更范围时另建版本，保留旧口径和桥接对照，不能覆盖 v1。各包等权是固定、可复算的管理约定，并不声称复杂度相同。

本口径建立后登记的原范围缺陷：17 已修复，0 开放；新增范围风险 0。这些记录不增加分母，也不自动获得完整条件分数。

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
| R5.1 | 已有故障矩阵区分技术失败与游戏内失败，保留已提交步骤 | 满足 | [qa-ai-recovery-coverage.md](../docs/qa-ai-recovery-coverage.md) |
| R5.2 | 已有分层修复与安全停止测试验证不重复 Core 副作用 | 满足 | [qa-ai-recovery-coverage.md](../docs/qa-ai-recovery-coverage.md) |
| R5.3 | 逐条关闭矩阵中仍未核验的嵌套故障出口 | 未满足 | [qa-ai-recovery-coverage.md](../docs/qa-ai-recovery-coverage.md), [partial-plan-visible-status.test.ts](../tests/partial-plan-visible-status.test.ts), [partial-plan-visible-status.md](../docs/partial-plan-visible-status.md) |
| R5.4 | 最新完整离线代码快照全套通过，旧失败不得改写为通过 | 满足 | [current-offline-snapshot.md](../docs/current-offline-snapshot.md) |

## R6 Pending/background jobs and asynchronous restart continuation

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R6.1 | 持久请求和后台任务可识别中断且保留进度 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R6.2 | 未证实提交的 prepared 工作保守停止且不自动重复 | 满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R6.3 | 可恢复的异步工作重启后继续未提交部分并准确结算 | 未满足 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |
| R6.4 | 进程强杀覆盖关键准备、提交、终结窗口且查询结果一致 | 待验证 | [request-restart-recovery.test.ts](../tests/request-restart-recovery.test.ts) |

## R7 Extension development/install and external workspace effects

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R7.1 | 开发安装失败保留明确阶段、退出码及构建输出 | 满足 | [build-performance-diagnosis-2026-10-20.md](../docs/build-performance-diagnosis-2026-10-20.md) |
| R7.2 | 注册和安装受影响回归及真实本地自扩展重新验收通过 | 满足 | [build-performance-diagnosis-2026-10-20.md](../docs/build-performance-diagnosis-2026-10-20.md) |
| R7.3 | 外部工作区每类副作用具有恢复身份及安全撤回或停止 | 未满足 | [build-performance-diagnosis-2026-10-20.md](../docs/build-performance-diagnosis-2026-10-20.md) |
| R7.4 | 强杀外部工具与嵌套构建后重启验收通过 | 待验证 | [build-performance-diagnosis-2026-10-20.md](../docs/build-performance-diagnosis-2026-10-20.md) |

## R8 Frontend synchronization and all System/media mutation paths

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R8.1 | 同实例 System 与媒体写协调，19个已复现覆盖写故障消失 | 满足 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |
| R8.2 | 长回合图片可写且最终凭据、HTTP 重启重放不重复行动 | 满足 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |
| R8.3 | 图片 Provider 身份、外部写者、资产 GC 不遗失权威修改 | 未满足 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |
| R8.4 | 前端所有写路径在断连、迟到响应、多客户端下同步正确 | 待验证 | [media-canonical-coordination.md](../docs/media-canonical-coordination.md) |

## R9 Read-time current/view migration race acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| R9.1 | 空闲 current/view 迁移在现有锁内重读后写 | 满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts) |
| R9.2 | 父请求准备失败不先迁移，媒体交叉不覆盖新凭据 | 满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts) |
| R9.3 | 多个服务实例或进程读迁移竞争不覆盖新提交 | 未满足 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts) |
| R9.4 | 进程强杀及外部替换时迁移结果和错误分类可验证 | 待验证 | [p0a-migration-read-races.test.ts](../tests/p0a-migration-read-races.test.ts) |

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
| A1.1 | 各复合发言阶段绑定原文授权的唯一姓名 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A1.2 | 上游猜测不能覆盖原文直接收件人 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A1.3 | 依赖结果保留先前收件人与阶段身份 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A1.4 | 真实歧义要求澄清，实际 TALK 命中正确人物且重放不重复 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |

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
| A4.2 | 已实现完成证据核验，准备动作不冒充目标完成 | 满足 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts) |
| A4.3 | 开放表达的意图、边界、原目标完成有代表性离线覆盖 | 未满足 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts) |
| A4.4 | 当前模型在代表性多世界原始语句上通过目标完成验收 | 待验证 | [goal-contract-batch1.test.ts](../tests/goal-contract-batch1.test.ts) |

## A5 NPC/item/place/scene-object binding across worlds

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A5.1 | NPC/item/place/scene-object 的现有候选绑定受公开场景约束 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A5.2 | 原文收件人优先于 Planner 错人，依赖执行命中正确实体 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A5.3 | 跨世界别名、同名、缺席和混合角色覆盖所有对象类别 | 未满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A5.4 | 固定多世界绑定语料通过，歧义不猜测 | 待验证 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |

## A6 Pronouns and contextual references

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A6.1 | 公开对话焦点与唯一在场候选支持已有代词绑定 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A6.2 | 话题人物不当收件人，真实歧义不能被 Planner 猜测解除 | 满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A6.3 | 跨句代词、多个动作角色及上下文切换有确定验收 | 未满足 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |
| A6.4 | 固定多世界指代语料通过且无过度澄清回退 | 待验证 | [goal-stage-person-binding.test.ts](../tests/goal-stage-person-binding.test.ts) |

## A7 Composite/conditional goals and partial completion

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A7.1 | 已有复合与条件契约表达依赖及部分完成 | 满足 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |
| A7.2 | 条件不成立或被世界拒绝不触发技术重试翻盘 | 满足 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |
| A7.3 | 混合条件、动态目标和中途改变意图保留原授权边界 | 未满足 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |
| A7.4 | 固定组合语料及重启后续执行全部通过 | 待验证 | [goal-contract-batch2.test.ts](../tests/goal-contract-batch2.test.ts) |

## A8 Freeform physical interaction and dynamic body/distance/environment prerequisites

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A8.1 | 已有 Freeform 身体动作及环境能力可结算 | 满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts) |
| A8.2 | 距离、身体和环境前提不能由描写虚构满足 | 满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts) |
| A8.3 | 开放交互涵盖各类物品、地形及能力的动态前提 | 未满足 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts) |
| A8.4 | 多世界自由动作语料通过，游戏内失败原样保留 | 待验证 | [low-stakes-open-goal.test.ts](../tests/low-stakes-open-goal.test.ts) |

## A9 Broad multi-world natural-language acceptance corpus

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| A9.1 | 建立固定且代表性的多世界自然语言验收集及明确期望 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| A9.2 | 覆盖意图、绑定、条件、前提、部分完成与恢复的组合 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| A9.3 | 在当前源代码上运行完整离线语料并保留逐项结果 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| A9.4 | 独立复核遗漏与失败，不能只用历史或挑选样例宣布通过 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

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
| W4.2 | 时间额度与欠账连续且不重复推进 | 满足 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts) |
| W4.3 | 日程、旅行、突发中断与资源变化协调调整 | 未满足 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts) |
| W4.4 | 多世界长时间生活行为丰富且持续可执行 | 待验证 | [npc-physical-plan-continuity.test.ts](../tests/npc-physical-plan-continuity.test.ts) |

## W5 Persistent long/short goals, executable plans and blocked-plan revision

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W5.1 | 短期和长期目标及计划已有持久结构 | 满足 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts) |
| W5.2 | 即时执行计划和阻塞计划有已验证修订路径 | 满足 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts) |
| W5.3 | 长期目标根据新事实、关系与失败作持续调整 | 未满足 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts), [npc-own-resource-context.test.ts](../tests/npc-own-resource-context.test.ts), [npc-own-resource-context.md](../docs/npc-own-resource-context.md), [npc-legacy-long-goal.test.ts](../tests/npc-legacy-long-goal.test.ts), [npc-legacy-long-goal.md](../docs/npc-legacy-long-goal.md), [npc-ended-goal-execution.test.ts](../tests/npc-ended-goal-execution.test.ts), [npc-ended-goal-execution.md](../docs/npc-ended-goal-execution.md) |
| W5.4 | 跨重启多世界长过程计划执行和修订均验收通过 | 待验证 | [npc-persistent-plans.test.ts](../tests/npc-persistent-plans.test.ts) |

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
| W9.3 | 离线副本验证政策缺失、启用与迁移的行为 | 待验证 | [claude-takeover-integration.md](../docs/claude-takeover-integration.md) |
| W9.4 | 经明确授权后执行所需正式数据变更或确认无需迁移 | 待验证 | [claude-takeover-integration.md](../docs/claude-takeover-integration.md) |

## W10 Multi-world extended-duration and future multiplayer acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| W10.1 | 建立固定多世界长期模拟场景与失败标准 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
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
| N3.3 | 多步叙述完整表达成功、失败与未执行的区别 | 未满足 | [compound-narration-aggregation.test.ts](../tests/compound-narration-aggregation.test.ts), [compound-degraded-prose.test.ts](../tests/compound-degraded-prose.test.ts), [compound-degraded-prose.md](../docs/compound-degraded-prose.md), [partial-plan-visible-status.test.ts](../tests/partial-plan-visible-status.test.ts), [partial-plan-visible-status.md](../docs/partial-plan-visible-status.md), [compound-reaction-budget.test.ts](../tests/compound-reaction-budget.test.ts), [compound-reaction-ownership.md](../docs/compound-reaction-ownership.md) |
| N3.4 | 多世界长复合动作描写自然且不漏步骤 | 待验证 | [compound-narration-aggregation.test.ts](../tests/compound-narration-aggregation.test.ts) |

## N4 Facts, presence, perception and legal-description false rejection balance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N4.1 | 已有事实、在场和感知校验阻止越权描写 | 满足 | [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts), [compound-physical-firewall.test.ts](../tests/compound-physical-firewall.test.ts), [compound-physical-firewall.md](../docs/compound-physical-firewall.md), [compound-degraded-prose.test.ts](../tests/compound-degraded-prose.test.ts), [physical-reaction-speech-integrity.md](../docs/physical-reaction-speech-integrity.md) |
| N4.2 | 已知合法描写及误拒边界有回归证据 | 满足 | [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts), [repeated-physical-narrative-scope.test.ts](../tests/repeated-physical-narrative-scope.test.ts), [repeated-physical-narrative-scope.md](../docs/repeated-physical-narrative-scope.md) |
| N4.3 | 扩大合法比喻、转述和场景表述语料降低误拒 | 未满足 | [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts) |
| N4.4 | 多世界误放与误拒均按固定期望验收 | 待验证 | [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts) |

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
| N6.3 | 开放容器、环境物、临时物与转交组合有固定覆盖 | 未满足 | [initial-possessions.test.ts](../tests/initial-possessions.test.ts), [local-scene-materialization.test.ts](../tests/local-scene-materialization.test.ts), [narrative-firewall-observability.test.ts](../tests/narrative-firewall-observability.test.ts) |
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
| N8.2 | 降级文本自然表达已结算事实及未完成部分 | 未满足 | [narration-degradation-http.test.ts](../tests/narration-degradation-http.test.ts), [compound-degraded-prose.test.ts](../tests/compound-degraded-prose.test.ts), [compound-degraded-prose.md](../docs/compound-degraded-prose.md), [compound-reaction-budget.test.ts](../tests/compound-reaction-budget.test.ts), [compound-reaction-ownership.md](../docs/compound-reaction-ownership.md) |
| N8.3 | 身体、对话、观察、移动的降级文本逐项验收通过 | 满足 | [degraded-prose-acceptance.v1.json](../docs/degraded-prose-acceptance.v1.json), [degraded-prose-grounding.md](../docs/degraded-prose-grounding.md), [degraded-prose-grounding.test.ts](../tests/degraded-prose-grounding.test.ts), [degraded-prose-grounding.test.ts.snap](../tests/__snapshots__/degraded-prose-grounding.test.ts.snap) |
| N8.4 | 当前模型与离线回退组合均不输出工具式总结 | 待验证 | [narration-degradation-http.test.ts](../tests/narration-degradation-http.test.ts) |

## N9 Broad multi-world differentiated prose benchmark

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N9.1 | 固定多世界差异化文本基准和可复核评分表 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N9.2 | 覆盖人物声音、节奏、感知、自然度和连续性 | 未满足 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N9.3 | 当前源代码跑完整基准并公开逐项未达标结果 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N9.4 | 独立或人工复核通过，不能用事实测试替代质量验收 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

## N10 Current-source real-provider and human play acceptance

| 条件 | 具体通过条件 | 状态 | 依据 |
|---|---|---|---|
| N10.1 | 经授权使用当前代码及真实 Provider 进行叙述验收 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N10.2 | 多世界真实游戏长会话有人类体验证据 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N10.3 | 用户验收叙述自然度、行动感与事实一致性 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |
| N10.4 | 授权部署后的正式环境验收与回退方案完成 | 待验证 | [four-theme-acceptance-status.md](../docs/four-theme-acceptance-status.md) |

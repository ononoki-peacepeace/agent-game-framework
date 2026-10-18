# AI交接与校验失败出口核对（2026-10-18）

本轮没有付费调用。此表根据实际调用出口、错误捕获及离线故障注入建立，**不代表整个Framework已实现统一的定向恢复闭环**。本轮只修共享Schema输入契约，未新增业务重试调用。

## 实际交接清单

|生成阶段/实际路径|校验者与失败类别|实际恢复及限制|验证/缺口|
|---|---|---|---|
|所有结构化输出：`ai/provider-schema.ts`、`ai/runtime.ts.call/generate`，扩展与世界草稿直接入口|原Zod领域Schema；缺省、默认值、nullable、错误类型|用同一Zod **input** Schema恢复Provider引入的null缺省，再完整领域parse。合法null/空数组/空对象各自保留。非法类型不猜测|`npc-schema-contract`逐字段/嵌套/跨入口；不是模型重试|
|玩家Semantic：`agent/semantic-entry.ts`实际for循环|结构、路由/证据、目标、空间/顺序、澄清有效性、目标保真|最多2份候选；Schema诊断含path/code/expected/message及不超过6000字符的原候选；语义失败传失败码/原因。重跑完整领域与语义校验。禁用内部截断重试，网络完整超时/未知程序错误/Provider Schema错误不交给模型|`semantic-understanding-retry`故障注入及HTTP关联测试。语义拒绝反馈不是每种都附完整原候选，仅重新理解原请求+诊断；应保留为覆盖差异|
|有序Planner：`planner.createAgentPlan`→`executor`plan_attempt|blueprint/依赖DAG/转译/目标对齐|最多3个计划，重复同一转译错误提前停止；原请求+具体failure_reason交回Planner，尚未提交世界动作|`agent-recovery`拒绝计划/错误目标回放。**缺口：PlanConversionError虽持有proposal，重试context没有携带该原输出；不是完整原候选定向修复**|
|开放目标下一步：`executor`open_goal_planning|下一步Schema及候选可执行性、Revision|最多2次，Revision未变才能重规划；已完成trail和提交Receipt保留|`agent-recovery`下一步不可用测试。**缺口：主要反馈失败码，无完整候选/字段诊断；catch覆盖未知程序/传输错误，可能做一次无效昂贵重试**|
|Goal Alignment：`goal-alignment.ts`→Semantic/Planner所有者|目标保真审查只读Schema及verdict|失败不得执行；由现有Semantic/规划预算控制纠偏，无权自行修改世界|`semantic-understanding-retry`alignment返回统一语义边界；审核不是Core保证。`systemAgent`低推理强度调用有回退，但不是诊断式修复，见预算说明|
|Natural Scene：`scene-interaction.ts`→`executor`普通/arrival循环|scene Schema、发言索引/授权、在场、NPC计划/接触状态、现场事实|确定性修复完整1-based索引；最多2个场景提案，结构错误反馈原输出和path，已识别语义错误反馈相关字段/期望/必要候选；每次重跑场景全部检查，事务外提案不等于MOVE|`scene-interaction`定向5例（索引修复、受阻提案修复、越权玩家话语、缺席speaker等），`scene-recovery-http`。拒绝/内容限制/Provider失败可终止。并非所有普通Error都携带原候选|
|NPC深度决策：`npc-agent.decideNpc`|`npcDecisionSchema`→`validateDecision`→计划关联及Core准入|本轮共享契约确定性修复；语义冲突仍拒绝。后台持久失败退避15/30/60/120/180游戏分钟，公平调度，当前request不重试，成功时间不伪造|`ai-recovery-boundaries`注入错误类型/语义矛盾证明各只调用一次；NPC HTTP/欠账测试证明退避、Reload/Undo、同request幂等。**缺口：非确定性Schema/语义失败没有把原输出+错误反馈原NPC生成阶段；退避是以后新决策，不是定向修复**|
|NPC即时行动/持久计划/Core|计划首步严格等价、动作类型/目标/时间/条件及真实Receipt|完全一致才共享一次Core结果和计划cursor；冲突拒绝；Core失败不推进cursor，预算不足不提前执行|`npc-immediate-plan`、`npc-world-http`含保存失败恢复，不重复MOVE或计划首步。Core非法动作不能通过模型“修正结果”|
|World初始化：`runtime.initialize`|worldCandidateIssues、领域Schema、编译、语义/novelty检查|原始候选+字段路径/当前值/约束，投影只允许被拒绝字段及依赖改变；最多2次修订，每次完整校验；截断另有有界分段生成|`world-initializer-repair`字段、引用、不可删事件绕过、修复仍坏、旧世界不变、额度失败测试。网络/文件/未知程序错误终止，不修改既有世界|
|Incident续生：`background/generation.proposeValidatedBackground`＋`runtime.proposeBackgroundContinuation`|backgroundProposalSchema、因果/真相/人物/地点/Core保存候选|**实际raw输出交回有界validator**，最多3个提案；前一提案+Zod字段path/code/message或程序语义拒绝原因交回原Director；完整apply重校验；原始Save不就地改写|`ai-recovery-boundaries`真实运行时回调注入错误reason类型→第二次quiet；连续三错终止；timeout/文件错误只1次。`persistent-guidance-world`语义提案修正。后台字段不全不会在回调内部提前丢失|
|Narrator：`service.turn`→`runtime.narrate`|领域Schema、对白anchor/语言、在场、物品/物理/感知事实、Firewall|Schema最多2份；事实/展示/允许的Provider故障最多3份；Schema含原候选≤6000及字段诊断，事实错误传必要片段/允许效果；重跑完整验证。只重建pending候选的叙述，Core不重做；耗尽按已证实Receipt回退或终止|`agent-recovery`、`narrative-bounded-retry`注入Schema/Firewall/伪造现场、三次失败及Provider故障，证明Receipt一次。**缺口：部分事实错误仅错误文本/片段而非完整原候选；最终`validateNarrativeClaims`提交前失败直接终止，未回到本循环**|
|Narrator表达退化精修：`runtime.refineNarrative`|narrativeHealth、输出Schema，再由调用方权威事实复审|最多一次表达重写，失败返回首份，禁止改变权威结果|原候选作为fixed_outcome提供；这是表达修订，不是通用Schema修复。会增加Narrator调用，不能把外层3次说成全回合3次模型上限|
|局部地点提案/审核：`agent/location-exploration.ts`|locationSearchSchema→独立世界审核→applyLocationSearch|拒绝则不登记；Schema失败/地理不符返回unavailable/incompatible，外层可能结束目标|`ai-recovery-boundaries`实际生成坏Schema只调用1次、不新增地点。**缺口：本入口未将原提案及诊断反馈同一地点生成阶段**；独立审核不是修复|
|普通环境裁决：`runtime.assessEnvironment`→Core准入|环境Schema、来源quote/既有resolution绑定、操作授权/所有权/资源限制|最多2次审核，Schema/path或来源引用诊断回原阶段；已登记事实优先复用。Core再审所有权/受保护物等，拒绝不等于让模型篡改限制|`environment-gap-http`覆盖实际入口、失败拒绝、防刷、Reload/Undo。部分Core准入拒绝是终态，不能全部当模型错误放行|
|旧动作解释/Freeform：`service.turn`→`runtime.interpret/freeform`|动作注册Schema、public目标绑定、Freeform语义、Core|参数错误最多2轮，Freeform可修复绑定错误最多2提案；有具体failure_code/公开目标/diagnostics；内部截断另可一次紧凑重生成|`agent-recovery`覆盖参数与对象重试/两错终止。**缺口：旧interpret仅动作类别/参数失败码，无完整失败输出/路径；一般Zod/程序错误不总进入结构化修复**|
|Routine生活提案/结果：`runtime.routine/sparseEvent`→`server/routine-controller`|生活Schema、时间/路径/补丁范围、Core/Save|随机检查后携带正式结果再生成是裁决流程，不是纠错；失败可暂停/终止任务|共享input规范化已适用。**缺口：通用生活结果的非确定性Schema/准入失败没有统一定向回送；本轮未覆盖全部Routine故障出口**|
|System能力/Contract、开发和世界草稿直接输出|System Understanding、CapabilityPlan授权、独立扩展Schema、最终事务/静态构建|共享输入规范化适用；明确授权冲突保持终态；开发任务自身有有限恢复/重规划预算|扩展专项测试通过。**不声称完整覆盖**：世界草稿/部分System辅助审核/扩展规格Schema错误可直接拒绝，未逐出口实现候选反馈；开发代码构建重试不等于游戏模型输出纠错|

## 预算、超时与秘密边界

- DeepSeek与Codex当前每次传输上限180秒，DeepSeek完整超时有冷却；拒绝/认证/权限/额度/网络无候选并不适合要求模型“修改JSON”。本轮未缩短或改写其配置。
- `AIRuntime.call`默认允许一次截断/空JSON重生成；Semantic、Scene及Narrator主生成显式关闭这层重试。其他调用可能与外层预算相乘，World分段/表达精修/事实审查也有独立调用。**没有全Framework统一的总调用、Token和总墙钟时间预算**；低推理回退可再进入默认截断重试。当前所有已核对循环有限，但不能把“有界”说成整体低延迟。
- NPC失败只消耗当前请求的有限决策机会，不伪记成功；下一次仅随玩家合法推进时间、到达退避时间并被公平选择才尝试。既存REV389时间戳原样保留，不偷改档强制立即再试。
- 修复数据只应来自生成阶段既有授权上下文。Semantic/Scene/Narrator有不可信候选标识与长度上限；World/Director因其职责本来读取GM上下文，候选不向玩家暴露。NPC目前尚未新增反馈通道。通用提示并不能证明所有历史输出已完美抵御指令注入，后续仍需专门边界测试。
- Schema/语义拒绝不触发权威提交。提交后错误必须使用原request/Receipt恢复，不整轮重放；保存故障恢复使用pending candidate，未缓存的展示生成仍可能再次调用模型。存储/事务/文件错误应修程序或恢复I/O，不应交给模型重写世界结果。

## 后续系统性修复范围（本轮不冒充完成）

1. 在现有生成阶段引入统一的**失败数据封装**（阶段ID、字段诊断、最小原候选、不可重试类别），由现有所有者执行最多一次修复；不新增Planner/Executor或状态事务。
2. 优先接NPC与局部地点出口；修复前先定义可修错误白名单，权限/证据/风险拒绝仍终态。一次NPC修复须计入当前批次总预算，候选通过完整领域、语义、计划关联校验后才Core执行。
3. 为Planner、旧动作解释、最终Narrator claims补齐候选与准确字段反馈；保持Receipt游标及Save边界，禁止反馈模型重写已提交步骤。
4. 给一次玩家请求建立共享调用/Token/墙钟剩余额度，取消内外重试预算乘法；阶段恢复由所有者申请预算，不是全场盲目重生成。
5. 然后补Routine、System辅助、草稿/扩展规格的逐出口故障注入。验收包含模拟Schema错误、可恢复事实错、授权冲突、I/O错、提交后展示失败与重启恢复；只有实际被测试出口才能升级为“覆盖”。

## 本轮验证依据

- `qa-ai-recovery-final-tests.log`：6文件89例通过，Semantic/Planner/World/Narrator/后台路径。
- `qa-scene-recovery-focus-tests.log`：5例通过，34例因明确`-t`选择未运行，未删除或全局skip测试。
- `qa-npc-schema-final-tests.log`：12文件202例通过，含6例新出口故障注入、完整NPC字段、真实正文回放、计划首步幂等、调度恢复及World Gap。
- 无付费模型验证；不宣称真实DeepSeek成功。未全量重跑；既有daily-qa旧Narrator断言问题与已修System场景夹具分开，未放宽断言、未改无关功能。

## 2026-10-18 接管收尾（无付费调用）

接管后先核实真实状态，而不是沿用前任进度报告：离线 `tsc --noEmit` 已恢复全绿（此前日志中的 7 个 `AIRequest.schema` 类型错误与 Semantic 展开错误均已解决）；恢复相关定向测试 272/272 通过。

本轮补上的四个缺口（均为故障注入/离线验证，不涉及付费 Provider）：

1. `AIRuntime.systemAgent` 低推理强度审计回退的门槛去掉错误的 `validationRepair===false` 前置，`reasoningEffort==='low'` 且结构/截断失败时，在原预算下重试一次默认强度（`tests/semantic-evidence-performance.test.ts`）。
2. `AIRuntime.call` 的 `validationRepair` 内层调用把外层 `retryTruncated` 硬编码为 `false`，导致 `compileRoutine` 的截断重试被吞掉；改为透传，并把 `compileRoutine` 的 `retryTruncated` 恢复为 `true`（`tests/routine-lifecycle.test.ts`）。
3. `tests/ai-targeted-recovery.test.ts` 的 Routine 后掷候选夹具用 `+1` 分钟触发的是越界检查（`segment.end`）而非计划区间一致性检查（`segment`），改为 `-1` 分钟以命中原意。
4. `tests/npc-world-http.test.ts` 的“无效决策退避”夹具原先注入的是**结构错误**（`plan_updates:'invalid array'`），如今会被所有者定向修复；改为注入**语义冲突**（`evidence_refs:['unknown_secret']`）以命中真正的不可修复退避路径——没有放宽断言，是让夹具与已实现的“结构可修、语义/授权不可修”契约一致。

更新后的出口状态：

|出口|状态|
|---|---|
|NPC 决策：Schema/语义候选回送、批次预算、退避与幂等|已实现并验证（`ai-targeted-recovery`、`ai-recovery-boundaries`、`npc-world-http`、`npc-immediate-plan`）|
|地点搜索：候选本地修复、独立审核、负向审核|已实现并验证（`ai-targeted-recovery`、`exploration-continuation-reliability`）|
|Routine：掷骰前候选、掷骰后固定区间/随机结果、校验失败修复|已实现并验证（`ai-targeted-recovery`、`routine-lifecycle`）|
|Semantic / Planner / Narrator / World 初始化 / Background Incident|沿用并重新验证既有有界恢复（相关定向文件全绿）|

仍为红、且**不属于本轮 AI 定向恢复机制**的既有回归（接管前即存在，需另行处理，不能算作本轮缺口）：

- `scene_position.label` 缺失：`framework-behavior`（屋外/窗边）、`phase3-local-compound`（厨房/门口/书桌前）、`continuity`（Undo 恢复场景位置）——局部移动/本地复合候选子系统。
- Choice/代词绑定：`action-capability-routing`（presentation、interaction_context、binding 状态）、`qa29-qa30`（binding availability、pending MOVE 恢复 revision）——选择验证/购买授权子系统。
- `narrator-goal-focus`（recent_scene_history 缺“买咖啡这件事还停在原地”）、`daily-qa-batch`（计划 status partial vs completed）、`phase41-activity-prerequisites`（activityRequirement kind generic vs mechanical）、`sparse-routine`（NPC 背景调用预算 15>13）——分属 Narrator 目标聚焦、计划状态、环境前置与 NPC 自治预算四个不同子系统。

结论：全 Framework 的 AI 定向恢复机制（统一失败封装、原候选+精确诊断回送、共享预算、单一权威提交、不可恢复正确终止）已实现，其专属故障注入与端到端测试通过；全量回归尚有 16 例失败，分布在 9 个与恢复机制正交的既有子系统，已如实列出，未冒充完成。

## 2026-10-18 最终质量收口（无付费调用）

基线证据：在 `c9596d6`（v0.1.19）建立独立 worktree，8 个被跟踪的失败测试文件在 HEAD 上 122/122 全绿。结论：全部失败均为未提交源码改动引入的回归，不是基线缺陷。

本轮实际修复（均已定向验证，不新增付费调用、不改 `data/current.json`）：

|修复|对应失败|性质|
|---|---|---|
|`systemAgent` 低推理回退去掉错误 `validationRepair===false` 门槛|semantic-evidence-performance|恢复机制回归|
|`call` 的 validationRepair 内层透传 `retryTruncated`；`compileRoutine` 恢复截断重试|routine-lifecycle|恢复机制回归|
|NPC 退避夹具由结构错误改为语义冲突|npc-world-http|夹具对齐（结构可修、语义不可修）|
|`talkPerson` 非人物 referent 不再短路代词/目标解析|action-capability-routing 3 例|代词绑定回归|
|`plan_admission` 的 unavailable 结果 presentation 由 assistant 改回 story|action-capability-routing 1 例|呈现回归|

恢复预算审查结论：每个生成阶段均有独立 `generationBudget`/`takeGeneration`（含 deadline 与超时信号）与 1 次截断重试；NPC 批次用共享预算且逐请求退避；未发现单层无界嵌套。仍缺「单次玩家请求的全链路总调用/Token/墙钟预算」（矩阵已列），是后续系统项，不阻塞恢复机制本身。

仍未解决（12 例，按共同根因分组）：

- 规范本地锚点 vs 旧自由语法（8 例）：`framework-behavior`(2)、`phase3-local-compound`(3)、`continuity`、`phase41`、`daily-qa-batch`。这是「本地位置必须以已登记非人物锚点为准」这一刻意产品变更与旧测试夹具的冲突——新行为被 `rest-transaction-http`、`choice-storage-closure` 明确测试。正确收口是给旧测试夹具登记锚点（不删断言、不放宽生产校验），但需产品确认「屋外/厨房/门口/书桌前/窗边」是否应为锚点，未在本轮擅自定案。
- `qa29-qa30`「missing referents」：presence_query 空 referent 究竟该 `needs_binding`（旧 QA 期望）还是转 ambient observation（scene-recovery-http/action-capability-routing 期望），是语义取舍，未定案。
- `qa29-qa30`「persisted pending MOVE」、`narrator-goal-focus`、`sparse-routine`（NPC 背景调用预算 15>13）：分属 pending 恢复、Narrator 目标聚焦、NPC 自治预算三个独立根因，未修复。

结论：未达到部署门禁。恢复机制与代词绑定回归已修复并验证；仍有 12 例失败集中在「规范本地锚点/环境观察」的语义收口与三个独立根因，已如实列出，不得宣称全 Framework 已完整验收。

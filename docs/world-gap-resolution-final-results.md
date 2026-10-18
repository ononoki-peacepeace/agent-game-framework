# World Gap Resolution：普通环境物品收口

日期：2026-10-17。范围：续接上一轮剩余项；不重做对白索引，不扩展宏观剧情/NPC调度。

## 交付状态

**本轮列出的剩余能力已实现并通过离线端到端验收。真实 DeepSeek 与浏览器真人验收未执行，不宣称已经通过。**

普通环境查询复用现有 Semantic → Plan/Contract → Freeform → Core → PendingTurn → Narrator → 原子保存/Checkpoint/Receipt。没有第二套路由器、世界存储或物品执行器。`environment_state` 是现有 SavePackage 的可选世界状态字段，随原有事务和 Undo 一起提交或恢复，旧存档无需迁移。

## 原断点与修改

- 原来 Freeform 要求物品先有实体 ID；普通未定义物体会变成缺失前置条件，或只能由 Narrator 描写，无法安全持久化。
- `ensureOrdinaryItem` 只是创建原语，不负责年代、资源、所有权或受保护事实准入。本轮没有直接把玩家名词送进该工具。
- 验收暴露一个现有快捷路径问题：包含“检查”的输入可走 `directPerception`，忽略 Semantic 已声明的非纯感知/多阶段意图。本轮收紧为仅在统一语义允许纯观察时使用该快捷路径，保留普通观察快速执行。

主要生产文件：

| 模块 | 实际改动 |
|---|---|
| `src/core/environment-schema.ts` / `environment.ts` | 受限查询、准入、稳定对象引用、持久正/负裁决、资源预算、内部 Core 行动 |
| `src/core/freeform.ts` / `src/server/service.ts` | 在模型判定前执行确定性契约检查；使用原事务和执行入口；修复仅作用于失败阶段 |
| `src/ai/runtime.ts` | 新增按需小预算准入审核、阶段内结构/引用修复、相关上下文；不把审核自由正文升格为事实 |
| `src/agent/plan-schema.ts` / `goal-contract.ts` / `affordances.ts` / `planner.ts` | 环境尝试完成契约；未知 item_move 交接；不放松已登记目标约束；只凭真实 Receipt 完成 |
| `src/core/schema.ts` / `state.ts` / `turn-history.ts` | 可选存档字段、引用/预算校验、当前地点环境细节投影、Undo/Checkpoint |
| `src/modules/inventory.ts` / `commerce.ts` | 他人所有权与共享设施阻止直接拿取；禁止借其他入口复制已登记同名物品；补全物品不可经济交易 |
| `src/core/narrative-firewall.ts` | 区分执行完成与未找到/不能拿取；降级保留具体查询结果，不给任意 `state` 修改权限 |
| `src/server/app.ts` | 运行指纹纳入新准入文件及相关权威模块 |

## 受控判定

1. 查询必须引用当前阶段完整原文及原文中的对象名称，不是客户端可提交的世界补丁。
2. 优先全局已登记对象与当前地点既有裁决。远处、他人持有、未发现或受保护的对象不得被重新生成，也不向玩家泄露其隐藏位置/归属。
3. 未定义对象经过现有 Provider/Schema 基础设施做一次受限审核：年代、技术、场景、已有冲突、普通/受保护/稀缺/贵重/危险/消耗资源、所有权及授权范围。依据须逐字来自当前权威世界/场景资料。
4. Core 检查分类与依据，只允许普通低风险物品或环境细节。可以得到 `present`、`absent`、`unresolved`；不会为满足玩家而总返回存在。
5. 普通可拾取物使用原 Item/Inventory 实体，数量1、重量上限1kg，不生成价格、道具功能、证据、秘密、属性奖励、容器套装。普通细节只保存地点事实，不强制注册 Item 或修改地图。
6. 实际拿取再次检查在场/可触及、身体状态、其他人物持有、所有权和共享设施规则。只有合法拿取成功才调用原 `putItemInInventory`，写 owner 和库存。共享、私有、受保护及稀缺资源不得通过该路径自动变成玩家财产。
7. 正负结果与物品、时间及 Receipt 同事务保存。未找到不是程序异常；不能取得也不伪装成已取得。

分类仍是受限模型的语义判断，不是对任意自然语言安全性的数学证明；Core 另有独立硬边界。没有使用物品名称白名单或《雾钟馆》特判。

## 防重复与持久一致性

- 稳定 ID 由 game/location/规范化名称派生；名字大小写、宽窄字符等归一。
- 别名只能引用同地点真实已有裁决，不得引用虚构或其他地点 ID。
- 同一对象重复查找、拿走、转交、移至别处、损毁后都不会在原处刷新替代品；正负缓存不能被后续相反模型提案覆盖。
- 如果后来真的有权威物品进入场景，真实新状态优先于旧的“当时未发现”记录。
- 每地点最多3件补全物品、全世界最多24件、裁决总数最多128条；不因取走或损毁回收预算，不淘汰旧记录为新资源腾位置。预算耗尽返回未确认，不虚称世界没有该物体。
- 补全物品标记不可交易；即使后来商店出现价格条目也无法出售，避免刷资源变现。
- 既有已登记物品、商店库存和合法转移仍走原机制，不受“最多24件补全”的限制。
- Undo 恢复本回合之前的完整世界：本回合新增物品和裁决一起撤销，原有裁决继续保留；不把已撤销生成偷偷留在第二份状态中。
- 服务重建后相同 request_id 从持久结果恢复，不重复生成、扣时间或提交。

保守边界是有意的：贵重/稀缺/消耗资源、武器、关键证物、重要设备和他人私人财产不能借普通物品补全机制取得。设备的使用/充电/消耗等仍必须由已有正式能力支持，不能因为注册了实体就宣称功能已完成。

## Agent 自主纠错与调用预算

- 混入其他效果、错误原文引用：先程序拒绝，复用既有最多一次 Freeform 定向修复，不先浪费一次准入调用。
- 准入 JSON/字段错误、引用了不存在的场景依据或 same_as：只向准入阶段反馈具体字段、期望、失败候选，最多修复一次。
- 网络/超时直接终止该准入，不重新生成完整玩家请求或重复 Core 行动。
- 授权范围不符、独立步骤遗漏、实际所有权冲突不靠反复生成绕过。Trace 有 `environment.admission.rejected` 的原因码、字段、阶段；正常裁决记录 `environment.resolved`。
- 普通对话等没有环境查询的请求不增加这一调用。环境查询通常增加1次准入调用，结构修复时最多额外1次；1800输出 Token/次。它们是本阶段上限，不是整个回合的总调用上限。
- 已有裁决决定存在性，重复请求的审核只能核对本次授权，不能重抽旧事实。

## 端到端证据

固定离线重建输入：`我检查桌上是否有充电器，有的话拿起来。`

真实执行的阶段：

`HTTP /api/input → Semantic → Planner → Goal Alignment → Freeform → Environment Adjudication → Core → Narrator → Narrative Audit → Save`

结果见 `docs/qa-world-gap-offline-evidence.json`（明确 `real_provider=false`）：

- REV0 → REV1，游戏时间0 → 2分钟，只结算一次。
- Core DETERMINISTIC Receipt，有 check_id、空掷骰数组、正式 committed 状态。
- 一个稳定物品实体进入玩家库存，owner=player，场景 location 被正确移除。
- 正文“你找到了充电器，并将这件物品收好。本次检查经过2分钟。”实际由 Narrator 返回且通过审核；该成功用例只调用一次 Narrator，**不是只证明错误能降级显示**。
- 替身适配器实际收到7次调用，其中新准入1次。旧 AIRuntime 计数器只记5次，因为已有 direct generate 调用未纳入该计数；本报告采用适配器实际次数，不据旧计数虚报节省。
- 相同请求和重载后的相同请求不再调用模型，也不重复提交。

这是经过生产入口的合成 Provider 决策，不是 DeepSeek 原始响应录制，也不代表真实 Provider 已验收。

## 工程验证

- 环境专项 `tests/environment-gap-http.test.ts`：最终 **35/35** 完整单文件通过（15.10秒），日志 `docs/qa-world-gap-offline-tests.log`。
- 相关旧回归9文件 **154/154**：普通对话、NPC主观表达、现场观察、QA25、复合移动交流、初始化物品、物证、叙事基础、物品收纳与 Goal Contract。
- 合计189项相关用例已覆盖验证；不把其中重复复测累加成新增测试数。
- 已知旧 Narrator 断言仍 **1项失败**：`tests/system-agent-understanding.test.ts:224`，期望旧场景短语进入当前上下文。未修改断言。单独复核日志：`docs/qa-world-gap-known-narrator-failure.log`。
- 先前两次批量运行曾发生 Worker 异常退出，无对应JS断言堆栈，未按整批成功统计；根因未确认。后续单独35项完整通过，9个其他文件先前已通过。没有放宽超时/门禁，没有以增加全量运行次数掩盖。
- `npx tsc --noEmit`、最终 `npm run build`、`git diff --check` 通过。仍有既有 bundle 大小提醒。
- 未调用任何付费 Provider，未运行全量或大规模浏览器自动化。

## 相机/胶卷/外套：只读结论

核查快照：正式 REV388，第1日17:28。

- 人物公开描述明确有相机、半卷胶片和外套。
- 初始化 definition.entities 及当前实体均没有对应物品；玩家 `inventory.items={}`，没有 equipment 组件。
- 因此是旧世界公开设定与结构化初始化数据不一致，**不是单纯的背包UI遗漏**。当前不能按已持有相机结算实际使用。
- 现有新世界生成已有 `initial_possessions` 契约；本轮相关测试通过。
- 保留历史只有有限窗口，不能排除曾经发生但现已无法回溯的物品变化，不能凭简介自动补发或断言当前仍应持有。
- World Gap 也不用于填补人物简介缺失的随身物品。单独迁移候选仍见 `qa-initial-possessions-migration-preview.md`，未执行；实际迁移需要重新确认当时存档和独立授权。

正式存档两次只读核验均为REV388、17:28，SHA256：

`95527b7bc9fa7968e77d44843ee3e3217b347bdcd6530e2eda500dab61fea144`

没有环境补全字段写入正式存档。没有发起正式行动、停止/重启3100或改动正式世界。

## 编译与后续验收

v0.1.19新编译指纹：

`f7e9c4415efa48c1a87f003312a1e45a3587d4897db438b0a68fa4bf15eca5f6`

构建完成不代表当前3100进程已加载新代码。需要用户在原终端确认无在途请求后安全停止，再以原方式 `npm run start:lan`；本线程没有代为部署。

最低成本自检，约15–30秒、无API费用，仅临时隔离存档：

```powershell
Set-Location D:\game
npx vitest run tests/environment-gap-http.test.ts --maxWorkers=1
```

预期35/35。需要复核旧能力时，可单独运行 `tests/scene-recovery-http.test.ts`、`tests/qa25-http-replay.test.ts`，不必重复跑全量。

用户安全部署后，只读核验（不要打印整个session对象，其中含令牌）：

```powershell
$session = Invoke-RestMethod http://127.0.0.1:3100/api/session
$session.runtime | Select-Object version, execution, code_sha256
```

真人QA建议：合理地点查找普通日常用品、询问不合理地点的现代物品、再次检查已拿走的同一物品。观察真实模型的分类、所有权与拒绝是否合理；不得把“未找到”当成框架失败，也不要为期待存在而反复重试。发生失败时保留 request_id/trace_id、`environment.*`、`agent.recovery.*`、Receipt 和最终Revision。

剩余验收限制：真实 DeepSeek、浏览器展示及实际延迟尚未验收；模型对“普通/重要”的分类质量仍须有限真人QA。没有宣称通用任意物品生成、设备功能自动实现、任意NPC私人背景自动变成客观事实或真实模型永不误判。

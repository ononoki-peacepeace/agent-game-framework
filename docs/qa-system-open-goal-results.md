# System → Open Goal 管理闭环（2026-10-17）

## 结论与证据边界

代码修复、隔离 HTTP 验证、类型检查和构建已完成。没有调用真实 DeepSeek，没有操作正式目标，没有重启 3100。真实 Provider / 浏览器验收尚未执行。

保留日志中没有找到能唯一对应这次“指定取消”请求的完整 Trace。目标 UUID 对应的 `tr_9db03c095344` 是早先的目标创建记录，不能冒充本次取消请求。测试明确标注：`unclear + quests` 是用户报告的结构形态，正文、语义输出和 UUID 是合成夹具。

## 根因

1. 权威控制器原本位于 `src/agent/executor.ts`，查询、取消、恢复已经能管理真实 `active_goal/paused_goals`；入口却只识别严格的精确命令，附带范围说明的自然请求会进入 System。
2. System 的 `capabilityDigest` 只列旧工具与模块，未列实际可组合能力和 Open Goal 管理。Registry 没有目标管理描述，理解契约也没有对应 workflow / 控制字段。
3. `system_management` 原本跳过通用能力组合路径；System 没有到既有目标控制器的执行分发。这不是只补一段能力说明就能解决的问题。
4. 原 `agentTransaction` 对仅改变计划元数据的事务也执行 NPC 自主调度；管理目标时可能意外启动逾期 NPC 工作。

## 修改

- `plan-schema.ts`、`system/goals.ts`：共享 `goal_control={kind:query|cancel|resume,target:current|paused|UUID}`，不创建新目标状态。
- `semantic-entry.ts`、`system/understanding.ts`、`context-router.ts`：从真实能力注册表提供可用性，公开当前/暂停目标的 ID 和状态；区分玩家 Open Goal、Quest、NPC 目标、开发任务和配置。理解契约增加 `goal_management/open_goals`。
- `system/capabilities.ts`、`resolver.ts`：注册三个管理能力，复用既有能力参数、可用性、权限、依赖校验；计划中的操作和目标必须与结构化授权一致，再调用原控制器。
- `system/agent.ts`、`session.ts`：传递原请求 ID / game ID / expected revision；System 优先委托目标管理，避免被行为指导编译器吞掉；旧式高置信度 `unclear` 理解允许一次限定为目标管理的能力组合，不能转为其他修改。返回真实结构化结果，不用表达模型改写成功状态。
- `agent/executor.ts`、`contracts.ts`：原控制器增加可委托入口，返回状态、Revision、实际 Receipt。取消已结束目标不再提交。恢复先使用现有事务 Receipt 登记请求，再继续原计划；重复请求、Undo 后重发不能重复执行。若进程在登记后中断，旧 ID 仅查询/拒绝重复执行，用户确认后可用新请求继续。
- `server/service.ts`：只有世界时间确实变化时才在此事务钩子执行 NPC 自主调度；真实时间推进仍走原调度链。
- `server/app.ts`：运行指纹覆盖本次 System 执行模块。

没有第二套 Goal/Receipt/世界状态系统。取消和查询不会执行人物动作、推进世界时间；**明确恢复**仍可能执行该计划原先授权的动作，并遵守原 Core、Narrator 和阶段校验。

## 离线验收

`tests/system-open-goal-control.test.ts`：7/7，通过真实 `/api/input` 与 `/api/system`、真实路由/能力选择/控制器/JsonStore；Provider 为测试替身。

覆盖：一个 blocked + 三个 paused；限定取消；其余计划逐项不变；时间、人物、NPC 状态及行动 Receipt 不变；查询真实取消状态；不存在目标拒绝；重复取消；磁盘重载后幂等；Undo；旧请求在 Undo 后不可重新执行；指定恢复到原合同执行器并保存证据；HTTP 未授权拒绝；能力缺失、权限不足、目标不一致、过期 Revision 和错误 game ID 拒绝。

核心回归命令（约 30 秒，无 API 费用，仅隔离写入）：

```powershell
Set-Location D:\game
npx vitest run tests/system-open-goal-control.test.ts tests/qa25-http-replay.test.ts tests/universal-capabilities.test.ts tests/system-agent.test.ts --maxWorkers=1
```

结果：4 文件、50/50 通过。最后 Surface/能力回答调整后，相关 3 文件21/21再次通过。

额外检查 `system-agent-understanding.test.ts` 为14/15；未通过项 `G. optional enrichment...` 要求 Narrator prompt 包含旧场景文字“教室里的书还没有收完”，实际当前场景输入没有该文字。该用例不走本次目标管理入口；本轮未扩大修改 Narrator，也不将这组报告为全绿。日志中的巨大 Prompt 不应复制到玩家报告。

`npx tsc --noEmit`、最终 `npm run build`、`git diff --check` 通过。构建有现有 chunk 大小及依赖注释警告。沙箱启动 esbuild 出现 EPERM 后，仅授权测试/构建命令重跑。

## 模型成本与限制

- 精确旧命令保留零模型调用。
- 新结构化语义入口的隔离记录是语义 + 原有平面保真审核，共2次；不增加管理专用模型调用。
- 兼容旧理解输出时为2次原语义调用 +1次 System 理解；若仍只返回 `unclear`，最多再组合1次能力计划。本轮夹具实测分别为2/3/4次；不是实际 DeepSeek 速度数据。
- 不无限修复，不把权限、事务、存档错误交给模型重试。不确定提交结果只提示查询，不自动重发行动。
- 暂未验证真实模型是否稳定填写新字段；没有声称真人问题已验收。
- Registry 摘要修复是共用的能力发现机制；没有将其他尚未接线/不可用的能力虚标为可执行。

## 正式状态与部署

验证前后正式文件 SHA256 均为：
`f69852663397d3ea6ce872c86815ccb0f17b31fe3dfad426f7e52ef9d3462dca`

REV343，day1/minute905（15:05）不变。3100 仍为原 compiled 指纹 `443d80aa1e06b4edebd0a712e3e83631f523954d27847b2fbc223e8b2ebfe4f1`，Provider 为 DeepSeek。

新编译指纹：`cc09c33b2f1f45180c696d889fc583a87e4398c221a819d3c225422f219b6e02`。

需要用户在原启动终端确认没有正在处理的正式请求后，正常 Ctrl+C，再执行已存在的 `npm run start:lan`；不要另开实例、删除锁或强杀未知进程。该启动脚本继承原环境。无需存档迁移。部署会加载代码，不会自动提交玩家行动。

只读核验（数秒，无 API 费用）：

```powershell
$sessionInfo = Invoke-RestMethod http://127.0.0.1:3100/api/session
$sessionInfo.runtime | Select-Object version, execution, code_sha256
Get-FileHash -LiteralPath D:\game\data\current.json -Algorithm SHA256
```

不要输出整个 session 响应，以免暴露会话令牌。真人验收前先用“查询目标状态”确认目标；取消是实际管理写入，应由用户主动执行。失败时保留 request_id、trace_id、`system.goal_control.result`、`agent.transaction` 及 HTTP 结果中的 `advanced.goal_control/outcome`，不要为取证重复恢复同一行动。

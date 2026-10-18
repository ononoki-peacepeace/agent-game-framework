# QA-26：System 目标取消失败的录制回放与修复

## 原始证据

- Trace：`tr_676bb7e898db`
- request_id：`d6157e54-cd32-4b4f-afe2-956283bf72fa`
- 原始响应：`data/input-requests/67907fa0-29a9-43b7-a957-3704e2ed6ef4/d6157e54-cd32-4b4f-afe2-956283bf72fa.json`
- 已选择性复制原输入、`advanced.goal`、`advanced.plan`、失败文案至 `tests/fixtures/qa26-open-goal-cancel.json`，未复制世界或 GM 数据。

本次由 Semantic 的 `goal_spec.goal_control` 直接委托；没有运行独立 System Understanding，返回的 `session.understanding=null`，日志仅有两次成功的语义/平面对齐调用，无重试。完整 Semantic 外层与对齐模型正文未保存；最终 GoalSpec、CapabilityPlan 则完整保存在 HTTP 响应。`delegateGoalManagement(goal ?? fallback)` 使用原 GoalSpec，并未采用空输出的 fallback。

### 旧守卫逐项复核

| 字段 | 实际值 | 触发旧拒绝 |
| --- | --- | --- |
| ordered.length | 1，唯一 open_goal.cancel | 否 |
| control.success | true | 否 |
| goal_control 存在 | true | 否 |
| kind 一致 | cancel / cancel | 否 |
| target 一致 | 两端均216f8f82-269f-4d6b-a481-d20dddde98d3 | 否 |
| desired_state.length | 0 | 否 |
| **desired_outputs.length** | **1** | **是，唯一条件** |
| external_artifact | false | 否 |
| dependencies.length | 0 | 否 |
| multi_step | false | 否 |
| play_action | null | 否 |

`validation.ordered` 本身未保存；原计划只有一个无依赖步骤，结合校验器和隔离回放确定排序。失败响应所在代码分支也证明此前能力校验已通过。

非空输出的原值：`{kind:"state_change",description:"目标 216f8f82-269f-4d6b-a481-d20dddde98d3 被取消，其余三个暂停计划保持原状态"}`。这是实录，不是猜测模型生成了冗余字段。旧代码把任何结果说明当成另一项操作而拒绝。上轮HTTP夹具始终使用 `desired_outputs:[]`，所以50例没覆盖该真实结构。

正式目标仍 blocked，REV343/15:05，失败 request_id 没有管理事务 Receipt。请求记录 `state=completed` 仅表示失败响应已返回，不表示取消成功。

## 修改

- `src/system/resolver.ts`：逐字段授权检查。单一 typed goal_control 的 state_change 作为该控制的结果说明，保留原字段，不清空、不解析中文猜工具。唯一步骤、操作和UUID一致性照常检查；独立状态写入、其他输出类型、多步骤、依赖、人物目标、游戏动作、持续动作、时间安排、外部操作均拒绝。
- `src/system/goals.ts`：明确结果说明不提供独立执行授权。
- `src/system/agent.ts`：委托参数与GoalSpec控制缺失/冲突，返回 `goal_control_source_conflict`，不使用默认值遮盖。
- `src/agent/semantic-entry.ts`：既有平面对齐审核检查独立意图是否被遗漏或藏入结果说明，不增加模型调用。

拒绝时返回 `advanced.reason_code=goal_control_authorization_mismatch`、`authorization_issues[{field,expected,actual}]`；Trace 记录 `system.goal_control.rejected`。通过时记录 `system.goal_control.authorized` 的检查值、输出类型和绑定范围，不记录完整Prompt、凭证、GM信息。

操作与UUID仍由单一语义来源确认。引擎不从结果文案授予第二项动作；独立操作必须结构化，原文与结构的一致性仍由原有语义审核负责。不能将离线回放等同于真实模型语义准确率保证。

## 修复前后证据与验收

先增加录制夹具而不修改生产代码：`recorded: HTTP...` 稳定失败，原文为“目标管理操作与已确认授权不一致”。修改后同一用例通过。

实际路径：POST /api/input → Semantic回放 → 既有平面对齐 → System → 能力组合 → 授权校验 → 原Open Goal控制器 → agentTransaction → JsonStore → HTTP Receipt。

GoalSpec、CapabilityPlan 使用原始记录，断言返回计划逐字段不变；未保存的外层Semantic与对齐输出明确为合成替身。隔离世界以REV343/15:05、相同目标和三个暂停ID开始；取消后REV344，原目标failed（现有取消终态），返回真实隔离事务Receipt。其余三个计划、人物、NPC状态、时间和行动结算Receipt不变。查询、重复取消、重载幂等、Undo、旧ID重发、指定恢复及权限拒绝都有覆盖。

相关5文件：**76通过、1失败**。

- system-open-goal-control：19/19。
- qa25-http-replay：29/29。
- universal-capabilities：10/10。
- system-agent：4/4。
- system-agent-understanding：14/15。唯一失败仍为上轮G用例同一224行：期待旧场景文字“教室里的书还没有收完”。无新增失败；没有修改Narrator迁就断言。

详细统计：`qa26-test-results.json`。`npm run build`（含TypeScript检查）、`git diff --check`通过；保留现有chunk大小和依赖注释警告。未跑全量、浏览器或真实Provider。

最低成本复验，约10秒，无API费用，仅写临时隔离存档：

```powershell
Set-Location D:\game
npx vitest run tests/system-open-goal-control.test.ts --maxWorkers=1
```

预期19/19。失败请保留request_id、trace_id、advanced.reason_code/authorization_issues、system.goal_control.*记录，不要为取证重复恢复正式行动。

## 正式存档与部署

验证前后SHA256均为 `f69852663397d3ea6ce872c86815ccb0f17b31fe3dfad426f7e52ef9d3462dca`，REV343/15:05未变。未调用模型，未操作正式目标，未重启3100。正式HTTP仍为旧指纹 `cc09c33b2f1f45180c696d889fc583a87e4398c221a819d3c225422f219b6e02`。

新compiled指纹：`130fc71197ccfa5d1f17828022ae5a360a0bae8980098b590b7769ef94179f81`。

用户确认没有在途请求后，在原启动终端正常Ctrl+C，再执行已有 `npm run start:lan`，继承原Provider环境；不要另起同存档实例、删除锁或强杀未知进程。无需存档迁移。随后只读核验：

```powershell
$info = Invoke-RestMethod http://127.0.0.1:3100/api/session
$info.runtime | Select-Object version, execution, code_sha256
Get-FileHash -LiteralPath D:\game\data\current.json -Algorithm SHA256
```

本轮证明录制失败结构经过真实代码执行链的离线回放已修复；真实DeepSeek新输入、浏览器展示和正式取消结果，仍待用户部署后验收。

# QA25 第三轮真实失败：HTTP 执行闭环收口

日期：2026-10-17。正式服务未重启；没有调用真实 DeepSeek，没有重放正式行动。测试全部从独立小世界创建临时目录，不以正式存档作为写入测试输入。

## 新证据

- 正式 HTTP 实际 compiled 指纹：`d62ddc1f3aab1c77612cbf780479de50acc30a8bf1d547647504fb4dce7e4130`。
- request_id：`216f8f82-269f-4d6b-a481-d20dddde98d3`。
- trace_id：`tr_9db03c095344`。
- 03:47:54.518Z收到，03:49:49.945Z最终返回，约115.43秒。

| 阶段 | 真实结果 |
|---|---|
| Semantic | world_action / natural_scene，multi_step=true。两次模型响应成功，约16.93秒、3.04秒。没有超时或截断证据。 |
| 路由 | 已执行上一轮 composite_goal handoff，进入既有有序Contract计划。 |
| Planner / 保真 | 一次Planner（4.28秒）、一次aligned审核（1.78秒）；两步：群体告知→普通阅读，g2依赖g1。 |
| 绑定 / 候选 | 三名听众全部bound，audience_ids完整，availability=ready；TALK候选存在。不是单人目标歧义。 |
| 首份Scene | 四条发言（玩家1、在场NPC3），effects为空。模型响应12.94秒；玩家台词保真aligned（4.62秒）；随后DIALOGUE_EVENT_MISMATCH / dialogue_validation。旧代码把兼容摘要dialogue不等于任一实际发言当作整场失败。 |
| 重试Scene | 响应19.53秒，四发言、effects为空；speech_only=true。被scene_presence_validation拒绝：旁白声称有人离场，但没有权威位置变更。 |
| Core / 阅读 | 群体交流未提交，g1 blocked、g2 pending；没有执行阅读，没有本请求的行动Receipt或NPC移动Receipt。 |
| 持久化 | 正式REV从339到343，保存了计划管理及失败进度；时间始终905（15:05）。子错误仍携带REV341，外层曾显示story，属于状态包装缺陷，不能说整个请求毫无写入。 |

共7次成功模型响应；失败是应用层输出契约/现场事实校验，不是Provider无响应、JSON解析、阅读资源不足或存档写入失败。

边界：持久请求记录保留完整Goal Contract和原始玩家意图；常规日志保留语义/场景结构及校验阶段，未保存完整Semantic/GoalSpec和两份Scene正文。因此不能逐字还原造成离场判定的句子，也不能确认是何种措辞触发正则。没有据此放宽在场约束。新回放采用真实已记录结构；具体台词、旁白和缺失语义字段是明确标注的合成替身。

## 最小闭环与代码改动

责任仍为：Semantic授权 → 有序Goal/Contract → 当前地点群体交流 → Core活动与时间 → 既有后台调度 → Narrator → 原子保存。没有新建Planner、世界状态或日常行为引擎。

1. `src/agent/scene-interaction.ts`
   - speech_events为对白唯一来源；验证人物、provenance、玩家授权及台词保真后，由最后一条已验证NPC发言派生旧dialogue投影，不因冗余摘要不同而重调模型。超过旧摘要容量时置null，完整原话仍保留在事件中。
   - **仅在speech_only阶段**，无凭据的离场旁白可确定性剔除，保留实际发言顺序及安全旁白，再执行在场检查、发言检查、beats检查和完整Schema重验。普通场景不因此放松；错误的结构化presence_claims、不在场说话人、越权玩家台词等仍拒绝。不会借修复旁白移动NPC。
   - 增加Trace关联的发言结构、摘要匹配索引及确定性修复原因；只记录ID、长度、类型，不保存完整Prompt、台词或认证信息。
2. `src/agent/executor.ts`、`affordances.ts`、`outcome.ts`、`goal-contract.ts`
   - 已识别的语义行动传至通用执行边界，避免单独阅读中“不调查”的字样被旧动作分类重新解释为观察。明确MOVE等已有Contract路径保持原路。
   - 进度持久化后重建外层最终revision和完成证据，避免返回子阶段的旧REV。
   - 计划管理写入不作为新故事证据；部分成功保留真实故事，但未完成原因单独反馈，不能用旧正文盖住失败。
   - 缺席听众返回具体在场阻碍；场景失败明确说明交流未提交、后续未执行。
   - 旧真实记录还有“玩家简称→Planner完整名单、referent=null”的组合。复用已通过的目标保真审核，不再另要求原文逐字包含每个完整姓名；仍只绑定公开且唯一的实体，并在执行时核验所有听众实际在场。HTTP回放包含这一结构，讨论对象、择一对象等绑定负例继续通过。
3. `src/core/freeform.ts`
   - 合法前置条件不满足使用既有WorldBlockedError，保留具体阻碍，不误归类为内部事务异常。观察对象提案本身错误仍先走既有有界修复。
4. `src/agent/semantic-entry.ts`、`src/server/app.ts`
   - 安全记录play_action、multi_step、依赖/目标数量及绑定步骤结构；运行指纹纳入本轮Scene和错误包装模块。
5. 测试：新增`tests/qa25-http-replay.test.ts`，调整`living-world-qa22-25.test.ts`与`goal-contract-batch3.test.ts`，验证确定性修复及部分结果/错误反馈的新语义。

正常请求没有新增固定重试；摘要/旁白投影修复不调用模型。真正非法的发言继续使用已有最多一次场景修复，之后终止。没有用安全旁白代替玩家发言或NPC决定。

## HTTP端到端回放

没有mock `handleAgentInput`、Planner、Core、Narrator或事务方法。Provider替身返回结构化候选，经真实AIRuntime解析、HTTP CSRF入口、Semantic、计划/保真、群体绑定、Executor、场景校验、Core、Narrator及JsonStore原子保存。每例启动独立随机端口，持久数据位于专用临时目录，结束后关闭并清理该测试目录。

| 验收 | 结果 |
|---|---|
| A 群体告知→阅读15分钟 | 三名听众的真实发言/听闻记录成立，g1后g2完成，活动Receipt一次，玩家位置不变。 |
| B null referent、名单只在normalized_goal | 通过真实HTTP计划编译与群体绑定，不依赖理想化referent。 |
| C natural_scene＋四发言＋WAIT | 整段非法场景在提交前交还计划；计划交流不提前执行WAIT，阅读仅结算一次15分钟。 |
| D 无MOVE却描写离场 | speech_only中修复旁白，NPC权威位置不变；未把离场文本写入提交历史。非法说话人/错误位置声明仍失败。 |
| E 交流后阅读 | 明确检查g1/g2完成、阅读提案与Narrator实际调用、15分钟Receipt和最终时钟。 |
| F NPC选择留下 | 保留“我想留在这里”的实际回复，阅读照常完成，不强制离场。 |
| G 单独阅读＋不调查限制 | 原始语义行动进入Core活动，未因否定调查语句变为观察。 |
| H 缺席听众 / 阅读资源条件不足 | 分别返回真实在场或持有阻碍；依赖阶段不冒充完成。交流已成立时保留其记录，阅读失败不增加15分钟。 |
| I Save/Reload/Undo/幂等 | 新建GameService/App并从JsonStore重载；同request_id返回已保存响应，模型调用与时间不增加；Undo恢复阅读时间。失败结果的revision等于当前view/save。 |
| J 平静 / 后台活动 | 到期NPC经Core MOVE/HOLD产生Receipt；事件满足条件时改变既有flag，未满足时不触发。玩家阅读正常，远处曝光日志为空，当前故事不泄漏远处交接内容。 |

最终：11个HTTP场景通过；9个相关文件共144个不重复用例分批通过（跨批重复的HTTP用例不重复计数）。独立TypeScript检查及`npm run build`通过，`git diff --check`通过。没有运行全量或浏览器真人验收。

## 正式存档及部署

本轮开始、结束只读核验均为REV343、15:05，SHA256：

`f69852663397d3ea6ce872c86815ccb0f17b31fe3dfad426f7e52ef9d3462dca`

本轮编译指纹：

`1053188d317c06d42d9ac1f582a220b183db68d9d13e690b2dec49630a70069f`

正式3100未重启。本地通过不等于真实DeepSeek验收成功：真实模型仍可能生成新的非法人物、资源、台词或格式；这些仍需有界失败，不能强制通过。没有验证真实模型延迟、生成成功率或本轮浏览器显示。旧失败request_id继续返回原失败；不得自动重放。继续旧目标或发送新请求都必须由玩家明确操作。

最低成本离线复核（不收费，专用临时存档；预计10–40秒）：

```powershell
Set-Location D:\game
npx vitest run tests/qa25-http-replay.test.ts --maxWorkers=1
```

预期11/11通过；失败保留终端输出、失败用例名与Trace。部署时先确认没有在途行动，在原启动终端正常停止服务，再执行已有入口：

```powershell
npm run start:lan
```

只读确认新代码：

```powershell
(Invoke-RestMethod http://127.0.0.1:3100/api/session).runtime |
  Select-Object version, execution, code_sha256
```

预期v0.1.19、compiled、上述新指纹；不自动迁移、回滚或推进正式世界。

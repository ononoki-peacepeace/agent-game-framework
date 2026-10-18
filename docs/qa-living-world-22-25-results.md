# QA22–25：生活行为与持续世界定向收口

最新的带修饰语听众绑定失败与修复见`docs/qa25-recipient-binding-results.md`，包含本轮实际Trace对比、19例HTTP回放和最新编译指纹。

后续第三轮真实失败及HTTP端到端收口见`docs/qa25-http-closure-results.md`；该报告记录了本轮最新根因、124例定向结果及编译指纹，优先于下方历史部署结论。

日期：2026-10-17。正式世界仅只读；未调用真实 DeepSeek、未向正式服务发送行动、未重启服务。

## 真实证据与结果

| QA | 原因及证据 | 修改与验收 |
|---|---|---|
| 22 | REV332 的右侧探索有已提交观察凭据；REV333 `tr_40605b243343` 走 Natural Scene，只有交流，没有返回 MOVE。旧场景输入有历史故事，却缺少按提交顺序排列的行动凭据，重用了较早左侧叙事。不能据旧旁白认定玩家真的走过某条路或已经返回。 | Narrator、Natural Scene 接入最多六条有序已提交玩家行动；明确区分 attempted_action 与 movement_route/position。NPC Agent 另取本人的行动凭据，不获得其他人的私密历史。回归验证相似观察目标切换及实际模型输入接线；真实模型的叙事服从性未验收。 |
| 23 | 失败请求 `1812e870-735f-48ba-ba7c-0412865c68c4` / `tr_b64b17fd3bbd` 与成功请求 `287efc29-c592-41ec-997c-218ed22f873c` / `tr_8dd9596c5ba9` 均为 world_transaction → FREEFORM_ACTION，不是两套路由。前者报对象存在性前提失败；后者完成5分钟感知判定、没有新发现并提交334。旧日志未保存完整前提提案，无法还原具体缺失 ID。 | 存在性/同场前提可引用当前权威地点描述中的物体名称及 scene_reference 引文；Core 核验地点、名称和原文。只证明场景物存在，不生成 Item、持有、损坏或发现。拿取/使用所需结构化权限仍独立校验。错误引文可进入已有一次有界提案修复。 |
| 24 | 当前2条后台事件中1条取消、1条活跃；1条 Macro Arc 已处于 developing，并有激活和阶段推进记录。后台最后评估与当前时钟一致。当前已有阶段的玩家曝光条件均未满足，曝光记录为0。不能再使用旧REV311的latent结论，也没有证据证明当前事件漏调度或传播记录丢失。 | 保留既有调度、概率和曝光规则，没有强行插入事件。当前保留的NPC MOVE凭据包含同行移动，不能全算自主行为；运行日志可明确区分轻量自主观察和短期计划行动。深度决策尚未到下一调度窗口。隔离验证到期自主MOVE、HOLD值守、远处事件、后来到场曝光及平静条件分支。 |
| 25 | 两次请求 `51a5f7c3-ee35-4ea6-8233-f3b148760491` / `tr_b3fb2a82b8ff`、`ef2edaa7-c618-495a-a7de-df6f112dcf98` / `tr_2a9edcf86414` 均保留两步，保真审核aligned。告知三人被单人会话契约判为needs_binding；阅读activity本来ready，但整份计划在准入阶段停止，未提交时间。首次可选布尔null问题已由既有确定性修复恢复，不是最终失败点。 | 明确的并列人物名单绑定为群体，复用一次Natural Scene，不把“问A关于B”当群体。群体发言及完成证据与既有active_goal原子保存，之后阅读正常执行；15分钟由既有时间解析和Core提交。仍无法执行时返回具体失败步骤及原因，不再只显示“没有现实步骤”。 |

## 实际修改文件

- `src/agent/plan-schema.ts`、`goal-contract.ts`、`affordances.ts`：可选群体听众契约、执行接线、完成证据与恢复。
- `src/agent/executor.ts`：群体场景内的计划进度提交钩子、具体准入错误反馈。
- `src/core/prerequisites.ts`、`freeform.ts`：受核验的场景描述引用，不改变结构化物品权限。
- `src/ai/action-context.ts`、`runtime.ts`：有序权威行动上下文。
- `src/agent/scene-interaction.ts`、`npc-agent.ts`：接收相应行动历史，保留人物知识边界。
- `tests/living-world-qa22-25.test.ts`：六项定向回归。

新增字段均可选；旧存档不需要正式迁移。QA17旧区域标签没有清理。

## 隔离验证

- 群体告知 → 阅读15分钟：三人听闻记录成立，不强制离开；恢复不重复发言或扣时间。Undo阅读保留先前真实告知。
- 权威描述中的普通物体可观察；无实体生成；不存在的引文、虚构物体和未持有物品不能取得权限。
- 近期相似目标按提交顺序进入场景；没有MOVE时不提供虚假的返回路线。
- 玩家仅阅读：位置保持不变、时间增加15分钟；到期NPC自主移动及值守经Core提交，2次Mock决策。
- 已满足条件的远处后台事件改变权威flag，玩家当时看不到；后来到场才获得已登记的可观察后果。
- 条件未满足时不触发该事件；Save/Reload、Undo与同request_id重试没有重复结算。
- 8个相关测试文件分批共94例通过；未运行全量。TypeScript及`npm run build`通过，存在原有非阻断的依赖注释和bundle大小警告。
- 所有Provider均Mock。没有真实生成成功率、Token或耗时结论，也没有浏览器真人验收结论。

## 正式存档保护

开始及最后核对均为REV339，SHA256：

`62d53b49d02e88c5a66fa90fbf34e48f13e5d053d5d3966e75ae73ab43324766`

正式人物、地图、事件、RNG和旧叙事未被改写。旧的错误叙事不会因此自动更正。

## 最低成本验收与限制

```powershell
Set-Location D:\game
npx vitest run tests/living-world-qa22-25.test.ts --maxWorkers=1
```

预计10–30秒，14例通过（含下述真实输出结构补修）；不调用API、不收费，只使用隔离MemoryStore。失败时保留完整终端输出。

编译产物已更新，正式服务没有重启。用户须先确认没有在途行动，在原启动终端正常停止服务，再执行：

```powershell
npm run start:lan
```

继续在原终端运行可保留现有环境；不要删除runtime.lock或强杀未知进程。启动会写正常运行日志/锁，不主动提交游戏行动。

新会话应使用新的request_id；旧终态失败请求按幂等规则仍返回原结果，不自动重放。

仍需真人验证：真实模型是否始终遵从最近行动方向、正确生成场景引用、自然完成群体告知及普通阅读。后台能力不保证每段时间都有事件；HOLD值守不会凭文字自动产生工资、物品或合作收益，重大变化仍须既定规则。没有实现服务器永久实时离线社会模拟。

## QA25：最新编译版真实失败的定向补修

这是最新服务中的真实漏测，不是旧服务未加载。取证请求：

- `aaec33d3-9f93-4824-8836-b786537dc002` / `tr_ee1b8f26b2fa`。
- `e8003ef8-848b-4924-baff-8cbd2c1f6558` / `tr_0dd36ec66b43`。

两次均为 `world_action / world_transaction`；语义、Planner、目标保真各一次模型调用成功，保真均为 aligned。三次模型调用分别约为11.46/4.71/1.77秒和21.91/5.21/3.06秒。随后本地契约编译 needs_binding、plan_admission 拒绝，Receipt列表为空，REV339未变。没有执行阅读，也没有NPC离场结算。

请求终态记录保存了实际计划和编译契约；常规日志只保存语义决策摘要，没有完整的原始模型逐字响应。可确认计划结构为：

```text
g1: WORLD_SPEECH, operation_hint=talk, referent=null, target_entities=[]
normalized_goal: 对A、B、C说：…… / 向A、B和C说……
旧契约: person=他, ambiguous, person_id=null, needs_binding
g2: WORLD_ACTION, operation_hint=activity, depends_on=[g1], activity_occurred, ready
```

上轮Mock把并列姓名填入referent；旧群体绑定只读取该字段。真实DeepSeek则只在normalized_goal中保留了完整收件人名单。这是可选字段表达差异造成的程序绑定缺口，不是玩家没有指定对象、Provider失败或Schema拒绝。

本次修改：

- `src/agent/goal-contract.ts`：保留原referent路径；缺省时解析发言接收者位置上的连续并列公开姓名，唯一映射至已有实体。讨论对象、择一对象、未知名单成员不会自动变成群体。执行层继续检查所有听众实际在场，不新增模型调用。
- `tests/living-world-qa22-25.test.ts`：用两次保存计划的脱敏结构复现null referent、空targets及不同名单连接方式，并通过真实executePlan准入进入一次Natural Scene后阅读15分钟。保留Save/Reload、同request_id恢复、Undo及NPC自主行动/远处事件联动验证。补缺席听众下依赖/独立阅读两分支，不改变模型给出的阶段依赖。
- `src/server/app.ts`：现有运行指纹纳入goal-contract、affordances、executor、plan-schema编译模块，避免绑定代码变化却仍报告旧指纹；没有新增运行状态系统。

核心流程：群体告知有真实发言及听闻证据后完成g1，再执行g2。有人不在场时不伪造告知；依赖它的阅读保持pending，独立阅读可以结算。正常阅读消耗15分钟，沿用既有Core、后台调度和事务，不强迫同伴离场。

新增字段没有变化，不需要迁移正式存档。旧失败request_id继续按幂等规则返回旧终态；部署后的真人验收应使用新请求。没有调用真实DeepSeek，本轮只能确认真实输出形状的离线回归，不宣称真实模型验收已通过。

最终自检：4个相关文件52例通过，独立`npx tsc --noEmit`通过，`npm run build`通过，`git diff --check`通过。未运行全量或浏览器验收。构建仅有原有依赖注释及bundle大小警告。

新编译指纹（v0.1.19 compiled）：

`83599ac78557abdb0045d0839ca8834fcd5403c93915287866484ba9ae33ef13`

最后只读核对正式存档仍为REV339，SHA256仍为`62d53b49d02e88c5a66fa90fbf34e48f13e5d053d5d3966e75ae73ab43324766`。正式服务未重启，不代表已部署。

## QA25：Natural Scene 分支再次失败（本轮）

开始时通过正式`GET /api/session`确认compiled指纹确为`83599ac78557abdb0045d0839ca8834fcd5403c93915287866484ba9ae33ef13`，不是部署遗漏。

请求`b8685788-8058-4659-a0eb-6c886fdb0656`，Trace `tr_6d3572ac0fc3`，03:22:31.978Z收到，03:23:42.421Z返回失败。持久请求记录为completed/HTTP200，但业务结果是engine_failure/schema_failure/natural_scene；不是成功结算。

| 阶段 | 实际证据 |
|---|---|
| Semantic | 两次成功模型响应，26.246秒和2.498秒；决策world_action/natural_scene，阶段30.695秒。不是Provider超时或截断。 |
| Planner / 群体Contract | 没有plan_attempt、goal_compiled、goal_alignment或tool_candidates；本次绕过上一轮Contract绑定路径，不能宣称该绑定再次失败或已在本次成功执行。 |
| Natural Scene | 两次Schema成功的提案，分别16.858秒、15.573秒；各4条speech event（1玩家、3在场NPC），effects=[wait]。不是单人目标歧义。 |
| 世界事实校验 | 两次INVALID_SPEECH_EVENT/scene_presence_validation；最终detail为“旁白声称在场人物已经离场，但没有权威位置变更”。首次进入已有一次repair_scene，第二次停止。 |
| Executor / Core / Save | 场景尚未提交便失败，没有Core行动、Receipt或阅读完成记录，REV339、时间905未变。没有存档写入失败证据。 |

四次模型调用均有成功响应，共约61.17秒；整条链约70.44秒。日志没有保存原始场景正文、完整Semantic/GoalSpec或wait分钟值，无法逐字还原被拦截句子，也不能证明原模型曾生成独立“阅读15分钟”步骤。不能据泛化错误码称为JSON Schema错误；实际是程序的在场事实约束拒绝。没有放宽该约束。

本次最小接线修复：

- `src/agent/executor.ts`：Natural Scene遇到有多阶段/依赖的GoalSpec，转入已有Contract计划；整段场景若同时提出后续权威动作又因在场冲突被拒，确认同revision、无提交后转入原请求的既有规划与目标保真流程，不再重复生成整段。计划内交流不允许递归转回规划。纯对话仍保留原有一次修复。已排序的沿途/抵达子发言不再继承父级完整GoalSpec，避免重新规划或重复MOVE。
- `src/agent/skills/natural-scene.skill.ts`、`src/agent/scene-interaction.ts`：传递speech_only范围，明确之后的阅读/等待/移动由父级计划结算；人物只能决定短期计划，不能凭旁白离场。丢弃本阶段不拥有的玩家后续effects，不为必然丢弃的提案另调授权模型；在场校验仍先执行。场景接收/在场拒绝记录关联当前Trace，仅保留结构、公开在场ID及诊断，不记录完整正文。
- `tests/living-world-qa22-25.test.ts`：补natural_scene路由（不同于上轮从executePlan开始）、未标多阶段时的在场冲突+wait恢复，以及连续拒绝的事务安全用例。复现依据为真实日志确认的4发言、3在场听众、wait和在场拒绝结构；离场句子为脱敏合成等价句，不冒充缺失的真实模型原文。

隔离验证：群体告知后Core阅读15分钟，不额外扣场景提案的15分钟；不强迫同伴离场；保存重载和同request_id恢复不重做；Undo恢复阅读时间。既有到期NPC自主MOVE/HOLD、后台事件推进与远处信息隔离继续通过。连续两份非法离场场景提案仍明确失败，人物位置、时间、Revision、Receipt和叙事历史不变，不强行放行。

本轮4个相关文件77例通过；独立TypeScript检查通过。未调用真实DeepSeek，未执行正式行动，未重启3100服务。真实模型自然输出质量及部署后完整玩家链路仍待用户验收。

`npm run build`及`git diff --check`通过。最终v0.1.19 compiled指纹：`d62ddc1f3aab1c77612cbf780479de50acc30a8bf1d547647504fb4dce7e4130`。

结束时正式存档仍为REV339、15:05，SHA256与本轮开始一致：`62d53b49d02e88c5a66fa90fbf34e48f13e5d053d5d3966e75ae73ab43324766`。正式服务未部署本次新构建。

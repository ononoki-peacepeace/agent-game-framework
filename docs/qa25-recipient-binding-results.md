# QA25 最新真实目标绑定不一致：定向修复

2026-10-17。正式存档只读；未调用DeepSeek、未重启正式服务、未自动执行玩家行动。

## 1. 最新请求及字段对比

正式HTTP指纹已确认是`1053188d317c06d42d9ac1f582a220b183db68d9d13e690b2dec49630a70069f`。

最新request_id：`674b0591-f918-4a9e-bb93-a650b488f85a`；Trace：`tr_ab2359d00203`。日志有新的input.received、Semantic、Planner、alignment和goal_compiled，持久请求记录也对应新ID，排除历史失败回复重放。

| 字段/阶段 | 上次绑定成功 `tr_9db03c095344` | 最新失败 `tr_ab2359d00203` |
|---|---|---|
| Semantic | natural_scene，multi_step=true，后交给有序计划 | world_transaction，play_action=other，multi_step=true，dependency_count=2，target_count=3 |
| Planner发言目标 | 完整三人名单 | “对同场的A、B和C说……”完整三人名单 |
| referent | 非空并列姓名 | null |
| 群体契约 | 三个bound，audience_ids完整 | person=null、mention=他、ambiguous，无audience_ids |
| 阅读目标 | activity，依赖交流 | activity，依赖交流，availability=ready |
| 最终停止 | 进入Scene后输出校验失败 | plan_admission，尚未进入Scene或Core |

最新response.plan.plan_id为独立的新ID `57e7fac2-7f4a-40e6-985c-56d2112fb626`。原active_goal仍是`216f8f82-269f-4d6b-a481-d20dddde98d3`，3份历史暂停计划不变。本次没有行动Receipt、没有阅读结算或新的Revision，仍REV343、15:05。

完整原始Semantic/GoalSpec没有持久化，不能恢复三个Semantic目标的具体字段/ID；这里只确认日志保存的数量和路由。保存的Goal Contract可确认normalized_goal、referent及编译后target_entities；不能把编译后空数组冒充原始Planner输出数组。缺失的场景正文没有用于伪造录制回放。

## 2. 精确根因

同一个`compileGoalContract`有“referent名单”“normalized_goal中名单”和“单人解析”兼容输入分支，不是存在第二套Core或群体执行器。

旧`talkAudience`要求“对/向”等发言介词后立即出现公开姓名。最新模型加了接收者修饰语，解析从“同场的”开始失败，随后回退`talkPerson`；它正确认为多名人物不满足单人唯一目标，于是把合法群体标成歧义。

此前HTTP用例只有“对A、B和C说”，没有覆盖“对修饰语＋名单说”。通过的referent路径也不能证明另一种输入形式正常。

额外确认：上一条`fd5fe309-999f-4fa3-9b6e-e29653fd814f`是单独“取消当前目标”，真实Provider却返回clarification。最新Trace.has_resolved_input=true，解释文本附带了这条旧澄清。它没有自动执行旧计划，也没有造成本次名单解析的直接失败，但暴露了真实Provider和Mock的目标控制入口不一致。当前pending_world_clarification已经清除；未对正式状态进行额外清理。

## 3. 修改

- `src/agent/plan-schema.ts`、`src/ai/runtime.ts`：增加可选`speech_recipients`公开姓名数组，明确区分听众和谈论对象；非交流步骤不使用。旧存档和旧输出可不含该字段，不需迁移。
- `src/agent/goal-contract.ts`：结构化听众、旧referent及旧文本解析都收口为同一person绑定数组，再生成同一个conversation_attempted/audience_ids契约。每名听众必须唯一映射至公开人物，未知或重复成员不允许被悄悄删除。
- 旧文本兼容不再要求姓名紧贴介词：以完整公开姓名列表为边界，允许前置描述，不维护“同场”等词汇白名单。前缀不得藏有其他列表成员/择一关系；并列连接词不能被再次当作新发言入口，以免把未知成员删掉。
- `src/agent/goal-alignment.ts`：现有同一次目标保真审核接收明确的听众字段，核对玩家授权、简称、讨论对象与择一限制。没有新增模型调用或重试。
- `src/server/app.ts`：现有、精确、且确实指向已存计划的目标控制命令，在所有Provider下先走同一确定性入口，不再仅Mock能识别。自由语言仍走原语义链；不是新增取消系统或关键词动作路由。
- 新增安全`agent.speech_binding`诊断：记录绑定来源、公开ID及状态，不记录完整Prompt、台词、密钥或私密GM信息。运行指纹覆盖目标保真模块。

单人MOVE、物品操作等唯一目标要求没有放宽。群体TALK执行仍逐人检查真实位置，NPC去留仍由已有Core和自主行动结算；Narrator没有取得位置修改权。

## 4. HTTP隔离验收

`tests/qa25-http-replay.test.ts`使用专用临时JsonStore、随机端口及Provider替身，经过真实HTTP、Semantic解析、Planner/Contract、保真审核、Executor、Core、Narrator、原子保存。没有mock执行器或事务方法。

新增/强化：

- 最新保存的“对同场的A、B和C说＋referent=null”结构，world_transaction路径：群体告知成功，阅读15分钟完成，三个NPC仍在权威地点。
- 无法从自然正文定位名单时，结构化听众字段仍能绑定，并确认名称数组进入了真实目标保真请求。
- 未知成员、未知首成员、择一对象、谈论对象不会自动组成合法听众集合。
- blocked旧计划与3份暂停计划并存：新请求完成，旧计划仅暂停，没有旧发言或旧行动重放。
- 非Mock名称的Provider下单独取消当前目标：零模型调用、只终止剩余计划，时间/行动Receipt不变；随后新复合请求正常完成。
- 保留原有的在场非法旁白、非法发言、资源阻碍、Save/Reload、Undo、重复请求、NPC MOVE/HOLD、事件可见性等HTTP回放。

具体场景台词和未记录的完整Semantic字段为明确标注的合成替身。最新normalized_goal的句式、空referent及已观察路由来自保存记录；没有把本地结果冒充真实DeepSeek成功。

19个HTTP测试通过；本轮分批8个相关文件共143个不重复用例通过。TypeScript、`npm run build`、`git diff --check`通过。没有运行全量、浏览器真人验收或真实模型调用。

## 5. 状态与部署

开始/结束正式存档均为REV343、15:05，SHA256一致：

`f69852663397d3ea6ce872c86815ccb0f17b31fe3dfad426f7e52ef9d3462dca`

新v0.1.19 compiled指纹：

`313c06c0014c1c60372b5d464574f68a5e2c8837dc3ed758fd6bdd4a7573df2b`

未部署、未重启3100。不存在新增固定模型调用；新字段会略增加请求/输出体积，没有真实Token或延迟测量。仍需用户部署后的DeepSeek验收；模型若给出不正确的听众或其他非法动作，必须继续拒绝，不能保证任意模型输出都成功。

最低成本本地复核（预计15–40秒，19例，无API费用，仅临时存档）：

```powershell
Set-Location D:\game
npx vitest run tests/qa25-http-replay.test.ts --maxWorkers=1
```

确认无在途请求后，在原启动终端正常停止旧服务并执行已有入口：

```powershell
npm run start:lan
(Invoke-RestMethod http://127.0.0.1:3100/api/session).runtime |
  Select-Object version, execution, code_sha256
```

旧失败request_id不会自动重放或改变历史结果。是否继续旧目标、取消它或发起新行动，均由用户明确决定。失败时保留新request_id、Trace和对应绑定诊断。

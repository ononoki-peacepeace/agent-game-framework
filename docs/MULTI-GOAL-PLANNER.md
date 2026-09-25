# Multi-Goal Planner / Future Intent / System Session

进度：本轮限定 P0 已完成并通过验收（100%）。

本轮仅处理 P0。未开发 CSS、PWA、图像 Provider、Extension 玩法或战斗。

## 1. Multi-Goal AgentPlan

src/agent/plan-schema.ts 定义 AgentPlan / AtomicGoal：plan_id、goals、dependencies、execution_order、ui_policy、status；目标包含 depends_on、condition、branch、temporal_scope、side_effect_level、requires_confirmation 和执行结果。

## 2. Goal decomposition

src/agent/planner.ts 提供语义槽位 fast path，加 AIRuntime.planGoals 的结构化模型规划 fallback。不是单纯按“而且”切句。模型只能返回严格 schema 的目标；目标结果、状态写入由 Executor 处理。

熟悉的资金/关系/条件/未来邀请表达走本地路径；其他组合调用当前 AIAdapter。生产模型的开放域拆解准确率尚未做大规模评估，本轮 fallback 用受控 adapter 验证真实调用边界与严格输出校验。

## 3. Dependency Graph

校验重复 ID、未知依赖、自依赖、环和缺少条件父节点的分支。拓扑排序后执行，目标经历 pending / ready / running / completed / skipped / failed / unresolved。依赖失败或未完成会阻止后续执行。独立只读目标目前按拓扑顺序批量执行，不并发调用。

## 4. Conditional Intent

显式 CONDITIONAL_INTENT 节点执行三值判断：true / false / unknown；then / else 依赖此节点，只执行匹配分支。future 与 current action 是子节点的独立类型。

熟悉条件复用 shared/relationship.ts 的投影：有 graph familiarity 时按现有“较高”阈值 35 判断；无 graph 时仅采用明确的公开朋友/熟悉描述，陌生/不熟为 false，无法确定为 unknown。它是首版明确规则，不是任意自然语言关系谓词引擎。恋爱/秘密感受条件不读取 GM 真相，返回 unknown。

## 5. Future Intent

保存玩家自己的打算，绝不当作世界结果。登记不推进时间、不调用 GM turn、不产生 NPC 回应、不改关系、不消费事件 RNG。无日期的“之后/打算”可以保持无日期计划。

## 6. Scheduled Intent

以世界 day 为日期，明天 day+1，后天 day+2；保存 any / morning / afternoon / evening / after_school 时间窗，不宣称精确赴约时间。未来目标不能以 now world action 的时间类型提交。

## 7. Persistence

Save Package 可选 future_intents[] 含 id、plan_id、goal_id、created_at、source_text、target_date、time_window、target_entities、goal、condition、condition_expected、status、completed_by_request。

新增字段对旧存档可选；JsonStore 替换实例和 export/import 已测试。登记/取消经 GameService.agentTransaction 验证 game_id、revision、request_id，再原子写入，日志事件 agent.transaction。相同请求重复提交不重复登记；过期 revision 拒绝。

## 8. 到期语义

到期仅转为 due 并提示；超过窗口为 expired，绝不自动写 completed。查看计划重新提示玩家状态、位置、目标可见性和待处理选择。

玩家明确要求“执行……计划”时，首版只支持目标明确的已到期单人物社交尝试：重新检查 foreground blocker、玩家 HP、目标同地点和条件；再由既有 Intent Interpreter / Action pipeline 处理实际 TALK 或 SOCIAL_INTERACT，NPC 回应沿用现有流程。其他行动或目标不能冒充完成。

实际行动和 completed_by_request 在同一次存档提交；completed 表示该邀请/社交尝试已做，不表示 NPC 同意、约会成功或共同活动完成。测试中 NPC 回答“我还需要考虑”，没有被改写成接受。

支持查看、按目标/日期取消、完成和失效状态。多条匹配会要求进一步说明，不猜测内部 ID。superseded 留有状态值，但本轮未实现通用计划编辑/替换流程。

## 9. Multi-goal UI policy

一份合成回复；最多一个主导航目标，关系页优先，其他结果以文本表达。App 不再把每个 focus_entity 当作另一次打开人物详情。没有为每个 Goal 发 toast。

## 10. AgentResult

保留 intent/message/ui_actions/tool_calls/canonical_changes/time_advanced/clarification/view；增加 plan_id、plan、results[]、future_intents[]。每个 result 关联 goal_id、summary、related_entity、status。单目标 clarification 字段保持兼容。

## 11. System Session

src/system/session.ts 保存 session_id、game_id、current_goal、current_intent、clarifications、resolved_entities、selected_tools、pending_confirmation、development_job_id 和状态。按 GameService / game 隔离，并串行处理会话请求。

当前会话存于服务进程内存，跨 HTTP 请求有效；服务重启后不恢复，旧 session_id 会被拒绝。development_job_id 是预留字段，本轮没有扩展开发会话编排。

## 12. 多轮 clarification

“我想改一个人物头像”先询问人物；“伊芙琳”接续同 session，明确解析人物后返回现有裁剪器指令。多个同名人物继续澄清，可按列出的序号选择。人物 ID 单独传入执行器，显示名不会改变工具路由。

取消 / 算了 / 不弄了终止会话；完成后新请求创建新会话。破坏性模块操作的确认可通过下一轮“确认”接续。头像 System 任务的 completed 指“解析目标并交付打开编辑器指令”，不代表头像已保存；实际保存仍须用户在现有编辑器确认。

## 13. Relationship projection

Game Agent、人物卡、人物详情、关系页共用 relationshipSummary / relationshipBadge；条件使用同文件中的 relationshipCondition。legacy profile 关系现在会出现在关系页，并明确注明没有量化数值。结构化 graph 优先。

## 14. 新增自动化测试

tests/multi-goal.test.ts 新增 33 项，覆盖单/多 query、A/B/C、DAG、true/false/else/unknown、未来时间、持久化、取消、到期与实际完成、只导航一次、结果 ID、System 澄清/同名/取消/新会话/确认、投影一致、隐藏信息隔离、严格 schema、请求重复及 stale revision、当前台词提及明天。

## 15. 三个验收输入实际结果

通过独立 HTTP 脚本 scripts/agent-plan-smoke.ts 实际执行。测试世界有 356 点，伊芙琳的公开熟悉度 50、信任 25；没有使用正式剧情存档。

- A：两个查询均完成；关系 query → 条件节点 → future goal 有真实依赖；条件 true，登记 day+1 意图；time_advanced=0，当前场景、实体、事件状态均不变，无 NPC 互动，主动导航最多一次。
- B：true 分支登记 day+1 / after_school；else 跳过；时间不变。false 分支另由自动化测试验证只执行训练尝试；未来 ELSE 版本也测试只登记正确分支。
- C：第一轮 waiting_for_clarification；第二轮相同 session_id、解析伊芙琳、返回 open_crop_editor。UI 已接到现有编辑器入口；本轮未开展浏览器视觉验收。

完整结构化结果：.tmp/agent-plan-acceptance-1790262848479/results.json。

## 16. Build / test / 数据边界

最终 npm run build 通过；npm test -- --maxWorkers=2：20 个测试文件、172 项测试全部通过（原有 139 项 + 本轮新增 33 项）。构建仅保留第三方 Zod 注释位置警告。

首轮默认并发曾导致一项原有 Routine JsonStore 测试超过 5 秒；降低 maxWorkers=2 后该测试和全量回归通过，没有跳过、删除或提高其超时。

git diff --check 指出 src/ai/contracts.ts 原有 EOF 空行；已与本轮备份比较，文件 SHA256 完全相同，本轮没有修改该文件。

正式 data/current.json 与本轮备份 SHA256 一致：
D58C0A715F92780597AEF0A96E98BB80AAFC38105DE9C6D75DFE0FF43125C56B。
没有推进正式世界、写 provider secrets、提交或发布。

## 17. 未完成项与边界

- System 会话和短期请求结果缓存不跨服务重启恢复；未来计划存档持久化已实现。
- 未来计划到期默认提醒，不是无人值守自动执行；显式执行仅支持受校验的单人物社交尝试。
- 日期窗口采用首版固定日内边界；复杂历法、世界自定义放学时间、重复日程、通用计划修改/替换未实现。
- 条件只提供公开熟悉程度、当前位置和 unknown；任意关系谓词需要扩展规则，不能声称通用语义推理已完备。
- 模型 fallback 的 schema、隐私和执行边界已测试；本轮未调用真实外部模型评测长尾语言拆解，也未做视觉/PWA验收。

本轮 P0 完成：Multi-Goal decomposition、DAG dependency、conditional intent、future intent、System multi-turn session 和新增自动化测试均已实现并验证。上述边界不等同于通用自主规划系统已完备。

# QA15–21：定向修复与隔离验收（2026-10-17）

## 正式证据（不含隐藏剧情）

| QA | 已确认原因 | 本轮处理与验证 |
|---|---|---|
| 15 | `tr_1593b7b0e7d9`、`tr_7eb06b5cdbde`：Open Goal 出发前交流后，被 search-inquiry 包装为 partial_progress，调用方立即返回，尚未执行后续探索。首次短句 `tr_3d9c3dc11ac6` 走 natural_scene；未保存完整候选语义，不能断言同一原因。 | 出发前交流不再触发该提前返回；无关场景提案由原 Open Goal 执行器接管，不能阻断独立阶段。隔离验证交流后执行调查，及既有交流→MOVE→抵达场景回归。 |
| 16 | `tr_e5231860198f`：两次场景校验分别为 SOFT_CONTACT_INVALID、INVALID_SPEECH_EVENT/scene_presence_validation；正式 REV324 未提交。不是地图 MOVE Guard 拒绝。旧日志不足以还原具体失败输出。 | 有界场景修复增加实际校验错误正文；不放宽接触与在场校验。模拟首份错误接触、第二份修正，世界只提交一次。真实模型仍需用户验收。 |
| 17 | `tr_7d361cdb58f6`：局部探索通过 FREEFORM_ACTION 结算；旧 localDestination 从完整行动文字抽取终止条件，并在判定前写入 scene_position.label。该标签已经进入正式存档。 | 观察/探索不再由文本抽取位置；普通局部移动解析剥离终止从句。未修补正式历史标签。 |
| 18 | `tr_2bfa4cc6721b`：首次保真审核把 travel_after_discovery=true 误解为到达首个新区域后仍继续行走；第二份候选 spatial_scope 校验失败。没有 persistence 非法枚举证据，旧日志未保存具体失败字段。 | 澄清字段语义；公开地点唯一名称可确定性映射为 ID；逐字段诊断进入有界恢复及日志，未知 ID 或改写引文仍拒绝。 |
| 19 | `tr_334a5130864a`：有观察 Receipt、耗时5分钟，没有地图 MOVE；叙事却描述了远离建筑的小径进展。现有局部状态没有米级距离/听觉范围模型。 | 生成及既有观察审核明确引用“未结算位置变化”边界；不以文学描写完成远行或分离同行者。不为没有发现创建新地点。 |
| 20 | `tr_e66f70af559c`：动作规划 intent_interpreter 输入60756字符，输出预算6000，报 max_output_tokens。没有该请求的新正式提交。另两个探索的 freeform 首次4000 Token截断后，紧凑恢复成功。不是网络超时证据。 | 规划、动作绑定去除 UI 和冗余故事/目标快照，保留相关人物、物品、地图、能力及原始请求；不增加重试上限或修改语义16000预算。截断仍可能发生。 |
| 21 | 既有 Core 限制连接点只能为 parent 或直接子级，阻碍以深层前庭连接外层同级区域；已有未知地点又优先用 parent 作为接近点。真实提案/审核内容未保存，不能证明每一次 incompatible 都由该 Guard 造成。 | 支持父区域内任意深度的真实连接点；本地发现优先当前合法入边，保留独立地理审核、稳定 ID、路线及事务。隔离验证跨父级区域→子区域→重载→Undo。 |

## 代码与自检

- 修改现有 Semantic、Open Goal/Natural Scene 交接、Freeform、地点生命周期与 Narrator 上下文/审核；新增 `src/ai/action-context.ts` 仅投影绑定上下文，没有新建决策或地图系统。
- 新增 `tests/exploration-continuation-reliability.test.ts`：6例通过。
- 直接相关8个文件分批共104例通过，无全量测试、无真实 Provider、无浏览器自动化。
- 类型检查和构建见交付终端结果；没有增加固定模型调用或无限修复。
- 正式只读投影实测：REV333 的 publicView 54878字符，绑定投影19033字符，减少65.3%。这不是完整 Prompt 或 Token 降幅，不能据此宣称真实响应提速。

## 存档与兼容

- 起始 REV331，SHA256 `ce1d98ea1ce9da306165d7018bc2e9ec1bfb31fdf1e189113b4c5ed5d9f8f0ae`。
- 后续只读观察 REV333，SHA256 `bfdbc6b18c65c48c5bdb8bffa78b0d2d46032e9234ee71c337528872623587ef`。
- 日志明确关联原请求 `f9c43bbb-b188-4511-987f-ac11b4c42030` 提交332，以及玩家后续请求 `bc212a28-bda9-4091-8b2d-ddccd0475fda` 提交333。测试使用独立 MemoryStore，未对正式服务发行动请求，未回滚用户进度。
- 旧错误 scene_position 不自动迁移。建议另行授权受控清理：锁定最新 Revision/Hash，确认 label 仍为原污染值并核对后续位置事实，仅删除错误标签，保留地点、路线、RNG 和历史；重复执行应为 no-op。此处只给方案，没有执行。
- 前庭现有 parent 不自动改写；若要更改地图组织，须独立核实世界空间事实及已有路线，不能顺便补造岛内通路。

## 尚未验证或未实现

- 真实 DeepSeek 的成功率、输出长度与延迟，以及最终浏览器呈现，交由用户有限验收。
- 没有米级局部空间/听觉距离模拟；不能把一个泛化观察 Receipt 当成已经远行或NPC分队的证据。
- 本轮修复同一请求内的阶段续接，没有新增跨进程自动续跑 Open Goal 的通用阶段检查点。必要澄清/模型失败后的剩余复杂目标仍须在当前真实状态下继续，不能自动重放原请求。
- 外部模型仍可不完整返回；严格校验、有限恢复与不重复结算继续保留，不能保证每次成功。

## 最低成本复验

```powershell
Set-Location D:\game
npx vitest run tests/exploration-continuation-reliability.test.ts tests/exploration-narrative-handoff.test.ts tests/dynamic-location-lifecycle.test.ts tests/compound-scene-travel-order.test.ts --maxWorkers=1
```

预计10–30秒，41例；Mock Provider、无API费用、不修改正式存档。错误时保留完整终端输出。
编译产物更新后，用户应在原启动终端确认没有在途行动，再正常停止并运行 `npm run start:lan`；Codex没有重启正式服务。

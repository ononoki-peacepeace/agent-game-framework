# Framework continuity consolidation

2026-09-25. 本轮在已有 v0.1.16 工作区上增量实现，保留之前的 System understanding、DevelopmentTask、模块生命周期和自由行动实现。开始时 build 通过，251 项测试通过。

## 审计结论与实现边界

- 原 World 入口为 `server/app.ts → agent/executor.ts → agent/planner.ts → GameService.turn`；System 入口为 `system/agent.ts → system/session.ts → understanding/tool execution`。此前没有共享跨框理解层。
- 原 TALK 使用 `target_id + topic`，没有跨回合焦点；现增加可选 `interaction_context`，进入 save/checkpoint/Undo。
- 原 JsonStore 只有 current 与手动 checkpoint，不足以按回合重建历史。现将一步 before image 与本回合结果写在同一 current 文件内，仍使用现有 fsync + rename，不改成 event sourcing。
- 原 narrator 已有 public view、上一回合、少量行动事实与目标关系。现增加有界人物资料、公开 persona、近期互动、近期叙事、当前场景及知识边界。
- 原安全过滤与截断重试混合，没有重复检测。现分离 refusal/content_filter，不将拒绝文本当 NPC 台词，并增加最多一次表达重生成。
- System 原始理解 JSON 原本已在高级折叠区；默认页残留标题来自 ExtensionPanel，现仅在开发展示模式出现。

## 主要文件

| 文件 | 职责 |
| --- | --- |
| `src/system/context-router.ts` | 共享只读 gate；来源提示、System session、World focus、能力摘要；World/System/Ambiguous 判别 |
| `src/core/interaction.ts` | 焦点建立、切换、离场/场景有效性与结束 |
| `src/core/turn-history.ts` | 非递归完整世界快照、稳定指纹、最近回合 checkpoint |
| `src/core/schema.ts` | 可选焦点、近期叙事、checkpoint、撤回审计与 active turn 标识 |
| `src/server/service.ts` | 同一事务内建立 checkpoint；Undo 锁、revision、receipt、完整恢复与校验 |
| `src/ai/narrative-health.ts` | 公开人物上下文、相似度/上下文覆盖信号、拒绝文本识别 |
| `src/ai/runtime.ts` | 受控上下文与一次表达重生成；不重复结算行动或 enrichment |
| `src/server/app.ts` | 两个输入入口转交、只读澄清、`POST /api/undo` |
| `src/client/App.tsx`, `SystemPanel.tsx`, `ExtensionPanel.tsx` | 撤回按钮、转交结果、单输入 System 与折叠详情 |

## 行为契约

**跨框输入**：复用 System 模型理解入口、能力摘要与会话；既有明确 System 请求和结构化未来计划可走确定性快捷路径。其他含混输入由模型判别，低置信度先澄清。模型不可执行工具或写状态。Gate 与澄清视图直接只读 storage，不触发旧档迁移写入。System 输入的理解上下文不携带 NPC focus。明确高置信度世界说话目标通过现有 TALK 校验，不赋予 NPC 必须回答的义务。

**Focus**：显式 TALK/社交、明确自然语言说话及经过在场校验的 narrator interaction 建立焦点。目标切换更新焦点；场景变化、NPC 离开、目标失效、明确结束会使其失效。失效写入存档后，NPC 回到原位置不会自行恢复旧对话。模型可以提出 active/ended 的有限交互状态，不能借此改位置、HP 或其他机械状态。

**Undo**：只撤回最近一个已完成世界回合，而非一次多目标输入的所有回合。快照包含实体、时间、位置、地图、关系、钱/物品、任务/未来计划、GM/event state、故事、事实及焦点。使用既有 canonical lock + media queue，恢复后完整校验并一次原子写入。revision 单调递增；保留 receipt，避免重复提交已处理行动。撤回回合的 before/after 保存在 `turn_audit`，新行动有新的 active turn ID。AI thread 清空，避免旧会话继续引用已撤回结果。

媒体文件、头像/立绘字段、Behavior Configuration、Extension 外部状态和真实 API 费用不回退。若此后已有冲突性的 canonical 修改（例如模块安装/移除、计划修改或其他事务），指纹不匹配，Undo 安全拒绝；不会覆盖这类新状态。模块/Extension 管理继续使用原有版本和 rollback 机制。当前只支持一步 Undo；撤回审计保留在存档中，长期大存档的归档策略尚未实现。

**叙事**：只使用 public projection，人物资料限制长度、近期事件限制条数。风格继续由 Behavior Configuration 提供；连续性保护不规定情绪顺序或最低字数。重复检测提供 recent similarity、dialogue loop、generic/context coverage 信号；最多一次重新表达，保留首次已裁定 facts/patches/choices/target，不再次运行世界行动。第二次表达仍差时不继续重试。结构化日志记录检测、重生成和失败。

Provider refusal/content_filter 不做截断重试。叙事拒绝时使用系统降级表达，已合法结算的事实仍然存在；若连行动裁定都没有得到有效结构化结果，不伪造行动成功。文本拒绝识别是保守启发式，不能证明覆盖所有 Provider 措辞。

## 验证与复现

```text
npm run build
npm test
npx tsx scripts/framework-acceptance.ts
npx tsx scripts/continuity-smoke.ts --browser
npx tsx scripts/continuity-smoke.ts --real
```

专项回归位于 `tests/continuity.test.ts`。HTTP/Chrome smoke 直接加载 `dist/server` 构建产物，所有存档、扩展和日志写入新建 `.tmp/continuity-smoke-*`；真实模型模式只读现有 Provider 配置，不打印凭据。

已获得的验收证据（均为自动化验收；目录名带毫秒时间戳，最新一轮为最终证据）：

- framework Chrome acceptance（真实 Chrome + 真实 HTTP + 确定性模型夹具，`manual_acceptance: false`、`live_model_validation: false`）：`.tmp/framework-acceptance-1790339370144/results.json` —— `passed: true`，覆盖 Y1–Y7，截图 `relationship.png` / `development.png` / `candidate-preview.png`。
- 生产 HTTP + Chrome Undo / System 默认页：`.tmp/continuity-smoke-1790339371359/report.json`（`--browser`，`status: passed`）与同目录 `system-undo.png`。
- DeepSeek 真实 HTTP smoke（只读 Provider 配置，全部写入 `.tmp` 隔离目录）：`.tmp/continuity-smoke-1790339972865/report.json` —— `status: passed`，通过显式 TALK 焦点、短句续聊继承焦点、world→System 转交不推进时间、System→world 请求不创建开发任务、完整世界像 Undo，并记录两段高压连续性样本（人物反应结合 persona、近期事件、关系与场景，未使用 Provider 拒绝文本当台词）。早前一轮同类证据：`.tmp/continuity-smoke-1790338904726/report.json`。
- 收尾复验（与当前工作区源码一致）：`npm run build` 通过；`npm test` 276/276 通过（26 个文件）；`npx tsx scripts/framework-acceptance.ts` 的最终 Chrome 运行见上。真实存档 `data/` 不属于任何验收写入范围。

- 完整世界像比对、交易双钱包/库存、关系 enrichment、任务完成、未来计划执行、Local Scene、重启持久化、重复 Undo、冲突拒绝、失败写入、媒体/风格保留均有自动断言。

上述 Chrome 为自动化验收，不等于真人长期体验。真实模型样本范围有限，文学性、复杂多人物打断和长程情绪连续性仍需人工验收。不能将一次 smoke 表述为长期模型质量保证。

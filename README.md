# Agent Game Framework

一个用 TypeScript 构建的 AI 叙事游戏框架：玩家用自然语言行动，Core 负责规则与状态结算，NPC 在持续世界中规划活动，Narrator 根据已结算事实生成叙事。

当前正式版本：**v0.1.20**。这是持续开发中的工程项目，适合阅读架构、运行离线演示与检查回归证据。固定四主题验收进度为 **109/160（68.125%）**，另有 22 项未满足、29 项待验证。构建和离线测试通过不等于真实模型、生产部署或真人体验验收完成。

## 核心设计

- **权威结算**：模块化 Core 校验动作、时间、位置、物品与关系变化；模型输出不能直接改写世界结果。
- **自然语言行动**：语义理解、目标绑定、条件与复合步骤执行；已提交步骤保留独立身份和事实，失败后保留可恢复进度。
- **事务与恢复**：请求身份、revision、持久化 receipt、Save/Reload/Undo 与部分提交恢复，防止重放重复结算。
- **持续世界**：NPC 的人物设定、知识、目标、计划和活动窗口与世界状态关联；玩家视图按可知范围投影。
- **事实约束叙事**：Narrator 使用 Core 结果与场景作用域；失败描写、重复动作和多步骤前缀都有离线回归。
- **可扩展界面**：React 客户端、Express API、结构化世界包、人物卡兼容与受约束的扩展开发流程。

主要代码位于 `src/core`、`src/agent`、`src/ai`、`src/server`、`src/client` 和 `src/storage`。测试使用 Vitest，浏览器验证使用 Playwright。示例世界、人物卡和 Prompt 位于 `content/`。

## 本地离线演示

需要 Node.js **22.13 或更高版本**、npm。以下 PowerShell 命令使用 mock Provider 和独立演示目录：

```powershell
npm ci
npm run build
$env:AI_ADAPTER='mock'
$env:HOST='127.0.0.1'
$env:PORT='3111'
$env:GAME_DATA_DIR=(Join-Path (Get-Location) '.tmp/demo/data')
$env:GAME_LOG_DIR=(Join-Path (Get-Location) '.tmp/demo/logs')
npm start
```

打开 `http://127.0.0.1:3111`，导入 `content/worlds/town.json`。可以检查界面、地图动作、商店和存档流程。Mock 用于离线联通与故障验证，自由文本可能显示受控失败；它不能展示真实模型的叙事质量。真实 Provider 需要使用者自行配置并明确承担相应调用费用。

## 验证与工程记录

```powershell
npm test
npm run build
node scripts/audit-public.mjs --revision HEAD --exceptions docs/public-audit-exceptions.json
```

开发隔离、数据目录和端口规则见 [并行开发约定](docs/parallel-development.md)。发布验证记录、测试范围和限制见 [v0.1.20 发布说明](docs/releases/v0.1.20.md)。固定条件及证据见 [验收进度](docs/four-theme-progress.md) 和 [验收台账](docs/four-theme-acceptance-status.md)。历史文档中的阶段百分比不能替代当前固定条件统计。

仍在推进的边界包括扩展实际消费能力、全部技术失败出口、服务所有者进程崩溃，以及长篇叙事的节奏与感知质量。公开审计是启发式检查，保留一个经审阅、已在公开历史中的普通本地路径例外；不包含正式游戏存档或运行凭据，也没有为此重写历史。

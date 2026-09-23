# Agent Game Framework

[中文](#中文) · [English](#english)

> **AI proposes / interprets. Framework validates and executes. Save state determines reality.**
>
> **AI 负责理解与建议；Framework 负责校验与执行；Save 决定世界事实。**

---

# 中文

一个可扩展的 **AI 原生持续世界游戏框架**。它不是把聊天窗口包装成 RPG，而是让 AI 负责自然语言理解、叙事和建议，让程序维护时间、地图、角色、关系、物品、技能、任务、检定和持久化世界状态。

当前应用版本：**v0.1.9**。

## 主要特性

- 持久化 Canonical Save：刷新、重启、换模型后世界事实仍以存档为准。
- Entity + Components + Module / Action / Event Registry，可扩展而不把具体游戏写死在 Core。
- 程序化时间、移动、骰子、背包、商店、装备等确定性规则。
- 角色、关系、属性、资质、技能、特质、装备、任务 / 机会。
- 分层地图、已知 / 隐藏地点、运行时地图扩展。
- Routine / 生活模式：重复日常并在值得玩家接管的事件出现时中断。
- AI Provider 可切换：Codex、OpenAI API、DeepSeek API、Responses-compatible、Mock。
- Provider 可保存在本机服务端；手机和电脑连接同一 Game Server 时共用同一 Provider。
- Character Card JSON 导入：Tavern / Character Card V1、V2、V3。
- 本地头像上传、浏览器语音输入。
- JSON World / Save 导入导出、自动保存、手动检查点。
- 局域网手机访问：电脑运行 Game Runtime，手机作为 Web 客户端。

## 架构

```text
Web UI
  ↓
GameService
  ↓
Action / Module Runtime
  ↓
Validated Canonical Save

        ↕
AI Runtime → AIAdapter → Codex / OpenAI / DeepSeek / Compatible / Mock
```

AI 可以提出行动、叙事和被允许的 Patch，但不能任意把 JSON 合并进存档。机械规则由已注册的 Handler 执行，Framework 校验后才会写入 Canonical Save。Codex Thread / 模型上下文只是可替换缓存，不是世界数据库。

## 快速开始

需要 **Node.js 22.12+** 与 npm。

```powershell
npm ci
npm run build
npm start
```

默认地址：

```text
http://127.0.0.1:3100
```

如果只想离线验证规则：

```powershell
$env:AI_ADAPTER="mock"
npm start
```

## 手机 / 局域网访问

电脑继续作为 Game Runtime 和 AI Server，手机只作为网页客户端。手机与电脑连接同一个可信 Wi‑Fi 后：

```powershell
$env:HOST="0.0.0.0"
npm start

# 或直接
npm run start:lan
```

启动日志会打印可用的 `http://192.168.x.x:3100` 地址，手机浏览器直接打开即可。

默认仍只监听 `127.0.0.1`；只有显式设置 `HOST=0.0.0.0` 才开启 LAN。LAN 模式只接受 localhost 与 RFC1918 私有 IPv4 Host，不建议把端口直接映射到公网。

Windows 如需放行防火墙，可只对 Private 网络开放 3100：

```powershell
New-NetFirewallRule -DisplayName "Agent Game Framework LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3100 -Profile Private
```

## AI Provider

| 模式 | Provider | 说明 |
|---|---|---|
| 会员 / 本地 | Codex | 使用本机 Codex CLI / ChatGPT 登录态，不需要 OpenAI API Key |
| API | OpenAI | OpenAI Responses API |
| API | DeepSeek | DeepSeek Responses API |
| API | Responses-compatible | 自定义 Base URL / Model / API Key |
| 离线 | Mock | 不调用真实模型，用于程序规则与测试 |

### 本机保存 Provider

Provider 弹窗可勾选 **“保存在这台电脑”**。配置保存在服务端：

```text
data/secrets/ai-provider.json
```

该目录应被 Git 忽略，也不会进入 Save Package 或浏览器 localStorage。浏览器只会知道“Key 已配置”，不会从服务端取回 Key 内容。

需要注意：当前实现是**本机文件保存**，不是操作系统凭证保险库；请保护本机账户和 `data/` 目录。你可以在 Provider 弹窗中选择“忘记本机保存”。

多个手机 / 电脑页面连接同一个 Node 服务时，会读取同一份 Provider 状态；页面在重新聚焦或短周期同步后会更新当前 Provider。

## Character Card

人物页支持导入 Tavern / Character Card V1、V2、V3 JSON。

导入逻辑遵循：

```text
Character Card
    ↓
Compatibility Adapter
    ↓
Framework Character Entity
    ↓
Canonical Save
```

角色卡中的 description、personality、scenario、first message、tags 等作为角色资料导入；它不能绕过 Framework 直接声明属性、金钱、权限、装备或世界事实。未知扩展字段会尽量保留在原始角色卡数据中。

当前只支持 JSON 导入；PNG/APNG Embedded Card、CHARX 等容器格式尚未实现。

## 创建世界

在启动页选择 **创建新世界**，描述世界和玩家，并可选导入文本 / Markdown Prompt 或 Prompt Profile JSON。WorldInitializer 返回结构化蓝图，Framework 编译并校验后才接受为新的 Canonical Save。

## 存档与隐私

每次正式行动自动保存。**存档**页支持手动检查点、恢复、JSON 导入与导出。

导出的 Save Package 可能包含 GM 隐藏状态，因此适合作为私人备份，不应未经检查直接上传到公开 Issue。

私人存档、头像、API Key、运行日志和迁移输入应放在 Git 忽略目录中。

## 项目结构

```text
src/core/        核心状态、Schema、Registry、地图、时间、骰子
src/modules/     游戏模块
src/ai/          Prompt / Provider / Adapter
src/storage/     JSON 持久化
src/server/      HTTP 边界与 GameService
src/client/      React Web UI
src/shared/      前后端共享契约
content/         公开示例世界 / Prompt Profile
tests/           离线回归测试
scripts/         smoke / 开发脚本
docs/            架构与版本文档
data/            本地私人运行数据（应忽略）
```

## 开发命令

```text
npm run build       TypeScript + 前端构建 + Server 编译
npm test            离线测试
npm start           运行 production build
npm run start:lan   以局域网模式运行 production build
npm run dev         开发模式
npm run smoke       Mock smoke test
npm run smoke:codex 可选真实 Codex 测试，会消耗额度
```

## 已知限制

- 当前是单玩家、本地 Server、一个活动存档 / 检查点。
- 尚无完整 Combat、NPC Schedule、公司经营和持续后台 Agent 模拟。
- Routine 负责通用时间压缩；具体上课、工作、训练的收益需要对应 Module。
- JSON 导出暂不打包头像图片本体。
- 角色卡当前只支持 JSON。
- AI 输出即使通过 Schema，也不等于叙事语义一定正确。
- 本机保存的 API Key 目前存于 Git 忽略的服务端文件，而不是 OS Credential Vault。

## Roadmap

- Visual Asset 层：avatar / portrait / full-body / canonical visual identity。
- 更多 Character Card 容器格式。
- NPC Schedule / Education / Work / Combat 等可插拔模块。
- 更完整的移动端 / PWA 体验。
- Portable Save Bundle，包括本地视觉资源。
- 更长时间的世界一致性评测。

## License

MIT License。

---

# English

An extensible **AI-native persistent-world game framework**. The model handles language understanding, narration and suggestions; the framework owns deterministic mechanics and validated canonical state.

Current application version: **v0.1.9**.

## Highlights

- Persistent canonical saves across turns, reloads, restarts and model changes.
- Lightweight Entity + Components with Module / Action / Event registries.
- Deterministic movement, time, dice, inventory, commerce and equipment.
- Structured characters, relationships, attributes, aptitudes, skills, traits and quests.
- Hierarchical maps with known/hidden locations and runtime discovery/extension.
- Routine / time compression with event-driven interruption.
- Pluggable AI providers: Codex, OpenAI, DeepSeek, Responses-compatible and Mock.
- Optional server-side provider persistence shared by desktop and mobile clients.
- Tavern / Character Card V1, V2 and V3 JSON import.
- Local avatar upload and optional browser speech-to-text.
- Autosave, checkpointing, JSON World/Save import and export.
- LAN mobile access with the desktop machine acting as the game server.

## Architecture

```text
Web UI → GameService → Action / Module Runtime → Validated Canonical Save
                ↕
           AI Runtime → AIAdapter → Codex / OpenAI / DeepSeek / Compatible / Mock
```

A model may propose an action or a permitted patch. It cannot arbitrarily merge JSON into the save. Registered handlers execute mechanical changes and framework validation controls what becomes canonical. Model threads are replaceable context, not the world database.

## Quick start

Requires **Node.js 22.12+** and npm.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3100`.

Offline / rule-only mode:

```powershell
$env:AI_ADAPTER="mock"
npm start
```

## Mobile over LAN

Keep the desktop as the Game Runtime / AI server and use the phone as a web client.

PowerShell:

```powershell
$env:HOST="0.0.0.0"
npm start

# or simply
npm run start:lan
```

The server prints private LAN URLs such as `http://192.168.x.x:3100`. Open one of them on a phone connected to the same trusted network.

Loopback remains the default. LAN mode only allows localhost and RFC1918 private IPv4 hostnames; do not expose the raw server directly to the public Internet.

## AI providers

| Mode | Adapter | Configuration |
|---|---|---|
| Local / subscription | Codex | Local Codex CLI + ChatGPT/Codex login, no OpenAI API key |
| API | OpenAI | OpenAI Responses API |
| API | DeepSeek | DeepSeek Responses API |
| API | Responses-compatible | Custom base URL, model and API key |
| Offline | Mock | No external model calls |

### Persistent provider configuration

The provider dialog can persist the selected provider and API key on the local server at:

```text
data/secrets/ai-provider.json
```

The file is outside canonical saves and should be excluded from Git. API keys are never returned to browsers; clients only receive whether a key is configured.

This is currently a local file, **not an OS credential vault**. Protect the local machine and `data/` directory. The UI provides a “forget saved configuration” action.

Desktop and mobile pages connected to the same Node server share the same provider state and periodically resync it.

## Character Cards

The Characters panel can import Tavern / Character Card V1, V2 and V3 JSON.

Character-card text/persona fields become character context, but the card does not bypass world rules or directly grant canonical stats, money, inventory, permissions or authority. Unknown extension data is retained where possible.

PNG/APNG embedded cards and CHARX containers are not implemented yet.

## Saves and canonical state

Every committed action autosaves. The Saves panel supports a manual checkpoint, restore, JSON import and export.

Exports may include GM-hidden information. Treat them as private backups rather than safe public bug-report attachments.

Private saves, uploads, provider secrets, logs and migration inputs should remain in ignored local directories.

## Project structure

```text
src/core/        state, schemas, registries, actions, events, map, time, dice
src/modules/     gameplay modules
src/ai/          prompt roles, provider manager and adapters
src/storage/     JSON persistence
src/server/      HTTP boundary and GameService
src/client/      React UI
src/shared/      shared client/server contracts
content/         public example world and profiles
tests/           offline regression tests
scripts/         smoke/development scripts
docs/            architecture and release notes
data/            ignored local/private runtime data
```

## Known limitations

- Single-player local server with one active save/checkpoint.
- No complete combat, NPC schedule, company simulation or continuously autonomous background agents yet.
- Routine provides generic time compression; domain-specific rewards require matching modules.
- JSON exports do not bundle avatar image bytes.
- Character-card import currently supports JSON only.
- Schema-valid AI output can still be semantically inconsistent.
- Persisted provider secrets are stored in an ignored local server file, not an OS credential vault.

## Roadmap

- Visual Assets: avatar / portrait / full body / canonical visual identity.
- Additional Character Card container formats.
- Pluggable NPC Schedule / Education / Work / Combat modules.
- Further mobile / PWA polish.
- Portable save bundles with visual assets.
- Longer-session consistency evaluation.

## License

MIT License.

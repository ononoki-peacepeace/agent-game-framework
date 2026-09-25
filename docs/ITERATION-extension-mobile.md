# 产品交互、Extension 与移动端迭代报告

日期：2026-09-24。工作目录：D:\game。

进度：本轮限定 MVP 开发与验收已完成（100%）；这不代表完整产品或任意动态扩展完成。

本轮范围：Phase A 交互语义修正、Phase B 受限模板 Extension MVP、Phase C Responsive Web / PWA shell、Phase D 自动化验收。不是完整动态插件系统，也不是原生手机 App。

## 1. Current code inspection summary

基于已有 Sparse Routine、DeepSeek 分角色预算、截断保护、显示解析、生产日志与媒体队列继续修改。保留工作树原有修改，没有重建项目或改写剧情。开始前备份位于 .tmp/extension-mobile-20260924-172345。

正式 data/current.json 与 current.before.json 的 SHA256 一致：3A5AEE40AE6B98E8620F20715093CCD43D58BDF09B51C1D0A960FD80EFC04B71。所有新浏览器测试使用独立 .tmp 存档；没有修改 data/secrets，没有提交或发布。

## 2. Root causes

| 问题 | 原因与处理 |
| --- | --- |
| 玩家声明任务完成 | 通用 acknowledge 接口直接写任务状态；现返回 410，界面删除完成/任意取消按钮，改用规则证据 |
| 保存计划推进世界 | 配置动作经过普通 turn 生命周期；配置动作现在跳过时间、随机事件与叙述，保留原前台场景 |
| 计划与后台状态混淆 | 一组状态同时表示配置与作业；拆成两组展示 |
| 无计划显示失败、旧失败残留 | 未区分配置缺失与终态版本；无计划显示中性提示，过时终态不占主卡片 |
| Routine 抢占选择 | handoff 只看部分 interrupt；加入 choices、显式 foreground、NPC 待答、正在执行事务与小游戏 |
| 模糊安排变精确时间 | UI 暴露内部执行 anchor；接受安排卡改为日期、时间窗、时长，执行参考仅在计划详情说明 |
| 头像常驻滑杆、缩放不足 | 旧控件嵌在详情且上限固定；改为独立编辑器、动态上限和实时 canvas 预览 |
| 媒体/游戏写入竞争 | 独立入口最终写入可能互相覆盖；canonical 提交与媒体提交在最终写入阶段串行并合并展示数据 |
| 手机过多 tabs | 原两栏只是堆叠，面板导航横向挤压；改为游戏/人物/地图/背包/更多单页切换 |

## 3. 修改文件

本轮主要新增：
- src/client/RoutinePlanPanel.tsx、AvatarCropEditor.tsx、ExtensionPanel.tsx
- src/shared/avatar.ts、src/core/task-rules.ts
- src/extensions/schema.ts、sdk.ts、host.ts、development.ts、verification.ts、intent.ts
- public/manifest.webmanifest、icon.svg、offline.html、sw.js
- tests/product-semantics.test.ts、extensions.test.ts
- scripts/product-browser-smoke.ts、extension-codex-smoke.ts
- extensions/README.md、本报告

本轮修改：
- src/client/App.tsx、panels.tsx、api.ts、main.tsx、styles.css；index.html
- src/core/schema.ts、runtime.ts；src/modules/characters.ts、routine.ts
- src/server/app.ts、service.ts
- tests/routine-lifecycle.test.ts、sparse-routine.test.ts

git status 中还存在本轮之前的修改，不能把整个工作树都归为本轮新增。

## 4. Routine 新 UI / 状态语义

计划状态：未设置 / 已保存 / 正在编译 / 已编译 / 需要补充信息。作业独立显示运行、阶段、最近一次 AI、暂停、中断和失败。面板只保存、编辑、清除、查看和请求安全暂停。

统一自然语言入口识别继续日常的常用表达，才启动 Scheduler。没有计划时返回中性提示。后台 pending choices 与明确 foreground blocker 会阻止接管。NPC 待答兼用文本检测作为补充，不能保证识别所有开放叙事；世界/模型应提交明确 foreground 语义。

## 5. Task completion 自动判定

世界可声明 task_rules：任务、所属任务册、地点、起止窗口、顺序步骤（行动类型、目标、最低实际耗时）。成功行动提交时按证据累计 task_progress，满足全部步骤才将对应任务和日程完成。

已有任务没有规则时不会靠 prose 或点击补成 completed。当前旧存档的志愿任务尚无完整 authored objectives，本轮不擅自补剧情或假造完成。复杂并行目标、跨任务依赖、失败/放弃后果与更完整的规则引用审计仍待扩展。

## 6. Avatar crop 新交互

普通人物详情只提供“调整头像”入口。编辑器支持圆形遮罩、遮罩外变暗、鼠标/单指拖动、滚轮/slider/双指缩放、实时预览、取消、重置和确定。

保存 source_asset_id / scale / offset_x / offset_y / crop_version，派生 PNG 作为头像缓存。原 fullbody 不覆盖。600×1800 测试图动态允许 25×，已经实际测试 6× 以上裁剪。刷新恢复参数；slider 显示按 0.01 步长取整，持久化仍保留精度。

## 7. Extension SDK 架构

玩家输入 → 意图路由 → 开发向导 → 隔离 workspace → Spec/manifest → 静态检查 → TypeScript 检查 → 规则测试 → 安装预览 → 玩家确认 → ExtensionHost → 纯规则 reducer → SDK 请求 → Framework transaction → 保存/日志 → UI。

第一版仅支持内置 blackjack / turn_based_combat 规则与声明式配置。Codex 返回受限 JSON Spec；Framework 写独立 profile.ts 和 dist/profile.json。没有执行模型生成的任意 JavaScript，也没有声称实现通用第三方代码沙箱。

## 8. 权限模型

manifest 声明公开状态、地点、背包读取及 owned state、经济、生命、消耗物品请求。纯规则只收到自己的局面和有限上下文；不能拿到整个 save、其他 namespace、GM、密钥、文件系统或 shell。

Host 校验权限、场景、余额、下注上限与请求形状；GameService 校验 game_id / revision / request_id，串行写入并记录 committed transaction。extension.result.proposed 只表示候选结果，不能当作已提交事实。

这些保证适用于本轮受限模板；未来开放第三方代码必须另做进程隔离、资源限额和能力审计。

## 9. Save / version / rollback

Save Package extensions 按 namespace 保存 manifest、version、enabled、installed、state、previous。卸载保留休眠状态。导入缺少本机已验证版本时提示，禁止执行，不丢状态。

保留一个上一版本用于回滚。相同版本不同内容不能覆盖；回滚后新版本从已验证最高版本递增。进行中的一局必须结束后才能更新、禁用或卸载。构建失败与被篡改产物不能替换工作版本。

尚无跨 state_schema 的自动迁移。其他机器导入后缺包，需要相同的已验证包恢复机制进一步完善；不能保证任意旧包自动恢复。

## 10. Codex Extension Development Mode

后台作业可查看阶段、生成/验证日志和取消；构建时其他只读面板可用。生成不写 Framework 核心，不自动重启，不自动安装。产物哈希和预览内容在安装前复核。

真实 Codex 调用已运行成功，status=ready，随后真实 TypeScript 检查和 32 种规则种子测试通过。源码树 hash 与 canonical state 均未改变，未安装。证据：
.tmp/extension-codex-1790244818015/result.json
及其 workspaces 下产物。

首版是 JSON Spec 生成，不是任意玩法代码生成。未知钓鱼/炼金等需求会明确提示尚不支持，不能假装已有对应扩展。自然语言意图目前是有限规则识别，不是完整开放域需求编译器。生成流水线内尚未为每个候选自动执行浏览器 UI smoke；参考实现由本轮独立 smoke 覆盖。

## 11. Blackjack reference extension

受限 MVP 完成：真实 52 张牌堆、程序 RNG、要牌/停牌、庄家 17 停牌、胜利 1:1、可选下注。无 split / insurance / surrender，天然 21 点也按简化规则 1:1。

扣款与结算通过 Host 经济请求，事务 idempotency 防重复。客户端隐藏庄家暗牌与剩余牌堆。关闭 UI 保留未完成局，刷新不重新扣费。适用场景以 casino 标签/名称识别；原抽象模拟不被强制替换。

## 12. Turn-Based Combat

基础训练参考实现：程序 RNG 攻防、玩家真实 HP、对手 HP、攻击和逃跑，没有自动奖励；Host 提供受限 damage/heal/consume 请求。

治疗请求边界已有实现，但开发向导不选择物品、UI 未提供治疗按钮，状态效果、技能系统、奖励和叙述扩展尚未完成。不是完整 RPG 战斗系统。WASD 实时战斗没做。

## 13. Mobile / PWA

Responsive Web：手机单列页面、底部五项导航、更多全屏菜单、触摸尺寸与游戏按钮、手机 crop 手势。桌面保持双栏。

PWA：manifest、SVG 占位图标、standalone、service worker 和断网提示。SW 只缓存离线提示/图标，不缓存 API、存档、头像或动态游戏响应；行动必须连接 Framework server。HTTPS / localhost 是 service worker 前提；LAN HTTP 仅响应式网页。未验证真实 iOS/Android 桌面安装、平台 SVG 图标兼容性、软键盘与安全区；不宣称完全离线可玩或手机 App 完成。

## 14. 实际验收结果

- Phase A：build 通过，114 tests 通过。
- Phase B：build 通过，121 tests 通过。
- Phase C：build 通过，121 tests 通过。
- 最终保护修正：build 通过，122 tests / 15 files 通过。Rollup 仅有 Zod 注释位置警告。
- 生产模式 Chrome + Playwright，桌面 1440×1000 / 手机 390×844：计划保存不推进时间、扩展自然语言需求、后台构建时切页、明确安装、21 点要牌/停牌、刷新恢复、生产日志、手机多面板与无横向溢出、手机牌桌、SW 不缓存 API、断网提示均通过。
- 真实头像 mouse drag / wheel / realtime preview / 参数刷新 / 原图字节一致，以及 CDP 原生 touch drag / pinch 通过。
- 上述完整浏览器证据：.tmp/product-browser-1790244857787/results.json 与截图。最终追加 smoke 亦通过：.tmp/product-browser-1790245056356。覆盖修正后的手机弹窗，以及回合制训练构建、安装、新一局、攻击、逃跑。截图已人工检查。
- 单元/API 测试覆盖 pending choices / NPC 待答 handoff、无计划及过时失败、时间窗显示、禁止手工完成、任务规则、DeepSeek 截断/重试、日志脱敏/空闲 polling、媒体并发、扩展隔离/事务/恢复/失败候选/版本管理。
- Codex 实测成功证据见第 10 项。
- 既有 scripts/browser-smoke.ts 并非本次主要验收入口；本次使用新 product-browser-smoke.ts。

## 15. 未完成项

任意动态代码扩展、通用插件沙箱、钓鱼/炼金/布置、跨版本状态迁移、旧任务完整目标规则、战斗技能/状态/治疗 UI/奖励、WASD、真实手机安装与完整离线游戏均未完成。

受限模板 Extension MVP 已完成；完整动态扩展能力尚未完成。

## 16. 风险与下一步

优先补 task_rules 引用/冲突审计及具体世界任务作者规则；开放叙事 handoff 需更可靠的显式状态生产与清除。补开发请求内容指纹、候选构建更强的故障注入、跨机器扩展包恢复与 state_schema 迁移。开放任意代码之前单独设计安全隔离，不能沿用模板安全结论。

下一轮建议先做真实手机 HTTPS 安装与软键盘验收，再补训练治疗/技能和一个明确的 authored task；之后才评估更多扩展类型。保留当前可工作的原型，避免为未来重做所有模块。

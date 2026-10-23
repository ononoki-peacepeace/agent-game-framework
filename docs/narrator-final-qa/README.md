# Windows 网页 Narrator 最终质量验收交接

2026-10-23（北京时间）。这是 QA 准备包，不是验收通过报告。没有启动服务、读取正式存档、调用付费 Provider 或修改正式计分。

## 版本与使用顺序

核对到远端 main `7cd0c8a4665831acc0b52faf646ddf9062b2d874`；PR #8 head `dc18a7209e53ff1ac166a8bdebb500a1db2ed691`，PR #9 head `39b60a77f130937202d0a97c4e7eb74305afd97b`，PR #10 head `b54c48ac95ae734f4a760b7b693563b70d5cc9ac`。这些 head 不在该 main 的祖先链内。不能据此推断 Windows 本地整合状态；用户已确认 PR 均交付。GitHub 元数据 API 历史 Forbidden，Git refs 是本次可核对依据。

本包独立基于上述 main，仅新增文档/案例和本地记录工具，不携带 PR #8～#10 产品实现。Windows 在安全检查点完成既定适配后再采样。先核对 PR #8 的具体结果、降级/发言恢复，PR #9 的记忆投影，PR #10 的人格预算/发言归属；N6 场景还需要 PR #3～#7 的物品/消耗修复。PR #10 与 #8 在 `narrative-health.ts` 人格调用旁的位置字段及交接追加处存在文本冲突：保留位置/在场、目标优先、拒绝边界，并保留 `purpose='narration'`。不覆盖 Windows 未提交文件，不由本包合并。

远端旧进度 JSON 仅为历史快照。**Windows 的正式台账及当前整合版本是统一计分依据，本包不导出或回写总分。** 将 Windows 台账引用填入 run.json；未知就保留未知。

1. 阅读 [13项完成路径](conditions.md) 和 [独立评审规则](review.md)。
2. Windows 在现有网页流程中选独立 QA 存档，确认已部署构建、源文件哈希、预算授权和完整日志可导出。不要把正式游戏转为测试存档。
3. 从当前整合源码目录运行下面的本地命令，创建一个**不存在**的新输出目录。工具只创建记录文件，不创建世界、调用接口、开启服务器或变更 Provider 配置。
4. 填 run.json 的实际部署核对、QA game_id、三世界结构证据及绑定。输入案例前检查条件；缺失能力记录 blocked，不能靠旁白补造。
5. 按 [cases.json](cases.json) 执行并逐步填 records.json。所有第一次失败、修正、拒绝、费用未知和未触发分支都保留；不挑最好输出。
6. 完成一个经 Windows 批准的预算批次后封存并检查。部分包可以封存，但 check 会返回未完成清单，不得声称全套通过。
7. 独立评审者对原始输出和事实依据填写评分；身份、授权、部署版本与费用由 Windows/用户在工具之外确认。收到授权的数据包后，iMac 可继续独立分析，开发者观察不代替独立验收。

## 本地命令（PowerShell 可直接运行）

```powershell
# 在已整合的仓库目录。父目录先由操作者选择；目标目录必须不存在。
node scripts/narrator-live-qa.mjs init C:\QA\narrator-run-001
# 填写 run.json 的 bindings 等，并把相关 QA 快照导出到 artifacts 下。
node scripts/narrator-live-qa.mjs render C:\QA\narrator-run-001 relationships P01
# render 只输出 JSON 中的原句；人工核对 setup 后逐条粘贴现有网页。
# 填 records.json、原始日志、凭据、输出后：
node scripts/narrator-live-qa.mjs seal C:\QA\narrator-run-001
node scripts/narrator-live-qa.mjs check C:\QA\narrator-run-001
```

`init` 记录运行目录 Git HEAD 与已跟踪源文件哈希；**这不证明现有网页运行了该构建**。`deployed_head`、`deployed_source_verified` 和 `integration_verified` 须由 Windows 核对部署实际构建后填写。若有未提交源码，source.json 中实际文件哈希才是内容标识，附构建清单，不伪造 clean commit。

工具拒绝覆盖已有目录或封存文件，拒绝引用目录外路径（含符号链接逃逸），不静默补齐缺失日志。修正封存后的记录时创建新版本目录，保留旧包和关联说明。哈希只证明相对于封存字节没变，不认证人类身份、模型来源或事实真伪。

## 与已有基准的关系和费用控制

原 `docs/narrator-quality-program.v1.json` 加 `narrator-prose-benchmark.v1.json` 的 **56 案例、9 对照**保持原样；`scripts/narrator-quality-program.mjs` 是离线捕获，不能冒充网页真实模型。原 review-template / quality-review 工具仍用于其原格式，不要把本包 records.json 直接传给它。本包保留相同五维锚点，并把具体性与连贯性作为诊断单列；不替换原案例、不修改条件分母。

14 案例卡 × 三结构 = 42 个网页记录槽，每卡可能有多轮、成对前提及多个结果分支，**42 不是请求数、Token 数或费用上限**。原56与网页场景可引用同一原始证据，但必须匹配版本、输入、事实、来源和场景条件；不能用不相干案例或旧 mock 输出补空格。N9.3 需要 Windows 固定当前集成源并给完整基准逐项列出结果与缺失，不能仅跑本包后称原基准完成。

建议预算先批准一个结构的 P01、A01、A02 作为日志/绑定试运行（仍不能关闭条件），随后按缺口分批；未批准的案例留 not_run。Windows 指定总调用、输入/输出 Token、费用、超时与修正上限。所有 Semantic/NPC/Planner/Narrator/修正/失败调用都记账，费用未知记 null+原因，不记0。没有授权或剩余额度时停止模型调用，保留 checkpoint。不得为凑结果无限重掷、诱发付费拒绝或运行第二个服务。

三世界须有真正结构差异：交易/移动、关系/知识、自主生活/背景事件。只改名称不合格。每结构的正常、缺失/歧义、世界拒绝、技术故障和重放必须有证据。固定用例中的结果类别未实际出现就记 not_observed，由 Windows 决定是否用已有受控 Core 场景补足；不把假输出写成真实模型。

## 结果对接

[记录格式与示例](records.md) 指定 request/game/revision、原始调用、Core/NPC依据、可见输出和费用字段。原始 Windows 日志格式不必改写：复制授权导出的原件，填写对应相对路径；完整性工具只校验引用，不解析或替代 Windows 原日志系统。敏感凭证必须在分享副本中脱敏，并保留脱敏说明/受控原件定位；不得改模型正文或事实来掩盖失败。

无新增已复现未修复产品缺陷。本次是证据准备；有限投影可能遗漏超预算信息、抽象 Core 失败缺少具体原因、单人物重复有时合法等属于已知待观察边界，不宣称任意输入都解决。出现真实反例后按 records.md 保存版本/输入/原文/权威事实/重现步骤，再进行最小修复。

# NPC Provider/Domain契约系统性修复及恢复覆盖结果

2026-10-18。Schema代码、离线验收及安全部署完成；**全Framework定向纠错闭环尚不完整**，具体逐出口清单见[恢复覆盖表](qa-ai-recovery-coverage.md)。未调用付费模型、未自动游戏、未改正式世界。

## 1. 为什么前次遗漏plan_proposals

前次规范化依据`z.toJSONSchema(schema)`默认的**output**契约：`plan_updates.optional()`输出仍可缺省，而`plan_proposals.default([])`及`goal_proposals.default([])`的解析后输出必须是数组。因此相同的Provider缺省表示`null`只修了普通optional，漏了带default的字段。不是模型需要保证输出空数组，也不是领域应接受任意null。

已保存第二次原正文被固定为脱敏fixture。同一正文经过旧output模式规范化，仍在`plan_proposals`拒绝；经input模式恢复后通过。新增永久回归明确断言这个修复前/后差异，没有修改失败正文。

## 2. 正式边界及全部字段

共享`structuredInputSchema`使用Zod的`io:'input'`，Provider编译器仅把**输入可缺省**字段转换为必填nullable wire键。返回后用同一个输入契约把引入的null恢复为缺省，再执行原领域parse，由领域自己应用default。

|字段|领域输入语义|Provider null返回后的处理|
|---|---|---|
|kind、intent、decision_summary|必填非null|仍拒绝null/错类型|
|speech、vote_target、proposed_action|必填nullable|保留真实null；proposed_action空对象仍拒绝|
|evidence_refs、belief_updates、goal_updates|必填数组，无默认|保留空数组；null/缺省/错类型仍拒绝|
|plan_updates|可缺省非nullable数组|还原缺省，不强塞空数组|
|goal_proposals、plan_proposals|输入可缺省，解析后default([])|还原缺省，由Zod应用[]|
|social_response|nullable且default(null)|null保持null，缺省由Zod处理|

同样检查嵌套steps、not_before、condition、action duration及更新结构；有默认值/optional/nullable各守原语义。元组、数组、字典、可判别union、本地引用/定义使用共享转换；歧义union不猜测，保持原值由领域拒绝。未知字段沿用原入口策略：strict helper拒绝，已有runtime prune仅剔除未授权多余键后再完整校验，不能进入Core修改位置。

完整机器可读逐项对照：[qa-npc-schema-contract-audit.json](qa-npc-schema-contract-audit.json)。不是只列plan_updates与plan_proposals；发现另一个同类字段goal_proposals也一并解决。不是字段名称特判，也没有把所有null转为空数组。任意外部JSON Schema方言并不自动等同于受支持的Zod输入契约。

## 3. 修改模块

- `src/ai/provider-schema.ts`：共享输入契约与parse边界；严格Provider编译递归到定义/元组，返回值按输入语义还原。
- `src/ai/runtime.ts`：通用call/direct generate，以及Planner、Open Goal、Incident、Freeform统一发送输入契约；领域Schema和NPC语义检查不放宽。
- `src/agent/semantic-entry.ts`：确定性恢复使用同一输入契约。
- `src/extensions/tasks.ts`、`src/extensions/development.ts`、`src/server/app.ts`：直接Provider入口的输入契约/规范化/领域校验保持成对；app运行指纹增加共享provider-schema模块覆盖。
- `tests/npc-schema-contract.test.ts`、`tests/fixtures/npc-decision-deepseek-recorded.json`、`tests/ai-recovery-boundaries.test.ts`：字段矩阵、真实正文回放、失败出口故障注入。

没有新增模型调用或第二套NPC执行器。NPC成功调度、失败退避、首步共享Receipt机制继续复用上一轮代码。

## 4. 真实产物与离线执行证据

- `tr_ab0e111beb22`产物有完整raw_model_output，已原样固定。录制DeepSeek响应经过**实际DeepSeekAdapter响应解析→共享规范化→领域Schema→NPC语义→即时动作/计划协调→Core→权威Receipt→隔离JsonStore→Reload→同request重放→Undo**。NPC执行一次HOLD45，得到committed Receipt；raw plan_proposals=null对应无新持久计划，不伪称本样本验证了首步关联。目标建议合法保留，无凭空物品或额外资源；重复request不再决策/执行，Undo还原。
- 复建的是原产物标明的repository town隔离夹具，使用记录request_id使原evidence_refs仍对应确定性生成的既有日常Receipt；没有向正式档注入记忆、没有把原Prompt/隔离存档说成已保存。
- `tr_f74b4250d22f`只保留字段类型/错误和用量，**没有原始动作/计划正文**，因此不能完整重放或证明原动作真的等价。原始类型结构由明确合成夹具覆盖；即时动作与计划首步的精确相同/冲突、Core保存失败恢复另由已有NPC HTTP和计划回归验证。不能把这些合成数据冒充真实原返回。
- 原生成语义可能仍被正确拒绝；修好Schema不代表任意模型目标、证据引用或计划均合法。真实模型是否稳定产生兼容计划，仍未通过本轮新调用验收。

## 5. 测试与恢复覆盖

- 12文件202例相关回归通过：NPC契约/即时与持久计划/HTTP/欠账调度/长期世界、World Gap、System场景与扩展直接入口。
- 6文件89例恢复回归通过：Semantic、Planner、World、Director、Narrator。
- Natural Scene按明确`-t`选择5例通过，其余34例本轮未运行。
- 最后新增原始正文旧/新契约对照及重复完整回放2例通过（其中回放用例与前批重复）。合计**297个不同用例通过**；未重复跑全量。
- `npx tsc --noEmit`、`npm run build`、`git diff --check`通过。保留既有客户端大bundle与Zod注释构建提示，未改门禁。
- 曾有新增引用定义编译测试失败，定位为normalizeObject提前return跳过同层$defs；修正后同用例通过，保留早期日志，不靠移除断言过关。
- 旧System/Narrator场景夹具回归通过；更早`daily-qa-batch`无权威事实的旧断言已在基线报告中记录，本轮未再运行、未掩盖、未扩大修复。

**恢复实际覆盖**：确定性Schema修复全共享入口接通；Semantic/Scene/World/Director/Narrator等已存在有界反馈路径，经故障注入确认。

**未覆盖出口**：NPC非确定性Schema/语义失败目前只退避，无定向模型修复；地点提案、Routine、部分System/草稿/扩展规格失败直接终止；Planner及部分事实拒绝反馈缺原候选；最终Narrator claims失败不回生成循环。预算在各层有界但尚无统一全请求总预算。详见覆盖表中的实际路径/风险/分阶段方案。**本轮不把Schema完成包装为整个恢复框架完成**。

## 6. 安全部署及正式档完整性

备份：`.codex-checkpoints/npc-schema-systematic-deploy-20261018-065302/`，current完整JSON、世界包、Routine作业、package/启动脚本、新旧dist压缩包及manifest；两个编译包均逐项读取校验171项。

检查时旧PID19380已退出且3100无监听，HTTP连接拒绝；仍有仅含19380的失效锁。再次核验进程/端口/HTTP、备份锁后仅删除此锁，没有强杀进程。用户在原终端执行start:lan保留原Provider/代理环境。正式HTTP随后确认：

- **v0.1.19、compiled、PID13624**，运行锁13624。
- 指纹 **`dfcf49da2b87b34b9d5824002213f8835fe5c825e47b716dd6f223f753d9e3c7`**，匹配本次编译物。
- DeepSeek Flash配置存在且持久化，健康ok，首页HTTP200。没有推理调用。旧health.version硬编码不作为版本证据，未在本轮改无关代码。
- 正式REV389，第1日17:48，餐厅。先内存预检基础设置/迁移changed=false，再读取HTTP投影；前后正式文件SHA256完全一致：
  `119585428f0739a55865f97a1372879007bfdfc6893e10edb42179f42b60b75c`。
- 既存NPC调度时间未改写。后续真实验收应等待正常游戏时间和公平调度满足现有条件；不能为马上再试而偷偷清除调度记录。

只在没有新世界写入且SHA仍为此基线时可安全停服恢复rollback-dist；不可恢复旧save抹掉玩家进展。新增状态产生后若回退编译物，应先做Schema兼容性复核。

部署HTTP安全证据：[qa-npc-schema-deploy-http.json](qa-npc-schema-deploy-http.json)。本轮不含真实新Provider验收；如后续授权，一次隔离NPC调用可验证新Schema边界，但NPC合法选择无行动/无计划时，不能用这一次证明首步关联、所有错误恢复或长期自治均已真实验收。

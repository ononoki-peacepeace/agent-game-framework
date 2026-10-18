# 人物能力、执行链与 Narrator 集中收口结果

日期：2026-10-16。本报告覆盖人物能力任务及随后 QA-01～08。没有改写正式存档、重放正式行动、修改正式 RNG，未重启正式服务，未 commit/tag/push/release。

## 结论与恢复真人 QA 条件

本轮完成了已定位的目标绑定、局部阶段执行、属性/技能接线、Narrator 错误降级及运行版本诊断修复。不能宣称全部真人 QA 已通过：真实隔离 HTTP 行动执行成功，但叙事人工复核发现具体身体表现及物品变化越界，已补离线拒绝门禁但未再做真实重跑；正式世界仍没有结构化人物能力；当前正式服务也没有证明已加载本轮代码。

建议先由用户安全重启服务并核验 `/api/session.runtime`，再做小规模非破坏性 QA。暂不建议把正式暴力行动、永久伤害或全部叙事事实边界视为验收完成。不要直接迁移正式人物能力，不根据职业或性别猜数值。

## 一、真实取证

### REV 289 为什么变成机械摘要

- request_id `d7a9278c-ec60-4982-9d2f-089ad9d43cc1`，trace `tr_f1efa3de7c44`，expected_revision 288。
- 完整十秒目标存在，实际四次尝试，时间片 3+3+3+1 秒。接触结果依次失败、成功、失败、成功；两次后续伤害阶段均失败。最终没有新增伤害。
- 当时双方没有 attributes/skills。有效修正 2/2 来自既有控制与目标警觉，不能把自然语言职业设定当成实际力量优势。NPC HP80 不满足既有 HP<50 伤势阈值。
- NPC 反应 Schema 拒绝 `proposed_action.duration_minutes=null`，随后继续 Narrator。
- Narrator 三次：29.710 秒首稿被 inventory 规则误拦（“力道收进去了”）；22.895 秒第二稿触发接触否认校验；24.653 秒第三稿 Schema 失败。第二稿完整原文、第三稿具体 Schema 路径未留存，不能补造。
- 外层 Provider/Schema 错误捕获仍调用简短 canonicalResolutionNarrative，绕过已改进的物理 fallback。这是旧改造未覆盖的真实分支。
- 共 9 次模型调用；包括 Freeform 输出预算截断后的压缩修复。Core 已完成后，重试只发生在生成阶段。

### QA-01～08 逐项证据

| QA | Trace / request_id | 实际断点与本轮处置 | 验收状态 |
|---|---|---|---|
| 01 | tr_2d03780716c6 / e9e1c15e-e76d-4277-9865-35d13c210ac0 | 三次调用，无 Core/提交。interact 绑定只承认 interactable，漏掉真实 character，目标停在 needs_binding。绑定器纳入人物；统一语义的局部身体阶段直接交给现有 Core，接触→控制→推动仍逐级检查。 | 离线 PASS，原句真实 Provider NOT RUN |
| 02 | tr_7414be596dac / 3f36b6d9-2abe-40b1-a537-d988135d2742 | 三次 incomplete、六次调用，无 Core/提交。旧原始候选未保留，无法断言具体缺失哪一字段。确认固定 GoalSpec 下反复重规划无法修正上游契约；现在同一 alignment 可提出修订，返回唯一 Semantic Entry 一次，再重新审核，不由 Planner 改目标。 | 有界修订到执行的离线闭环 PASS；该极简原句真实 NOT RUN |
| 03 | tr_5beb4665e39c / 5f0fdeab-51d9-4f0f-9874-675492d4b7f4 | 5 次调用，实际两阶段 OPPOSED_CHECK partial_success；NPC BREAK_FREE 失败，提交 REV290。旧 raw proposal 未保留，不能仅凭旁白断言 Core 把打击换成抓握。此前实际 restrained_by 仍存在。新增 typed physical_intent.forms 从语义所有者传至 Core/反应/Narrator，拒绝把明确 strike 替换为 restrain。 | 离线 PASS，旧动作类型证据不完整 |
| 04 | tr_603749115539 / c102eed4-8278-4779-9e99-69a4b4e37b86 | 磁盘原文“我往她脸上狠狠打了一拳”，Semantic 已选 n_hayase，Freeform 两次 target_binding_invalid。Core 重新按字面姓名匹配，丢失上游目标。4 次调用，无 Core/提交。现在内部传递已验证目标 ID，统一引用补全，歧义不任意选人。 | 离线 PASS |
| 05 | tr_9f5b28d8823a / 2346857d-54db-4921-a1ba-d03823c690fb | 四个子 Receipt 和一个聚合 Receipt，HP80→60。Narrator 先 Schema 错、再 position claim 错、再接触否认，进入短 fallback。第二稿原文未保留，不能认定 position 拒绝误报。既有控制可能使“别抓我”合理。统一 fallback、逐次事实、当前动作 forms 及实际 NPC 路线都进入生成。 | 离线 PASS；真实执行 PASS，文学事实边界仍有缺陷 |
| 06 | tr_1ea2204fc324 / 065ecf34-b46f-4e85-838e-5ef0cebf6b90 | 玩家尝试失败后 NPC 通过自主活动 Core MOVE 离开，Receipt 335e192a-6570-42be-abd1-e4b0f5bd90a8，路线实际2分钟。不是旁白瞬移。旧 fallback 遗漏离场。现在只投影玩家可观察的新 Receipt，正常叙事必须交代实际离场，fallback 同样保留。 | 离线 PASS，真实离场展示 NOT RUN |
| 07 | tr_04baada57f8b / c548ac8c-bd93-458b-9ce4-bf2827097041 | 此请求日志顺序是接触失败→NPC BREAK_FREE成功→NPC MOVE离场（Receipt 0f8ca278-9b77-4453-a07f-73c6c52d1934）。不能用最终位置证明开始时不在场。该回合还因“刚离场者发言”校验及 Schema 失败降级。修正同回合离场反应上下文；另加真正远处目标的前置拦截，不掷骰、不泄漏地点。 | 历史前提部分不成立；远处目标离线 PASS |
| 08 | tr_4df905b32f38 / c05c0ece-1c3c-4239-9a95-a815514d393f | Provider两次都返回，均 goal_spec.persistence invalid_value；既有一次恢复确实运行，仍失败。没有超时或 Undo 缓存污染证据。现在明确 enum 及字段诊断，继续完整校验，不擅自把未知值转 none。 | Schema反馈离线 PASS；Undo后建议性交流真实 HTTP PASS |

REV290/291/292/296 的部分完整旧候选、原始 Narrator 和旧 Receipt 已不在当前 Undo 分支，日志不够时不将推测写成事实。Undo 增加 revision 但恢复旧时间是合法行为，不为此修改时钟。

## 二、能力与状态：已有、缺失、接线

- 已有：attributes、aptitudes、skills、condition、physical_state、scene_position、成长 XP、对抗判定及伤害累积。旧 capability 只按 domain 名取单项 attribute 或 skill，没有统一的相关技能+基础能力映射；正式世界启用模块中没有 attributes/skills，所以人物简介不能产生真实差异。
- 本轮复用 ruleset 增加可选 capability_domains：显式关联 attribute、相关 skills、世界数值 baseline/step、是否受身体状态影响、单次体力成本。缺失数据按中性值，绝不从性别、职业标签推断胜负。
- 判定使用映射后的基础能力+已登记相关技能，仍受既有伤势、疲劳、警觉、实际控制等修正。每次尝试重新读取已更新状态；体力只在真正判定时扣一次，折叠、Narrator重试、重载不再扣。
- 确定性动作仍不掷骰、不默认消耗新体力。没有完整距离物理模拟；现有粗粒度距离、姿势与阻挡规则保留，不假称已实现人体力学。
- 初始化新增可选 capability_profiles，明确来源 basis 写入既有 attributes.initial_source。若提供 profiles，必须覆盖实际创建的全部人物，ID不可重复或失效。完全省略仍兼容旧蓝图；启用属性模块且缺值使用明确中性默认。不能声称所有旧世界都自动有充分人物能力。
- 身体动作的 contact、control、injury 与长期目标分开。新增 control_stage_id 复用既有分阶段判定；控制成功而后续推动失败时保留实际控制，不把单纯接触当作束缚。
- 伤害继续使用已有 HP/状态与来源。永久残疾、不可逆死亡、完整部位伤势/医疗协议仍未实现，本轮不扩张。

### 旧世界迁移方案（仅预览，无执行）

先列实际缺失人物和能力域；由创作方审定来源、能力值和技能；未知用中性值但标明未知；检查已有伤势与成长不被覆盖；以游戏ID+规则版本+实体ID生成幂等迁移候选；展示差异、完整 validateSave、隔离 Save/Reload/Undo 后，另行授权原子提交。不能因为玩家希望优势就修改数值。正式世界本轮未迁移。

## 三、具体修改与边界

- src/core/schema.ts、resolution.ts、modules/attributes.ts、ai/contracts.ts、authoring.ts、world-initializer-repair.ts：现有能力与初始化接线，旧存档可选扩展。
- src/system/goals.ts、agent/semantic-entry.ts、planner.ts、goal-alignment.ts、goal-contract.ts、entities.ts、executor.ts、core/freeform.ts：单一语义的动作 forms 与目标ID传递；人物绑定；已授权局部多阶段直接执行；上游错误只返回统一语义边界修订一次。没有第二套 Router/Executor。
- agent/npc-agent.ts：duration_minutes=null 表示未指定，仍通过实际动作规则；反应获得当前动作与真实旧控制状态。
- core/narrative-firewall.ts、server/service.ts、ai/runtime.ts：修正“力道收进去了”和真实转移的区别；保留背袋等容器转移校验；补实测持有物散落拒绝；混合连续结果允许局部失败但不允许整体否认已成立接触；两层错误路径复用同一 fallback；可观察 NPC 路线进入事实与离场呈现；不暴露远处活动。
- 移除骰点文本静默替换成机械摘要的路径，改走同一有界审核。禁用 Narrator 内部截断重试，服务级最多三次生成尝试是唯一预算所有者；正常成功不额外调用，Core不会因 Narrator 重试再执行。
- server/app.ts/index.ts、client/api.ts/App.tsx：启动时捕获实际代码指纹、PID、时间、执行类型和 package 版本；session只增加安全诊断字段。页头不再硬编码0.1.16。
- 相对本轮开始的 src/tests 备份：生产22文件 +272/-86 行；测试2文件 +210行。行数是物理行，部分原有源码很紧凑，不代表功能复杂度。隔离验收脚本另计。没有把此前全部未提交修改归为本轮新增。

## 四、真实 DeepSeek HTTP 验收

原始隔离证据：`.tmp/qa-rev289-real-1792153429367/report.json`（含非正式测试原始输出、真实 check/Receipt/场景片段）。正式秘密未复制进去。

预算最多2回合、12次调用、总480秒；实际2回合、8次调用，不为期望胜负追加请求。

### 场景1：十秒连续打击、允许反抗、目标失能不保证

request_id `0c2d386a-3297-4ab4-85bb-883ad5ffd972`。

- 预先登记隔离能力：玩家 strength3+unarmed2；NPC agility−2；不是生成后修改RNG谋取结果。
- HTTP200，REV0→1，60.353秒，5次调用，无生成重试/fallback。
- semantic8.387秒、alignment8.291秒、Freeform14.738秒、NPC5.654秒、Narrator22.794秒；其余约0.489秒。
- 输入31871、输出9247 Token，其中 reasoning6757（reasoning为输出子集，不重复相加）。
- 5次实际尝试+1聚合Receipt；十秒只推进一次。接触成功/失败/失败/成功/成功；后两次伤害20+20，HP100→60；控制未成立。NPC警觉在后续判定中生效。每次1点体力，聚合不再扣。没有保证失能。
- NPC中文呼救，scene_beats 正确speaker_id；未擅自提交离场。
- **执行 PASS，叙事事实边界 FAIL/部分未解决**：首稿虽通过现有自动门禁，人工复核有“怀里的公告纸散开落地”和“脸侧淤红”，Receipt只确认抽象伤害，没有证明具体部位伤势或物品掉落。本轮已用这份原始输出补持有物散落、无权威依据具体伤势的离线拒绝及生成指导，未再付费重跑；门禁仍不等于完整自然语言事实证明。不能把首稿自动通过等同于世界事实完全保真。
- 同一隔离HTTP Undo：REV1→2，时间恢复09:00、seconds0、HP100。

### 场景2：Undo后普通建议性 NPC 交流

request_id `f7551440-bd3d-4de1-a38f-9b1ee8b057ae`。

- 输入“这里暂时好像没什么线索，要不要去别处看看？”，带真实 structured npc_interaction。
- HTTP200，REV2→3，18.723秒，3次调用：semantic4.832秒、goal_preservation2.394秒、Scene11.341秒，其他约0.156秒。
- 输入14053、输出2543 Token，reasoning1696。
- 原句玩家speech原样保留；NPC自主问询方向，没有强制同意/移动。player仍在广场。交流累计21秒，整分时钟未变不是零计时。
- 场景事务完成，没有物理动作所以独立 Core Receipt0，不能凭0Receipt否认合法已提交交流。
- 3次分别负责语义、目标保真、完整多人Scene；不是三次重复生成同一回答。本轮未取消保真安全门。没有足够A/B样本证明P95改善。

两条请求合计 input45924/output11790/reasoning8453。复杂场景仍需约一分钟，不能宣称普通回合都已流畅或从历史世界差异推出严格提速比例。新增诊断/能力映射均本地执行，没有每次固定新增模型调用；受控语义修订仅错误分支最多一次语义生成，仍需后续已有计划审核。

## 五、工程验收

| 项目 | 结果 |
|---|---|
| 定向回归 | 前一批12文件187/187；最终受影响3文件40/40，含新语义修订后执行闭环及能力统计。不同批次有重叠，不相加冒充总量 |
| 广泛回归 | 执行128文件1195用例，初次126文件通过、1193/1195；失败分别为背袋校验遗漏和新增测试替身字段/审核配置。修复后两文件包含在40/40中；没有再次重复全量。原始JSON保留 `.tmp/qa-rev289-regression.json`，不能把它改写成绿报表 |
| sparse-routine | NOT RUN：既有45秒超时本轮未重跑/未放宽 |
| 统计检验 | 同种子123456789，劣/均/优每组512次，成功率30.2734%/52.7344%/76.3672%，有差异但不保证胜负 |
| TypeScript / build | 最终结果见本报告末尾验证记录 |
| 浏览器 | PASS：1366/390px，真实已保存正文完整保留、speech归属/气泡/无头像降级、日志过滤；0次游戏POST、0次真实模型调用。原始测试文本有上文已披露的事实越界，截图不构成该越界已修复的证据 |
| 浏览器修正过程 | 首次脚本误要求手机上被设计隐藏的页头版本可见，修正为DOM版本及session指纹检查，未为通过测试改产品CSS |
| 浏览器证据 | `.tmp/qa-rev289-browser-1792154084417/report.json`，story-1366.png、speech-mobile-viewport.png；当前编译UI+真实文本回放，不冒充浏览器再次付费完成整回合 |
| Save/Reload/Undo | 离线覆盖+真实HTTP Undo通过；未改正式世界 |

## 六、正式服务与存档保护

- 正式3100端口 PID14352，进程/最近startup为本地17:27；运行trace证明已加载上轮重复动作代码，但没有本轮版本指纹。只读GET `/api/session` 返回 engine deepseek、runtime缺失。因此不能声称当前已运行本轮源码。
- Vite既有 `/api` 代理仍指127.0.0.1:3100，未另接正式后端。旧前端硬编码版本会误导排查，现已改为服务报告；不把存档Core版本当应用版本。
- 最初证据文件REV289；本轮后续只读取证时磁盘已有用户操作到REV302。未重放正式行动，不能将其变化归为隔离测试，也不能声称正式世界一直是289。
- 只读取证基线与最终复核均REV302、day1 minute809，SHA256 `042c205aa1fa6a56a785f1ee29f92f1ed70c42fe613875bb0b340360b7412cc5`。真实隔离报告也记录 production_unchanged=true。
- 尚需用户安全重启正式服务后确认 runtime code_sha256/started_at。未擅自停止旧进程或运行中的正式请求。

## 七、剩余问题与下一轮顺序

1. 具体伤势表现仍没有完整的身体部位事实模型。真实输出中淤红没有权威依据，已补最小证据约束：具体淤青/红肿/骨折等不能由抽象HP伤害推导，必须有对应权威事实；允许普通呼吸、声音与姿态表达。新增离线回归通过，但未声称真实模型修复重跑已通过，文本门禁也不能证明所有自然语言事实。
2. 正式世界缺失能力数据，需审核迁移候选，不能从人物简介强行回填。新生成capability_profiles只完成离线契约验收，本轮没有真实重建世界。
3. QA01、02原句及实际 NPC 成功离场的完整真实Provider/UI组合未分别再测，预算停止；对应通用机制有离线覆盖。
4. 新版runtime尚未在正式进程确认；请先完成可控重启与版本检查，再测试普通建议交流、代词单次尝试、多阶段控制/推动、十秒连续动作，核对Receipt与故事。
5. 历史raw输出诊断缺口通过记录Schema字段/错误和短pattern片段改善，不记录完整秘密prompt；不能追溯出未曾保存的旧字段值。
6. 永久残疾、死亡医疗语义仍未实现，不扩大本轮范围。复杂请求5次串行调用仍是延迟风险，不以本次两个样本宣布P95优化。

本轮结论：已交付可核验的通用修复与有限真实执行证据，**尚未达到全部真人叙事验收完成条件**。保留失败证据、未验收项和已知能力缺口。


### 追加收口验证

真实输出暴露的具体伤势/持有物变化已补离线门禁。首次6文件91例执行发现编辑时校验块误重复插入摘要函数，已纠正；受影响2文件31/31复测通过，未放宽断言。其余4文件此前通过。最终构建、diff及存档哈希复核结果随后记录。

最终新增属性标签投影断言已通过：能力初始化/世界初始化修复2文件34/34。初始化使用标准属性中文名称；浏览器真实回放使用手工隔离fixture的空labels，截图中的“未命名属性”不是正式人物迁移或新生成世界验收证据。

最终工程门禁：`npm run build` PASS（含 tsc --noEmit、Vite、服务端 tsc）；`git diff --check` PASS。仅有依赖PURE注释及前端537.76kB包体积警告。最终正式存档SHA256仍为042c205aa1fa6a56a785f1ee29f92f1ed70c42fe613875bb0b340360b7412cc5。


## 2026-10-17 最终验收更新

真实DeepSeek叙事及自主离场隔离验证已补齐，修复视线离场误报与非零属性基准缺值。正式服务因原启动环境不可读仍未安全重启，不宣称部署完成。详见 [最终验收报告](qa-final-narrator-acceptance-2026-10-17.md)。

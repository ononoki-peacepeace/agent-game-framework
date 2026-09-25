# 地图回归与生活模式修复记录

本轮以 v0.1.16 工作树为基线；未覆盖用户已有未提交改动。安全分支：codex/routine-segments-repair。基线 commit：6005f1707bf70e51937f55c34876684f92c05b79。未创建提交或推送。

## 诊断证据与地图恢复

- 仓库只有两个历史提交（439d4c7、6005f17），无 tag；reflog 未提供 v0.1.10–v0.1.16 各次覆盖的独立源码快照。
- 当前 MapPanel 及相关层级辅助函数与上述两次提交一致。core/map、core/state 投影、PublicLocation 及原地图 CSS 没有本轮回归差异。本轮没有修改地图组件、地图 CSS、坐标布局算法或路线规则。
- 实际 current 存档的 definition.map 与本地旧 v012 迁移包完全一致：12 个地点、没有 parent_id、无动态地点。原始 content/worlds/town.json 是另一演示世界，不能拿它覆盖私人世界。
- 本地 v013 与 v015 包保存相同的19地点层级和坐标；v015额外明确 known_by_default。恢复来源为 imports/herne/Herne_rev43_Framework_Save_v015.json，按原文件地点定义恢复，没有人工推导新父级或设计布局。
- 证据能定位当前数据来源与扁平化原因，但无法证明究竟哪次未记录的操作换入了 v012 数据；不将此推断冒充历史事实。
- 关闭真实服务后另存最新备份，只写 definition.map.locations、map_state.known_location_ids，并将 revision 54 升到55。其他字段进行深比较，全部一致，包括时间、实体、关系、属性、技能、钱包、物品、任务、事件、路线、game_id、receipt和AI threads。没有改动 data/secrets。
- 服务已在原 0.0.0.0:3100 LAN 模式恢复。实际 GET /api/state 返回19地点、18个有父级地点、revision55。

## 生活模式根因与新调用链

旧 START/CONTINUE 在 routine 模块里按 chunk_minutes 循环 advance；之后调用仅可叙述程序事实的 Narrator。Narrator 又被限制为只有人物交流时才能提出关系补丁，课程/兼职/训练根本没有进入结算入口。后加 HTTP 层先推进再 export/import 回滚，既重置游戏身份与线程，又替换了客户端的 expected_revision，因此出现空时间、回滚和版本问题。

新链路：原始请求版本/去重检查 → 克隆 canonical 候选 → 保存/读取自然语言计划 → 当前 Provider 的 gm_reasoning → 下一段明确起止、实际活动、行程、补丁和中断结果 → schema/允许字段/累计幅度/现有实体和路线校验 → 程序结算及事件 hook → 全存档校验 → 原子写入一次 → 前端显示活动记录 → 未中断时发起下一段请求。

普通段一次 GM 调用；正式随机先由 GM 请求检查，程序 dice 生成并记录，再用第二次 GM 调用结算，不能由模型提供正式点数。行程只沿已知且条件满足的有向路线；路上中断时停在触发点并丢弃后续尚未完成活动收益。任何 AI/校验/磁盘错误不提交该段，不借助 import 回滚。重复 request_id 不重复发放收益。

允许有界玩家钱包、现有技能XP、属性、关系及结构化 HP/体力/压力变动；不开放任意对象路径、地图修改、库存凭空增减或任务重写。旧档明确写在人物简介里的三项状态仅在成功生活段内兼容为 condition，原简介不改写。界面优先显示结构化值。

删除了小时循环、HTTP revision覆盖、空结果事后 import 回滚、必须先安装课程/工作模块才有生活结果的提示。旧 activities/chunk_minutes 等存档字段仅保留读取兼容，不再控制调度。

## 本轮修改文件

- src/ai/routine.ts：生活段输出契约、权限提示。
- src/ai/contracts.ts、profiles.ts、runtime.ts：GM角色、canonical上下文、thread缓存。
- src/server/routine-controller.ts：事务内生活结果、数值补丁、行程、RNG和中断结算。
- src/server/service.ts、app.ts：统一请求校验与单次提交，移除HTTP回滚补丁。
- src/modules/routine.ts：取消空时间循环、保留旧存档兼容、持久历史与状态。
- src/core/runtime.ts：允许内部行程推进复用原动作规则，同时避免重复触发外层行动生命周期。
- src/client/App.tsx、panels.tsx：逐段自动继续、中断/手动暂停、生活历史、人物状态分行，以及重试保留请求ID。
- tests/routine.test.ts、status-summary.test.ts：新增回归测试；core/api-ai/storage-service相关旧测试更新。两个原有夹具失败可在修改前备份源码中复现：AI世界最少4地点而夹具只有3地点；磁盘失败桩早于旧档懒升级。
- vitest.config.ts：仅发现正式 tests，避免 .tmp 安全备份被当作测试项目。
- scripts/browser-smoke.ts：适配既有界面的真实选择器，没有改变应用行为。

## 验证结果

- npm run build：通过。
- npm test：7文件、67项全部通过。
- npm run smoke：通过，含真实进程关闭/启动、HTTP动作、存档与GM隐藏字段隔离。
- npm run smoke:browser：通过，含导入、移动、买卖、人物交流、刷新、检查点、导出再导入。
- 真实 Codex：最终契约 START/CONTINUE 均成功，每段完成2小时资料整理并增加8点工资；第二次复用GM thread。测试仅使用独立公开演示世界，不推进私人存档。
- 隔离浏览器：自动完成两段工作，第三次遇到模拟重要邀请立即停止；进程重启后整个 public state一致。
- 地图：旧版源码一致性验证；恢复后逐级节点数量1→2→5→5；学院区所有SVG坐标与旧文件经原算法计算一致；手机390px无横向溢出。
- 实际服务：重启后 health正常，LAN监听保持，恢复后的真实存档除上述3处字段外与备份深比较一致。

## 仍存在的限制

- Codex本身延迟未解决：最终实测两个普通段分别约131秒和133秒。已取消每小时多次调用，但不能声称点击后即时完成。暂停按钮停止后续段，正在生成的段会完成校验后才停。
- 当前框架没有完整通用日历映射，UI以canonical第N天与时刻显示；不凭空把迁移档历史描述中的月日当作新的时钟。原有空推进造成的历史时间本轮未擅自回退。
- patch的结构、对象、累计限额和状态不变量由程序验证；活动描述是否合理、是否识别到语义上的重大事件仍依赖GM，不能等同于形式化的世界模拟证明。
- 未定义赔率、成长/升级规则、资格或日历存在歧义时，GM应中断询问；越界补丁拒绝整个段，不偷偷发放收益。技能到升级阈值需接管。
- 自动执行由当前前端逐段驱动，关闭页面后不继续下一段；刷新后需手动继续。世界后台正式事件由现有hook/RNG在段或行程边界触发，不宣称连续逐分钟模拟。

## 本地证据（未纳入公开资源）

安全备份与地图字段对比：.tmp/repair-2026-09-23T13-56-02-193Z。
最终真实Codex：.tmp/routine-live-1790175833505/report.json、calls.json。
浏览器与进程重启：.tmp/ui-repair-1790176101272/report.json及截图。
真实服务最后核对：.tmp/repair-2026-09-23T13-56-02-193Z/final-live-verification.json。

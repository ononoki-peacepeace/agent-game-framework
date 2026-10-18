# NPC即时动作与持久计划首步关联（2026-10-18）

## 证据边界与根因

真实隔离Trace `tr_f74b4250d22f` 的产物只保留类型：proposed_action为object、goal_proposals和plan_proposals各1项，未保留目标、参数、步骤正文或动作类型。不能声称该返回实际属于相同动作，也不能把本轮合成夹具称为原始正文回放。

原 `validateDecision` 只检查“即时动作非空且有带步骤的新计划”，一律拒绝；没有比较首步，因此也拦截合理的首步双重表示。同时原即时执行器没有将Core Receipt关联计划游标的机制，单纯放宽该断言确实会造成重做风险。

## 正式契约及实现

- `src/agent/npc-agent.ts`：`immediateNpcPlanLink` 校验相同动作类型、稳定target_id、类型约束、启动时间、显式条件、活动/观察范围与实际话语。MOVE限当前可知直接可达目标，路线和实际耗时仍由Core决定；HOLD时长须相同；HOLD/INSPECT文字不等价时不猜测，TALK必须与实际提交话语逐字一致。
- 仅后台world_event现有执行器具有共享Receipt交接；direct_scene、physical_event等尚未接通的入口保留拒绝，避免放宽后重复执行。
- 冲突错误以 `NPC_IMMEDIATE_PLAN_CONFLICT` 区分字段，不通过新增LLM解决。无可确定等价关系时继续拒绝，使用现有失败退避。
- 首步与即时动作只有一次Core调用。Core结果需匹配角色、动作、目标和时间预算；MOVE还需实际抵达。成功结果与计划cursor=1、last_receipt_id在同一保存候选中原子提交。
- `src/agent/npc-state.ts`：现有execution增加可选 `last_receipt_id`，旧存档兼容；后续原计划执行器同样记录该字段。
- 预算不足时只保存cursor=0，不提前执行或推进；Core拒绝时保持cursor=0，记录阻碍和本请求失败标记。后续原计划执行器继续剩余步骤；短期目标仅在计划真正完成时结束。
- `plan_proposals.condition`复用既有execution.condition待定机制，避免条件信息被当成未知字段丢弃；带待定条件的计划不可同时要求立即执行，不提供新的自然语言条件求值器。
- `src/ai/runtime.ts`仅补充同一契约说明，没有增加调用或第二套规划器。Narrator无权推进游标。

## 离线验证

最终8文件 **121/121** 通过：即时计划、持久计划、NPC HTTP、欠账调度、Provider Schema、World Gap HTTP、System/Narrator场景及长期NPC。

新增覆盖：

- MOVE/INSPECT/TALK/HOLD首步共享Receipt；MOVE采用Core实际路线成本。
- 目标、类型、时长、调查范围、话语、未来启动、待定条件和未支持入口冲突拒绝。
- 不足时间不执行，Core拒绝不跳步；合法后续时间可执行一次。
- HTTP→Semantic→NPC决策→Core→Save：先MOVE再继续HOLD/TALK，只有一次MOVE。
- 首步最终保存失败，原隔离存档完全不变；重试复用原Pending Candidate。Core spy证明MOVE实际调用总数仍为1，NPC决策没有再次调用；Receipt和游标同一候选恢复提交。
- Reload、请求幂等、Undo后位置、时间、计划与Receipt一致；冲突NPC决策不阻断玩家合法WAIT。

日志：`qa-npc-immediate-plan-final.log`。类型检查与 `npm run build`通过，`git diff --check`通过。既有客户端大包提醒保留。未调用真实Provider、未重放正式行动。早期失败记录保留；新增夹具在场目标和重复路线错误已修正，未放宽生产校验。

保存失败恢复沿用既有机制：Core/NPC不重做，但未缓存的Narrator/事实审核可能重新生成展示文本；本轮没有扩展展示缓存。

## 部署

新编译指纹：`cc7575d009a69cd89876eb53e100fedf668c733d8bcfbdbe8b9e390d44264885`。

备份：`.codex-checkpoints/npc-plan-link-deploy-20261018-062332/`，完整current.json、世界包、Routine作业、package、启动脚本、新旧编译包及manifest。新旧压缩包均完整读取171项，两个Schema均接受基线。

正式基线REV389，第1日17:48、餐厅；SHA256：`119585428f0739a55865f97a1372879007bfdfc6893e10edb42179f42b60b75c`。

回退编译物为部署前实际运行6c5b643b…；只能在没有新游戏写入、存档SHA仍为基线时安全停服恢复编译物。新执行状态产生后不得盲退旧严格Schema，不得恢复旧存档抹去玩家进展。

部署已完成：用户在原启动终端Ctrl+C，独立确认PID17628退出、3100无监听、运行锁正常释放，未强杀或删除锁。用户保留原环境启动后，正式HTTP和startup日志均确认PID19380、compiled v0.1.19及上述新指纹，运行锁匹配。

Provider仍为DeepSeek Flash，凭证已配置、配置已持久化；首页、JS、CSS均HTTP200，健康ok。既有 `/api/health.version` 0.1.16硬编码未改，版本判断以 `/api/session.runtime` 为准。HTTP证据：`qa-npc-immediate-plan-deploy-http.json`。

先在内存验证投影不会触发基础设置或世界包迁移，再GET `/api/state`，返回REV389、17:48。正式文件SHA仍与基线逐字节一致，人物、物品、NPC调度、时间及RNG均未被部署改变。

可开始有限真人QA；真实模型是否能稳定输出满足精确关联契约的组合仍需验收。本轮没有付费调用，也未把未知原始动作正文当成已修复通过的证据。

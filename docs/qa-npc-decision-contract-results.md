# NPC决策契约与失败调度修复（2026-10-18）

## 根因与实现

已确认原Trace `tr_bda104c27457` 的 `plan_updates:null` 合法于Provider Schema，却非法于领域Schema。原始完整模型正文未保存；回归只复用这一已记录字段，其他决策内容明确为合成数据。

- `src/ai/provider-schema.ts`：新增统一 `normalizeProviderOptionals`，以原始领域JSON Schema为依据，仅去除“原本可省略、原本不允许null”的属性null。递归处理对象、数组、记录、局部引用及可确定的联合分支；联合含义不明确时不猜测。真正nullable值、必填null、无效类型不被擅自删除/修复。
- `src/ai/runtime.ts`：所有经过既有结构化 `call` 的返回先做上述投影，然后执行原有集合规范化、字段过滤及完整领域校验。没有新增模型调用或绕过事实/动作校验。
- `src/agent/npc-state.ts`：可选持久化 `autonomy_retry`，记录失败次数、最近尝试时间、最早重试时间和失败阶段；旧存档不需要迁移。
- `src/agent/npc-agent.ts`：有效决策通过认知准入后才更新 `last_autonomous_at`。决策/认知准入失败采用15、30、60、120、最多180游戏分钟退避；失败次数记录最多16，退避不超过180分钟。每请求仍最多2次深度调用；同request_id不立即重试。按最近成功/失败尝试时间公平排序，未服务者优先，退避到期只是最早机会，不保证抢占其他NPC。
- 有效决策后的Core动作失败仍按原执行/计划机制处理，不反复调用决策模型以求成功。未知格式/类型错误继续拒绝，不改成NPC行动成功。

## 离线证据

- Provider：null/缺省/空数组、真实nullable、递归可选字段、记录、联合分支、必填与无效类型；真实AIRuntime入口中 `plan_updates:null` 经1次替身生成即可通过，不额外调用。
- 调度：失败不记成功、持久退避、公平轮转、同请求不重复、指数退避上限。
- 临时HTTP世界：错误类型导致有界失败并保留玩家WAIT；重复请求不重新决策；Reload保留退避；Undo恢复退避和时间；之后合法null计划通过并经Core提交一次MOVE/HOLD/TALK。
- 原NPC HTTP用例也改用 `plan_updates:null`，经过真实HTTP/Semantic/Core/Narrator/JsonStore及保存失败恢复、Undo、幂等边界。
- 最终扩展运行8文件：114通过、1失败（115项）；其中本轮核心及World Gap/Narrator/长期NPC相关7文件102/102通过。日志 `qa-npc-contract-final-regression.log`。
- 额外失败位于 `daily-qa-batch.test.ts:80`：理想化Mock要求收钢琴、去厨房及做早饭完成，但其旁白缺少已结算事实支持。用备份的部署前编译物与新版做同输入内存对照，均返回相同事实校验拒绝、plan partial、Revision增量0；不是本轮引入，不放宽Firewall或改断言。证据 `qa-npc-contract-baseline.log`，脚本在本轮checkpoint目录。
- `npx tsc --noEmit`、`npm run build`、`git diff --check`通过；既有客户端bundle大小提醒保留。无全量重复测试、无付费调用。

## REV389兼容与真实验收

正式基线REV389，第1日17:48；SHA256：`119585428f0739a55865f97a1372879007bfdfc6893e10edb42179f42b60b75c`。

旧版已将藤村、真帆的失败机会写成 `last_autonomous_at=17:48`，未留下新字段。不能据日志擅自改写正式角色调度。它们仍需正常生活行为累计180游戏分钟后重新获得常规机会，且受公平队列预算影响；其他尚有欠账的NPC可以更早验证新契约。新版本之后的失败才使用短退避。不跳时、不改RNG、不人为创建计划。

最低真实成本：单次隔离NPC决策1次Provider调用可检查对外/领域契约；正式完整回合通常有语义1+后台NPC最多2+Narrator1（约4次，其他正常安全审核另计），以Trace实际调用为准。此轮没有执行上述调用，不能宣称真实模型已验收。

## 部署与回退

新版 v0.1.19指纹：`6c5b643b6c3171ac59dbe016461e18ea9165a7d8e6ccf0521e5204bbce9c0274`。

备份 `.codex-checkpoints/npc-contract-deploy-20261018-052222/`：完整正式存档、世界包、Routine作业、package、启动脚本及新旧编译包；存档可读且SHA一致，两个编译包完整读取各171项，新旧Schema均接受当前基线。

回退编译物指纹be109f04…，与部署前正式实例一致。仅在正式存档仍为上述SHA且没有新动作时停服回退编译物；产生新 `autonomy_retry` 状态后，旧严格Schema可能拒绝，必须重新评估并向前修复，不能恢复旧存档抹去游戏进展。

部署完成：用户在原终端安全停止PID15852，独立确认进程退出、3100无监听、锁正常释放；没有删除锁或强杀进程。用户以原环境重新启动，实际HTTP与startup日志均确认PID17628、compiled v0.1.19、新指纹 `6c5b643b6c3171ac59dbe016461e18ea9165a7d8e6ccf0521e5204bbce9c0274`，运行锁匹配。

DeepSeek Flash配置已持久化、凭证已配置；没有调用模型验证服务端。首页、JS、CSS均HTTP200，健康ok。`/api/health.version` 仍保留既有0.1.16硬编码，版本核验以实际 `/api/session.runtime` 指纹为准。

先离线确认基础设置/世界包迁移不会触发，之后GET `/api/state` 返回REV389、第1日17:48；玩家仍在餐厅。投影读取后正式文件SHA仍与部署前完全一致，人物、物品、NPC调度、时间、RNG等均未因部署改变。脱敏HTTP证据：`qa-npc-contract-deploy-http.json`。

代码、离线验证和部署已完成；真实Provider行为验收尚未执行。可开始有限真人QA，不应为验证立即修改旧失败NPC的调度时间。

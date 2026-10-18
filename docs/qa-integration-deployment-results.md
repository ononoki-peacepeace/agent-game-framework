# 两轮成果集成部署核验（2026-10-18）

## Narrator 旧断言门禁

结论：测试夹具过时，不是本轮自治调度或环境补全的生产缺陷。

- 原测试只写 `last_turn`，没有写对应 `narrative_history.location_id`，却要求旁白“教室里的书还没有收完”作为当前现场进入提示。
- 旧 HEAD 的 Narrator 无条件传入 `save.last_turn`。当前 `src/ai/runtime.ts` 的 `sameScene` 要求最新历史地点与权威当前位置一致，且当前没有移动路线；用于阻止历史场景、父子地点环境串用。
- 原失败日志仍保留于 `docs/qa-npc-world-known-narrator.log`，没有删除或掩盖。
- 修正 `tests/system-agent-understanding.test.ts`：有地点锚点时必须保留原旁白；没有锚点时必须排除。两个分支仍验证正文保留、可选关系补丁被丢弃、关系未被修改。不修改生产逻辑、不跳过断言。
- 集成回归五文件 **78/78** 通过（System、环境 HTTP、NPC 欠账、持久计划、NPC HTTP）；类型检查、构建、diff-check 通过。
- 日志：`qa-integration-deploy-tests.log`、`qa-integration-deploy-types.log`、`qa-integration-deploy-build.log`、`qa-integration-deploy-diff.log`。构建仍有既有客户端包大小提醒。

## 编译、正式基线与备份

- 新编译版 v0.1.19：`be109f04bdfbadafbfa6f263f69026cc3e58f90a3accd51a9a84f6df1475502c`。包含 World Gap 与 NPC Autonomy；本轮仅测试变更，生产指纹不变。
- 正式基线：REV388，第1日17:28，`pc_asano` 位于 `dining_hall`。
- 正式存档 SHA256：`95527b7bc9fa7968e77d44843ee3e3217b347bdcd6530e2eda500dab61fea144`。
- 备份：`.codex-checkpoints/integration-deploy-20261018-050028/`。包括完整 `current.json`、世界包、Routine 作业、package、启动脚本、新版 dist.zip、回退 rollback-dist.zip 与 manifest。未复制或打印 API Key。
- 备份存档 JSON 可读，复制前、备份、复制后 SHA 一致；新版与回退版 Save Schema 均接受基线。两个编译压缩包均完整读取验证，各171项。
- 回退包是上一轮备份的 v0.1.19（f7e9c44…），不是原进程29e917ce…的精确镜像。只能在没有新游戏写入、存档仍是上述 SHA 时停服回退编译物；不得恢复旧存档来抹去后续玩家进展。发生新写入后须重新评估兼容性。

## 停机及启动交接

- 原 HTTP 实例 PID16356，旧指纹29e917ce…；112条 completed、3条 failed，无 running 请求记录；Routine 作业均终态/中断，历史 Pending Candidate 均早于当前Revision，未自动恢复或清理。
- 用户在原终端 Ctrl+C 后，PID退出、3100无TCP监听且HTTP不可达，但旧锁残留。遵守门禁暂停；取得用户明确授权后再次核验 PID、端口、锁内容与存档 SHA，仅备份并删除记录16356的失效锁。
- 现有 Windows `start-lan.mjs` 包装器转发信号不能保证子进程执行清理；本轮未改动该启动机制，今后仍需停机后核验锁。
- 用户在原终端执行 `npm run start:lan`，正式HTTP现已核验：PID15852，compiled v0.1.19，指纹 `be109f04bdfbadafbfa6f263f69026cc3e58f90a3accd51a9a84f6df1475502c`，运行锁匹配。启动日志记录相同指纹。
- `/api/session` 确认 deepseek / deepseek-flash、凭证已配置、配置已持久化；不调用模型验证外部服务可用性。
- 在隔离内存中核对现有存档不会触发基础功能设置或世界包迁移，之后只读 GET `/api/state` 返回REV388、第1日17:28。首页、JS、CSS均HTTP200；健康检查ok。
- HTTP投影读取后再次核验正式文件SHA与基线一致，因此人物、物品、时间、RNG等所有文件内容均未改变。脱敏证据：`docs/qa-integration-deploy-http-evidence.json`。
- 遗留低优先级问题：`/api/health.version` 硬编码0.1.16；版本判断以 `/api/session.runtime` 的模块加载指纹和package版本为准。本轮未扩展修改。
- 部署完成，可开始有限真人QA；两轮真实模型行为仍需用户验收，离线测试与部署成功不等于已通过真实Provider验证。
- 无付费调用、无正式行动、无存档迁移、无物品补发。

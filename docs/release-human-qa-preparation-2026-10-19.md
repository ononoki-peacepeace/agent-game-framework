# Framework 真人测试发布准备（2026-10-19）

## 版本快照范围

- 本地发布候选分支：`codex/integrated-world-human-qa-snapshot`。快照收录 `src/`、`tests/`、`content/`、`scripts/`、审阅文档和 `.gitignore`；不推送、不部署。
- `data/`、`.codex-checkpoints/`、`.tmp/`、`dist/`、`node_modules/`、本机密钥和运行日志继续排除版本管理。检查点原样保留。构建物可由该分支和锁定依赖重新生成。
- 离线验收基线：1529/1529 测试通过，`npm run build` 通过。正式旧档自动补发门禁与 Framework 代码门禁分开；REV389 的相机、胶卷等仍待人工证据裁决。

## 只读正式环境预检查

- 3100 端口运行 Node PID 1540，`D:\game\data\runtime.lock` 内容为 1540；进程报告编译版 `0.1.19`，代码指纹 `722b005c9ae26cd505ad645ffd1a2a43b8b37ca5fc1c37017b0fa0d567886500`。其数据目录持久化 DeepSeek 配置，密钥已配置；未读取密钥值。
- 当前 `dist` 报告相同指纹。版本号本身不足以证明代码差异；切换前必须重新核对运行进程指纹、待发布构建指纹及 Git 提交。当前 3100 指纹相同不构成本轮部署记录。
- 正式 `data/current.json` 为 REV389，SHA-256 `119585428f0739a55865f97a1372879007bfdfc6893e10edb42179f42b60b75c`。旧检查点 `npc-schema-systematic-deploy-20261018-065302/current.json` 与其清单哈希一致，包含 `rollback-dist.zip`（171 项）和 `new-dist.zip`（171 项）。该备份是既有恢复点，不替代切换前的新备份。

## 独立测试实例

- 已创建 `D:\game\.tmp\human-qa-20261019\data\current.json`：新游戏 ID `d6213ba8-ac8f-4469-9c5b-8a3558034c07`，revision 0，SHA-256 `3058ecbac756c787d985e79ed9b78c787e8499408853101e72a8a78e315a2785`。由当前 `content/worlds/town.json` 离线创建，未复制正式存档或正式 Provider 配置。
- 3101 端口、`127.0.0.1`、独立数据目录和日志目录、`mock` Provider 已实测启动。`/api/session` 返回编译版指纹和 `mock`、无凭据、无持久化配置；测试实例随后正常退出，测试锁已清除。Mock 只能做程序联通检查，不能替代真人模型验收。
- 再次启动独立离线实例，在 PowerShell 中执行：

```powershell
Set-Location D:\game
$env:GAME_DATA_DIR='D:\game\.tmp\human-qa-20261019\data'
$env:GAME_LOG_DIR='D:\game\.tmp\human-qa-20261019\logs'
$env:AI_ADAPTER='mock'
$env:HOST='127.0.0.1'
$env:PORT='3101'
node dist/server/server/index.js
```

浏览器打开 `http://127.0.0.1:3101`。真人模型测试获授权后仍使用该独立目录和 3101 端口，再选择获批准的 Provider 与凭据；不要复制 `D:\game\data\secrets`。开始前确认 3101 空闲、测试目录无锁、`/api/session` 的指纹和 Provider 符合预期。测试结束用终端 Ctrl+C 正常退出，并检查测试锁消失。若 3101 已被占用，先查明进程，不覆盖锁。

## 正式切换与回滚门禁

本轮不切换 3100。将来如获授权，应先冻结目标 Git 提交并重建，记录构建指纹；只读核对 3100 PID、锁、正式 revision/哈希及正在处理的请求。停机后创建并校验新的正式存档、相关世界包、调度文件、Provider 配置的受保护备份及旧 `dist` 构建包，然后原子切换构建并启动；启动后核对运行指纹与预定构建完全相同，复查正式存档 revision/哈希。失败时先停新版、核对锁，再恢复旧构建和必要配置；正式存档只能依据切换前准确哈希与是否已产生新玩家事务决定是否恢复，不能盲目回写旧档。未经人工裁决不执行相机、胶卷或外套补发。

实际 3100 服务切换需要用户单独授权；任何付费 Provider 的真人行动也需要用户单独授权。本轮没有执行二者。

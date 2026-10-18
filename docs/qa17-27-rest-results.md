# QA-17 / QA-27：休息回合的空间污染与提交后失败

## 正式证据

- Trace：`tr_db7e0fdb5912`
- 父 request_id：`92de44a0-5d67-424a-973c-f3fb5d1d3839`
- Core step request_id：`80dd086b-e8d4-4f10-94d1-aa7d609360ce`
- 正式原文实际比简写样本更长：`我走到中央大厅一侧的长椅坐下，安静休息十分钟。不主动打扰任何人，也不刻意调查刚才听到的传闻。周围的人照常做自己的事情。`
- Semantic日志：world_action / world_transaction / play_action=wait / temporal_wait=false / multi_step=false。
- 持久化响应保留了计划、错误Outcome；选取后保存为 `tests/fixtures/qa27-rest.json`。完整Semantic、Freeform提案和Narrator原始响应未保存，隔离回放明确使用重建外层与提案，不冒充原文。

## 精确根因与提交顺序

1. Planner产生单步 `g_rest_bench / operation_hint=activity / completion=activity_occurred`。
2. `core/freeform.ts::localDestination` 用移动语法截取整段“中央大厅一侧的长椅坐下”。旧QA-17只做物理动作排除和个别语法截断；这里没有被它处理的方位后缀，且截取结果未经真实空间对象绑定便写入 `scene_position.label`。
3. Freeform的活动凭据条件原本包含 `!destination`。错误的局部位置使活动凭据被抑制；实际仍执行了DETERMINISTIC/rest成功判定，扣10分钟。
4. 后台系统正常运行，一名NPC通过权威activity MOVE离场，time_cost=2，其离场没有额外把玩家世界时钟再扣2分钟；人数7→6有真实Receipt，并非Narrator漏人。本轮不改变该行动。
5. Narrator在保存前运行并返回；08:36:44 `save.commit` 接受348→349，保存差异包括玩家scene_position和该NPC的location。
6. 08:36:46 `agent.completion_checked` 报 receipt_found=true、complete=false：Receipt只有time/position、缺少activity。单步快捷路径不保存Open Goal，因此原 `goalCommit` 也被省略，完成检查落在实际保存之后。
7. 失败Outcome又丢掉了已经提交的Receipt，记录为 engine_failure/invariant_failure、revision349、state_certain=false、receipt_ids=[]，于是UI显示通用“未完成安全结算”。原文故事与真实时间却已保存。

**本案例两项问题共享因果链**：空间截取污染→活动凭据缺失→保存后合同拒绝。与此同时，“单步未做提交前完成校验”“提交后错误丢失提交证据”是应独立修复的通用断点。

## 修改机制与文件

- `src/core/freeform.ts`：文字截取器仅产生候选；新增共享绑定边界，只能绑定当前地点唯一存在、非人物的真实实体锚点，写入其权威名称。未绑定动作短语不会成为区域；跨地图移动仍走MOVE/Location Lifecycle。执行、资源判断和完成证据检查共用绑定结果。局部接近和合法活动可同时成立，活动凭据不再因局部位置而消失。
- 普通背景长椅仍可用于自然休息，不要求为所有家具注册Item；只是不会凭行动文字新建持久空间标签。姿态没有另建状态系统，休息记录沿用activity Receipt/action_facts；本轮没有保证持久化“坐姿”。
- `src/agent/affordances.ts`：单步不保存Open Goal也必须执行提交前完成检查。提交后反馈异常先读取并验证真实Receipt；已完整提交则恢复成功，确有后续证据异常则保留已提交步骤、Receipt及准确状态，不伪装回滚。合并计划结果时不覆盖掉这些凭据。
- `src/agent/executor.ts`：单步计划也携带已提交story，与技术错误分开展示，复用既有前端部分提交呈现。

没有新增模型调用、地图系统、事务系统；没有关掉NPC或事件调度。普通动作不会因为姿态词被额外分配新区域。

## 离线回放及回归

生产代码修改前：按正式日志重建play_action=wait，并回放录制计划，经真实HTTP入口稳定返回engine_failure；原状态已提交到349并带污染标签。额外反馈故障用例也失败。

修改后 `rest-transaction-http.test.ts` 9/9：

- HTTP→Semantic→Planner→Freeform/Core→Narrator→Save→响应，348/15:26→349/15:36，地点不变、不生成错误区域、存在真实activity Receipt。
- 保存重载、Undo回到15:26、同request_id不重复提交。
- 提交后反馈异常由真实凭据恢复成功。
- Narrator Schema失败有界修复；Provider失败走既有安全降级，仍只提交一次。安全降级可能只返回简短摘要，不把它当正常模型叙事质量验收。
- 保存失败、完成凭据被故障注入删除时，提交前拒绝，正式隔离世界不变。
- 客户端在Narrator等待期间真正abort；后台完成后轮询原ID、重试均恢复原结果，无第二次执行。
- 真实本地锚点可绑定，动作短语、未登记区域、远处锚点不能绑定。
- 模拟旧版“已提交但缺activity”的异常镜像：准确返回已提交进度、Receipt和story，不报告世界未改变，不重复执行。

其他相关回归分批通过：QA25 HTTP29、QA26/System目标19、物品16、动态地点14、判定20、展示17、调查4。跨批次去重的相关测试128项通过。

扩展System理解检查14/15：唯一失败仍为旧G用例同一224行，期待历史“教室里的书还没有收完”。它直接调用TALK，不走本次Freeform/合同路径，未新增失败，也未修改该断言。合计本轮核对142通过、1项既有失败；未运行全量套件。

注意一项旧测试原本要求 `穿鞋拿钥匙出门` 在没有登记出口/路线的情况下生成“屋外”scene_position。这正是本轮禁止的空间伪造，已改为验证仅有实际物品结果、不生成虚构位置；正常MOVE和合法动态地点由专门地图测试验证。

`npx tsc --noEmit`、最终构建及diff-check通过。没有真实Provider或浏览器真人验收。

## 正式区域修复候选（未执行）

见 `docs/qa17-27-region-repair-candidate.json`。前置条件为REV349、15:36、玩家pc_asano仍在hall_great、当前污染值完全匹配，并核对完整SHA256。

历史checkpoint证明该回合之前玩家没有scene_position。因此候选只移除该组件，不撤销十分钟休息，不恢复离场NPC，不改RNG、事件或历史事实。

将来需用户另行授权后，用既有元数据事务保存新Revision、Receipt和checkpoint，保留原值及审计记录；不要直接编辑正式JSON或改历史checksum。撤销维护事务会恢复原值，必须明确提示。现在没有提供自动执行迁移脚本，没有修改正式存档。

正式SHA256验证前后均为 `ffab8b36afe8ffcb055da9b054cbbd786e8442e85f5addb762ab097551da72ce`，REV349/15:36不变。部署代码不会自动清理旧污染。

## 用户复验与部署

新编译指纹：`29e917ce27502f406ba48db66aeb7a004d77fe03391749d7c567f8c77532a675`。
3100只读检查仍运行旧指纹 `130fc71197ccfa5d1f17828022ae5a360a0bae8980098b590b7769ef94179f81`。

最低成本离线命令约10秒、无API费用、仅临时隔离写入：

```powershell
Set-Location D:\game
npx vitest run tests/rest-transaction-http.test.ts --maxWorkers=1
```

预期9/9；失败保留request_id、trace_id、agent.completion_checked、save.commit和outcome的Receipt字段。

确认无在途请求后，由用户在原启动终端正常Ctrl+C，再执行已有 `npm run start:lan`。不另起同存档实例、不删除锁、不强杀未知进程。核对 `/api/session` 的runtime.code_sha256。本轮没有停止或重启3100。

真人QA仅需检查：普通休息的时间与完成反馈、已有环境中的坐/站/接近不会污染区域、正常MOVE后位置正确。正式旧污染的移除仍须单独授权，不能因新代码部署而宣称它已清理。

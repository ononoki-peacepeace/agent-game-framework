# Windows日志对接与记录格式

`init` 生成 `source.json`（本地源码哈希）、`catalog.json`（固定案例）、`run.json`（部署/授权/绑定）和 `records.json`（42个空槽）。`artifacts/` 用于Windows授权导出的QA记录。原始日志保持原格式；不存在的输出不填模拟文本。

## run.json

- `source_head`来自当前源码目录，`deployed_head`与实际构建核对后填；两个 verified 标记只能在人工核对后改 true，并填写 deployed_build_evidence / integration_evidence 的包内证据文件。
- `authorization_ref`与`budget_plan_ref`指向Windows真实受控测试授权/预算记录，不填API key、token或Provider配置。
- `qa_game_ids`分别填写commerce/relationships/autonomy真实QA游戏ID。
- `world_witnesses`填写相对证据文件：模块/地图/交易或关系/自主事件的实际结构差异，不能只是世界标题。
- `bindings[world][key]`的name是实际显示名，canonical_ref是实体/地点/环境事件等真实引用，evidence_file指向支持该绑定的QA快照。未知绑定保持null，render会拒绝缺失字段。
- `windows_formal_ledger_ref`仅是Windows正式进度引用，不由本工具读写台账。

## records.json

每槽为`world/case_id`。`status`为not_run/blocked/captured；blocked填写原因。`observations`必须保留案例要求的所有子项；observed需要证据路径，未出现记not_observed或blocked，不将缺失当通过。

每轮 turns 的填写形状如下（方括号中的说明须换成实际值，不能原样提交）：

```json
{
  "input": "玩家实际输入的完整原句",
  "request_id": "真实请求ID",
  "game_id": "本结构的QA游戏ID",
  "revision_before": 12,
  "revision_after": 13,
  "origin": "authorized_real_provider",
  "replay_of": null,
  "artifacts": {
    "request": "artifacts/turn-01-request.json",
    "before": "artifacts/turn-01-before.json",
    "after": "artifacts/turn-01-after.json",
    "receipts": "artifacts/turn-01-receipts.json",
    "npc_decisions": "artifacts/turn-01-npc-decisions.json",
    "visible_output": "artifacts/turn-01-visible.txt",
    "ui_response": "artifacts/turn-01-response.json"
  },
  "calls": [{
    "id": "原始调用ID",
    "role": "narrator",
    "origin": "authorized_real_provider",
    "provider": "实际Provider",
    "model": "实际模型版本",
    "raw_request": "artifacts/call-01-request.json",
    "raw_response": "artifacts/call-01-response.json",
    "raw_error": null,
    "usage": {"input_tokens": 1200, "output_tokens": 180},
    "cost": null,
    "unavailable_reason": "示意：账单尚未结算；应填写本轮真实原因",
    "pricing_ref": "实际定价/账单引用"
  }]
}
```

以上Token数是字段示意，不是实际运行或费用预测。没有真实数据时保留null和原因。calls包括该轮全部模型角色、失败和修正，按实际时间顺序列出；不要只保留最终Narrator调用。完整请求文件必须含模型输入和参数，去除凭证；响应保存原文及finish/reason/usage，错误保存原始失败。最终网页旁白/对白、提示与错误状态都放visible_output，不只取API中的narrative字段。

`origin`允许 authorized_real_provider / actual_offline_fallback / authored_control / replay / technical_failure；调用origin允许 authorized_real_provider / offline_control。技术失败尚无叙事时用technical_failure，并保留实际错误展示，不能假称fallback成功。blocked案例中已经发生的轮次和日志也必须记录。真实模型拒绝后落入fallback时，轮origin是actual_offline_fallback，真实失败调用仍如实保留。作者样本永远不能改标真实模型。

精确重放轮的replay_of等于原request_id，calls应为空；保留原始请求payload字节、重放前后完整存档及响应。人工/现有工程检查核对原请求归属、相同payload、时间/RNG/资源/返回故事与字节一致；本工具仅校验结构与哈希，不替代实际事务断言。未发生NPC决定时导出真实空数组及说明，不伪造记录。

## 评审与失败报告

review中四个hard_gates、原五维ratings和诊断默认null，真人读证据后填写；每项evidence必须引用原文与来源。`conditions_awarded`始终空，统一计分由Windows处理。保持开发者观察与独立判定为不同记录；不假造reviewer身份。

每个真实反例另存一个issue JSON/Markdown：版本/构建/世界/请求ID、完整输入、预期事实边界、实际输出原文、对应Core/NPC依据、生成→校验→修正→fallback链、首次失败路径、能否复现、最小恢复步骤、严重性、费用与权限限制。修复后新增结果并关联旧issue，不覆盖旧输出。

## 工具边界

seal封存被引用文件和记录文件的SHA-256；check列出缺失项、未验证部署、没有真实模型输出的案例，并始终返回`real_model_quality_verified:false`和空授分数组。即使结构完整，也不能认证调用来源、授权、人类身份、费用真实性、所有日志是否都已导出或世界事实正确。

检验失败应保留原包并修正新版本，不能删掉低质量案例。分享前仅脱敏凭证和不必要个人资料，登记脱敏范围；不转交正式存档。恢复时从Windows实际QA版本与尚未采集/评审项继续，不重新开发已交付功能。

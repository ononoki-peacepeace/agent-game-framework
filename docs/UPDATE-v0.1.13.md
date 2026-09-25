# v0.1.13 — Routine Safety / State Sync

本补丁修复生活模式可能一次推进大量时间、却没有任何课程/工作/训练/社交等 canonical 结算的问题。

- START_ROUTINE / CONTINUE_ROUTINE 服务端强制限制为单次最多 1440 分钟，chunk 5–120 分钟。
- 每次 Routine 批次在内存中保存当前 Save snapshot。
- 批次完成后比较 canonical entity/location 状态；如果只有 routine/time 变化，没有任何可验证结算，也没有真实中断事件，则自动恢复批次前 snapshot。
- 回滚后明确提示“空白时间没有写入正史”，不再静默吞掉 30 天。
- Routine UI 不再发送 43200 分钟；默认最多 24 小时，并把用户文本拆成 activities hints。
- action/input 完成后前端主动再次读取最新 state，减少 revision 冲突。
- 遇到“状态已更新”时自动同步最新状态；重试会重新生成 request_id 并使用最新 revision，避免永远拿旧 revision 重试。

注意：本补丁不会伪造不存在的 Education / Work / Gambling 等模块。若世界没有相应模块，Routine 会安全停止/回滚，而不是凭 AI 文本把收益写成事实。

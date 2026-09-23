# v0.1.8 — LAN / Mobile Web + Character Card JSON

## 手机 / 局域网

默认仍只监听 `127.0.0.1`。需要让同一 Wi‑Fi 下的手机访问时，在 Windows PowerShell 中：

```powershell
$env:HOST="0.0.0.0"
npm start
```

启动日志会列出可用的私有局域网 URL，例如：

```text
局域网: http://192.168.1.23:3100
```

手机与电脑连接同一局域网后，用手机浏览器打开该地址。

安全边界：LAN 模式只接受 localhost、127.0.0.1 与 RFC1918 私有 IPv4 Host（10/8、172.16/12、192.168/16）。它不是公网部署模式。不要通过路由器端口映射把 3100 裸露到互联网。

如果 Windows 防火墙阻止连接，只对 Private profile 放行 TCP 3100，例如管理员 PowerShell：

```powershell
New-NetFirewallRule -DisplayName "Agent Game Framework LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3100 -Profile Private
```

手机 UI 增加底部快捷导航；右侧世界面板在窄屏下改为横向可滚动标签。

## Character Card JSON

人物页支持导入：

- legacy Tavern / Character Card V1 flat JSON
- `chara_card_v2`
- `chara_card_v3`

导入行为：

- 放到玩家当前 location；
- 不推进时间；
- 不调用 AI；
- 不把角色卡声明的能力、地位、装备等自动写成世界正史；
- description/personality/scenario 等作为角色人设上下文供现有 AI runtime 使用；
- card 内的 `system_prompt` / `post_history_instructions` 只作为角色资料，不能覆盖 Framework / engine policy；
- 未识别的第三方字段保存在存档中的 raw card，便于以后迁移或扩展；
- 当前版本只支持 JSON。PNG/APNG embedded card、CHARX、角色卡资产和 lorebook 激活暂未实现。

公开示例：`content/examples/character-card-v2.json`。

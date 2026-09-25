# Extension SDK v1：声明式模板 MVP

当前仅支持 blackjack 与 turn_based_combat 两个经过审查的规则模板。
扩展入口是 dist/profile.json，不是可任意执行的 JavaScript。公共 SDK 在
src/extensions/sdk.ts，不暴露 SavePackage、GM、文件系统、网络、shell 或密钥。

后台开发目录为 data/extensions/workspaces/<job-id>/{extension.json,src,assets,tests,dist}。
Codex 使用禁用工具的独立目录会话返回 Spec，Framework 生成配置源码、执行 TypeScript
检查及规则/API 测试。用户确认后才安装。失败更新保留旧版本；禁用与卸载保留休眠状态。

这是受限模板扩展，不是通用代码沙箱。任意钓鱼、炼金、房屋或 WASD 游戏代码生成和加载尚未实现。
需要真实代码扩展时，必须另行实现隔离进程/能力协议，不能直接 import 未经信任的 JS。

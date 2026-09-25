# Agent Game Framework v0.1.14 corrected overlay

解压到项目根目录并覆盖。

本修正版实际包含：

- 生活模式自然语言只进入 `pattern`，`activities` 只保留合法程序 ID；前端自定义生活模式发送空 activities，服务器同时做 schema-safe 过滤。
- 地图当前层级改为确定性网格布局，不再读取旧 `position` 坐标造成节点重叠；增加当前层级、上级、直接子地点提示，并对长地名换行。
- 玩家/人物摘要按句号、分号和换行拆成独立行。
- package.json / package-lock.json 版本已真正更新为 0.1.14。

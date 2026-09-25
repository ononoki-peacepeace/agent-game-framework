# v0.1.12 — Unified World Input + Right-side Routine + Removable Avatars

## 这一版改了什么

1. **头像可撤销**
   - 人物详情、主角状态页、人物列表均可移除已有头像。
   - 移除后回到无头像状态；全身图不会一起删除。

2. **减少“这是按钮”的提示文字**
   - 剧情发言卡不再显示“点击查看人物详情”。
   - 主角状态卡不再单独显示“人物详情”文字按钮。
   - 头像 / 名字仍然可点击打开详情。

3. **生活模式只在右侧设置**
   - 左侧 `RoutineControl` 已删除。
   - 右侧“生活模式”面板在未启用时直接提供日常描述输入和开始按钮；运行后继续显示继续 / 结束 / 打断状态。

4. **当前场景对象使用通用 Entity 渲染**
   - 仍然按实体 ID、identity、location、component 等字段读取，不写死任何 NPC。
   - 有 `avatar_id` 时显示头像；没有就不放头像占位。
   - 人物实体的头像 / 名字可以打开人物详情。

5. **主输入框升级为统一世界入口**
   - 普通自由文本仍走已有 Intent Interpreter / Action 执行路径。
   - 明确的“生成 / 创建 / 让这里出现新角色、人物、NPC”等输入会被识别为实体生成指令。
   - 新人物优先使用当前文本 AI Provider 生成角色资料，然后通过既有 Character Card 导入边界进入当前地点；AI 不可用时降级为最小可用人物实体。
   - 这条导演路径只拥有“游戏世界实体创建”能力，不获得 Shell、任意文件读写、任意网络调用或 secret 权限。

6. **视觉生成接口不伪造**
   - 角色生成会保存 `visual_prompt` 到 Character Card extensions，方便下一阶段连接真正的图像 Provider。
   - 当前文本 Provider 并不能直接产生本地图片文件，所以本版不会谎称新 NPC 已自动生成 AI 头像 / 全身图。
   - v0.1.11 已有的“无头像时上传全身图 → 浏览器本地自动裁头像”继续生效。

## 覆盖安装

停止服务后，把本 overlay 解压到 Agent Game Framework 项目根目录并允许覆盖同名文件，然后重新：

```powershell
npm run build
npm start
```

开发模式可继续使用原来的 `npm run dev` / `npm run start:lan`。

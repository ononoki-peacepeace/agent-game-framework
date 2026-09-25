/**
 * Player-facing copy. Internal vocabulary (session fields, storage names, tool ids, workflow words) must never
 * reach a normal player, even when a model produced the sentence. This rewrites the few terms that leak, drops
 * fragments that only talk about internals, and never leaves an empty message behind.
 */
const moduleLabels: Record<string, string> = { map: '地图', characters: '人物', relationships: '关系', inventory: '背包', commerce: '商店', equipment: '装备', quests: '任务', routine: '生活模式', attributes: '属性', aptitudes: '资质', skills: '技能', traits: '特质', core: '核心', character_page:'人物页', status_page:'状态页', relationships_panel:'关系页' };
const toolLabels: Record<string, string> = { 'framework.development': '框架开发', 'extension.create': '新玩法准备', 'behavior.configure': '风格设置', 'behavior.clear': '恢复默认风格', 'module.enable': '启用系统', 'module.disable': '停用系统', 'module.remove': '移除系统', 'media.generate_image': '图片生成', 'avatar.crop': '调整头像', 'media.set_avatar': '设置头像', 'ui.feedback': '产品反馈', 'diagnostic.logs': '运行日志', 'save.export': '导出存档', 'character.lookup': '查找人物', 'character.media.get': '查看人物图片' };
export function sanitizePlayerText(text: string | null | undefined, fallback = '我还需要一点信息：你想让谁做什么？') {
  let source = String(text ?? '').trim();
  for (const [id, label] of Object.entries(toolLabels)) source = source.split(id).join(label);
  source = source.replace(/\b([a-z][a-z0-9_]{2,})\b/g, (word: string) => moduleLabels[word] ?? word);
  text = source;

  const raw = String(text ?? '').trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/没有\s*(进行中的)?交谈[、,，]?\s*没有\s*pending[^。！？]*[。！？]?/gi, '')
    .replace(/\binteraction_context\b/gi, '交谈状态')
    .replace(/\bpending(_field)?\b/gi, '待处理项')
    .replace(/\bpublic_state\b/gi, '可见状态')
    .replace(/\bcanonical\b/gi, '正史')
    .replace(/\btool[_ ]?id\b/gi, '操作')
    .replace(/\bcapability(?:\s|_)*digest(?:\.tools)?\b/gi, '可用能力')
    .replace(/\binstalled_extensions\b/gi, '已安装功能')
    .replace(/\bunderstanding\b/gi, '需求整理')
    .replace(/\b(dimensions?)\b/gi, '维度')
    .replace(/\bcapability_gap\b/gi, '缺少的能力')
    .replace(/\bworkflow\b/gi, '处理流程')
    .replace(/\bDevelopmentTask\b|\bdevelopment_task\b/gi, '开发任务')
    .replace(/\bEXTENSION_REQUEST\b/gi, '新功能请求')
    .replace(/\btrust\s*\/\s*familiarity\b/gi, '人际关系')
    .replace(/\b(?:trust|familiarity)\b/gi, '关系程度')
    .replace(/\bschema\b/gi, '格式')
    .replace(/\bprovider\b/gi, '模型服务')
    .replace(/\bSystem\s*session\b/gi, '系统会话')
    .replace(/\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b/gi, '相关操作')
    .replace(/[、,，]{2,}/g, '、')
    .trim();
  return cleaned.replace(/^[、,，。；;\s]+/, '').trim() || fallback;
}

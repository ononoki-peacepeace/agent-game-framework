/**
 * Player-facing copy. Internal vocabulary (session fields, storage names, tool ids, workflow words) must never
 * reach a normal player, even when a model produced the sentence. This rewrites the few terms that leak, drops
 * fragments that only talk about internals, and never leaves an empty message behind.
 */
export function sanitizePlayerText(text: string | null | undefined, fallback = '我还需要一点信息：你想让谁做什么？') {
  const raw = String(text ?? '').trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/没有\s*(进行中的)?交谈[、,，]?\s*没有\s*pending[^。！？]*[。！？]?/gi, '')
    .replace(/\binteraction_context\b/gi, '交谈状态')
    .replace(/\bpending(_field)?\b/gi, '待处理项')
    .replace(/\bpublic_state\b/gi, '可见状态')
    .replace(/\bcanonical\b/gi, '正史')
    .replace(/\btool[_ ]?id\b/gi, '操作')
    .replace(/\bcapability\s*digest\b/gi, '能力清单')
    .replace(/\bcapability_gap\b/gi, '缺少的能力')
    .replace(/\bworkflow\b/gi, '处理流程')
    .replace(/\bDevelopmentTask\b/g, '开发任务')
    .replace(/\bschema\b/gi, '格式')
    .replace(/\bprovider\b/gi, '模型服务')
    .replace(/\bSystem\s*session\b/gi, '系统会话')
    .replace(/[、,，]{2,}/g, '、')
    .trim();
  return cleaned.replace(/^[、,，。；;\s]+/, '').trim() || fallback;
}

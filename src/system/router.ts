import { toolAvailability, type ToolDescriptor } from './tools.js';

export type MetaCategory = 'PRODUCT_FEEDBACK' | 'BUG_REPORT' | 'MODULE_MANAGEMENT' | 'SETTING' | 'MEDIA_OPERATION' | 'MEDIA_GENERATION' | 'EXTENSION_REQUEST' | 'FRAMEWORK_DEVELOPMENT' | 'IN_WORLD_INPUT' | 'UNKNOWN';
export interface MetaPlan {
  category: MetaCategory;
  goal: string;
  tool_id: string | null;
  args: Record<string, unknown>;
  needs_confirmation: boolean;
  reply: string | null;
}

// Category vocabulary. The router matches a *goal*, then selects an available tool for that goal —
// it does not hard-code one branch per sentence.
const vocabulary: { category: MetaCategory; patterns: RegExp[] }[] = [
  { category: 'IN_WORLD_INPUT', patterns: [/继续(按|原)?(现在)?的?生活|继续日常|继续生活模式/, /^(我)?(去|移动到|前往|走到)/, /^(我)?(和|跟|向).{0,8}(说|聊|问)/, /^(我)?(等待|等)\s*(一|几|两|\d)/, /^(我)?(检查|观察|调查)/] },
  { category: 'FRAMEWORK_DEVELOPMENT', patterns: [/(修改|重写|重构|改).{0,6}(存档机制|框架|核心|架构|引擎本身)/, /framework.{0,6}(development|源码|核心)/i] },
  { category: 'MEDIA_GENERATION', patterns: [/(生成|画|绘制|做一张|创建).{0,8}(头像|立绘|全身图|图片)/, /重新生成.{0,6}(头像|立绘)/] },
  { category: 'EXTENSION_REQUEST', patterns: [/(开发|制作|设计).{0,30}(功能|系统|玩法|界面|扩展)/, /(希望|想要).{0,40}(键盘|交互|控制|功能)/, /(增加|新增|加|添加|想要|希望).{0,10}(新玩法|一种新玩法|新系统|小游戏|玩法)/, /framework.{0,8}(没有|不存在).{0,6}玩法/] },
  { category: 'MODULE_MANAGEMENT', patterns: [/(启用|开启|打开|恢复|重新启用|需要|加入|增加|添加).{0,8}(地图|商店|背包|装备|任务|生活模式|属性|资质|技能|特质|关系系统)/, /(不需要|不用|关闭|停用|禁用|隐藏|移除|删除|不要).{0,8}(地图|商店|背包|装备|任务|生活模式|属性|资质|技能|特质|关系系统)/] },
  { category: 'MEDIA_OPERATION', patterns: [/(调整|裁|重裁|重新裁|剪).{0,8}(头像|立绘)/, /(换|设置|改用|修改|改).{0,8}(头像|立绘|全身图)/, /(头像|立绘).{0,6}(不好|太远|太小|调整)/] },
  { category: 'PRODUCT_FEEDBACK', patterns: [/(按钮|界面|ui|页面|布局|排版).{0,8}(不好用|难用|太挤|难看|不清楚|不直观)/i, /(反馈|建议|吐槽|体验)/] },
  { category: 'BUG_REPORT', patterns: [/(点不开|点了没有反应|没有反应|打不开|报错|出错|失败|bug|卡住|异常)/i] },
  { category: 'SETTING', patterns: [/(默认|设置|偏好|改成).{0,10}(显示|大小|字号|语言|主题)/, /(导出|备份).{0,6}(存档|save)/i] },
];

const moduleAlias: Record<string, string> = {
  地图: 'map', 商店: 'commerce', 背包: 'inventory', 装备: 'equipment', 任务: 'quests',
  生活模式: 'routine', 属性: 'attributes', 资质: 'aptitudes', 技能: 'skills', 特质: 'traits', 关系系统: 'relationships',
};
const categoryTools: Record<MetaCategory, string[]> = {
  PRODUCT_FEEDBACK: ['ui.feedback'],
  BUG_REPORT: ['diagnostic.logs'],
  MODULE_MANAGEMENT: ['module.enable', 'module.disable', 'module.remove'],
  SETTING: ['save.export'],
  MEDIA_OPERATION: ['avatar.crop', 'media.set_avatar', 'character.media.get', 'character.lookup'],
  MEDIA_GENERATION: ['media.generate_image'],
  EXTENSION_REQUEST: ['extension.create'],
  FRAMEWORK_DEVELOPMENT: ['framework.development'],
  IN_WORLD_INPUT: [],
  UNKNOWN: [],
};

export function classifyMeta(input: string): MetaCategory {
  const text = input.trim();
  for (const entry of vocabulary) if (entry.patterns.some(pattern => pattern.test(text))) return entry.category;
  return 'UNKNOWN';
}
export function moduleFromText(input: string) {
  const key = Object.keys(moduleAlias).find(word => input.includes(word));
  return key ? moduleAlias[key] : null;
}
export function planMeta(input: string, capabilities: string[]): MetaPlan {
  const text = input.trim(), category = classifyMeta(text), available = toolAvailability(capabilities);
  if (category === 'IN_WORLD_INPUT') return { category, goal: 'in-world action', tool_id: null, args: {}, needs_confirmation: false, reply: '这属于游戏内操作，请使用左侧输入框（角色行动 / 世界指令）。系统页只处理游戏本身的事情。' };
  const candidates = categoryTools[category].map(id => available.find(tool => tool.tool_id === id)!).filter(Boolean);
  const ready = candidates.filter(tool => tool.available);
  if (!ready.length) {
    const missing = candidates[0];
    const reply = !missing ? '我还不确定你的目标，可以再具体一点吗？'
      : missing.tool_id === 'media.generate_image' ? '当前未配置图像生成能力（缺少 media.image_generation）。我不会假装已经生成图片；可以改用已有的全身图裁剪头像，或在框架开发侧接入图像 Provider。'
      : `当前未配置「${missing.name}」所需的能力：${missing.required_capabilities.join('、')}。这需要在框架开发侧接入后才能使用。`;
    return { category, goal: category, tool_id: missing?.tool_id ?? null, args: {}, needs_confirmation: false, reply };
  }
  // Module management picks the tool from the requested verb, never from declaration order.
  const verb = category === 'MODULE_MANAGEMENT'
    ? (/(彻底|永久|完全)?\s*(移除|删除)/.test(text) ? 'module.remove' : /(不需要|不用|关闭|停用|禁用|隐藏|不要)/.test(text) ? 'module.disable' : 'module.enable')
    : null;
  const tool: ToolDescriptor = verb ? ready.find(entry => entry.tool_id === verb) ?? ready[0] : ready[0];
  const args: Record<string, unknown> = {};
  if (category === 'MODULE_MANAGEMENT') {
    args.module = moduleFromText(text);
    if (tool.tool_id === 'module.remove') return { category, goal: 'remove module', tool_id: 'module.remove', args, needs_confirmation: true, reply: '移除系统会删除它自己的状态（会先写检查点）。确认后再执行。' };
  }

  if (tool.tool_id === 'diagnostic.logs') args.event = /地图|map/i.test(text) ? 'display' : undefined;
  if (tool.tool_id === 'ui.feedback' || tool.tool_id === 'extension.create' || tool.tool_id === 'framework.development') args.request = text;
  if (tool.tool_id === 'avatar.crop' || tool.tool_id === 'media.set_avatar' || tool.tool_id === 'character.media.get' || tool.tool_id === 'media.generate_image') args.name = text.match(/[「"']([^」"']{1,24})[」"']/)?.[1] ?? null;
  const needs_confirmation = tool.confirmation_policy === 'always' || (tool.confirmation_policy === 'ambiguous-only' && (tool.tool_id.startsWith('module.') ? !args.module : false));
  return { category, goal: tool.name, tool_id: tool.tool_id, args, needs_confirmation, reply: null };
}

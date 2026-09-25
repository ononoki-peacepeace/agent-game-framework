import { z } from 'zod';

/**
 * World creation templates.
 *
 * A template is program data, not a prompt trick: it carries an experience-level draft that is compiled into the
 * *existing* world creation description, so the normal authoring + validation pipeline still applies and the
 * semantic blank world keeps working. Templates describe a skeleton — never a plot.
 */
export const worldDraftSchema = z.strictObject({
  title: z.string().min(1).max(60),
  one_liner: z.string().min(1).max(200),
  era: z.string().min(1).max(60),
  player_role: z.string().min(1).max(60),
  initial_scope: z.string().min(1).max(120),
  danger: z.enum(['low', 'medium', 'high']),
  supernatural: z.enum(['none', 'subtle', 'open']),
  npc_density: z.enum(['low', 'medium', 'high']),
  experiences: z.array(z.string().max(30)).min(1).max(5),
  special_rules: z.array(z.string().max(120)).max(4),
  recommended_modules: z.array(z.string().max(30)).max(8),
});
export type WorldDraft = z.infer<typeof worldDraftSchema>;
export interface WorldTemplate {
  id: string; version: number; display_name: string; description: string;
  recommended_experience: string[]; starter_inspiration: string[]; draft: WorldDraft; blank?: boolean;
}
const draft = (value: WorldDraft) => worldDraftSchema.parse(value);

export const worldTemplates: WorldTemplate[] = [
  {
    id: 'arcane_academy', version: 1, display_name: '奇幻学院',
    description: '学习、社交、探索与危机并存的类近代学院世界。',
    recommended_experience: ['学习', '社交', '探索', '危机'],
    starter_inspiration: ['学院地下的旧书库每年只开一次', '魔法正在缓慢衰退', '学院里有从不露面的资助人'],
    draft: draft({ title: '银枝学院', one_liner: '你是刚入学的新生，学院里既有课程与同伴，也有说不清来历的事。', era: '类近代', player_role: '新生', initial_scope: '学院与周边区域', danger: 'medium', supernatural: 'open', npc_density: 'high', experiences: ['学习', '社交', '探索', '危机'], special_rules: ['超自然是公开事实，但细节被学院管控'], recommended_modules: ['map', 'characters', 'relationships', 'inventory', 'routine'] }),
  },
  {
    id: 'modern_city', version: 1, display_name: '现代都市',
    description: '工作、人际与城市生活的现代背景世界。',
    recommended_experience: ['社交', '职业', '生活'],
    starter_inspiration: ['所有人在午夜都会收到同一条短信', '这座城市的地铁偶尔开向不存在的一站'],
    draft: draft({ title: '临海城', one_liner: '你在临海城谋生，日常平稳，但总有些细节对不上。', era: '当代', player_role: '刚搬来的年轻人', initial_scope: '居住街区与工作区', danger: 'low', supernatural: 'subtle', npc_density: 'high', experiences: ['社交', '职业', '生活'], special_rules: [], recommended_modules: ['map', 'characters', 'relationships', 'inventory', 'commerce'] }),
  },
  {
    id: 'medieval_adventure', version: 1, display_name: '中世纪冒险',
    description: '城镇、道路与荒野之间的低魔冒险世界。',
    recommended_experience: ['冒险', '探索', '成长'],
    starter_inspiration: ['王国的边界正在悄悄后撤', '每个村庄都留着一位不肯离开的守夜人'],
    draft: draft({ title: '石桥边境', one_liner: '你在边境地带讨生活，接活、赶路、与人和野兽打交道。', era: '中世纪', player_role: '新来的旅人', initial_scope: '边境城镇与周边荒野', danger: 'high', supernatural: 'subtle', npc_density: 'medium', experiences: ['冒险', '探索', '成长'], special_rules: ['低魔：传闻多，实证少'], recommended_modules: ['map', 'characters', 'relationships', 'inventory', 'commerce', 'attributes'] }),
  },
  {
    id: 'post_apocalypse', version: 1, display_name: '末日生存',
    description: '资源紧张的废土生存世界。',
    recommended_experience: ['生存', '探索', '抉择'],
    starter_inspiration: ['广播里每隔七小时出现一次同样的数字', '有些避难所的门从里面焊死了'],
    draft: draft({ title: '灰线废墟', one_liner: '你在废墟边缘找了处落脚点，活下去并弄清这里发生过什么。', era: '灾后二十年', player_role: '幸存者新人', initial_scope: '废墟定居点与周边搜寻区', danger: 'high', supernatural: 'none', npc_density: 'low', experiences: ['生存', '探索', '抉择'], special_rules: ['水与药是硬通货'], recommended_modules: ['map', 'characters', 'relationships', 'inventory'] }),
  },
  {
    id: 'school_life', version: 1, display_name: '校园日常',
    description: '以日常、朋友与成长为核心的校园世界。',
    recommended_experience: ['日常', '社交', '成长'],
    starter_inspiration: ['天台的门锁总是坏的', '每年毕业前都有一次没说出口的告别'],
    draft: draft({ title: '松见学园', one_liner: '你就是这所学校的学生，日子由课程、同伴和一些小事组成。', era: '当代', player_role: '在校学生', initial_scope: '校园与通学路线', danger: 'low', supernatural: 'none', npc_density: 'high', experiences: ['日常', '社交', '成长'], special_rules: [], recommended_modules: ['map', 'characters', 'relationships', 'routine', 'attributes'] }),
  },
  {
    id: 'crime_city', version: 1, display_name: '犯罪都市',
    description: '秩序与灰线交织的都市犯罪世界。',
    recommended_experience: ['博弈', '社交', '风险'],
    starter_inspiration: ['城里所有人都知道谁不能赊账', '警局档案室少了一整年的记录'],
    draft: draft({ title: '旧港区', one_liner: '你在旧港区讨生活，认识谁、欠谁、得罪谁都很重要。', era: '近当代', player_role: '刚入行的新人', initial_scope: '旧港区与夜生活街区', danger: 'high', supernatural: 'none', npc_density: 'high', experiences: ['博弈', '社交', '风险'], special_rules: ['暴力有代价，关系网比拳头好用'], recommended_modules: ['map', 'characters', 'relationships', 'inventory', 'commerce'] }),
  },
  {
    id: 'space_colony', version: 1, display_name: '太空殖民地',
    description: '封闭殖民地中的工作、制度与人际世界。',
    recommended_experience: ['职业', '社交', '探索'],
    starter_inspiration: ['站内时刻比地球慢一点点', '三号舱段长期无人值班'],
    draft: draft({ title: '赫利俄斯站', one_liner: '你是站上的一名新成员，工作、配额与隔壁舱室的人构成了日常。', era: '远未来', player_role: '新到站员', initial_scope: '主站与相邻舱段', danger: 'medium', supernatural: 'none', npc_density: 'medium', experiences: ['职业', '社交', '探索'], special_rules: ['舱外必须按规程行动'], recommended_modules: ['map', 'characters', 'relationships', 'inventory', 'commerce', 'skills'] }),
  },
  {
    id: 'small_town', version: 1, display_name: '小镇生活',
    description: '节奏缓慢、邻里关系密集的小镇世界。',
    recommended_experience: ['日常', '社交', '经营'],
    starter_inspiration: ['镇上的人都记得二十年前那个夏天', '公交车只在有人招手时停'],
    draft: draft({ title: '槐溪镇', one_liner: '你在槐溪镇安顿下来，邻居、老店与季节构成了生活。', era: '当代', player_role: '搬来定居的人', initial_scope: '镇中心与周边村落', danger: 'low', supernatural: 'subtle', npc_density: 'medium', experiences: ['日常', '社交', '经营'], special_rules: [], recommended_modules: ['map', 'characters', 'relationships', 'commerce', 'routine'] }),
  },
  {
    id: 'blank', version: 1, display_name: '空白世界',
    description: '只有框架结构的空白世界，用于自行搭建或检查框架。',
    recommended_experience: ['自定义'],
    starter_inspiration: [],
    blank: true,
    draft: draft({ title: '空白世界', one_liner: '完全空白，不预置任何人物、地点或剧情。', era: '未设定', player_role: '未设定', initial_scope: '未设定', danger: 'low', supernatural: 'none', npc_density: 'low', experiences: ['自定义'], special_rules: [], recommended_modules: ['core'] }),
  },
];
export function templateById(id: string) { return worldTemplates.find(template => template.id === id) ?? null; }
export function draftToDescription(value: WorldDraft, notes: string[] = []) {
  if (value.title === '空白世界') return '完全空白世界，只需要框架结构，不需要任何人物、地点或剧情。';
  return [
    `世界名称：${value.title}`,
    value.one_liner,
    `时代：${value.era}；玩家身份：${value.player_role}；初始范围：${value.initial_scope}`,
    `危险程度：${{ low: '低', medium: '中等', high: '高' }[value.danger]}；超自然：${{ none: '没有', subtle: '轻微隐秘', open: '公开存在' }[value.supernatural]}；NPC 密度：${{ low: '低', medium: '中等', high: '高' }[value.npc_density]}`,
    `主要体验：${value.experiences.join('、')}`,
    value.special_rules.length ? `特殊规则：${value.special_rules.join('；')}` : '',
    value.recommended_modules.length ? `建议启用的玩法系统：${value.recommended_modules.join('、')}` : '',
    notes.length ? `玩家补充：${notes.join('；')}` : '',
    '不要预设强制主线，不要预设反派，不要替玩家安排必然发生的事件。',
  ].filter(Boolean).join('\n');
}
export function previewOf(value: WorldDraft, source: { kind: 'template' | 'idea' | 'recommended'; id?: string }) {
  return {
    source, title: value.title, one_liner: value.one_liner, era: value.era, player_role: value.player_role,
    initial_scope: value.initial_scope, danger: value.danger, supernatural: value.supernatural,
    npc_density: value.npc_density, experiences: value.experiences, special_rules: value.special_rules,
    recommended_modules: value.recommended_modules,
  };
}
export const inspirationPool = [
  '魔法正在衰退', '所有人都有一个秘密身份', '城市午夜会改变布局', '死者偶尔会回来',
  '每个人出生时都有一个预言', '有些地方只在雨中可见', '记忆可以被买卖', '钟声一响，所有人都要说实话',
  '没有什么特别之处',
];
export function inspirations(seed: number, count = 6) {
  const start = Math.abs(Math.floor(seed)) % inspirationPool.length;
  return Array.from({ length: Math.min(count, inspirationPool.length) }, (_unused, index) => inspirationPool[(start + index) % inspirationPool.length]);
}
const recommendedStarters: WorldDraft[] = [
  worldTemplates.find(template => template.id === 'small_town')!.draft,
  worldTemplates.find(template => template.id === 'modern_city')!.draft,
  worldTemplates.find(template => template.id === 'school_life')!.draft,
];
export function recommendDraft(variant = 0) { return recommendedStarters[Math.abs(variant) % recommendedStarters.length]; }
const ideaKeywords: [RegExp, string][] = [
  [/(魔法|学院|学校|学徒)/, 'arcane_academy'], [/(末日|废土|废墟|生存)/, 'post_apocalypse'],
  [/(太空|太空站|殖民|飞船)/, 'space_colony'], [/(中世纪|骑士|王国|冒险)/, 'medieval_adventure'],
  [/(犯罪|黑帮|港区|警)/, 'crime_city'], [/(校园|高中|学生|日常)/, 'school_life'],
  [/(小镇|乡|邻里|经营)/, 'small_town'], [/(都市|现代|城市)/, 'modern_city'],
];
export function draftFromIdea(idea: string): WorldDraft {
  const text = String(idea ?? '');
  const hit = ideaKeywords.find(([pattern]) => pattern.test(text));
  const base = (hit ? templateById(hit[1]) : null)?.draft ?? recommendDraft(0);
  const value: WorldDraft = {
    ...base,
    one_liner: base.one_liner,
    special_rules: [...base.special_rules],
  };
  if (/(黑暗|阴暗|压抑)/.test(text)) value.special_rules.push('整体气氛偏暗');
  if (/(隐藏|异常|秘密|诡异)/.test(text)) value.supernatural = value.supernatural === 'none' ? 'subtle' : value.supernatural;
  if (/(人物(很)?多|关系(很)?复杂|人际)/.test(text)) value.npc_density = 'high';
  if (/(危险|残酷|凶险)/.test(text)) value.danger = 'high';
  return applyWorldModification(value, text);
}
/** Player wording changes the draft: templates are a starting point, never a fixed save. */
export function applyWorldModification(value: WorldDraft, text: string): WorldDraft {
  const next: WorldDraft = { ...value, special_rules: [...value.special_rules], experiences: [...value.experiences], recommended_modules: [...value.recommended_modules] };
  const clean = String(text ?? '');
  if (/(不要魔法|换成超能力|超能力)/.test(clean)) { next.special_rules = next.special_rules.filter(rule => !rule.includes('魔法')); next.special_rules.push('超能力取代魔法'); }
  if (/(危险(程度)?(低|小)|没那么危险|太平一点)/.test(clean)) next.danger = 'low';
  if (/(危险(程度)?(高|大)|更危险)/.test(clean)) next.danger = 'high';
  if (/(npc|NPC|人物|角色).{0,6}(少|少一点)/.test(clean)) next.npc_density = 'low';
  if (/(npc|NPC|人物|角色).{0,6}(多|多一点|更多)/.test(clean)) next.npc_density = 'high';
  if (/(老师|教师)/.test(clean)) next.player_role = '新来的老师';
  else if (/(学生|新生)/.test(clean)) next.player_role = '新生';
  if (/(恐怖|惊悚|害怕)/.test(clean)) next.special_rules.push('带有恐怖元素');
  if (/(不要(隐藏)?异常|没有异常|正常世界)/.test(clean)) { next.supernatural = 'none'; next.special_rules = next.special_rules.filter(rule => !/异常|秘密|扭曲/.test(rule)); }
  else if (/(隐藏异常|有异常|超自然|诡异)/.test(clean)) { next.supernatural = 'subtle'; if (!next.special_rules.some(rule => /异常/.test(rule))) next.special_rules.push('看似正常但存在极少数异常'); }
  if (/(小镇|不要大城市|换成小镇)/.test(clean)) next.initial_scope = '一座小镇及其周边';
  return worldDraftSchema.parse(next);
}

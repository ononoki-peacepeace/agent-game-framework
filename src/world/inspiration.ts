import { worldDraftSchema, worldTemplates, type WorldDraft } from './templates.js';

/**
 * World Inspiration Library.
 *
 * Diversity comes from combining several independent dimensions (setting, tone, social texture, anomaly, role,
 * experience, special hook) under a few light compatibility rules — not from maintaining dozens of full templates.
 * Everything here is deterministic program data: seeds pick the combination, the model only writes it naturally.
 */
export type InspirationDimension = 'setting' | 'tone' | 'social' | 'anomaly' | 'role' | 'experience' | 'hook';
export interface InspirationOption { id: string; label: string; dimension: InspirationDimension; incompatible?: string[]; tags?: Partial<Record<'era' | 'danger' | 'supernatural' | 'npc_density', string>> }
const option = (id: string, label: string, dimension: InspirationDimension, extra: Partial<InspirationOption> = {}): InspirationOption => ({ id, label, dimension, ...extra });

export const inspirationLibrary: InspirationOption[] = [
  option('city_modern', '现代大都市', 'setting', { tags: { era: '当代都市' } }),
  option('city_coastal', '沿海工业城', 'setting', { tags: { era: '当代工业城市' } }),
  option('university_town', '大学城', 'setting', { tags: { era: '当代' } }),
  option('border_town', '边境小镇', 'setting', { tags: { era: '近现代' } }),
  option('remote_island', '偏远岛屿', 'setting', { tags: { era: '当代' } }),
  option('mountain_settlement', '山区聚落', 'setting', { tags: { era: '近现代' } }),
  option('underground_city', '地下城市', 'setting', { tags: { era: '近未来' } }),
  option('space_station', '太空站', 'setting', { tags: { era: '远未来' } }),
  option('colony', '殖民地', 'setting', { tags: { era: '远未来' } }),
  option('magic_academy', '魔法学院', 'setting', { tags: { era: '类近代', supernatural: 'open' }, incompatible: ['realism_strict'] }),
  option('ancient_kingdom', '古代王国', 'setting', { tags: { era: '前工业时代' }, incompatible: ['tech_modern'] }),
  option('wasteland', '荒原聚落', 'setting', { tags: { era: '灾后' }, incompatible: ['tech_modern'] }),
  option('warm', '温馨', 'tone'),
  option('realism_strict', '完全现实', 'tone', { incompatible: ['anomaly_open_magic'] }),
  option('mysterious', '神秘', 'tone'),
  option('oppressive', '压抑', 'tone'),
  option('dark', '黑暗', 'tone'),
  option('absurd', '荒诞', 'tone'),
  option('light', '轻松', 'tone'),
  option('tense', '紧张', 'tone'),
  option('slow', '缓慢', 'tone'),
  option('acquaintance_web', '熟人社会', 'social', { tags: { npc_density: 'high' } }),
  option('dense_relations', '高密度人际关系', 'social', { tags: { npc_density: 'high' } }),
  option('factions', '派系复杂', 'social'),
  option('class_visible', '阶级明显', 'social'),
  option('alienated', '人际疏离', 'social'),
  option('transient_crowd', '流动人口很多', 'social'),
  option('anomaly_none', '没有异常', 'anomaly', { tags: { supernatural: 'none' } }),
  option('anomaly_hidden', '隐藏超自然', 'anomaly', { tags: { supernatural: 'subtle' }, incompatible: ['realism_strict'] }),
  option('anomaly_open_magic', '公开魔法', 'anomaly', { tags: { supernatural: 'open' }, incompatible: ['realism_strict'] }),
  option('anomaly_memory', '记忆异常', 'anomaly', { tags: { supernatural: 'subtle' } }),
  option('anomaly_time', '时间异常', 'anomaly', { tags: { supernatural: 'subtle' } }),
  option('anomaly_identity', '身份异常', 'anomaly', { tags: { supernatural: 'subtle' } }),
  option('anomaly_space', '空间异常', 'anomaly', { tags: { supernatural: 'subtle' } }),
  option('anomaly_decline', '文明衰退', 'anomaly'),
  option('anomaly_warp', '轻微现实扭曲', 'anomaly', { tags: { supernatural: 'subtle' } }),
  option('student', '学生', 'role'), option('new_employee', '新员工', 'role'), option('resident', '普通居民', 'role'),
  option('doctor', '医生', 'role'), option('teacher', '教师', 'role'), option('investigator', '调查员', 'role'),
  option('merchant', '商人', 'role'), option('newcomer', '新移民', 'role'), option('drifter', '流浪者', 'role'),
  option('civil_servant', '公务员', 'role'), option('technician', '技术人员', 'role'),
  option('exp_social', '社交', 'experience'), option('exp_daily', '日常', 'experience'), option('exp_explore', '探索', 'experience'),
  option('exp_survive', '生存', 'experience'), option('exp_career', '职业', 'experience'), option('exp_growth', '成长', 'experience'),
  option('exp_intrigue', '权谋', 'experience'), option('exp_crime', '犯罪', 'experience'), option('exp_business', '经营', 'experience'),
  option('exp_investigate', '调查', 'experience'),
  option('hook_secret_everyone', '所有人都有一个秘密', 'hook'),
  option('hook_forgotten', '少数人会被公共记录遗忘', 'hook', { tags: { supernatural: 'subtle' } }),
  option('hook_shifting_city', '城市部分区域会周期性变化', 'hook', { tags: { supernatural: 'subtle' } }),
  option('hook_unreliable_memory', '某些记忆并不可靠', 'hook', { tags: { supernatural: 'subtle' } }),
  option('hook_new_technology', '一种技术正在改变社会', 'hook'),
  option('hook_declining_city', '城市正在衰退', 'hook'),
  option('hook_new_institution', '一个新制度刚刚实施', 'hook'),
  option('hook_few_anomalies', '看似正常但存在极少数异常', 'hook', { tags: { supernatural: 'subtle' } }),
];
export const byDimension = (dimension: InspirationDimension) => inspirationLibrary.filter(entry => entry.dimension === dimension);
const find = (id: string) => inspirationLibrary.find(entry => entry.id === id) ?? null;
/** Tiny deterministic PRNG so a seed always answers the same way. */
function rng(seed: number) { let state = (Math.abs(Math.floor(seed)) || 1) % 2147483647; return () => { state = (state * 48271) % 2147483647; return state / 2147483647; }; }
function pick<T>(items: T[], random: () => number, used: Set<string>, key: (item: T) => string): T { const free = items.filter(item => !used.has(key(item))); const pool = free.length ? free : items; return pool[Math.floor(random() * pool.length) % pool.length]; }
/** Light compatibility: an option is excluded when anything already chosen declares it incompatible. */
function compatible(option: InspirationOption, chosen: InspirationOption[]) {
  if (chosen.some(entry => (entry.incompatible ?? []).includes(option.id))) return false;
  if ((option.incompatible ?? []).some(id => chosen.some(entry => entry.id === id))) return false;
  return true;
}
export interface InspirationPick { setting: string; tone: string; social: string; anomaly: string; role: string; experiences: string[]; hook: string }
export function sampleInspiration(seed: number, required: string[] = [], recent: string[] = [], allowConflicts = false): InspirationPick {
  const random = rng(seed + 7);
  const chosen: InspirationOption[] = [];
  const takeById = (id: string) => { const entry = find(id); if (!entry) return null; if (!allowConflicts && !compatible(entry, chosen)) return null; chosen.push(entry); return entry; };
  for (const id of required) { if (recent.includes(id)) continue; takeById(id); }
  const used = new Set<string>();
  const dimensionPick = (dimension: InspirationDimension) => {
    const candidates = byDimension(dimension).filter(entry => allowConflicts || compatible(entry, chosen));
    const entry = pick(candidates, random, used, item => item.id);
    if (entry) { used.add(entry.id); chosen.push(entry); }
    return entry;
  };
  const setting = chosen.find(entry => entry.dimension === 'setting') ?? dimensionPick('setting');
  const tone = chosen.find(entry => entry.dimension === 'tone') ?? dimensionPick('tone');
  const social = chosen.find(entry => entry.dimension === 'social') ?? dimensionPick('social');
  const anomaly = chosen.find(entry => entry.dimension === 'anomaly') ?? dimensionPick('anomaly');
  const role = chosen.find(entry => entry.dimension === 'role') ?? dimensionPick('role');
  const hook = chosen.find(entry => entry.dimension === 'hook') ?? dimensionPick('hook');
  const experiences: string[] = chosen.filter(entry => entry.dimension === 'experience').map(entry => entry.id);
  while (experiences.length < 3) { const entry = dimensionPick('experience'); if (!entry) break; experiences.push(entry.id); }
  return {
    setting: setting?.id ?? 'city_modern', tone: tone?.id ?? 'realism_strict', social: social?.id ?? 'acquaintance_web',
    anomaly: anomaly?.id ?? 'anomaly_hidden', role: role?.id ?? 'newcomer', experiences: [...new Set(experiences)].slice(0, 3), hook: hook?.id ?? 'hook_few_anomalies',
  };
}
export const pickLabels = (inspiration: InspirationPick) => [inspiration.setting, inspiration.tone, inspiration.social, inspiration.anomaly, inspiration.role, ...inspiration.experiences, inspiration.hook].map(id => find(id)?.label ?? id);
/** The library's chips: a few light inspirations the player may pick, or ignore entirely. */
export function inspirationChips(seed: number, count = 6, recent: string[] = []) {
  const random = rng(seed + 31), chosen: InspirationOption[] = [];
  const dimensions: InspirationDimension[] = ['anomaly', 'hook', 'social', 'tone', 'setting', 'role'];
  for (const dimension of dimensions) {
    const candidates = byDimension(dimension).filter(entry => compatible(entry, chosen) && !recent.includes(entry.id));
    const entry = candidates[Math.floor(random() * candidates.length) % Math.max(candidates.length, 1)];
    if (entry) chosen.push(entry);
  }
  return chosen.slice(0, count).map(entry => ({ id: entry.id, label: entry.label, dimension: entry.dimension }));
}
const dangerFrom = (chosen: InspirationOption[]): WorldDraft['danger'] => chosen.some(entry => ['wasteland', 'border_town'].includes(entry.id)) ? 'high' : chosen.some(entry => ['city_coastal', 'underground_city'].includes(entry.id)) ? 'medium' : 'low';
export function draftFromInspiration(seed: number, required: string[] = [], recent: string[] = [], idea?: string): { draft: WorldDraft; picks: InspirationPick } {
  const inspiration = sampleInspiration(seed, required, recent);
  const chosen = [...new Set([inspiration.setting, inspiration.tone, inspiration.social, inspiration.anomaly, inspiration.role, ...inspiration.experiences, inspiration.hook])].map(id => find(id)).filter((entry): entry is InspirationOption => Boolean(entry));
  const settingLabel = find(inspiration.setting)?.label ?? '一座城市';
  const roleLabel = find(inspiration.role)?.label ?? '新来的人';
  const toneLabel = find(inspiration.tone)?.label ?? '现实';
  const anomalyLabel = find(inspiration.anomaly)?.label ?? '没有异常';
  const socialLabel = find(inspiration.social)?.label ?? '熟人社会';
  const hookLabel = find(inspiration.hook)?.label ?? '看似正常但存在极少数异常';
  const era = settingLabel.includes('太空') || settingLabel.includes('殖民地') ? '远未来'
    : settingLabel.includes('地下城市') ? '近未来'
    : settingLabel.includes('学院') || settingLabel.includes('王国') ? '类近代'
    : settingLabel.includes('边疆') ? '近现代' : '当代';
  const template = worldTemplates.find(entry => entry.id === (settingLabel.includes('学院') ? 'arcane_academy' : settingLabel.includes('小镇') ? 'small_town' : settingLabel.includes('太空') ? 'space_colony' : 'modern_city'));
  const draft = worldDraftSchema.parse({
    title: template ? `${template.draft.title}·${settingLabel.slice(0, 4)}` : `${settingLabel}的日常`,
    one_liner: idea && idea.trim() ? `${String(idea).trim().replace(/[。！？!?]+$/u, '')}。` : `一座${toneLabel}气息的${settingLabel}，${socialLabel}，${anomalyLabel}。`,
    era, player_role: roleLabel, initial_scope: `${settingLabel}及其周边`,
    danger: dangerFrom(chosen),
    supernatural: chosen.some(entry => entry.tags?.supernatural === 'open') ? 'open' : chosen.some(entry => entry.tags?.supernatural === 'subtle') ? 'subtle' : 'none',
    npc_density: chosen.some(entry => entry.tags?.npc_density === 'high') ? 'high' : settingLabel.includes('聚落') || settingLabel.includes('岛屿') ? 'low' : 'medium',
    experiences: inspiration.experiences.map(id => find(id)?.label ?? '日常').slice(0, 4),
    special_rules: [hookLabel, `${toneLabel}基调`].slice(0, 3),
    recommended_modules: template ? template.draft.recommended_modules : ['map', 'characters', 'relationships', 'inventory'],
  });
  return { draft, picks: inspiration };
}
/** Signature used to keep "换一个" from repeating or cycling between two candidates. */
export function candidateSignature(draft: WorldDraft) {
  // Scope and player role are part of "which world is this": an adjustment such as "换成小镇" or "我想当老师"
  // must produce a different candidate, otherwise "换一个" could hand back the world the player just edited.
  return [draft.title, draft.era, draft.danger, draft.supernatural, draft.npc_density, draft.initial_scope, draft.player_role, draft.experiences.join('|'), (draft.special_rules[0] ?? '')].join('::');
}

/**
 * Produce a candidate whose signature has not been seen in `recent`. Up to three seeded attempts, then a
 * library-assembled fallback that is guaranteed to differ (no unbounded regeneration).
 */
export function distinctCandidate(seed: number, recent: string[], required: string[] = [], idea?: string) {
  const attempted: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = draftFromInspiration(seed + attempt * 977, required, recent, idea);
    const signature = candidateSignature(candidate.draft);
    attempted.push(signature);
    if (!recent.includes(signature)) return { ...candidate, signature, attempts: attempt + 1 };
  }
  const variant = draftFromInspiration(seed + 5_003 + recent.length * 131, required, [...recent, ...attempted], idea);
  const signature = `${candidateSignature(variant.draft)}::${recent.length}`;
  return { ...variant, signature, attempts: 4 };
}
export const WORLD_CANDIDATE_HISTORY = 8;
export const worldFeatureLabels = (draft: WorldDraft) => draft.special_rules.slice(0, 3);

import { worldDraftSchema, worldTemplates, type WorldDraft } from './templates.js';

/**
 * World Inspiration Library.
 *
 * Diversity comes from combining several independent dimensions (setting, tone, social texture, anomaly, role,
 * experience, special hook) under a few light compatibility rules — not from maintaining dozens of full templates.
 * Everything here is deterministic program data: seeds pick the combination, the model only writes it naturally.
 */
export type InspirationDimension = 'setting' | 'tone' | 'social' | 'anomaly' | 'role' | 'experience' | 'hook';
export interface InspirationOption { id: string; label: string; dimension: InspirationDimension; incompatible?: string[]; category?: string; tags?: Partial<Record<'era' | 'danger' | 'supernatural' | 'npc_density', string>> }
const option = (id: string, label: string, dimension: InspirationDimension, extra: Partial<InspirationOption> = {}): InspirationOption => ({ id, label, dimension, ...extra });

export const inspirationLibrary: InspirationOption[] = [
  // A template locks a *category*, not a concrete place: within 太空殖民地 the sampler may produce a lunar city,
  // a Martian canyon settlement, a Europa research cluster, an asteroid mining town, a generation ship quarter…
  option('city_modern', '现代大都市', 'setting', { tags: { era: '当代都市' }, category: 'city' }),
  option('city_coastal', '沿海工业城', 'setting', { tags: { era: '当代工业城市' }, category: 'city' }),
  option('city_satellite', '新区卫星城', 'setting', { tags: { era: '当代' }, category: 'city' }),
  option('city_old_ring', '内环老城', 'setting', { tags: { era: '当代' }, category: 'city' }),
  option('city_port', '港口商贸城', 'setting', { tags: { era: '当代' }, category: 'city' }),
  option('city_megalopolis', '巨型都会带', 'setting', { tags: { era: '近未来' }, category: 'city' }),
  option('university_town', '大学城', 'setting', { tags: { era: '当代' }, category: 'school' }),
  option('school_campus', '城郊寄宿学园', 'setting', { tags: { era: '当代' }, category: 'school' }),
  option('school_seaside', '海滨中学', 'setting', { tags: { era: '当代' }, category: 'school' }),
  option('academy_mountain', '山间学院', 'setting', { tags: { era: '类近代', supernatural: 'open' }, incompatible: ['realism_strict'], category: 'academy' }),
  option('academy_city', '都会学舍', 'setting', { tags: { era: '类近代', supernatural: 'open' }, incompatible: ['realism_strict'], category: 'academy' }),
  option('academy_border', '边境学舍', 'setting', { tags: { era: '类近代', supernatural: 'subtle' }, category: 'academy' }),
  option('academy_lake', '湖畔学院', 'setting', { tags: { era: '类近代', supernatural: 'open' }, incompatible: ['realism_strict'], category: 'academy' }),
  option('space_lunar', '月球地下殖民城', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_mars', '火星峡谷定居点', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_europa', '木卫二冰下研究聚落', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_asteroid', '小行星采矿城', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_generation', '世代飞船居民区', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_ring', '轨道环城市', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_hulk', '废弃殖民舰改造聚落', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_depot', '深空补给站', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('space_frontier', '行星表面边境城', 'setting', { tags: { era: '远未来' }, category: 'space' }),
  option('town_river', '河谷小镇', 'setting', { tags: { era: '当代' }, category: 'town' }),
  option('town_fishing', '沿海渔镇', 'setting', { tags: { era: '当代' }, category: 'town' }),
  option('town_mining', '矿区小镇', 'setting', { tags: { era: '近现代' }, category: 'town' }),
  option('town_border', '边境小镇', 'setting', { tags: { era: '近现代' }, category: 'town' }),
  option('town_mountain', '山区聚落', 'setting', { tags: { era: '近现代' }, category: 'town' }),
  option('isle_remote', '偏远岛屿', 'setting', { tags: { era: '当代' }, category: 'town' }),
  option('crime_harbor', '旧港区', 'setting', { tags: { era: '近当代' }, category: 'crime' }),
  option('crime_nightlife', '夜生活街区', 'setting', { tags: { era: '近当代' }, category: 'crime' }),
  option('crime_industrial', '工业带边缘城', 'setting', { tags: { era: '近当代' }, category: 'crime' }),
  option('medieval_border', '边境要塞镇', 'setting', { tags: { era: '前工业时代' }, incompatible: ['tech_modern'], category: 'medieval' }),
  option('medieval_kingdom', '王国都城', 'setting', { tags: { era: '前工业时代' }, incompatible: ['tech_modern'], category: 'medieval' }),
  option('medieval_road', '商路驿站', 'setting', { tags: { era: '前工业时代' }, incompatible: ['tech_modern'], category: 'medieval' }),
  option('waste_ruins', '废墟定居点', 'setting', { tags: { era: '灾后' }, incompatible: ['tech_modern'], category: 'apocalypse' }),
  option('waste_bunker', '避难所聚落', 'setting', { tags: { era: '灾后' }, incompatible: ['tech_modern'], category: 'apocalypse' }),
  option('waste_underground', '地下城市', 'setting', { tags: { era: '近未来' }, category: 'apocalypse' }),

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
/**
 * Deterministic xorshift PRNG with a mixing step. The previous LCG mapped neighbouring seeds to almost the same
 * first draw, which is why the same chip ("身份异常") kept coming back on every 换一批.
 */
function rng(seed: number) {
  let state = (Math.imul(Math.abs(Math.floor(seed)) || 1, 2654435761) ^ 0x9e3779b9) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
}
function shuffled<T>(items: T[], random: () => number) { const copy = [...items]; for (let index = copy.length - 1; index > 0; index -= 1) { const swap = Math.floor(random() * (index + 1)) % (index + 1); [copy[index], copy[swap]] = [copy[swap], copy[index]]; } return copy; }

function pick<T>(items: T[], random: () => number, used: Set<string>, key: (item: T) => string): T { const free = items.filter(item => !used.has(key(item))); const pool = free.length ? free : items; return pool[Math.floor(random() * pool.length) % pool.length]; }
/** Light compatibility: an option is excluded when anything already chosen declares it incompatible. */
function compatible(option: InspirationOption, chosen: InspirationOption[]) {
  if (chosen.some(entry => (entry.incompatible ?? []).includes(option.id))) return false;
  if ((option.incompatible ?? []).some(id => chosen.some(entry => entry.id === id))) return false;
  return true;
}
export interface InspirationPick { setting: string; tone: string; social: string; anomaly: string; role: string; experiences: string[]; hook: string }
export function sampleInspiration(seed: number, required: string[] = [], recent: string[] = [], category?: string, allowConflicts = false): InspirationPick {
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
  let setting = chosen.find(entry => entry.dimension === 'setting') ?? dimensionPick('setting');
  // A template locks the category (太空殖民地), never one concrete place: swap in another archetype of the same class.
  if (category && setting?.category && setting.category !== category && !allowConflicts) {
    const allowed = byDimension('setting').filter(entry => entry.category === category && compatible(entry, chosen.filter(item => item.id !== setting!.id)));
    if (allowed.length) setting = allowed[Math.floor(random() * allowed.length) % allowed.length];
  }
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
export interface InspirationChip { id: string; label: string; dimension: InspirationDimension; picked: boolean }
/**
 * A batch of suggestions. `exclude` is the previous batch's *unpicked* chips, so nothing the player did not
 * choose keeps coming back; `picked` are the chips the player locked in and they are always shown first.
 * The dimension order is shuffled and a random subset is used, so two batches do not share a fixed skeleton.
 */
export function inspirationChips(seed: number, count = 6, exclude: string[] = [], picked: string[] = []) {
  const random = rng(seed * 131 + 31), chosen: InspirationOption[] = [];
  const locked = picked.map(id => find(id)).filter((entry): entry is InspirationOption => Boolean(entry));
  chosen.push(...locked);
  const dimensions: InspirationDimension[] = ['anomaly', 'hook', 'social', 'tone', 'setting', 'role', 'experience'];
  for (const dimension of shuffled(dimensions, random)) {
    if (chosen.length >= count) break;
    if (chosen.some(entry => entry.dimension === dimension) && random() > 0.25) continue;
    const candidates = byDimension(dimension).filter(entry => compatible(entry, chosen) && !exclude.includes(entry.id) && !chosen.some(chosenEntry => chosenEntry.id === entry.id));
    if (!candidates.length) continue;
    chosen.push(candidates[Math.floor(random() * candidates.length) % candidates.length]);
  }
  return chosen.slice(0, count).map(entry => ({ id: entry.id, label: entry.label, dimension: entry.dimension, picked: picked.includes(entry.id) }));
}
const dangerFrom = (chosen: InspirationOption[]): WorldDraft['danger'] => chosen.some(entry => ['wasteland', 'border_town'].includes(entry.id)) ? 'high' : chosen.some(entry => ['city_coastal', 'underground_city'].includes(entry.id)) ? 'medium' : 'low';
const categoryModules: Record<string, string[]> = {
  city: ['map', 'characters', 'relationships', 'inventory', 'commerce'], school: ['map', 'characters', 'relationships', 'routine', 'attributes'],
  academy: ['map', 'characters', 'relationships', 'inventory', 'routine'], space: ['map', 'characters', 'relationships', 'inventory', 'commerce', 'skills'],
  town: ['map', 'characters', 'relationships', 'commerce', 'routine'], crime: ['map', 'characters', 'relationships', 'inventory', 'commerce'],
  medieval: ['map', 'characters', 'relationships', 'inventory', 'commerce', 'attributes'], apocalypse: ['map', 'characters', 'relationships', 'inventory'],
};
const categorySettings = (category: string) => byDimension('setting').filter(entry => !entry.category || entry.category === category);
export function draftFromInspiration(seed: number, required: string[] = [], recent: string[] = [], idea?: string, category?: string): { draft: WorldDraft; picks: InspirationPick } {
  const inspiration = sampleInspiration(seed, required, recent, category);
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
  const template = worldTemplates.find(entry => entry.id === (settingLabel.includes('学院') || settingLabel.includes('学舍') ? 'arcane_academy' : settingLabel.includes('学园') || settingLabel.includes('中学') || settingLabel.includes('大学城') ? 'school_life' : settingLabel.includes('小镇') || settingLabel.includes('渔镇') || settingLabel.includes('矿区') || settingLabel.includes('岛屿') ? 'small_town' : settingLabel.includes('港') && settingLabel.includes('旧') ? 'crime_city' : settingLabel.includes('城') && !category ? 'modern_city' : settingLabel.includes('要塞') || settingLabel.includes('都城') || settingLabel.includes('驿站') ? 'medieval_adventure' : settingLabel.includes('废墟') || settingLabel.includes('避难所') ? 'post_apocalypse' : 'space_colony'));
  const premise = idea && idea.trim() ? String(idea).trim().replace(/[。！？!?]+$/u, '') : null;
  const draft = worldDraftSchema.parse({
    title: settingLabel,
    one_liner: premise ? `${premise}（${settingLabel}）` : `${toneLabel}基调的${settingLabel}，${socialLabel}，${anomalyLabel}。`,
    era, player_role: roleLabel, initial_scope: `${settingLabel}及其周边`,
    danger: dangerFrom(chosen),
    supernatural: chosen.some(entry => entry.tags?.supernatural === 'open') ? 'open' : chosen.some(entry => entry.tags?.supernatural === 'subtle') ? 'subtle' : 'none',
    npc_density: chosen.some(entry => entry.tags?.npc_density === 'high') ? 'high' : settingLabel.includes('聚落') || settingLabel.includes('岛屿') ? 'low' : 'medium',
    experiences: inspiration.experiences.map(id => find(id)?.label ?? '日常').slice(0, 4),
    special_rules: [hookLabel, `${toneLabel}基调`].slice(0, 3),
    recommended_modules: categoryModules[category ?? ''] ?? (template ? template.draft.recommended_modules : ['map', 'characters', 'relationships', 'inventory']),

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
export function distinctCandidate(seed: number, recent: string[], required: string[] = [], idea?: string, category?: string) {
  const attempted: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = draftFromInspiration(seed + attempt * 977, required, recent, idea, category);
    const signature = candidateSignature(candidate.draft);
    attempted.push(signature);
    if (!recent.includes(signature)) return { ...candidate, signature, attempts: attempt + 1 };
  }
  const variant = draftFromInspiration(seed + 5_003 + recent.length * 131, required, [...recent, ...attempted], idea, category);

  const signature = `${candidateSignature(variant.draft)}::${recent.length}`;
  return { ...variant, signature, attempts: 4 };
}
export const WORLD_CANDIDATE_HISTORY = 8;
export const worldFeatureLabels = (draft: WorldDraft) => draft.special_rules.slice(0, 3);

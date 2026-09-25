import type { Entity, PublicView } from './contracts.js';

/**
 * Single canonical relationship source.
 * The structured relationship graph wins. When a legacy save only recorded the relationship inside the
 * character profile (role / known state), that same profile text is used for BOTH the character UI and
 * the Game Agent, so the two can never contradict each other.
 */
export interface RelationshipSummary { text: string; source: 'graph' | 'profile' | 'unknown'; tones: { key: string; value: number }[] }
const labels: Record<string, string> = { familiarity: '熟悉度', trust: '信任', affection: '亲近', dependence: '依赖', protectiveness: '保护欲', suspicion: '怀疑', fear: '恐惧', respect: '尊重', romantic_interest: '恋爱倾向', leverage: '影响力' };
export function relationshipTone(value: number) {
  if (value >= 70) return '很高'; if (value >= 35) return '较高'; if (value >= 10) return '略高';
  if (value <= -70) return '很低'; if (value <= -35) return '较低'; if (value <= -10) return '略低';
  return '一般';
}

/** Conservative public-knowledge condition; profile facts never invent numeric scores. */
export function relationshipCondition(view:PublicView,target:Entity):boolean|null{
 const summary=relationshipSummary(view,target);
 if(summary.source==='graph'){const familiarity=summary.tones.find(t=>t.key==='familiarity');return familiarity?familiarity.value>=35:null;}
 if(summary.source==='profile'){const role=profileRole(target);if(/不熟|陌生|刚认识|不算朋友/.test(role))return false;if(/朋友|熟悉|好友/.test(role))return true;}
 return null;
}
function profileRole(entity: Entity) {
  const role = String(entity.components.character?.role ?? '').trim();
  if (role && !/^(player|导入角色卡人物|新认识的人物)$/i.test(role)) return role;
  const raw = String(entity.components.identity?.description ?? '').trim();
  if (!raw.startsWith('{')) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['current_relationship', 'relationship', 'role']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch { /* plain prose */ }
  return '';
}
export function relationshipSummary(view: PublicView, target: Entity): RelationshipSummary {
  const player = view.entities.find(entity => entity.id === view.player_id);
  const entries = (player?.components.relationships?.entries ?? {}) as Record<string, Record<string, number>>;
  const relation = entries[target.id];
  const tones = relation ? Object.entries(relation).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])) : [];
  if (tones.length) {
    const toneText = tones.slice(0, 3).map(([key, value]) => `${labels[key] ?? '关系指标'}${relationshipTone(value)}`).join('、');
    const role = profileRole(target);
    return { text: role ? `你和${label(target)}是${role}；${toneText}。` : `你和${label(target)}的关系：${toneText}。`, source: 'graph', tones: tones.map(([key, value]) => ({ key, value })) };
  }
  const role = profileRole(target);
  if (role) return { text: `你和${label(target)}目前是${role}（这一层关系记录在人物资料里，还没有形成可量化的关系数值）。`, source: 'profile', tones: [] };
  return { text: `你和${label(target)}目前还没有形成可记录的关系。`, source: 'unknown', tones: [] };
}
export function label(entity: Entity) {
  return String(entity.components.identity?.name ?? entity.id);
}
/** Human wording for the character list/detail badge, derived from the same source. */
export function relationshipBadge(view: PublicView, target: Entity) {
  const summary = relationshipSummary(view, target);
  if (summary.source === 'graph' && summary.tones.length) return summary.tones.slice(0, 2).map(({ key, value }) => `${labels[key] ?? '关系指标'}${relationshipTone(value)}`).join(' · ');
  if (summary.source === 'profile') return profileRole(target);
  return '';
}

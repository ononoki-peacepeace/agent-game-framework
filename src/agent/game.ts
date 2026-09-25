import { agentResult, type AgentResult, type UIAction } from './contracts.js';
import { entityLabel, resolveEntities } from './entities.js';
import { relationshipSummary } from '../shared/relationship.js';
import type { Entity, PublicView } from '../shared/contracts.js';

export type GameIntent = 'WORLD_QUERY' | 'WORLD_LOOKUP' | 'UI_NAVIGATION' | 'WORLD_ACTION' | 'UNKNOWN';

const questionWords = /[?？]|多少|几|是什么|什么关系|在哪里|在哪|怎么|如何|有没有|是否|谁|呢$|吗$/;
const lookupWords = /(人物资料|角色资料|资料|档案|详情|面板|界面|页面|记录)/;
const openWords = /(打开|查看|显示|切换|定位|跳转|看一下|看下)/;
const panelWords: Record<string, string> = {
  人物: 'characters', 人物页: 'characters', 关系: 'relationships', 关系页: 'relationships', 背包: 'inventory', 物品: 'inventory',
  地图: 'map', 商店: 'commerce', 属性: 'attributes', 技能: 'skills', 任务: 'quests', 存档: 'saves', 日志: 'logs', 系统: 'system', 生活模式: 'routine', 状态: 'status', 装备: 'equipment',
};

export function classifyGameIntent(text: string): GameIntent {
  const value = text.trim();
  if (!value) return 'UNKNOWN';
  if (openWords.test(value) && (lookupWords.test(value) || Object.keys(panelWords).some(word => value.includes(word)))) return 'UI_NAVIGATION';
  if (questionWords.test(value)) return 'WORLD_QUERY';
  if (lookupWords.test(value)) return 'WORLD_LOOKUP';
  return 'UNKNOWN';
}
function panelFor(text: string) {
  const hit = Object.entries(panelWords).find(([word]) => text.includes(word));
  return hit ? hit[1] : null;
}
// The Game Agent and the character UI read the very same canonical summary (src/shared/relationship.ts).
function relationLine(view: PublicView, target: Entity) {
  return relationshipSummary(view, target).text;
}
function moneyLine(view: PublicView) {
  const balances = (view.entities.find(entity => entity.id === view.player_id)?.components.wallet?.balances ?? {}) as Record<string, number>;
  const entries = Object.entries(balances);
  if (!entries.length) return '这个世界没有为你记录金钱。';
  return `你现在有 ${entries.map(([currency, amount]) => `${amount} ${view.currencies[currency] ?? currency}`).join('、')}。`;
}
/**
 * In-world agent: queries and navigation are read-only. Only a real world action or an explicit
 * "keep living" request advances time, and those keep using the normal turn pipeline.
 */
export function planGameRequest(view: PublicView, text: string): AgentResult | null {
  const intent = classifyGameIntent(text);
  if (intent === 'UNKNOWN') return null;
  const panel = panelFor(text);
  const { matches, confident } = resolveEntities(view, text);
  const target = matches[0] ?? null;
  if (intent === 'UI_NAVIGATION') {
    const actions: UIAction[] = [];
    if (panel) actions.push({ kind: 'open_panel', panel });
    if (target) {
      actions.push({ kind: 'focus_entity', entity_id: target.id, panel: panel ?? 'characters' }, { kind: 'scroll_to_entity', entity_id: target.id }, { kind: 'highlight_entity', entity_id: target.id });
      if (!panel || panel === 'characters') actions.push({ kind: 'open_character_detail', entity_id: target.id });
    }
    if (!actions.length) return null;
    const what = target ? entityLabel(target) : panel === 'status' ? '状态' : '面板';
    return agentResult('UI_NAVIGATION', `已打开${what}${target && panel ? '的相关信息' : ''}。`, { ui_actions: actions });
  }
  if (matches.length > 1) return agentResult(intent, `有几个人物都符合这个名字：${matches.map(entityLabel).join('、')}。请说明是哪一位。`, { clarification: 'which_entity' });
  if (/关系|熟悉|亲近|信任|好感|印象/.test(text)) {
    if (!target) return agentResult(intent, '你想问和谁的关系？可以说出人物名字。', { clarification: 'which_entity', ui_actions: [{ kind: 'open_panel', panel: 'relationships' }] });
    return agentResult(intent, relationLine(view, target), { ui_actions: [
      { kind: 'open_panel', panel: 'relationships' }, { kind: 'focus_entity', entity_id: target.id, panel: 'relationships' },
      { kind: 'scroll_to_entity', entity_id: target.id }, { kind: 'highlight_entity', entity_id: target.id },
    ] });
  }
  if (/多少钱|有多少钱|余额|钱|铜|金/.test(text)) return agentResult(intent, moneyLine(view), { ui_actions: [{ kind: 'open_panel', panel: /背包/.test(text) ? 'inventory' : 'status' }] });
  if (/在哪|位置|地点/.test(text)) {
    const here = String(view.entities.find(entity => entity.id === view.player_id)?.components.location?.location_id ?? '');
    const location = view.locations.find(entry => entry.id === here);
    const near = target ? `；${entityLabel(target)}${String(target.components.location?.location_id ?? '') === here ? '也在附近' : '不在同一地点'}` : '';
    return agentResult(intent, `你当前在${location?.name ?? '一个未登记的位置'}${near}。`, { ui_actions: [{ kind: 'open_panel', panel: 'map' }] });
  }
  if (/背包|物品|带着|身上有/.test(text)) {
    const items = (view.entities.find(entity => entity.id === view.player_id)?.components.inventory?.items ?? {}) as Record<string, number>;
    const names = Object.entries(items).filter(([, count]) => count > 0).map(([id, count]) => `${view.entities.find(entity => entity.id === id)?.components.identity?.name ?? '物品'}×${count}`);
    return agentResult(intent, names.length ? `你带着：${names.join('、')}。` : '你的背包是空的。', { ui_actions: [{ kind: 'open_panel', panel: 'inventory' }] });
  }
  if (/任务|委托|机会/.test(text)) {
    const quests = (view.entities.find(entity => entity.id === view.player_id)?.components.quests?.entries ?? {}) as Record<string, { title?: string; status?: string }>;
    const entries = Object.values(quests).slice(0, 5).map(entry => `${entry.title ?? '任务'}（${entry.status === 'completed' ? '已完成' : entry.status === 'accepted' ? '已接受' : '进行中'}）`);
    return agentResult(intent, entries.length ? `当前任务：${entries.join('、')}。` : '目前没有登记中的任务。', { ui_actions: [{ kind: 'open_panel', panel: 'quests' }] });
  }
  if (/技能|等级|经验/.test(text)) {
    const skills = (view.entities.find(entity => entity.id === view.player_id)?.components.skills?.entries ?? {}) as Record<string, { name?: string; level?: number }>;
    const entries = Object.values(skills).sort((a, b) => Number(b.level ?? 0) - Number(a.level ?? 0)).slice(0, 3).map(entry => `${entry.name ?? '技能'} Lv${entry.level ?? 0}`);
    return agentResult(intent, entries.length ? `最熟练的是：${entries.join('、')}。` : '还没有形成可记录的技能。', { ui_actions: [{ kind: 'open_panel', panel: 'skills' }] });
  }
  if (target && /怎么样|是谁|介绍|了解/.test(text)) {
    const role = String(target.components.character?.role ?? '');
    const described = String(target.components.identity?.description ?? '').replace(/\s+/g, ' ');
    const known = described && !described.startsWith('{') ? ` ${described.slice(0, 120)}` : '';
    return agentResult(intent, `${entityLabel(target)}${role ? `是你的${role}` : ''}。${known || '这方面你目前并不了解。'}`, { ui_actions: [{ kind: 'open_character_detail', entity_id: target.id }] });
  }
  if (target && !confident) return agentResult(intent, '有几个人物都符合这个名字，请说明是哪一位。', { clarification: 'which_entity' });
  if (target) return agentResult(intent, `${entityLabel(target)}目前没有你可以确认的更多信息。`, { ui_actions: [{ kind: 'open_character_detail', entity_id: target.id }] });
  return agentResult(intent, '我没能确认你问的是谁或哪一项，可以换一种说法吗？', { clarification: 'unspecified_subject' });
}

import { agentResult, type AgentResult, type UIAction } from './contracts.js';
import { entityLabel, explicitEntityReference, isSelfReference, resolveEntities, resolveNamedEntity } from './entities.js';
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
function provenanceTerms(value: string) {
  const normalized=value.toLowerCase().replace(/这个世界|世界观|创建时|最初|是不是|是否|有没有|设定|规则|我的|我有|我|什么|具体|内容|是|有|的|了|吗|呢/g,'').replace(/[^\p{L}\p{N}]/gu,'');
  const terms=new Set<string>();for(let size=2;size<=Math.min(4,normalized.length);size++)for(let i=0;i+size<=normalized.length;i++)terms.add(normalized.slice(i,i+size));return terms;
}
function relatedStatement(query:string,statement:string){
  const q=provenanceTerms(query),s=provenanceTerms(statement);if(!q.size||!s.size)return false;
  let overlap=0;for(const term of q)if(s.has(term))overlap++;return overlap>=Math.min(2,Math.max(1,Math.floor(Math.min(q.size,s.size)*.25)));
}
function provenanceAnswer(view:PublicView,text:string){
  const settingQuestion=/(世界|创建|最初).{0,12}(设定|规则|前提|要求)|设定.{0,12}(是否|是不是|有没有|吗)/.test(text);
  const detailQuestion=/(我的|我有|玩家角色).{0,30}(是什么|有哪些|多少|具体|内容|谁|哪)/.test(text);
  if(!settingQuestion&&!detailQuestion)return null;
  const provenance=view.world_provenance;
  if(!provenance)return {message:'这个旧存档没有记录创建来源，因此无法确认这是否是创建时声明的前提。',status:'UNKNOWN' as const};
  const records=provenance.records.filter(record=>['premise','rule','theme','constraint','trait'].includes(record.kind));
  const matched=records.find(record=>relatedStatement(text,record.statement))??(settingQuestion&&records.length===1?records[0]:null);
  if(!matched)return {message:'创建记录里没有找到与这个问题对应的声明。',status:'NOT_FOUND' as const};
  const source={PLAYER_DECLARED:'玩家创建时声明',TEMPLATE_DECLARED:'模板声明',AI_GENERATED:'创建流程生成',CANONICAL_INSTANTIATED:'已实例化为世界事实',DERIVED:'由现有事实推导',UNKNOWN:'来源未记录'}[matched.source];
  if(detailQuestion){
    const fact=provenance.records.find(record=>record.kind==='fact'&&record.fact_ref&&relatedStatement(text,record.statement));
    return fact?{message:`已保存的具体事实是：${fact.statement}`,status:'FOUND' as const}:{message:`这个世界确实记录了「${matched.statement}」这一创建前提（${source}），但当前存档还没有保存与你问题对应的具体事实。`,status:'NOT_DEFINED' as const};
  }
  return {message:`有。创建记录中的相关内容是「${matched.statement}」（${source}）。`,status:'FOUND' as const};
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
  const explicitReference=explicitEntityReference(text);
  let target = explicitReference?resolveNamedEntity(view,explicitReference):matches[0]??null;
  const provenance=provenanceAnswer(view,text);if(provenance)return agentResult(intent,provenance.message,{awareness_status:provenance.status});
  if(explicitReference&&!isSelfReference(explicitReference)&&!target)return agentResult(intent,`没有找到名为「${explicitReference}」的人物。`,{awareness_status:'NOT_FOUND'});
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
  if (/几点|时间|第几天|现在.*时候/.test(text))return agentResult(intent,`现在是第 ${view.time.day} 天 ${String(Math.floor(view.time.minute/60)).padStart(2,'0')}:${String(view.time.minute%60).padStart(2,'0')}。`,{awareness_status:'FOUND'});
  if (/我(是|叫)谁|我叫什么|我的名字|我是什么身份|我是哪个角色/.test(text)) {
    const player = view.entities.find(entity => entity.id === view.player_id);
    const name = String(player?.components.identity?.name ?? '你');
    const role = String(player?.components.character?.role ?? '');
    const here = String(player?.components.location?.location_id ?? '');
    const place = view.locations.find(entry => entry.id === here)?.name;
    return agentResult(intent, `你是${name}。${role ? `目前在${place ?? '这里'}担任${role}。` : place ? `目前在${place}。` : ''}`, { ui_actions: [{ kind: 'open_panel', panel: 'status' }] });
  }
  if (/在哪|位置|地点|这里是什么地方|这是什么地方/.test(text)) {

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
  if (/全身图|全身立绘|头像/.test(text)&&/(有|有没有|是否|存在|已经)/.test(text)){
    const entity=target??view.entities.find(item=>item.id===view.player_id),visuals=entity?.components.visual_assets as {images?:Record<string,string>}|undefined;
    const asksFullbody=/全身图|全身立绘/.test(text),exists=asksFullbody?Boolean(visuals?.images?.fullbody):Boolean(entity?.components.identity?.avatar_id);
    return agentResult(intent,`${entity?entityLabel(entity):'该人物'}${exists?'已有':'还没有'}${asksFullbody?'全身立绘':'头像'}。`,{awareness_status:'FOUND'});
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

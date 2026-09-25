import { moduleCatalog } from './catalog.js';

// Deterministic natural-language module management. The AI intent interpreter can also choose
// ENABLE_MODULE / DISABLE_MODULE / REMOVE_MODULE; this mapping keeps the common phrasing working offline.
const aliases: Record<string, string[]> = {
  map: ['地图', '地点系统', '移动系统'],
  inventory: ['背包', '物品栏', '物品系统'],
  commerce: ['商店', '交易系统', '经济系统'],
  equipment: ['装备', '装备系统'],
  quests: ['任务系统', '任务栏', '任务'],
  routine: ['生活模式', '生活计划', '日常安排'],
  attributes: ['属性系统', '属性'],
  aptitudes: ['资质'],
  skills: ['技能'],
  traits: ['特质'],
  relationships: ['关系系统', '人际关系', '关系'],
  characters: ['人物系统', '角色系统'],
};
export interface ModuleIntent {
  type: 'ENABLE_MODULE' | 'DISABLE_MODULE' | 'REMOVE_MODULE';
  module: string;
  confirmed: boolean;
  label: string;
}
export function moduleIntent(input: string): ModuleIntent | null {
  const text = input.trim();
  if (!text || text.length > 160) return null;
  const moduleId = Object.entries(aliases).find(([, words]) => words.some(word => text.includes(word)))?.[0];
  if (!moduleId || !moduleCatalog().some(module => module.id === moduleId)) return null;
  const confirmed = /^(确认|确定|执行|好的|可以|同意|直接)/.test(text) || /(确认|确定)(启用|停用|关闭|移除|删除|加|加入)/.test(text);
  const remove = /((彻底|永久|完全)\s*(移除|删除))|(移除|删除)(该|这个)?(模块|系统|玩法)/.test(text);
  const disableWords = /(不需要|不用|关闭|停用|禁用|隐藏|不要)/.test(text);
  const enableWords = /(加|增加|添加|加入|启用|开启|开启|想要|需要|恢复|重新启用)/.test(text);
  const type: ModuleIntent['type'] = remove ? 'REMOVE_MODULE' : disableWords && !enableWords ? 'DISABLE_MODULE' : enableWords && !disableWords ? 'ENABLE_MODULE' : disableWords ? 'DISABLE_MODULE' : 'ENABLE_MODULE';
  const verb = type === 'ENABLE_MODULE' ? '启用' : type === 'DISABLE_MODULE' ? '停用' : '移除';
  return { type, module: moduleId, confirmed, label: `${verb}模块 ${moduleId}` };
}

/**
 * Creation intent for a new world.
 *
 * EMPTY_WORLD / FRAMEWORK_TEST are *semantic* intents, not phrases: any request that asks for a
 * structure-only world used to check the framework must take the deterministic blank path and must
 * never reach the authoring model. The classifier is feature based (blank lexemes + purpose lexemes,
 * minus any positive world-content request), so it is not a list of fixed sentences.
 */
export type WorldCreationIntent = 'EMPTY_WORLD' | 'FRAMEWORK_TEST' | 'AUTHORED_WORLD';

const explicitEmpty = /\bEMPTY[_\s-]?WORLD\b/i;
const explicitTest = /\bFRAMEWORK[_\s-]?TEST\b/i;
/** Anything that asks for "no content": 空白 / 空的 / 不需要内容 / 不要生成 / 无设定 … */
const blankIntent = /(空白|空世界|空的世界|空的|纯空|无内容|没有内容|不放内容|不需要内容|不用内容|不要内容|不需要任何内容|不要具体|不需要具体|不要生成|不用生成|不需要生成|不用输出|不需要输出|不要输出|无需生成|不写内容|最小(世界|结构|集合)|只(要|需)?框架|placeholder|blank|empty shell|skeleton)/i;
/** Purpose: the world exists to check/test the framework itself. */
const testPurpose = /(检测框架|检查框架|测试框架|框架(自检|测试|检查|验收)|自检|冒烟|smoke ?test|acceptance test|回归测试|测试用)/i;
/** Positive world content: if the player actually asked for content, it is not a blank world. */
const worldContent = /(人物|角色|npc|主角|剧情|故事|情节|地点|地图|场景|房间|商店|交易|货币|任务|委托|世界观|设定|背景|城市|小镇|村庄|学校|学院|冒险|幻想|科幻|现代|恋爱|经营|生存|city|town|village|school|story|quest)/i;
const contentNegated = /(不需要|不用|不要|不放|别放|不含|不出现|排除|没有|无|别|禁止|不用管|无需)[^。！？!?]{0,8}(人物|角色|剧情|故事|地点|地图|商店|任务|货币|世界观|设定|内容|任何东西|东西)/;

export function blankWorldIntent(description: string): 'EMPTY_WORLD' | 'FRAMEWORK_TEST' | null {
  const text = String(description ?? '').trim();
  if (!text) return null;
  if (explicitTest.test(text)) return 'FRAMEWORK_TEST';
  if (explicitEmpty.test(text)) return 'EMPTY_WORLD';
  if (!blankIntent.test(text)) return null;
  // "空白世界，不需要剧情" keeps the blank intent; "空白世界里有学校" is asking for content.
  if (worldContent.test(text) && !contentNegated.test(text)) return null;
  return testPurpose.test(text) ? 'FRAMEWORK_TEST' : 'EMPTY_WORLD';
}
export function worldCreationIntent(description: string): WorldCreationIntent {
  return blankWorldIntent(description) ?? 'AUTHORED_WORLD';
}
/** Backwards compatible helper used by the client to enable/disable the create button. */
export function isEmptyWorld(description: string) {
  return blankWorldIntent(description) !== null;
}

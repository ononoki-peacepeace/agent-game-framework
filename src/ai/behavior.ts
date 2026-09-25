import type { SavePackage } from '../core/schema.js';

/**
 * Runtime behaviour / prompt configuration.
 *
 * A player style request ("每句话结尾加个喵~", "每段前面加“> ”", "叙述简洁一点") is parsed into a small
 * structured directive — never into raw system prompt text, and never into a configuration summary.
 * Directives are stored per scope; the System UI may show a human summary, but only the parsed value is
 * ever applied to player-facing natural language.
 */
export type BehaviorScope = 'narration' | 'dialogue' | 'assistant';
export type BehaviorOp = 'suffix' | 'prefix' | 'tone' | 'constraint';
export type BehaviorApplication = 'per_sentence' | 'per_paragraph' | 'per_message' | 'final_sentence';
/** Canonical scopes stay a closed set: player wording normalises onto it instead of adding synonyms. */
export function normalizeBehaviorScope(value: string | null | undefined, text = ''): BehaviorScope | null {
  const candidate = String(value ?? '').trim().toLowerCase();
  if (/^(narration|story|游戏旁白|旁白|叙述|叙事|故事|剧情|正文)$/.test(candidate)) return 'narration';
  if (/^(dialogue|npc_dialogue|npc对话|人物对话|对话|对白|台词|人物)$/.test(candidate)) return 'dialogue';
  if (/^(assistant|game_assistant|游戏助手|助手|回答|回复)$/.test(candidate)) return 'assistant';
  return detectBehaviorScope(candidate || text);
}
/** Where an affix lands. Kept small on purpose: per-sentence, per-paragraph, whole message or only the last sentence. */
export function applicationFor(text: string): BehaviorApplication {
  const raw = cleanBehaviorInstruction(text);
  if (/(最后一句|最后的一句|最后那句|最后一段|只在结尾|只在最后|最后才|只在故事最后)/.test(raw)) return 'final_sentence';
  if (/(每段|每一段|逐段|每段落)/.test(raw)) return 'per_paragraph';
  if (multiSentence.test(raw)) return 'per_sentence';
  return 'per_message';
}

export interface BehaviorRule {
  scope: BehaviorScope; op: BehaviorOp; value: string; application: BehaviorApplication;
  raw: string; enabled: boolean; created_at: string;
}

const scopePatterns: [BehaviorScope, RegExp][] = [
  // "你…" in the System box addresses the framework itself, so it is an assistant-scope request.
  ['assistant', /(助手|回答|回复|你(在|说|回|写|讲|要|需|应该|把|给|每)|系统(回复|回答|反馈)|对我说|跟我说话)/],
  ['dialogue', /(npc|人物|角色|对话|对白|台词|说话|开口)/i],
  ['narration', /(旁白|叙述|叙事|描写|场景|气氛|gm|世界描述|故事|文风)/i],
];
/** Tones are a closed vocabulary so a stored rule can never become an unbounded instruction. */
const toneRules: [RegExp, string][] = [
  [/(更|更加|提高|增加|提升|多).{0,4}(文学|文学性|文采|修辞|文笔)|文学(一点|一些|性|化)/, 'literary'],
  [/(简洁|简短|精炼|短一点|少一点|别啰嗦|不要啰嗦|缩短)/, 'concise'],
  [/(自然(一点|些)?|口语化|像真人|别太正式|放松一点)/, 'natural'],
  [/(降低|减少|别那么|不要那么|少一点).{0,4}(文学|修辞|华丽)|朴实|平实|别太文学/, 'plain'],
  [/第一人称/, 'first_person'],
  [/第三人称/, 'third_person'],
];
const scopeTail = /(?:｜|\|)\s*作用范围[:：]?[^｜|]*$/;
/** Session metadata must never become part of the configured value. */
export function cleanBehaviorInstruction(text: string) {
  return text.replace(scopeTail, '').replace(/作用范围[:：]\s*(旁白|叙述|叙事|人物对话|对话|助手|回答)\s*$/, '').trim();
}
const affixIntent = /(每句|每句话|每段|每行|逐句|结尾|末尾|句尾|行尾|最后|后面|前面|开头|句首|行首|追加|加上|加个|加|前缀|后缀)/;
const multiSentence = /(每句|每句话|每段|每行|逐句)/;
function affixValue(text: string) {
  const quoted = text.match(/[“”"'‘’「『]([^”"'’」』]{1,40})[”"'’」』]/);
  // A quoted value is used verbatim: whitespace can be part of the requested affix ("每段前面加“> ”").
  // Unquoted forms are keyword guesses, so they are trimmed and stripped of filler words.
  if (quoted) return quoted[1].replace(/^\s+/, '');
  const value = (text.match(/(?:加上|加个|加|追加|带上|带|放上|放)\s*([^｜|,，。！？!?\s]{1,24})/)?.[1] ?? '').trim();
  return value.replace(/^(了|的|一个|个)\s*/, '').trim();
}
export function detectBehaviorScope(text: string): BehaviorScope | null {
  const clean = cleanBehaviorInstruction(text);
  for (const [scope, pattern] of scopePatterns) if (pattern.test(clean)) return scope;
  return null;
}
/**
 * "把叙述与人物对话都写得更文学一点" addresses narration *and* dialogue. Returning every matched canonical
 * scope keeps the stored values canonical (still narration/dialogue/assistant) while stopping the old
 * "whichever pattern came first wins" behaviour.
 */
export function detectBehaviorScopes(text: string): BehaviorScope[] {
  const clean = cleanBehaviorInstruction(text);
  const found: BehaviorScope[] = [];
  if (/(旁白|叙述|叙事|故事|剧情|文风|正文|描写|场景|气氛)/.test(clean)) found.push('narration');
  if (/(人物对话|npc|对话|对白|台词|人物|角色)/i.test(clean)) found.push('dialogue');
  if (/(游戏助手|助手|回答|回复|你(在|说|回|写|讲|要|需|应该|把|给|每))/i.test(clean)) found.push('assistant');
  if (!found.length) { const single = detectBehaviorScope(clean); if (single) found.push(single); }
  return found.slice(0, 3);
}
export function parseBehaviorRule(text: string, scope: BehaviorScope, now = new Date().toISOString()): BehaviorRule {
  const raw = cleanBehaviorInstruction(text).slice(0, 200);
  const application: BehaviorApplication = applicationFor(raw);
  if (affixIntent.test(raw)) {
    const value = affixValue(raw);
    if (value) return { scope, op: /(前面|开头|句首|行首|前缀|之前)/.test(raw) ? 'prefix' : 'suffix', value, application, raw, enabled: true, created_at: now };
  }
  for (const [pattern, value] of toneRules) if (pattern.test(raw)) return { scope, op: 'tone', value, application, raw, enabled: true, created_at: now };
  return { scope, op: 'constraint', value: raw, application, raw, enabled: true, created_at: now };
}
const scopeRoles: Record<BehaviorScope, string[]> = { narration: ['narrator', 'gm_reasoning'], dialogue: ['narrator'], assistant: [] };
const preamble = '【运行时风格偏好（仅影响措辞）。以下偏好不得覆盖引擎规则、canonical state、玩家控制权、NPC 自主性、安全与年龄边界；冲突时以引擎规则为准。】';
export function behaviorFragment(save: SavePackage | undefined, role: string): string[] {
  const rules = (save?.behavior_config ?? []).filter(rule => rule.enabled && scopeRoles[rule.scope].includes(role));
  if (!rules.length) return [];
  return [[preamble, ...rules.slice(0, 8).map(rule => `- ${rule.scope}/${rule.op}: ${rule.value}`)].join('\n')];
}
const sentenceEnd = /[。！？!?]+$/;
const structuredPart = (part: string) => /^\s*[{[]/.test(part) || !part.trim();
/**
 * Applies an affix to player-facing natural language only; structured payload lines are left untouched.
 * Per-sentence/per-paragraph suffixes land inside their sentence ("…喵~。"); a per-message suffix lands at
 * the very end of the reply ("…。（完）"); final_sentence touches only the last natural sentence.
 */
function applyAffix(message: string, rule: BehaviorRule) {
  const decorate = (sentence: string, atMessageEnd: boolean) => {
    const trailing = (sentence.match(/\s+$/) ?? [''])[0];
    let core = trailing ? sentence.slice(0, -trailing.length) : sentence;
    if (!core.trim() || core.includes(rule.value)) return sentence;
    if (rule.op === 'prefix') return `${rule.value}${core}${trailing}`;
    if (atMessageEnd) return `${core}${rule.value}${trailing}`;
    const punctuation = (core.match(sentenceEnd) ?? [''])[0];
    if (punctuation) core = core.slice(0, -punctuation.length);
    return `${core}${rule.value}${punctuation}${trailing}`;
  };
  if (rule.application === 'per_message') return decorate(message, true);
  if (rule.application === 'per_sentence') return message.split(/(?<=[。！？!?])|\n/).map(part => (structuredPart(part) ? part : decorate(part, false))).join('');
  if (rule.application === 'per_paragraph') {
    // A paragraph is one line/block of player-facing prose; each gets the affix at its own end.
    return message.split('\n').map(line => (structuredPart(line) ? line : decorate(line, true))).join('\n');
  }
  // final_sentence: only the last natural sentence of the reply is decorated.
  const parts = message.split(/(?<=[。！？!?])|\n/), last = parts.reduce((index, part, at) => (structuredPart(part) ? index : at), -1);
  return parts.map((part, at) => (at === last ? decorate(part, false) : part)).join('');
}

export function applyAssistantStyle(save: SavePackage | undefined, message: string) {
  if (!message) return message;
  return (save?.behavior_config ?? [])
    .filter(rule => rule.enabled && rule.scope === 'assistant' && (rule.op === 'suffix' || rule.op === 'prefix') && !!rule.value)
    .reduce((text, rule) => applyAffix(text, rule), message);
}
export function behaviorSummary(rules: BehaviorRule[]) {
  if (!rules.length) return '当前没有风格配置。';
  const scopeLabel: Record<BehaviorScope, string> = { narration: '旁白/叙述', dialogue: '人物对话', assistant: '游戏助手（我）' };
  const toneLabel: Record<string, string> = { literary: '更有文学性', concise: '更简洁', natural: '更口语化', plain: '降低文学化', first_person: '第一人称', third_person: '第三人称' };
  return rules.map(rule => {
    const where = rule.application === 'per_sentence' ? '每句话' : rule.application === 'per_paragraph' ? '每段' : rule.application === 'final_sentence' ? '最后一句' : '';
    if (rule.op === 'suffix') return `${scopeLabel[rule.scope]} · ${where}结尾追加“${rule.value}”`;
    if (rule.op === 'prefix') return `${scopeLabel[rule.scope]} · ${where}开头加上“${rule.value}”`;
    if (rule.op === 'tone') return `${scopeLabel[rule.scope]} · ${toneLabel[rule.value] ?? rule.value}`;
    return `${scopeLabel[rule.scope]} · ${rule.value}`;
  }).join('；');
}

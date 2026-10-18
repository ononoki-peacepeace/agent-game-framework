import { z } from 'zod';
import type { PublicView } from '../shared/contracts.js';
import type { SavePackage } from '../core/schema.js';
import type { GameService } from '../server/service.js';
import { resolveEntities } from '../agent/entities.js';
import { moduleFromText } from './router.js';
import { toolAvailability } from './tools.js';
import { behaviorSummary, cleanBehaviorInstruction, detectBehaviorScope, normalizeBehaviorScope } from '../ai/behavior.js';
import { classifyFrameworkChange } from '../change/classifier.js';
import {capabilityRegistry,type CapabilityRegistry} from './capabilities.js';
import {openGoalControlSchema} from '../agent/plan-schema.js';

/**
 * System Agent understanding layer.
 *
 * The model does the reading: requirement extraction, partial understanding, entity proposals, precise
 * clarification wording. The program does the bookkeeping: real capabilities, canonical state, tools,
 * transactions and persistence. This module only *reads*; it never mutates the save.
 */
export const surfaceValues = ['character_page','status_page','map','relationships_panel','story_text','system_reply','inventory','quests','open_goals','other'] as const;
export const workflowValues = ['behavior_config','module_management','media_asset','development_task','diagnostic','feedback','capability_question','correction','goal_management','unclear'] as const;
export const understandingScopeValues = ['narration','dialogue','assistant'] as const;
export const understandingApplicationValues = ['per_sentence','per_paragraph','per_message','final_sentence'] as const;

export const systemUnderstandingSchema = z.strictObject({
  understood: z.array(z.string().max(300)).max(6),
  requested_change: z.string().max(600).nullable(),
  target_surfaces: z.array(z.enum(surfaceValues)).max(6).default([]),
  unresolved: z.array(z.strictObject({ field: z.string().max(60), why: z.string().max(300) })).max(4).default([]),
  entities: z.array(z.string().max(80)).max(4).default([]),
  likely_workflow: z.enum(workflowValues),
  goal_control:openGoalControlSchema.nullish(),
  style_target:z.enum(['world','character']).nullable().default(null),
  configuration_kind:z.enum(['style','topic','behavior_patch','character_persona']).nullable().default(null),
  side_effect_class: z.enum(['none','configuration','canonical','development']).default('none'),
  confidence: z.number().min(0).max(1).default(0.5),
  correction: z.strictObject({
    scope: z.enum(understandingScopeValues).nullable().default(null),
    application: z.enum(understandingApplicationValues).nullable().default(null),
    value: z.string().max(120).nullable().default(null),
    remove: z.boolean().default(false),
  }).nullable().default(null),
  clarification: z.strictObject({ needed: z.boolean(), question: z.string().max(600), examples: z.array(z.string().max(120)).max(4).default([]) }).nullable().default(null),
  response_hint: z.string().max(400).nullable().default(null),
  narrative_preference: z.strictObject({
    scopes:z.array(z.enum(['narration','dialogue','assistant'])).max(3),
    tone:z.enum(['literary','concise','natural','plain','first_person','third_person','mature']).nullable(),
    mode:z.enum(['allow','require','exclude']).nullable(),
    topics:z.array(z.enum(['violence','crime','romance','adult_intimacy','substance_use','politics','trauma'])).max(7),
  }).nullable().default(null),
});
export type SystemUnderstanding = z.infer<typeof systemUnderstandingSchema>;
export type SystemWorkflow = (typeof workflowValues)[number];
export type SystemSurface = (typeof surfaceValues)[number];

export interface ResolvedSystemRequest {
  workflow: SystemWorkflow; at: string; summary: string;
  scope: (typeof understandingScopeValues)[number] | null;
  application: (typeof understandingApplicationValues)[number] | null;
  op: 'suffix' | 'prefix' | 'tone' | 'constraint' | null;
  value: string | null; module: string | null; entity_id: string | null;
}
/** A clarification answer the session can merge on its own. Only the field that was missing is carried. */
export interface ClarificationMerge {
  field: string; scope?: (typeof understandingScopeValues)[number] | null;
  application?: (typeof understandingApplicationValues)[number] | null;
  surfaces?: SystemSurface[]; module?: string | null; entities?: string[];
}

const surfaceWords: [string, SystemSurface][] = [
  ['人物状态', 'character_page'], ['人物页', 'character_page'], ['人物卡', 'character_page'], ['人物详情', 'character_page'], ['角色页', 'character_page'], ['角色卡', 'character_page'],
  ['状态页', 'status_page'], ['属性页', 'status_page'], ['状态栏', 'status_page'],
  ['地图', 'map'], ['关系页', 'relationships_panel'], ['关系面板', 'relationships_panel'],
  ['故事正文', 'story_text'], ['正文', 'story_text'], ['旁白', 'story_text'],
  ['背包', 'inventory'], ['任务页', 'quests'], ['任务面板', 'quests'], ['系统回复', 'system_reply'],
];
/** Player wording maps onto the closed canonical scope set; no second set of persisted names. */
export function scopeInText(text: string) {
  if (/旁白|叙述|叙事|故事|剧情|正文/.test(text)) return 'narration' as const;
  if (/人物对话|npc|对白|台词|人物说/.test(text)) return 'dialogue' as const;
  if (/游戏助手|助手|系统回复|你的回答/.test(text)) return 'assistant' as const;
  return normalizeBehaviorScope(detectBehaviorScope(text));
}
export function surfacesIn(text: string) {
  const found: SystemSurface[] = [];
  for (const [word, value] of surfaceWords) if (text.includes(word) && !found.includes(value)) found.push(value);
  if (!found.includes('status_page') && /状态/.test(text) && /人物|地图/.test(text)) found.push('status_page');
  return found.slice(0, 6);
}
/**
 * Requirement extraction that works without a provider. It is intentionally a lexicon, not a
 * sentence-by-sentence special case: it fills the same structured result the model produces.
 */
export function shallowUnderstanding(text: string, view: PublicView): SystemUnderstanding {
  const clean = cleanBehaviorInstruction(text);
  const narrativePreference=shallowNarrativePreference(clean);
  const entities = resolveEntities(view, text).matches.slice(0, 4).map(entity => String(entity.components.identity?.name ?? entity.id));
  const surfaces = surfacesIn(clean);
  const relationshipWords = /(好感|关系|亲密度|信任|熟悉度)/.test(clean);
  const uiChange = surfaces.length > 0 && /(加上|加上去|增加|新增|显示|展示|放上|放到|呈现|改成|改一下|修改|换成|做个)/.test(clean);
  const styleLike = /(文风|风格|语气|口吻|旁白|叙述|叙事|描写|每句|每段|结尾|最后一句|简洁|简短|啰嗦|口语|文学|修辞|第一人称|第三人称|心理)/.test(clean);
  const moduleId = moduleFromText(clean);
  const media = /(头像|立绘|全身图|人物图|图片|照片|插画)/.test(clean) && /(生成|画|绘制|制作|做一张|来一张|补一张|换|替换|调整|裁|重裁|重新裁|修改|做)/.test(clean);
  const changeClassification = classifyFrameworkChange(clean);
  // "你现在能开发新功能吗？" asks about live capability; it is not a wish to develop something. A real provider
  // would otherwise file it as a development task and the honest, state-derived capability answer is lost.
  const asksForDevelopmentCapability = !/(帮我|给我|替我|我想|想要|希望|请).{0,10}(开发|新增|增加|添加|扩展|实现|做|修改)/.test(clean)
    && (/(能(不能)?|可以(不可以)?|能否|是否|会).{0,12}(开发|新增|增加|添加|扩展|实现|做|支持|修改|处理).{0,10}(功能|玩法|模块|系统|能力|扩展|框架|核心|存档|界面|面板|内容)/.test(clean)
      || /(你|你们|框架|系统|助手).{0,6}(能|可以|会).{0,8}(做什么|干什么|开发|支持|实现)/.test(clean));
  const development = Boolean(changeClassification && changeClassification.level >= 2) && !asksForDevelopmentCapability;
  const diagnostic = /(日志|报错|出错|打不开|点了没有反应|卡住|异常|bug)/i.test(clean);
  const feedback = /(界面|按钮|布局|排版|太挤|难看|不直观|建议|反馈|吐槽)/.test(clean);
  const question = /(有哪些|为什么|怎么回事|是不是|有没有|清单|列表|能做什么|有什么能力|介绍.{0,8}(能力|功能))/.test(clean) || asksForDevelopmentCapability;
  // "把地图上的人物卡加上好感度" mentions a module word but is a UI change; a module intent needs a real module verb.
  const moduleVerb = /(启用|开启|打开|恢复|重新启用|需要|加入|不需要|不用|关闭|停用|禁用|隐藏|移除|删除|不要)/.test(clean);
  const likely: SystemWorkflow = media ? 'media_asset' : narrativePreference||styleLike ? 'behavior_config' : uiChange || development ? 'development_task'
    : moduleId && moduleVerb ? 'module_management' : diagnostic ? 'diagnostic' : feedback ? 'feedback' : question ? 'capability_question' : 'unclear';
  const understood: string[] = [];
  if (media) understood.push(/(裁|调整)/.test(clean) ? '你希望调整人物的图片/头像' : '你希望为人物的图片/头像生成或替换资源');
  if (styleLike) understood.push('你希望调整故事或回答的写法');
  if (uiChange) understood.push('你希望修改游戏界面的展示内容');
  if (relationshipWords && (uiChange || development)) understood.push('涉及人物关系数据');
  if (moduleId) understood.push('你希望启用或停用某个游戏系统');
  if (development) understood.push('你希望增加一个当前框架还没有的玩法');
  if (diagnostic) understood.push('你遇到了疑似故障或想查看运行日志');
  if (feedback) understood.push('你想反馈界面或交互体验');
  if (!understood.length) understood.push(...(clean ? [`你的请求是「${clean.slice(0, 60)}」`] : []));
  const unresolved: { field: string; why: string }[] = [];
  const examples: string[] = [];
  if (likely === 'media_asset' && !entities.length && !/我自己|自己|我的头像/.test(clean)) {
    unresolved.push({ field: '人物', why: '不同人物的外观资料不同，需要先确定是谁' });
    examples.push('给伊芙琳生成头像', '给我自己换头像');
  }
  if (likely === 'development_task' && surfaces.length > 1) {
    unresolved.push({ field: '展示位置', why: '这几个位置是不同的界面，需要知道要改哪一个（或者都要）' });
    examples.push('只放人物页', '地图和人物页都放', '只改状态页');
  }
  if (likely === 'module_management' && !moduleId) {
    unresolved.push({ field: '要调整的系统', why: '启用或停用只作用于一个具体系统' });
    examples.push('关闭生活模式', '启用地图');
  }
  if (likely === 'behavior_config' && !narrativePreference && !scopeInText(clean) && detectBehaviorScope(clean) === null) {
    unresolved.push({ field: '作用范围', why: '同一句话加在旁白、人物对话还是游戏助手上，效果完全不同' });
    examples.push('旁白', '人物对话', '助手');
  }
  if (likely === 'unclear') {
    unresolved.push({ field: '具体目标', why: '我还看不出你想改的是界面、玩法、风格还是某个人物的资料' });
    examples.push('人物页显示好感度', '关闭生活模式', '故事写得更有文学性一点');
  }
  const clarification = unresolved.length
    ? { needed: true, question: `还缺一项信息：${unresolved[0].field}。`, examples }
    : { needed: false, question: '', examples: [] };
  return {
    understood: understood.slice(0, 6), requested_change: clean.slice(0, 600) || null, target_surfaces: surfaces, unresolved, entities,
    likely_workflow: likely, style_target:null, configuration_kind:null, side_effect_class: likely === 'development_task' ? 'development' : likely === 'media_asset' || likely === 'behavior_config' || likely === 'module_management' ? 'configuration' : 'none',
    confidence: likely === 'unclear' ? 0.2 : 0.35, correction: null, clarification, response_hint: null,
    narrative_preference:narrativePreference,
  };
}
function shallowNarrativePreference(text:string):SystemUnderstanding['narrative_preference']{
  if(/[?？]$|是否|能不能|可不可以/.test(text))return null;
  const configuring=/(设置|配置|调整|放宽|收紧|改成|改为|要求|希望|请|允许|接受|容许|可以出现|可涉及|不必回避|不限制)/.test(text);
  if(!configuring)return null;
  const topicPatterns=[['violence',/暴力|血腥|打斗/],['crime',/犯罪|违法|黑帮/],
    ['romance',/恋爱|爱情|感情关系/],['adult_intimacy',/成年.{0,8}(性关系|亲密关系|性行为)|成人.{0,8}(性关系|亲密关系)|性关系/],
    ['substance_use',/药物滥用|酗酒|毒品/],['politics',/政治|权力斗争/],['trauma',/创伤|心理创伤/]] as const;
  const topics=topicPatterns.filter(([,pattern])=>pattern.test(text)).map(([topic])=>topic);
  const mature=/(成人向|成熟题材|成熟风格|成熟叙事|更成熟|nsfw)/i.test(text);
  const style=/(语言|文风|风格|语气|口吻|旁白|叙述|对话|描写)/.test(text);
  const world=/(世界|题材|内容|尺度|范围|情节|出现|涉及)/.test(text);
  if(!((style&&mature)||(world&&topics.length)))return null;
  const scopes:('narration'|'dialogue'|'assistant')[]=style&&mature?
    [...(/叙事|叙述|旁白|文风|语言|风格|描写/.test(text)?['narration' as const]:[]),
      ...(/对话|对白|台词|语言风格/.test(text)?['dialogue' as const]:[])]:[];
  const mode=topics.length?(/必须出现|每回合|强制|一定要/.test(text)?'require':/禁止|不得出现|不要出现/.test(text)?'exclude':'allow'):null;
  return {scopes:scopes.length?scopes:style&&mature?['narration']:[],tone:style&&mature?'mature':null,mode,topics};
}
/** Canonical truths the System Agent may consult before asking the player anything. */
export function capabilityDigest(view: PublicView, save: SavePackage,registry:CapabilityRegistry=capabilityRegistry) {
  return {
    world: { title: view.title, modules: view.modules.filter(module => module.enabled).map(module => module.id), panels: view.panels.map(panel => panel.id), time: view.time, calendar: view.calendar??null, time_label: view.time_label??null, scheduled_tasks: view.scheduled_tasks??[] },
    characters: view.entities.filter(entity => entity.components.character).slice(0, 40).map(entity => String(entity.components.identity?.name ?? entity.id)),
    relationship_dimensions: Object.keys(save.definition.ruleset.relationship_dimensions),
    installed_extensions: Object.entries(save.extensions ?? {}).map(([id, entry]) => ({ id, name: String((entry.manifest as { name?: string }).name ?? id), version: entry.version, enabled: entry.enabled })),
    style_rules: behaviorSummary(save.behavior_config ?? []),
    executable_capabilities:registry.digest(view.capabilities),
    open_goals:[...(save.active_goal?[{scope:'current',plan:save.active_goal.plan}]:[]),
      ...(save.paused_goals??[]).map(item=>({scope:'paused',plan:item.plan}))].map(({scope,plan})=>({scope,id:plan.plan_id,status:plan.status})),
    tools: toolAvailability(view.capabilities).map(tool => ({ id: tool.tool_id, name: tool.name, available: tool.available, side_effect: tool.side_effect_level, requires: tool.required_capabilities })),
  };
}
export function mediaCapabilityNote(save: SavePackage) {
  const dimensions = Object.keys(save.definition.ruleset.relationship_dimensions);
  return dimensions.length
    ? `框架已提供人物关系数据（${dimensions.join('、')}），应优先复用现有数据展示，不要新建第二套系统。`
    : '这个存档还没有人物关系维度数据。';
}
const instruction = [
  '你是游戏框架的 System Agent 的理解层。你只负责读懂玩家对游戏本身（不是角色行动）的要求，并输出结构化理解。',
  '你必须做需求提取：玩家已经表达清楚的部分写进 understood，requested_change 用一句话重述目标。',
  '只能使用 capability_digest 里真实存在的模块、面板、关系维度、扩展与工具；不要假设框架具备没有列出的能力。',
  '如果 capability_digest 里已经有现成数据（例如人物关系维度），要求在 understood 里体现“复用已有数据”，不要建议建立第二套。',
  '只有当缺失的信息真的会改变结果时才 clarification.needed=true；只问缺失的那一项，并在 examples 里给出玩家可以直接回复的短句。',
  '不要为了走流程而澄清：信息足够时 clarification.needed=false。',
  '如果玩家是在修正上一条想法的范围（例如“不是游戏助手，是故事的最后一句”），likely_workflow=correction，并填写 correction（scope 用 narration/dialogue/assistant，application 用 per_sentence/per_paragraph/per_message/final_sentence）。',
  '范围必须归一到 canonical 值：故事/剧情/旁白→narration，人物对话/NPC 对话→dialogue，游戏助手/助手→assistant。不要发明新的 scope 名字。',
  'style_target 单独判断配置对象：对整个世界的叙事或所有人物对白的共同表达原则填 world；只有请求修改一位明确人物自己的性格、说话方式或口癖时填 character。全局对白原则不能抹去每位人物的性格与自主性；world 配置不要索要人物名字。与风格无关时填 null。',
  'configuration_kind 区分现有配置职责：style 是旁白或对白的整体语气、成熟度等表达风格；topic 是允许出现的世界题材边界；behavior_patch 是要求 AI 未来如何理解、规划、生成或避免重复模板的行为原则；character_persona 只修改明确人物自己的说话方式或性格。若一条请求同时有 style 与 topic，可填 style 并在 narrative_preference 分别给 tone/scopes 与 mode/topics。不要把题材许可或整体风格编译成 Behavior Patch；不要把具体的反问收尾等行为纠正降格成宽泛的语气标签。与这些配置无关时填 null。',
  '当玩家明确配置文风或世界题材允许范围时填写 narrative_preference；这属于 behavior_config 而不是模块开关。scopes/tone 表示写法，mode/topics 表示世界题材边界；允许=allow，要求必然出现= require，明确禁止=exclude。允许不意味着强制出现或提高概率。不要把普通游戏讨论或问句当配置。不要把用户整句填为风格值。没有对应偏好则填 null。',
  '你绝不执行任何操作、不修改世界状态、不声称已经完成。只输出符合 schema 的 JSON。',
].join('\n');
export async function understandSystemRequest(service: GameService, view: PublicView, save: SavePackage, text: string, sessionContext: unknown): Promise<{ understanding: SystemUnderstanding; source: 'model' | 'deterministic' }> {
  const shallow = shallowUnderstanding(text, view);
  const adapter = (service.ai as unknown as { adapter?: { name?: string; generate?: unknown } } | undefined)?.adapter;
  if (!adapter?.generate || adapter.name === 'mock') return { understanding: shallow, source: 'deterministic' };
  const parsed = await service.ai.systemAgent(systemUnderstandingSchema, save.definition.prompt_profile, {

    instruction:instruction+' Open Goal 是玩家的持久行动计划，不是 Quest、NPC 目标、开发任务或配置。查询、指定取消、指定恢复使用真实 open_goal.* 能力，填 goal_control={kind,target}；target 为已知计划 UUID 或明确的 current/paused。只取消一项必须绑定这一项，不能扩展到其他计划。不确定对象则澄清，不宣布操作已成功。', player_request: text, capability_digest: capabilityDigest(view, save,service.systemCapabilities), session: sessionContext,
  }, save);
  if (!parsed) return { understanding: shallow, source: 'deterministic' };
  // A model that understood something is trusted about what is *not* missing: an empty unresolved list is an
  // answer ("nothing else is needed"), so the deterministic guess must not replace it with a new question.
  const modelUnderstood = parsed.understood.length > 0 || parsed.likely_workflow !== 'unclear';
  // Deterministic facts still win where the model cannot know them (real entity names, real capability gaps).
  return {
    understanding: {
      ...parsed,
      entities: parsed.entities.length ? parsed.entities : shallow.entities,
      target_surfaces: parsed.target_surfaces.length ? parsed.target_surfaces : shallow.target_surfaces,
      unresolved: modelUnderstood ? parsed.unresolved : shallow.unresolved,
      narrative_preference:parsed.narrative_preference??shallow.narrative_preference,
    },
    source: 'model',
  };

}
/** A clarification answer that the session can merge without another model call. */
export function deterministicClarificationMerge(field: string | null, text: string, view: PublicView): ClarificationMerge | null {

  if (!field) return null;
  const clean = cleanBehaviorInstruction(text);
  if (field === '作用范围') {
    const scope = scopeInText(clean);
    return scope ? { field, scope, application: null } : null;
  }
  if (field === '展示位置') {
    const surfaces = surfacesIn(clean);
    return surfaces.length ? { field, surfaces } : null;
  }
  if (field === '要调整的系统') {
    const module = moduleFromText(clean);
    return module ? { field, module } : null;
  }
  if (field === '人物') {
    const matches = resolveEntities(view, clean).matches;
    return matches.length ? { field, entities: matches.slice(0, 4).map(entity => String(entity.components.identity?.name ?? entity.id)) } : null;
  }
  return null;
}

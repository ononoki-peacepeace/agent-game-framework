import {applyFeatureGuideAction,sessionInput,type SystemExecutionContext,type SystemSession} from './session.js';
import { z } from 'zod';
import { safeParse } from '../core/schema.js';
import { publicView } from '../core/state.js';
import type { GameService } from '../server/service.js';
import { planMeta, type MetaPlan } from './router.js';
import { toolAvailability, type ToolDescriptor } from './tools.js';
type AvailableTool = ToolDescriptor & { available: boolean };
import { applicationFor, behaviorSummary, detectBehaviorScopes, normalizeBehaviorScope, type BehaviorApplication, type BehaviorScope } from '../ai/behavior.js';
import { resolveEntities } from '../agent/entities.js';
import { relationshipSummary } from '../shared/relationship.js';
import { sanitizePlayerText } from './player-copy.js';
import { advanceFeatureGuide, featureGuideMessage, featureRequirement, isGuideConfirmation, startFeatureGuide, type FeatureGuide } from './feature-guide.js';
import { shallowUnderstanding } from './understanding.js';
import { resolveUniversalGoal, type UniversalResolution } from './resolver.js';
import type { DevelopmentProjection } from './development-status.js';
import {
  deterministicClarificationMerge, mediaCapabilityNote, scopeInText, understandSystemRequest,
  type ResolvedSystemRequest, type SystemUnderstanding, type SystemWorkflow,
} from './understanding.js';

const moduleNames: Record<string, string> = { map: '地图', commerce: '商店', inventory: '背包', equipment: '装备', quests: '任务', routine: '生活模式', attributes: '属性', aptitudes: '资质', skills: '技能', traits: '特质', relationships: '关系系统', characters: '人物系统' };
const moduleLabel = (id: string | null) => (id ? moduleNames[id] ?? id : '');
const behaviorScopeQuestion = '旁白叙述、人物对话，还是游戏助手（我）的回答方式？';
const mediaTools = ['avatar.crop','media.set_avatar','character.media.get','media.generate_image'];

export interface SystemResult {
  session?:SystemSession;
  category: string; tool_id: string | null; side_effect_level: string; needs_confirmation: boolean;
  message: string; advanced?: Record<string, unknown>; directive?: { kind: string } & Record<string, unknown>;
  clarification?: string | null; view?: unknown;
  /** Structured state the session keeps, so a clarification only fills what is still missing. */
  understanding?: SystemUnderstanding | null; pending_field?: string | null; workflow?: SystemWorkflow | null;
  resolved?: ResolvedSystemRequest | null; expression?: 'model' | 'template'; guide?: FeatureGuide | null;
  development?: DevelopmentProjection | null;
}
const result = (plan: MetaPlan, message: string, toolsList: ToolDescriptor[], extra: Partial<SystemResult> = {}): SystemResult => {
  const tool = toolsList.find(entry => entry.tool_id === plan.tool_id);
  return { category: plan.category, tool_id: plan.tool_id, side_effect_level: tool?.side_effect_level ?? 'none', needs_confirmation: plan.needs_confirmation, message, ...extra };
};

/** The System Agent: deterministic capability/tool layer first, model understanding where it adds real value. */
export async function handleSystemInput(service:GameService,raw:unknown):Promise<SystemResult>{
 const body=safeParse(z.strictObject({input:z.string().min(1).max(2000),confirmed:z.boolean().default(false),session_id:z.string().uuid().nullish(),request_id:z.string().uuid().optional(),game_id:z.string().optional(),expected_revision:z.number().int().nonnegative().optional()}),raw);
 const value=await sessionInput(service,body,(input,confirmed,context)=>executeSystemInput(service,{input,confirmed,request_id:body.request_id,expected_revision:body.expected_revision},context));
 return playerFacingSystemResult(value);
}
/** Only ordinary copy is cleaned; structured diagnostics stay intact under advanced/debug surfaces. */
export function playerFacingSystemResult(value:SystemResult):SystemResult{
 const guide=value.guide?{...value.guide,understood:value.guide.understood.map(line=>sanitizePlayerText(line,'')).filter(Boolean),draft:value.guide.draft.map(line=>sanitizePlayerText(line,'')).filter(Boolean),current_question:value.guide.current_question?sanitizePlayerText(value.guide.current_question,''):null,options:value.guide.options.map(option=>({...option,label:sanitizePlayerText(option.label,'继续'),detail:sanitizePlayerText(option.detail,'')}))}:value.guide;
 return {...value,message:sanitizePlayerText(value.message),...(guide?{guide}:{})};
}
const featureActionSchema=z.strictObject({type:z.enum(['FEATURE_GUIDE_OPTION','CONFIRM_FEATURE_PROPOSAL','CANCEL_FEATURE_PROPOSAL']),session_id:z.string().uuid(),proposal_id:z.string().uuid(),proposal_revision:z.number().int().positive(),option_id:z.string().min(1).max(60)});
/** Structured proposal actions bypass context routing and natural-language understanding. */
export async function handleSystemAction(service:GameService,raw:unknown):Promise<SystemResult>{
 const action=safeParse(featureActionSchema,raw),applied=applyFeatureGuideAction(service,action);
 if(applied.kind==='stale')return {category:'STALE_ACTION',tool_id:null,side_effect_level:'none',needs_confirmation:false,message:'这个方案已经变化，请使用当前方案。',...(applied.session?{session:applied.session}:{}),...(applied.guide?{guide:applied.guide}:{})};
 if(applied.kind==='cancelled')return {category:'EXTENSION_REQUEST',tool_id:null,side_effect_level:'none',needs_confirmation:false,message:'已取消这个开发想法。',session:applied.session!};
 if(applied.kind==='updated')return {category:'EXTENSION_REQUEST',tool_id:null,side_effect_level:'none',needs_confirmation:false,message:featureGuideMessage(applied.guide!),clarification:'feature_guide',pending_field:'想法方向',workflow:'development_task',session:applied.session!,guide:applied.guide};
 return {category:'EXTENSION_REQUEST',tool_id:'extension.create',side_effect_level:'development',needs_confirmation:false,message:'好的，我按这个最小版本准备候选；确认前不会改动你的存档或框架源码。',directive:{kind:'extension_development',request:featureRequirement(applied.guide!)},workflow:'development_task',session:applied.session!,guide:applied.guide};
}
/** Clarification fields the session can merge without a second model call, mapped to their wire codes. */
const clarificationCodes: Record<string, string> = { 作用范围: 'behavior_scope', 展示位置: 'which_surface', 要调整的系统: 'which_module', 人物: 'which_entity', 具体目标: 'unspecified_subject' };
const exampleLines: Record<string, string[]> = {
  作用范围: ['旁白', '人物对话', '助手'],
  展示位置: ['只放人物页', '地图和人物页都放', '只改状态页'],
  要调整的系统: ['关闭生活模式', '启用地图'],
  人物: ['给伊芙琳生成头像', '给我自己换头像'],
  具体目标: ['人物页显示好感度', '关闭生活模式', '故事写得更有文学性一点'],
};
/** A clarification answer the session can apply on its own: the missing field is already known. */
function mergeAnswer(context: SystemExecutionContext, text: string, view: ReturnType<typeof publicView>) {
  const session = context.session;
  if (!context.answeringClarification || !session.pending_field) return null;
  return deterministicClarificationMerge(session.pending_field, text, view);
}
function mergeInto(understanding: SystemUnderstanding | null, merge: ReturnType<typeof mergeAnswer>): SystemUnderstanding | null {
  if (!understanding || !merge) return understanding;
  const unresolved = understanding.unresolved.filter(item => item.field !== merge.field);
  const understood = [...understanding.understood, `已确认：${merge.field}`].slice(-6);
  return {
    ...understanding, unresolved, understood,
    target_surfaces: merge.surfaces?.length ? merge.surfaces : understanding.target_surfaces,
    entities: merge.entities?.length ? merge.entities : understanding.entities,
    clarification: unresolved.length ? understanding.clarification : { needed: false, question: '', examples: [] },
  };
}
function isCorrection(text: string, context: SystemExecutionContext) {
  return /^(不是|不对|我说的是|改成|应该是|其实是|我是说)/.test(text) && (context.previous ?? context.session.resolved_request)?.workflow === 'behavior_config';
}
function needsUnderstanding(plan: MetaPlan, text: string, context: SystemExecutionContext) {
  if (plan.category === 'UNKNOWN') return true;
  if (isCorrection(text, context)) return true;
  if (plan.tool_id === 'behavior.configure' && !context.behaviorScope && !plan.args.scope) return true;
  if ((plan.tool_id ?? '').startsWith('module.') && !plan.args.module) return true;
  // "给伊芙琳生成…头像" (no quoted name) has no entity yet: the understanding layer resolves it and reports the real asset状态.
  if (plan.tool_id === 'media.generate_image' && !plan.args.name) return true;
  // "加个赌博玩法" is already recognised as a development request, but a product idea still deserves the one
  // experience question before any technical proposal. Concrete requests (naming a surface or existing data)
  // keep going straight to the DevelopmentTask.
  if (plan.tool_id === 'extension.create' && !/(好感|关系|属性|技能|资质|背包|物品|任务|商店|地图|面板|页面|状态)/.test(text)) return true;
  return false;
}
/** Deterministic reading of a correction such as "不是游戏助手，是故事的最后一句". */
function deterministicCorrection(text: string, prior: ResolvedSystemRequest | null) {
  if (!prior || prior.workflow !== 'behavior_config') return null;
  const tail = text.replace(/^.*?(?:不是|不对|我说的是|改成|应该是|其实是|我是说)[^，,；;]*[，,；;]?\s*(?:是|要|只|就)?/, '');
  const scope = scopeInText(tail) ?? scopeInText(text) ?? prior.scope;
  const application = applicationFor(tail) !== 'per_message' ? applicationFor(tail) : prior.application;
  if (!scope) return null;
  return { scope, application, value: prior.value };
}
/** The player-visible clarification always states what was understood, what is missing, why, and how to answer. */
function clarificationMessage(understanding: SystemUnderstanding, fallback: string, prior?: ResolvedSystemRequest | null) {
  const lines: string[] = [];
  if (understanding.understood.length) lines.push(`我理解的是：${understanding.understood.join('；')}。`);
  if (prior?.summary) lines.push(`你上一条处理的是：${prior.summary}。如果这次是要改它，直接说清楚改哪一部分就行。`);
  const first = understanding.unresolved[0];
  if (first) lines.push(`还缺一项：${first.field}——${first.why}。`);
  const examples = (understanding.clarification?.examples?.length ? understanding.clarification.examples : exampleLines[first?.field ?? ''] ?? []).slice(0, 3);
  if (examples.length) lines.push(`你可以直接回复：${examples.map(example => `「${example}」`).join(' / ')}。`);
  if (understanding.clarification?.question && !first) lines.push(understanding.clarification.question);
  return sanitizePlayerText(lines.join('\n'), fallback);

}
function capabilityAnswer(view: ReturnType<typeof publicView>, save: Awaited<ReturnType<GameService['current']>>, text: string) {
  const extensions = Object.entries(save.extensions ?? {});
  if (/扩展|插件|功能包/.test(text)) {
    return extensions.length
      ? `当前世界已安装 ${extensions.length} 个扩展：${extensions.map(([id, entry]) => `${String((entry.manifest as { name?: string }).name ?? id)}${entry.enabled ? '' : '（已停用）'}`).join('、')}。`
      : '当前世界还没有安装扩展；你可以直接说想要的新玩法，我会先整理需求再准备候选扩展。';
  }
  if (/关系|好感/.test(text)) {
    const target = resolveEntities(view, text).matches[0];
    if (!target) return `人物关系数据来自 canonical 关系系统（当前维度：${Object.keys(save.definition.ruleset.relationship_dimensions).join('、') || '无'}）。说出人物名字我就能告诉你是哪一份数据。`;
    const summary = relationshipSummary(view, target);
    const entries = (view.entities.find(entity => entity.id === view.player_id)?.components.relationships?.entries ?? {}) as Record<string, unknown>;
    return `${String(target.components.identity?.name ?? target.id)}：${summary.text}（来源：${summary.source === 'graph' ? '关系数值' : '人物档案'}${entries[target.id] ? '，两人之间已有关系数值' : '，目前还没有关系数值'}）。`;
  }
  return `我读到的世界能力：模块 ${view.modules.filter(module => module.enabled).map(module => module.id).join('、') || 'core'}；面板 ${view.panels.map(panel => panel.label).join('、')}。你可以直接描述想改的东西，例如界面展示、玩法、人物资料或故事风格。`;
}
async function resolveUnderstanding(service: GameService, view: ReturnType<typeof publicView>, save: Awaited<ReturnType<GameService['current']>>, toolsList: AvailableTool[], text: string, context: SystemExecutionContext): Promise<SystemResult | null> {
  const session = context.session;
  const prior = context.previous ?? session.resolved_request ?? null;
  const merge = mergeAnswer(context, text, view);
  let understanding = mergeInto(session.understanding, merge);
  let source: 'model' | 'deterministic' = 'deterministic';
  if (!merge) {
    const answer = await understandSystemRequest(service, view, save, text, {
      current_goal: session.current_goal, understanding: session.understanding, pending_field: session.pending_field, previous: prior,
    });
    understanding = answer.understanding; source = answer.source;
  }
  if (!understanding) return null;
  // A merged answer supplies the field the session already knew was missing.
  if (merge) {
    if (merge.scope) context.behaviorScope = merge.scope;
    if (merge.application) context.behaviorApplication = merge.application;
    if (merge.module) context.moduleId = merge.module;
    if (merge.entities?.length) context.preferredNames = merge.entities;
  } else {
    const named = understanding.entities[0];
    if (named) context.preferredNames = understanding.entities;
  }
  const answering = Boolean(context.answeringClarification);
  // 1. Contextual correction of the previous style configuration. A real provider often labels a short answer
  // ("只放人物页") as a correction; while the session waits for a clarification field that is an answer, not a
  // revision of a style rule.
  const styleCorrection = prior?.workflow === 'behavior_config' && (!answering || session.pending_field === '作用范围');
  if (styleCorrection && (isCorrection(text, context) || understanding.likely_workflow === 'correction')) {
    const patch = understanding.correction
      ? { scope: normalizeBehaviorScope(understanding.correction.scope, text) ?? prior?.scope ?? null, application: understanding.correction.application ?? prior?.application ?? null, value: understanding.correction.value ?? prior?.value ?? null, remove: understanding.correction.remove }
      : { ...(deterministicCorrection(text, prior) ?? {}), remove: false } as { scope: BehaviorScope | null; application: BehaviorApplication | null; value: string | null; remove: boolean };
    return applyCorrection(service, toolsList, patch, understanding, prior);
  }
  // A model-labelled "correction" that arrives as the answer to a clarification keeps the pending workflow.
  if (answering && understanding.likely_workflow === 'correction') understanding = { ...understanding, likely_workflow: (session.understanding?.likely_workflow ?? 'unclear') as SystemWorkflow };
  const resolvedEntity = entityFor(view, text, context);
  // Media work that the framework cannot perform is reported, never questioned: asking about a style parameter
  // for an image nobody can generate would be a pointless loop.
  if ((understanding.likely_workflow === 'media_asset' || (understanding.likely_workflow === 'unclear' && resolvedEntity && /头像|立绘|图片|全身图/.test(text))) && resolvedEntity
    && toolsList.find(tool => tool.tool_id === 'media.generate_image')?.available !== true && !/裁|调整|重裁|重新裁/.test(text)) {
    const visuals = (resolvedEntity.components.visual_assets ?? {}) as { images?: Record<string, string>; avatar_crop?: unknown };
    const fullbody = visuals.images?.fullbody ?? null;
    return {
      category: 'MEDIA_OPERATION', tool_id: 'media.generate_image', side_effect_level: 'none', needs_confirmation: false,
      message: `我读懂了：你想为 ${String(resolvedEntity.components.identity?.name ?? resolvedEntity.id)} 准备人物头像。当前没有可用的图片生成功能，所以我不会假装已经生成。可以先用已有的全身图裁剪头像、上传图片，或接入图片生成服务。${fullbody ? '该人物已有全身图，可以直接裁剪头像。' : '（该人物目前没有可用的全身图。）'}`,
      advanced: { entity_id: resolvedEntity.id, has_fullbody: Boolean(fullbody), generation_available: false, capability_gap: 'media.image_generation' },
      directive: fullbody ? { kind: 'open_crop_editor', entity_id: resolvedEntity.id, source_asset_id: fullbody, current_avatar: resolvedEntity.components.identity?.avatar_id ?? null, crop: visuals.avatar_crop ?? null } : { kind: 'open_character_media', entity_id: resolvedEntity.id },
      understanding, workflow: 'media_asset',
    };
  }
  // 2. Something is genuinely missing: say what was understood, what is missing, why, and how to answer.
  // "人物页显示好感度" already names one surface and existing data: the development workspace is the right place
  // to settle presentation details, so the Agent must not keep asking. Several surfaces still need one question.
  const actionableTask = understanding.likely_workflow === 'development_task' && understanding.target_surfaces.length === 1;
  // A vague development idea is shaped by one experience question before any technical work starts. An active
  // guide owns the follow-up turns (delegate answer, adjustment, confirmation) and never writes canonical world.
  const activeGuide = Boolean(session.guide && session.guide.status !== 'confirmed');
  // Whatever the model called the open point, a development wish that names no surface is an idea to shape — the
  // player must never receive the model's technical question (capability gaps, schemas, existing modules).
  const answeringOtherField = context.answeringClarification === true && !['想法方向', '想法确认'].includes(session.pending_field ?? '');
  // The deterministic read of the player's own sentence also counts: a real provider may file "我想加个潜力系统"
  // as a module/capability question, and the player must still get the idea guide instead of a technical answer.
  const wishIsDevelopment = understanding.likely_workflow === 'development_task'
    || shallowUnderstanding(text, view).likely_workflow === 'development_task';
  const guideForIdea = !answeringOtherField && (activeGuide || (wishIsDevelopment
    && (understanding.unresolved.length > 0 || understanding.understood.length > 0))) && !surfacesFromText(text).length
    ? (session.guide && session.guide.status !== 'confirmed'
      ? (isGuideConfirmation(text) && session.guide.status === 'proposing' ? { ...session.guide, status: 'confirmed' as const } : advanceFeatureGuide(session.guide, text))
      : { ...startFeatureGuide(text), understood: understanding.understood.length ? understanding.understood.slice(0, 3) : startFeatureGuide(text).understood })
    : null;
  const shownIdea = guideForIdea ? { ...guideForIdea, understood: guideForIdea.understood.map(line => sanitizePlayerText(line, '')).filter(Boolean) } : null;
  if (shownIdea && shownIdea.status !== 'confirmed') return {
    category: 'EXTENSION_REQUEST', tool_id: null, side_effect_level: 'none', needs_confirmation: false,
    message: sanitizePlayerText(featureGuideMessage(shownIdea), '正在完善这个想法'), guide: shownIdea, clarification: 'feature_guide',
    pending_field: shownIdea.status === 'proposing' ? '想法确认' : '想法方向',
    workflow: 'development_task', understanding,
  };
  if (guideForIdea?.status === 'confirmed') understanding = { ...understanding, likely_workflow: 'development_task' };
  const missing = guideForIdea ? undefined : actionableTask ? undefined : understanding.unresolved[0];



  if (missing && understanding.clarification?.needed !== false && !context.behaviorScope && !context.moduleId) {
    return {
      category: understanding.likely_workflow === 'module_management' ? 'MODULE_MANAGEMENT' : understanding.likely_workflow === 'behavior_config' ? 'BEHAVIOR_CONFIGURATION' : understanding.likely_workflow === 'media_asset' ? 'MEDIA_OPERATION' : 'UNKNOWN',
      tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: clarificationMessage(understanding, `我还需要一项信息。`, prior), clarification: `${clarificationCodes[missing.field] ?? 'needs_detail'}`,
      understanding, pending_field: missing.field, workflow: understanding.likely_workflow,
    };
  }
  const entity = entityFor(view, text, context);
  // 3. Media / character assets: honest capability report, never a pretend generation.
  if (understanding.likely_workflow === 'media_asset' || (understanding.likely_workflow === 'unclear' && entity && /头像|立绘|图片|全身图/.test(text))) {
    if (!entity) return { category: 'MEDIA_OPERATION', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: clarificationMessage(understanding, '我需要知道是哪一个人物。'), clarification: 'which_entity', understanding, pending_field: '人物', workflow: 'media_asset' };
    const visuals = (entity.components.visual_assets ?? {}) as { images?: Record<string, string>; avatar_crop?: unknown };
    const fullbody = visuals.images?.fullbody ?? null;
    const wantsGeneration = /生成|画|绘制|制作|一张|新的/.test(text);
    const wantsCrop = /裁|调整|重裁|重新裁/.test(text);
    if (wantsCrop && fullbody) return { category: 'MEDIA_OPERATION', tool_id: 'avatar.crop', side_effect_level: 'none', needs_confirmation: false, message: `已为 ${String(entity.components.identity?.name ?? entity.id)} 打开头像裁剪器：拖动图片、滚轮/双指缩放，确认后保存头像裁剪设置（原图不变）。`, directive: { kind: 'open_crop_editor', entity_id: entity.id, source_asset_id: fullbody, current_avatar: entity.components.identity?.avatar_id ?? null, crop: visuals.avatar_crop ?? null }, understanding, workflow: 'media_asset' };
    if (wantsCrop) return { category: 'MEDIA_OPERATION', tool_id: 'avatar.crop', side_effect_level: 'none', needs_confirmation: false, message: `${String(entity.components.identity?.name ?? entity.id)} 还没有全身图，无法裁剪头像。请先上传全身图，或接入图像生成能力。`, advanced: { entity_id: entity.id }, understanding, workflow: 'media_asset' };
    const generationAvailable = toolsList.find(tool => tool.tool_id === 'media.generate_image')?.available === true;
    const message = generationAvailable
      ? `我读懂了：要为 ${String(entity.components.identity?.name ?? entity.id)} 生成人物图片。图片生成服务已接入，这一步需要你确认后才会真正调用。`
      : `我读懂了：你想为 ${String(entity.components.identity?.name ?? entity.id)} 准备人物头像。当前没有可用的图片生成功能，所以我不会假装已经生成。可以先用已有的全身图裁剪头像、上传图片，或接入图片生成服务。${fullbody ? '' : '（该人物目前没有可用的全身图。）'}`;

    return {
      category: generationAvailable ? 'MEDIA_GENERATION' : 'MEDIA_OPERATION', tool_id: 'media.generate_image', side_effect_level: 'canonical-state', needs_confirmation: generationAvailable,
      message, advanced: { entity_id: entity.id, has_fullbody: Boolean(fullbody), generation_available: generationAvailable, capability_gap: generationAvailable ? null : 'media.image_generation' },
      directive: fullbody ? { kind: 'open_crop_editor', entity_id: entity.id, source_asset_id: fullbody, current_avatar: entity.components.identity?.avatar_id ?? null, crop: visuals.avatar_crop ?? null } : { kind: 'open_character_media', entity_id: entity.id },
      understanding, workflow: 'media_asset',
    };
  }
  // 4. UI / product changes and brand-new gameplay become real development work, not a second input box.
  if (understanding.likely_workflow === 'development_task') {
    const surfaces = understanding.target_surfaces.length ? understanding.target_surfaces : surfacesFromText(text);
    const requirement = [understanding.requested_change ?? text, surfaces.length ? `展示位置：${surfaces.join('、')}` : '', /好感|关系/.test(text) ? mediaCapabilityNote(save) : ''].filter(Boolean).join('\n');
    // A concrete request goes straight to the DevelopmentTask; a vague product idea is shaped by the guide first.
    const concrete = surfaces.length > 0 || /(好感|关系|属性|技能|资质|背包|物品|任务|商店|地图|面板|页面|状态)/.test(text);
    let guide: FeatureGuide | null = session.guide && session.guide.status !== 'confirmed'
      ? (isGuideConfirmation(text) && session.guide.status === 'proposing' ? { ...session.guide, status: 'confirmed' as const } : advanceFeatureGuide(session.guide, text))
      : concrete ? null : startFeatureGuide(text);
    if (guide && guide.status === 'confirmed') guide = { ...guide, status: 'confirmed' as const };
    if (guide && guide.status !== 'confirmed') return {
      category: 'EXTENSION_REQUEST', tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: sanitizePlayerText(featureGuideMessage(guide), '正在完善这个想法'), guide, clarification: 'feature_guide', pending_field: guide.status === 'proposing' ? '想法确认' : '想法方向',

      workflow: 'development_task', understanding,
    };
    return {
      category: 'EXTENSION_REQUEST', tool_id: 'extension.create', side_effect_level: 'development', needs_confirmation: false,
      message: guide ? '好的，我按这个最小版本准备候选；确认前不会改动你的存档或框架源码。' : `我理解的是：${understanding.understood.join('；')}。${surfaces.length > 1 ? `展示位置我先按 ${surfaces.join('、')} 全部纳入需求。` : ''}我会建立开发任务整理需求、做候选并验证；确认前不会改动你的存档或框架源码。`,
      directive: { kind: 'extension_development', request: guide ? featureRequirement(guide) : requirement }, understanding, workflow: 'development_task', ...(guide ? { guide } : {}),

    };
  }
  // 5. Capability questions are answered from real state.
  if (understanding.likely_workflow === 'capability_question') {
    return { category: 'CAPABILITY_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: capabilityAnswer(view, save, text), understanding, workflow: 'capability_question', expression: 'template' };
  }
  // 6. Understood, but it maps onto no single deterministic tool (yet). Answer with what was understood and the
  //    nearest honest next step instead of falling back to a canned "I don't understand".
  if (understanding.understood.length) {
    return {
      category: 'SYSTEM_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: `${understanding.understood.join('；')}。\n如果这需要改动界面或玩法，我可以直接把它作为开发任务整理需求；如果只是要调整某个系统的开关或范围，告诉我具体是哪一项就行。`,
      understanding, workflow: understanding.likely_workflow, expression: 'template',
    };
  }
  return null;
}
function surfacesFromText(text: string) {
  const found: string[] = [];
  for (const [word, value] of [['人物页', 'character_page'], ['人物卡', 'character_page'], ['状态页', 'status_page'], ['地图', 'map'], ['关系页', 'relationships_panel'], ['背包', 'inventory'], ['任务', 'quests']] as [string, string][]) if (text.includes(word) && !found.includes(value)) found.push(value);
  return found;
}
function entityFor(view: ReturnType<typeof publicView>, text: string, context: SystemExecutionContext) {
  const names = context.preferredNames ?? [];
  for (const name of names) { const hit = view.entities.find(entity => String(entity.components.identity?.name ?? '') === name); if (hit) return hit; }
  if (/我自己|自己|我的/.test(text)) return view.entities.find(entity => entity.id === view.player_id) ?? null;
  const found = resolveEntities(view, text);
  return found.confident ? found.matches[0] ?? null : null;
}
async function applyCorrection(service: GameService, toolsList: AvailableTool[], patch: { scope: BehaviorScope | null; application: BehaviorApplication | null; value: string | null; remove: boolean }, understanding: SystemUnderstanding, prior: ResolvedSystemRequest | null): Promise<SystemResult> {

  const scope = patch.scope ?? 'assistant';
  // "不是游戏助手，是故事的最后一句" moves the same configuration; it must not leave a second, unrelated rule.
  if (patch.scope && prior?.scope && prior.scope !== scope) await service.clearBehaviorConfig(prior.scope);

  if (patch.remove) {
    const next = await service.clearBehaviorConfig(scope), rules = await service.behaviorConfig();
    return { category: 'BEHAVIOR_CONFIGURATION', tool_id: 'behavior.clear', side_effect_level: 'configuration', needs_confirmation: false, message: `已取消该范围（${scope}）的风格配置。当前：${behaviorSummary(rules)}`, view: next, understanding, workflow: 'behavior_config' };
  }
  const ruleOps = { op: 'suffix' as const, value: patch.value ?? '', application: patch.application ?? 'per_message' };
  if (!ruleOps.value) {
    return { category: 'BEHAVIOR_CONFIGURATION', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: `我理解你在修正上一条风格配置，但我不确定要保留的那句话本身。可以直接说：例如「保留原来的话，只改到旁白」。`, clarification: 'behavior_value', understanding, workflow: 'behavior_config' };
  }
  const next = await service.setBehaviorConfig({ scope, rule: ruleOps }), rules = await service.behaviorConfig();
  return { category: 'BEHAVIOR_CONFIGURATION', tool_id: 'behavior.configure', side_effect_level: 'configuration', needs_confirmation: false, message: `已按你的修正更新：${behaviorSummary(rules)}。它只影响措辞，不改动世界事实或玩家控制权。`, advanced: { behavior: rules }, view: next, understanding, workflow: 'behavior_config' };
}
/** The deterministic tool switch: unchanged execution semantics, used whenever the request is already clear. */
async function executeTool(service: GameService, plan: MetaPlan, body: { input: string; confirmed: boolean }, context: SystemExecutionContext, toolsList: AvailableTool[], entityId?: string): Promise<SystemResult> {
  const save = await service.current(), view = publicView(save);
  if (plan.reply && !(plan.tool_id === 'module.remove' && body.confirmed)) return result(plan, plan.reply, toolsList);
  const tool = toolsList.find(entry => entry.tool_id === plan.tool_id)!;
  service.logger.info('system.agent.request', { module: 'system', metadata: { category: plan.category, tool: tool.tool_id, side_effect: tool.side_effect_level, confirmed: body.confirmed } });
  switch (tool.tool_id) {
    case 'ui.feedback':
      service.logger.warn('system.feedback', { module: 'system', metadata: { text: String(plan.args.request).slice(0, 400) } });
      return result(plan, '已记录这条反馈，会写入本机日志。它不会修改游戏世界。', toolsList);
    case 'diagnostic.logs': {
      const entries = service.logger.entries({ limit: 200 });
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1);
      const warnings = entries.filter(entry => entry.level === 'warn' || entry.level === 'error').slice(-3).map(entry => entry.event);
      return result(plan, `本机日志最近 ${entries.length} 条：${[...counts].slice(0, 6).map(([event, count]) => `${event}×${count}`).join('、') || '（无）'}。${warnings.length ? `最近的警告/错误：${warnings.join('、')}。` : ''}完整内容见「日志」面板。`, toolsList);
    }
    case 'avatar.crop':
    case 'media.set_avatar':
    case 'character.media.get':
    case 'media.generate_image': {
      const byName = view.entities.filter(entity => entityId ? entity.id === entityId : entity.components.identity?.name && body.input.includes(String(entity.components.identity.name)));
      if (byName.length > 1) return result(plan, `有多个人物匹配这个名字：${byName.map(entity => String(entity.components.identity!.name)).join('、')}。请指定是谁。`, toolsList);
      const target = byName[0] ?? save.entities.find(entity => entity.id === save.player_state.entity_id)!;
      const visuals = (target.components.visual_assets ?? {}) as { images?: Record<string, string>; avatar_crop?: unknown };
      const fullbody = visuals.images?.fullbody ?? null, avatar = target.components.identity?.avatar_id ?? null;
      if (plan.category === 'MEDIA_GENERATION') {
        return result(plan, `当前未配置图片生成服务。我不会假装已经生成图片；可以改用已有的全身图裁剪头像，或接入图片生成服务。`, toolsList, { advanced: { entity_id: target.id, has_fullbody: Boolean(fullbody) } });
      }
      if (!fullbody) return result(plan, `${String(target.components.identity?.name ?? '这个人物')} 还没有全身图，无法裁剪头像。请先上传全身图，或接入图像生成能力。`, toolsList, { advanced: { entity_id: target.id } });
      return result(plan, `已为 ${String(target.components.identity?.name ?? target.id)} 打开头像裁剪器：拖动图片、滚轮/双指缩放，确认后保存头像裁剪设置（原图不变）。`, toolsList, {
        directive: { kind: 'open_crop_editor', entity_id: target.id, source_asset_id: fullbody, current_avatar: avatar, crop: visuals.avatar_crop ?? null },
        advanced: { entity_id: target.id, source_asset_id: fullbody },
      });
    }
    case 'module.enable':
    case 'module.disable':
    case 'module.remove': {
      const moduleId = (context.moduleId ?? plan.args.module) as string | null;
      if (!moduleId) return result(plan, '请说明是哪一个系统（地图、商店、背包、装备、任务、生活模式…）。', toolsList);
      if (tool.tool_id === 'module.remove' && !body.confirmed) return result(plan, `将要移除「${moduleLabel(moduleId)}」。移除会删除该系统的自有状态（会先写检查点）。确认后执行。`, toolsList);
      const currentModule = view.modules.find(module => module.id === moduleId);
      // The player asked about a page they can see, so the answer is about that page — never a module id or an
      // internal status string such as "quests 没有启用".
      if (tool.tool_id === 'module.disable' && currentModule && !currentModule.enabled) return result(plan, `「${moduleLabel(moduleId)}」现在本来就是关闭的。`, toolsList);
      if (tool.tool_id === 'module.enable' && currentModule?.enabled) return result(plan, `「${moduleLabel(moduleId)}」现在本来就是开启的。`, toolsList);
      let next: Awaited<ReturnType<GameService['manageModule']>>;
      try {
        next = await service.manageModule({ module: moduleId, confirmed: true, game_id: save.game_id, expected_revision: save.state_revision, request_id: crypto.randomUUID() }, tool.tool_id === 'module.enable' ? 'enable' : tool.tool_id === 'module.disable' ? 'disable' : 'remove');
      } catch (error) {
        service.logger.warn('system.module.failed', { module: 'system', metadata: { command: tool.tool_id, target: moduleId, reason: error instanceof Error ? error.message.slice(0, 200) : String(error) } });
        return result(plan, `这次没能${tool.tool_id === 'module.enable' ? '启用' : '关闭'}「${moduleLabel(moduleId)}」，世界状态没有改变。`, toolsList);
      }
      return result(plan, `${tool.tool_id === 'module.enable' ? '已启用' : tool.tool_id === 'module.disable' ? '已停用' : '已移除'}「${moduleLabel(moduleId)}」。`, toolsList, { needs_confirmation: false, advanced: { revision: next.revision, panels: next.panels.map(panel => panel.id) } });
    }
    case 'save.export':
      return result(plan, '已准备导出标准存档包。', toolsList, { directive: { kind: 'export_save' } });
    case 'extension.create':
      return result(plan, '这需要一个 Framework 目前没有的玩法。我会在「高级开发」里准备一个候选扩展，构建与验证通过后由你确认安装；它不会自动改框架源码。', toolsList, { directive: { kind: 'extension_development', request: String(plan.args.request ?? body.input) } });
    case 'behavior.configure': {
      const instruction = String(plan.args.instruction ?? body.input).slice(0, 200);
      // A clarification answer names one scope; otherwise every scope the sentence mentions is configured, so
      // "叙述与人物对话都更文学一点" never degrades to a single random target.
      const detected = detectBehaviorScopes(instruction);
      const targets: BehaviorScope[] = context.behaviorScope ? [context.behaviorScope]
        : detected.length ? detected : plan.args.scope ? [normalizeBehaviorScope(plan.args.scope as string, instruction)!] : [];
      if (!targets.length) return result(plan, `我理解你想给输出加一条固定的写法要求。还缺一项：这条要求作用在哪里——${behaviorScopeQuestion}你可以直接回复「旁白」「人物对话」或「助手」。`, toolsList, { clarification: 'behavior_scope', pending_field: '作用范围' });
      let next: Awaited<ReturnType<GameService['setBehaviorConfig']>> | null = null;
      for (const scope of targets) next = await service.setBehaviorConfig({ scope, instruction });
      const rules = await service.behaviorConfig();
      return result(plan, `已记下这条风格要求：${behaviorSummary(rules)}。它只影响措辞，不会修改世界事实、玩家控制权或安全规则。`, toolsList, { advanced: { behavior: rules }, view: next, resolved: resolvedFrom('behavior_config', rules.at(-1) ?? null, instruction) });

    }
    case 'behavior.clear': {
      const scope = normalizeBehaviorScope(plan.args.scope as string | null, body.input);
      const next = await service.clearBehaviorConfig(scope ?? undefined), rules = await service.behaviorConfig();
      return result(plan, scope ? `已恢复该范围的默认风格。` : '已恢复全部默认风格。', toolsList, { advanced: { behavior: rules }, view: next });
    }
    case 'framework.development':
      return result(plan, '修改 Framework 核心或存档机制属于框架开发，当前尚未接入核心源码开发流程，也不会让 Codex 直接改动源码。', toolsList);
    default:
      return result(plan, '我还不确定你的目标，可以再具体一点吗？', toolsList);
  }
}
function resolvedFrom(workflow: SystemWorkflow, rule: { op?: string; value?: string; application?: BehaviorApplication; scope?: BehaviorScope } | null, summary: string): ResolvedSystemRequest {
  return { workflow, at: new Date().toISOString(), summary, scope: rule?.scope ?? null, application: rule?.application ?? null, value: rule?.value ?? null, op: (rule?.op as 'suffix' | 'prefix' | 'tone' | 'constraint' | undefined) ?? null, module: null, entity_id: null };
}
async function executeSystemInput(service: GameService, raw: unknown, context: SystemExecutionContext): Promise<SystemResult> {
  const body = safeParse(z.strictObject({ input: z.string().min(1).max(2000), confirmed: z.boolean().default(false), request_id: z.string().uuid().optional(), expected_revision: z.number().int().nonnegative().optional() }), raw);
  const save = await service.current(), view = publicView(save), toolsList = toolAvailability(view.capabilities);
  const plan = planMeta(body.input, view.capabilities);
  const entityId = context.entityId;
  // The session goal is what the tool layer executes; understanding always reads what the player just said.
  const latest = context.latest ?? body.input;
  const universal = await resolveUniversalGoal(service, latest, { request_id: body.request_id, expected_revision: body.expected_revision });
  // Existing local media fallbacks (for example cropping an already stored full-body image) remain usable even
  // when the requested generation chain reports a missing provider capability.
  const mediaGap = universal.handled && universal.kind === 'CAPABILITY_GAP'
    && universal.goal.desired_outputs.some(output => output.kind === 'media_asset');
  if (universal.handled && !mediaGap) return universalSystemResult(universal);
  // A System write may only run for the sentence the player just sent, for a confirmation of it, or as the answer
  // to a clarification that the write itself asked for. A planned write left over from an earlier request is
  // never replayed because a later, unrelated message kept the session alive.
  const planned = toolsList.find(tool => tool.tool_id === plan.tool_id);
  const writeLevels = ['configuration', 'canonical-management', 'canonical-state', 'development'];
  const ownClarificationFields = ['要调整的系统', '作用范围', '人物', '展示位置'];
  const boundToCurrentRequest = body.input === latest || body.confirmed === true || context.behaviorScope !== undefined || Boolean(context.session.guide)
    || (context.answeringClarification === true && ownClarificationFields.includes(context.session.pending_field ?? ''));
  if (planned && writeLevels.includes(planned.side_effect_level) && !boundToCurrentRequest) {
    context.session.pending_confirmation = null;
    context.session.pending_field = null;
    return {
      category: plan.category, tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: '当前待处理的修改与刚才的需求不一致，因此没有执行。你可以把想改的东西重新说一遍；如果确实要执行刚才那件事，请直接说明要确认它。',
    };
  }
  if (needsUnderstanding(plan, latest, context)) {
    const resolved = await resolveUnderstanding(service, view, save, toolsList, latest, context);
    if (resolved) return resolved;
  }

  const executed = await executeTool(service, plan, body, context, toolsList, entityId);
  // Optional second call: only to phrase a real execution result, never to change its semantics.
  return express(service, view, save, body.input, executed, context);
}

function universalSystemResult(resolution: Exclude<UniversalResolution, { handled: false }>): SystemResult {
  if (resolution.kind === 'EXECUTED') return { category: 'UNIVERSAL_GOAL', tool_id: resolution.plan.steps.at(-1)?.capability_id ?? null, side_effect_level: 'canonical-state', needs_confirmation: false, message: resolution.message, view: resolution.view, advanced: { resolution_kind: resolution.kind, goal: resolution.goal, plan: resolution.plan } };
  if (resolution.kind === 'USER_AMBIGUITY') return { category: 'USER_AMBIGUITY', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: resolution.candidates.length ? `${resolution.question}\n${resolution.candidates.join('、')}` : resolution.question, clarification: 'universal_goal', pending_field: '具体目标', advanced: { resolution_kind: resolution.kind } };
  if (resolution.kind === 'CAPABILITY_GAP') return { category: 'CAPABILITY_GAP', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: resolution.message, advanced: { resolution_kind: resolution.kind, missing: resolution.missing, goal: resolution.goal, plan: resolution.plan } };
  return { category: 'EXECUTION_FAILURE', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: resolution.message, advanced: { resolution_kind: resolution.kind, retryable: resolution.retryable, goal: resolution.goal } };
}
const expressionSchema = z.strictObject({ message: z.string().min(1).max(800) });
async function express(service: GameService, view: ReturnType<typeof publicView>, save: Awaited<ReturnType<GameService['current']>>, text: string, executed: SystemResult, context: SystemExecutionContext): Promise<SystemResult> {
  const adapter = (service.ai as unknown as { adapter?: { name?: string } } | undefined)?.adapter;
  const executor = (service.ai as unknown as { systemAgent?: unknown });
  if (!adapter || adapter.name === 'mock' || typeof executor.systemAgent !== 'function') return executed;
  if (executed.clarification || executed.needs_confirmation || executed.directive) return executed;
  // A read-only acknowledgement (feedback, logs) stays deterministic: no model call for a button-sized action.
  const material = ['configuration','canonical-management','canonical-state','development'].includes(executed.side_effect_level) || executed.category === 'CAPABILITY_ANSWER';
  if (!material) return executed;

  const parsed = await service.ai.systemAgent(expressionSchema, save.definition.prompt_profile, {
    instruction: '你是游戏框架 System Agent 的表达层。只能根据下面这份真实执行结果，用玩家能懂的自然语言复述。不得声称做过没有发生的事，不得改变结果语义，不得输出内部标识、工具名或 schema。保持简短。',
    player_request: text, execution_result: { success: executed.category !== 'UNKNOWN', operation: executed.category, tool: executed.tool_id, changes: executed.advanced ?? {}, message: executed.message, clarification: executed.clarification ?? null },
  }, save);
  if (!parsed?.message) return { ...executed, expression: 'template' };
  return { ...executed, message: parsed.message, expression: 'model' };
}

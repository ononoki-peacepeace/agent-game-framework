import {goalSpecSchema,type GoalSpec} from './goals.js';
import type {OpenGoalControl} from '../agent/plan-schema.js';
import {applyFeatureGuideAction,sessionInput,type SystemExecutionContext,type SystemSession} from './session.js';
import { z } from 'zod';
import {randomUUID} from 'node:crypto';
import { safeParse } from '../core/schema.js';
import { publicView } from '../core/state.js';
import type { GameService } from '../server/service.js';
import { planMeta, type MetaPlan } from './router.js';
import { toolAvailability, type ToolDescriptor } from './tools.js';
type AvailableTool = ToolDescriptor & { available: boolean };
import { applicationFor, behaviorSummary, detectBehaviorScopes, normalizeBehaviorScope, type BehaviorApplication, type BehaviorScope } from '../ai/behavior.js';
import { resolveEntities } from '../agent/entities.js';
import {GameError} from '../core/schema.js';
import { queryRuntimeTruth } from '../agent/truth-query.js';
import { relationshipSummary } from '../shared/relationship.js';
import { sanitizePlayerText } from './player-copy.js';
import { advanceFeatureGuide, featureGuideMessage, featureRequirement, isDelegateAnswer, isGuideConfirmation, startFeatureGuide, type FeatureGuide } from './feature-guide.js';
import { shallowUnderstanding } from './understanding.js';
import { resolveUniversalGoal, type UniversalResolution } from './resolver.js';
import {interpretSemanticEntry} from '../agent/semantic-entry.js';
import {currentTrace} from '../observability/trace.js';
import {contentAllowanceSummary} from '../narrative/policy.js';
import {compileBehaviorFeedback} from '../ai/behavior-feedback.js';
import type { DevelopmentProjection } from './development-status.js';
import { planFrameworkChange } from '../change/planner.js';
import {
  deterministicClarificationMerge, mediaCapabilityNote, scopeInText, surfacesIn, understandSystemRequest,
  type ResolvedSystemRequest, type SystemUnderstanding, type SystemWorkflow,
} from './understanding.js';

const moduleNames: Record<string, string> = { map: '地图', commerce: '商店', inventory: '背包', equipment: '装备', quests: '任务', routine: '生活模式', attributes: '属性', aptitudes: '资质', skills: '技能', traits: '特质', relationships: '关系系统', characters: '人物系统' };
const moduleLabel = (id: string | null) => (id ? moduleNames[id] ?? id : '');
const behaviorScopeQuestion = '旁白叙述、人物对话，还是游戏助手（我）的回答方式？';
/** "你/你现在能做什么" always means the Assistant or the Framework, never the NPC the player last spoke to. */
const asksAboutAssistant=(text:string)=>/你(们)?\s*(现在|目前|当前|都)?\s*(能|会|可以|支持|有|是|做|干)/.test(String(text??''))||/你(们)?\s*(能|会|可以|支持)\s*(做什么|干什么|哪些|什么)/.test(String(text??''));
const mediaTools = ['avatar.crop','media.set_avatar','character.media.get','media.generate_image'];
const lastPersonaTarget=new WeakMap<GameService,{game_id:string;entity_id:string}>();
export const isCharacterPersonaInput=(text:string)=>/(说话|口吻|语气|语言习惯|句尾|性格)/.test(text)&&/(设为|设置|改成|改为|改得|修改|更改|变得|让|取消|恢复|默认)/.test(text)&&!/(旁白|全体角色|所有角色)/.test(text);
async function applyCharacterPersonaInput(service:GameService,body:{input:string;request_id?:string;game_id?:string;expected_revision?:number}):Promise<SystemResult>{
  const save=await service.current(),view=publicView(save),input=body.input;
  const matches=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character&&input.includes(String(entity.components.identity?.name??'\u0000')));
  if(matches.length>1)throw new GameError('这条设置涉及多个人物，请明确只修改哪一位。');
  const remembered=lastPersonaTarget.get(service);
  const entity=matches[0]??(/她|他|这个角色|该角色/.test(input)&&remembered?.game_id===view.game_id?view.entities.find(item=>item.id===remembered.entity_id):null);
  if(!entity)throw new GameError('请说出要修改说话风格的人物名字。');
  const current=entity.components.character as Record<string,unknown>;
  const reset=/(取消|恢复默认|还原默认)/.test(input);
  const field=/(性格)/.test(input)?'personality':/(语言习惯|句尾)/.test(input)?'verbal_habits':'speech_style';
  const afterName=input.slice(input.indexOf(String(entity.components.identity?.name))+String(entity.components.identity?.name).length);
  const value=afterName.replace(/^.*?(?:说话风格|说话方式|说话|语言习惯|句尾|口吻|语气|性格)/,'').replace(/^(?:设为|设置为|改成|改为|改得|修改为|变得|更)/,'').replace(/[。！!\s]+$/,'').trim();
  if(!reset&&!value)throw new GameError('请描述这位人物希望采用的说话方式。');
  const next=await service.setCharacterPersona({game_id:body.game_id??view.game_id,expected_revision:body.expected_revision??view.revision,request_id:body.request_id??randomUUID(),entity_id:entity.id,
    personality:field==='personality'?(reset?'':value):String(current.personality??''),
    speech_style:field==='speech_style'?(reset?'':value):String(current.speech_style??''),
    verbal_habits:field==='verbal_habits'?(reset?'':value):String(current.verbal_habits??'')});
  lastPersonaTarget.set(service,{game_id:view.game_id,entity_id:entity.id});
  return {category:'CHARACTER_PERSONA',tool_id:'character.persona.set',side_effect_level:'configuration',needs_confirmation:false,
    message:`已${reset?'恢复':'更新'}${String(entity.components.identity?.name)}的${field==='personality'?'性格提示':field==='verbal_habits'?'语言习惯':'说话风格'}。`,view:next};
}

export interface SystemResult {
  session?:SystemSession;
  category: string; tool_id: string | null; side_effect_level: string; needs_confirmation: boolean;
  message: string; advanced?: Record<string, unknown>; directive?: { kind: string } & Record<string, unknown>;
  clarification?: string | null; view?: unknown;
  /** The real category of this final response, so the surface never falls back to a wrong workflow title. */
  title?: string | null;
  /** Structured state the session keeps, so a clarification only fills what is still missing. */
  understanding?: SystemUnderstanding | null; pending_field?: string | null; workflow?: SystemWorkflow | null;
  resolved?: ResolvedSystemRequest | null; expression?: 'model' | 'template'; guide?: FeatureGuide | null;
  pending_goal?: {goal_id:string;original_input:string;clarifications:string[];question:string|null;created_revision:number} | null;
  development?: DevelopmentProjection | null;
  suspended_goal?: { goal_id: string; status: string; external_blocked: boolean } | null;
  capability_guidance?: {status:'WAITING_FOR_PROVIDER'|'PROVIDER_CALL_FAILED';capability:string;reason_kind:'adapter_missing'|'credential_missing'|'provider_failure';summary:string;options:{id:string;label:string;action:'connect_provider'|'configure_credentials'|'upload_asset'|'retry'|'view_reason'|'change_provider'|'cancel'}[];resumable:boolean} | null;
}
const result = (plan: MetaPlan, message: string, toolsList: ToolDescriptor[], extra: Partial<SystemResult> = {}): SystemResult => {
  const tool = toolsList.find(entry => entry.tool_id === plan.tool_id);
  return { category: plan.category, tool_id: plan.tool_id, side_effect_level: tool?.side_effect_level ?? 'none', needs_confirmation: plan.needs_confirmation, message, ...extra };
};

/** The System Agent: deterministic capability/tool layer first, model understanding where it adds real value. */
export async function handleSystemInput(service:GameService,raw:unknown,semantic?:import('../agent/semantic-entry.js').SemanticDecision):Promise<SystemResult>{
 const body=safeParse(z.strictObject({input:z.string().min(1).max(2000),confirmed:z.boolean().default(false),session_id:z.string().uuid().nullish(),request_id:z.string().uuid().optional(),game_id:z.string().optional(),expected_revision:z.number().int().nonnegative().optional()}),raw);
 if(isCharacterPersonaInput(body.input)&&(!semantic||semantic.operation_plane==='system_management')){
   const save=await service.current(),view=service.project(save);
   const named=view.entities.some(entity=>entity.id!==view.player_id&&entity.components.character&&
     body.input.includes(String(entity.components.identity?.name??'\u0000')));
   const remembered=lastPersonaTarget.get(service);
   const refersToRemembered=/她|他|这个角色|该角色/.test(body.input)&&remembered?.game_id===view.game_id;
   if(named||refersToRemembered){
     const {understanding}=await understandSystemRequest(service,view,save,body.input,null);
     if(understanding.style_target!=='world')return playerFacingSystemResult(await applyCharacterPersonaInput(service,body));
   }
 }
 const value=await sessionInput(service,body,(input,confirmed,context)=>executeSystemInput(service,{input,confirmed,request_id:body.request_id,expected_revision:body.expected_revision,game_id:body.game_id},context,semantic));
 const changePlan=(!semantic||semantic.operation_plane==='framework_development')?
   planFrameworkChange(body.input,{surface:'system'},body.request_id):null;
 const enriched=changePlan?{...value,advanced:{...value.advanced,change_plan:changePlan},...(value.directive?.kind==='extension_development'?{directive:{...value.directive,change_plan:changePlan}}:{})}:value;
 return playerFacingSystemResult(enriched);
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
 const request=featureRequirement(applied.guide!),changePlan=planFrameworkChange(request,{surface:'system'});
 return {category:'EXTENSION_REQUEST',tool_id:'extension.create',side_effect_level:'development',needs_confirmation:false,message:'好的，我按这个最小版本准备候选；确认前不会改动你的存档或框架源码。',directive:{kind:'extension_development',request,...(changePlan?{change_plan:changePlan}:{})},advanced:changePlan?{change_plan:changePlan}:undefined,workflow:'development_task',session:applied.session!,guide:applied.guide};
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
  if (context.answeringClarification === true && context.session.workflow === 'development_task') return true;
  if (plan.category === 'UNKNOWN') return true;
  if (isCorrection(text, context)) return true;
  if (plan.tool_id === 'behavior.configure' && !context.behaviorScope && !plan.args.scope) return true;
  if ((plan.tool_id ?? '').startsWith('module.') && !plan.args.module) return true;
  // "给伊芙琳生成…头像" (no quoted name) has no entity yet: the understanding layer resolves it and reports the real asset状态.
  if (plan.tool_id === 'media.generate_image' && !plan.args.name) return true;
  // "加个赌博玩法" is already recognised as a development request, but a product idea still deserves the one
  // experience question before any technical proposal. Concrete requests (naming a surface or existing data)
  // keep going straight to the DevelopmentTask.
  if (plan.tool_id === 'extension.create' && surfacesIn(text).length > 1) return true;
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
/**
 * A follow-up while a goal waits for a clarification is an *answer*: short, terse, often a bare value
 * ("给角色", "上午", "3000", "随便"). An explicit new instruction ("算了，先打开地图") is allowed to interrupt.
 */
function isClarificationReply(text: string) {
  const clean = String(text ?? '').trim();
  if (!clean) return false;
  if (/(打开|关闭|启用|停用|开始|取消|算了|去商店|去看看)/.test(clean)) return false;
  if (clean.length <= 18) return true;
  return /^(随便|你决定|你看着办|都可以|帮我选|默认|是|对|好|行|不要|否|就那个|那个|第[一二三四五1-9]|\d+)/.test(clean);
}
/** The player-visible clarification always states what was understood, what is missing, why, and how to answer. */
function clarificationMessage(understanding: SystemUnderstanding, fallback: string, prior?: ResolvedSystemRequest | null) {
  const lines: string[] = [];
  if (understanding.understood.length) lines.push(`我理解的是：${understanding.understood.join('；')}。`);
  if (prior?.summary) lines.push(`你上一条处理的是：${prior.summary}。如果这次是要改它，直接说清楚改哪一部分就行。`);
  const first = understanding.unresolved[0];
  if (understanding.clarification?.question) lines.push(understanding.clarification.question);
  else if (first) lines.push(`还缺一项：${first.field}——${first.why}。`);
  const examples = (understanding.clarification?.examples?.length ? understanding.clarification.examples : exampleLines[first?.field ?? ''] ?? []).slice(0, 3);
  if (examples.length) lines.push(`你可以直接回复：${examples.map(example => `「${example}」`).join(' / ')}。`);
  return sanitizePlayerText(lines.join('\n'), fallback);

}
function capabilityAnswer(service: GameService, view: ReturnType<typeof publicView>, save: Awaited<ReturnType<GameService['current']>>, text: string) {
  const extensions = Object.entries(save.extensions ?? {});
  const providers=service.runtimeProviderStatus();
  const runtimeTruth=queryRuntimeTruth(view,text,{text_provider:providers.text.provider,image_provider:providers.image.provider});
  if(runtimeTruth)return runtimeTruth.message;
  const namedExtension = extensions.find(([id, entry]) => {
    const name = String(entry.manifest.name ?? id);
    return text.includes(name) || text.includes(id) || entry.manifest.surfaces.some(surface => text.includes(surface.title));
  });
  if (namedExtension) {
    const [id, entry] = namedExtension;
    const panels = view.panels.filter(panel => panel.extension_id === id).map(panel => panel.label);
    if (!entry.installed) return `「${entry.manifest.name}」保留了历史状态，但当前没有安装。`;
    return `「${entry.manifest.name}」已经安装，当前${entry.enabled ? '已启用' : '已停用'}${panels.length ? `；可见入口：${panels.join('、')}` : ''}。`;
  }
  if (/扩展|插件|功能包/.test(text)) {
    const installed = extensions.filter(([, entry]) => entry.installed);
    return installed.length
      ? `当前世界已安装 ${installed.length} 个扩展：${installed.map(([id, entry]) => `${String((entry.manifest as { name?: string }).name ?? id)}${entry.enabled ? '' : '（已停用）'}`).join('、')}。`
      : '当前世界还没有安装扩展；你可以直接说想要的新玩法，我会先整理需求再准备候选扩展。';
  }
  if (/关系|好感/.test(text)) {
    const target = resolveEntities(view, text).matches[0];
    if (!target) return `人物关系数据来自 canonical 关系系统（当前维度：${Object.keys(save.definition.ruleset.relationship_dimensions).join('、') || '无'}）。说出人物名字我就能告诉你是哪一份数据。`;
    const summary = relationshipSummary(view, target);
    const entries = (view.entities.find(entity => entity.id === view.player_id)?.components.relationships?.entries ?? {}) as Record<string, unknown>;
    return `${String(target.components.identity?.name ?? target.id)}：${summary.text}（来源：${summary.source === 'graph' ? '关系数值' : '人物档案'}${entries[target.id] ? '，两人之间已有关系数值' : '，目前还没有关系数值'}）。`;
  }
 const availableTools=toolAvailability(view.capabilities).filter(tool=>tool.available).map(tool=>tool.name);
  const enabledModules=view.modules.filter(module=>module.enabled).map(module=>module.id);
  const installedExtensions=extensions.filter(([,entry])=>entry.installed&&entry.enabled).map(([,entry])=>String(entry.manifest.name));
  // Availability is read from live runtime state, never from a static promise: an answered question about
  // development must separate extension work, gated core work and the missing image provider.
  const extensionDevelopmentAvailable=service.systemCapabilities.get('feature.develop')?.implemented===true;
  const coreDevelopmentAvailable=toolAvailability(view.capabilities).find(tool=>tool.tool_id==='framework.development')?.available===true;
  const development=[
    `扩展开发：${extensionDevelopmentAvailable?'可用，能把新玩法整理成受校验的扩展开发任务；构建与验证通过后由你确认安装。':'当前不可用。'}`,
    `框架核心开发：${coreDevelopmentAvailable?'可用，但受安全门约束——在隔离工作区进行，必须通过自动测试并经你明确确认，不会直接改动你正在运行的世界或存档。':'当前不可用。'}`,
  ].join(' ');
  const image=providers.image.configured
    ? `图片生成已接入（${providers.image.provider}）。`
    : '图片生成 Provider 尚未接入；我会明确报告这个外部依赖，不会假装生成成功。';
  const goalControls=service.systemCapabilities.availability(view.capabilities).filter(item=>item.available&&item.id.startsWith('open_goal.'))
    .map(item=>({query:'查询',cancel:'指定取消',resume:'指定恢复'} as Record<string,string>)[item.id.slice('open_goal.'.length)]);
  return [
    `当前启用的世界模块：${enabledModules.join('、')||'仅核心运行时'}。`,
    `当前可见面板：${view.panels.map(panel=>panel.label).join('、')||'无'}。`,
    installedExtensions.length?`当前启用的扩展：${installedExtensions.join('、')}。`:'当前没有启用的扩展。',
    `可用操作包括：${availableTools.join('、')||'读取当前世界状态'}。`,
    `玩家开放目标管理：${goalControls.filter(Boolean).join('、')||'当前不可用'}；与世界任务和开发任务分别管理。`,
    `文本 AI：${providers.text.provider}${providers.text.model?` / ${providers.text.model}`:''}。${image}`,
    development,
  ].join('\n');
}
async function resolveUnderstanding(service: GameService, view: ReturnType<typeof publicView>, save: Awaited<ReturnType<GameService['current']>>, toolsList: AvailableTool[], text: string, context: SystemExecutionContext, precomputed?:SystemUnderstanding): Promise<SystemResult | null> {
  const session = context.session;
  const prior = context.previous ?? session.resolved_request ?? null;
  const merge = mergeAnswer(context, text, view);
  let understanding = mergeInto(session.understanding, merge);
  let source: 'model' | 'deterministic' = 'deterministic';
  if (!merge) {
    const answer = precomputed?{understanding:precomputed,source:'model' as const}:await understandSystemRequest(service, view, save, text, {
      current_goal: session.current_goal, understanding: session.understanding, pending_field: session.pending_field, previous: prior,
    });
    understanding = answer.understanding; source = answer.source;
  }
  if (!understanding) return null;
  if(understanding.goal_control)return {...await delegateGoalManagement(service,{input:text,...context.requestEnvelope},understanding.goal_control),understanding,workflow:'goal_management'};
  if(understanding.likely_workflow==='goal_management'||understanding.likely_workflow==='unclear'&&understanding.understood.length&&understanding.confidence>=.8){
    const planned=await resolveUniversalGoal(service,text,context.requestEnvelope??{}, {capabilityScope:'open_goals'});
    if(planned.handled)return {...universalSystemResult(planned),understanding,workflow:'goal_management'};
  }
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
  const explicitPreference=shallowUnderstanding(text,view).narrative_preference;
  const modelPreference=understanding.narrative_preference&&understanding.confidence>=0.8&&
    understanding.side_effect_class==='configuration'&&understanding.likely_workflow==='behavior_config'&&
    understanding.style_target!=='character';
  const preference=explicitPreference??(modelPreference?understanding.narrative_preference:null);
  if(preference){
    const requestedTopics=preference.topics;
    const hasStyle=Boolean(preference.tone&&preference.scopes.length);
    if(preference.mode==='require'&&requestedTopics.length){
      return {category:'BEHAVIOR_CONFIGURATION',tool_id:null,side_effect_level:'none',needs_confirmation:false,
        message:'题材偏好不能强制事件或人物行为必然发生，也不会提高出现概率。本次没有修改配置；可以设置为允许在自然因果下出现。',
        understanding,workflow:'behavior_config'};
    }
    if(preference.mode==='exclude'&&requestedTopics.length){
      return {category:'BEHAVIOR_CONFIGURATION',tool_id:null,side_effect_level:'none',needs_confirmation:false,
        message:'目前这一项只支持记录允许的题材范围；这次没有修改配置。',understanding,workflow:'behavior_config'};
    }
    const allowedTopics=preference.mode==='allow'?requestedTopics:[];
    if(hasStyle||allowedTopics.length){
      const next=await service.setNarrativePreferences({scopes:hasStyle?preference.scopes:[],tone:hasStyle?preference.tone:null,allowed_topics:allowedTopics},context.requestEnvelope);
      const updated=await service.current(),rules=updated.behavior_config;
      const parts=[hasStyle?`语言/叙事风格：${behaviorSummary(rules)}`:null,
        allowedTopics.length?`世界题材允许范围：${contentAllowanceSummary(updated.definition.roleplay_config?.content_allowances??[])}`:null].filter(Boolean);
      return {category:'BEHAVIOR_CONFIGURATION',tool_id:'behavior.configure',side_effect_level:'configuration',needs_confirmation:false,
        title:allowedTopics.length?(hasStyle?'叙事与世界题材配置':'世界题材配置'):'语言与叙事风格配置',
        message:`已更新${parts.join('；')}。允许出现不代表强制生成或提高概率；具体情节仍由人物意愿、世界状态与事件因果决定，人物可以拒绝。年龄以世界记录为准，世界事实和行动结算不变。`,
        advanced:{behavior:rules,content_allowances:updated.definition.roleplay_config?.content_allowances??[]},
        view:next,understanding,workflow:'behavior_config',resolved:hasStyle?resolvedFrom('behavior_config',rules.at(-1)??null,text):null};
    }
    if(preference.mode==='allow'&&!requestedTopics.length)return {
      category:'BEHAVIOR_CONFIGURATION',tool_id:null,side_effect_level:'none',needs_confirmation:false,
      message:'我理解你想放宽当前世界的题材范围。请说明具体允许哪些题材；这次没有修改配置。',
      clarification:'content_topics',understanding,workflow:'behavior_config'};
  }
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
  const actionableTask = understanding.likely_workflow === 'development_task' && understanding.target_surfaces.length === 1
    && (understanding.clarification?.needed !== true || (answering && session.workflow === 'development_task'));
  // A vague development idea is shaped by one experience question before any technical work starts. An active
  // guide owns the follow-up turns (delegate answer, adjustment, confirmation) and never writes canonical world.
  // A clear, side-effect-free request is answered immediately: no guide, no development task, no question form.
  if (understanding) {

    const literal = text.match(/[“"「『]([^”"」』]{1,60})[”"」』]/)?.[1]?.trim() ?? null;
    const settled = understanding;
    const direct = (message: string, advanced?: Record<string, unknown>) => ({ category: 'SYSTEM_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message, understanding: settled, workflow: settled.likely_workflow, expression: 'template' as const, ...(advanced ? { advanced } : {}) });
    if (literal && /(只回复|只回|回复我|回我|说出|照着说)/.test(text)) return direct(literal);
    if (/(道歉|道个歉|对不起)/.test(text) && /(说|给|来|道|要)/.test(text)) return direct('对不起。');
    if (/(打个?招呼|问个好|问声好|问好)/.test(text)) return direct('你好。');
    if (settled.side_effect_class === 'none' && !settled.unresolved.length && settled.likely_workflow === 'capability_question') {
      return { category: 'CAPABILITY_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: capabilityAnswer(service, view, save, text), title: '能力说明', understanding: settled, workflow: 'capability_question', expression: 'template', ...(settled.response_hint ? { advanced: { understanding_response_hint: settled.response_hint } } : {}) };
    }
  }
  const activeGuide
 = Boolean(session.guide && session.guide.status !== 'confirmed');

  // Whatever the model called the open point, a development wish that names no surface is an idea to shape — the
  // player must never receive the model's technical question (capability gaps, schemas, existing modules).
  const answeringOtherField = context.answeringClarification === true && !['想法方向', '想法确认'].includes(session.pending_field ?? '');
  // The deterministic read of the player's own sentence also counts: a real provider may file "我想加个潜力系统"
  // as a module/capability question, and the player must still get the idea guide instead of a technical answer.
  const wishIsDevelopment = understanding.likely_workflow === 'development_task'
    || shallowUnderstanding(text, view).likely_workflow === 'development_task';
  // A read-only question about the player's own appearance is a truth query: answered from canonical state,
  // never routed to a clarification ("who is the player?") or to the capability summary.
  if (/我.{0,6}(有(没有)?|拥有).{0,4}(头像|立绘|造型|外观)/.test(text) || /(头像|立绘).{0,4}(有没有|有吗|是什么|是多少)/.test(text)) {
    const player = view.entities.find(entity => entity.id === view.player_id);
    const identity = (player?.components.identity ?? {}) as { avatar_id?: string | null; name?: string };
    const visuals = (player?.components.visual_assets ?? {}) as { images?: Record<string, string> };
    const avatar = identity.avatar_id ?? null, fullbody = visuals.images?.fullbody ?? null;
    const state = !player ? 'UNAVAILABLE' : avatar ? 'FOUND' : fullbody ? 'NOT_FOUND' : 'NOT_DEFINED';
    const message = !player ? '还没有载入世界，所以现在查不到头像。'
      : avatar ? `你现在有头像（${String(identity.name ?? '你的角色')}）。`
      : fullbody ? '你还没有设置头像，但已经有一张全身图，可以直接裁一张头像。'
      : '你还没有头像，也没有可用于裁剪的全身图。';
    return { category: 'SYSTEM_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message, title: '人物资源', advanced: { truth_query: 'avatar', state, entity_id: player?.id ?? null, has_fullbody: Boolean(fullbody) }, understanding, workflow: 'media_asset', expression: 'template' };
  }
  // Creation provenance: what the world was authored as, read straight from the save (no model, no guessing).
  if (/(这个)?世界.{0,8}(最开始|最初|原本|一开始|创建时|初始|开始).{0,8}(设定|背景|主题|来源|描述)/.test(text) || /(世界观|世界设定).{0,6}(是什么|怎样|如何)/.test(text)) {
    const meta = (save.definition.meta ?? {}) as { title?: string; description?: string };
    const premise = String(meta.description ?? '').trim();
    const theme = String(((save.definition as { world?: { description?: string } }).world ?? {}).description ?? '').trim();
    const parts = [premise, theme && theme !== premise ? theme : ''].filter(Boolean);
    return {
      category: 'SYSTEM_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: parts.length ? `创建时的设定是：${parts.join('\n')}\n（细节以世界运行中已经发生的内容为准。）` : '这个世界的创建记录里没有写明初始设定。',
      title: '世界设定',
      advanced: { truth_query: 'creation_provenance', has_premise: Boolean(premise), has_theme: Boolean(theme) },
      understanding, workflow: 'capability_question', expression: 'template',
    };
  }
  const guideForIdea = !answeringOtherField && (activeGuide || (wishIsDevelopment

    && (understanding.unresolved.length > 0 || understanding.understood.length > 0))) && !understanding.target_surfaces.length && !surfacesIn(text).length
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
    const surfaces = understanding.target_surfaces.length ? understanding.target_surfaces : surfacesIn(text);
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
    return { category: 'CAPABILITY_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: capabilityAnswer(service, view, save, text), understanding, workflow: 'capability_question', expression: 'template', ...(understanding.response_hint ? { advanced: { understanding_response_hint: understanding.response_hint } } : {}) };
  }
  // 6. Understood, but it maps onto no single deterministic tool (yet). Answer with what was understood and the
  //    nearest honest next step instead of falling back to a canned "I don't understand".
  if(understanding.likely_workflow==='behavior_config')return null;
  if (understanding.understood.length) {
    return {
      category: 'SYSTEM_ANSWER', tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: `${understanding.understood.join('；')}。\n如果这需要改动界面或玩法，我可以直接把它作为开发任务整理需求；如果只是要调整某个系统的开关或范围，告诉我具体是哪一项就行。`,
      understanding, workflow: understanding.likely_workflow, expression: 'template',
    };
  }
  return null;
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
  const save = await service.current(), view = service.project(save);
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
      const target = byName[0];
      if(!target)return result(plan,'没有找到你明确指定的人物；请核对名字，或明确说“我的角色”。',toolsList,{clarification:'which_entity'});
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
        // A storage response can fail after commit. Let request recovery inspect
        // the prepared receipt instead of claiming that nothing changed.
        throw error;
      }
      return result(plan, `${tool.tool_id === 'module.enable' ? '已启用' : tool.tool_id === 'module.disable' ? '已停用' : '已移除'}「${moduleLabel(moduleId)}」。`, toolsList, { needs_confirmation: false, advanced: { revision: next.revision, panels: next.panels.map(panel => panel.id) } });
    }
    case 'save.export':
      return result(plan, '已准备导出标准存档包。', toolsList, { directive: { kind: 'export_save' } });
    case 'extension.create':
      return result(plan, '这需要一个 Framework 目前没有的玩法。我会在「高级开发」里准备一个候选扩展，构建与验证通过后由你确认安装；它不会自动改框架源码。', toolsList, { title: '开发任务', directive: { kind: 'extension_development', request: String(plan.args.request ?? body.input) } });
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
      // Core development is wired: it uses the existing development workspace, and any core-source change only
      // runs behind the isolated build/test gate plus the player's explicit confirmation.
      return result(plan, '修改 Framework 核心或存档机制属于框架开发：这个能力已经接通，会走隔离工作区、自动测试和安全门，只有全部通过并经你明确确认后才会生效。我先把它整理成一个开发任务。', toolsList, { title: '开发任务', directive: { kind: 'extension_development', request: String(plan.args.request ?? body.input) } });
    default:
      return result(plan, '我还不确定你的目标，可以再具体一点吗？', toolsList);
  }
}
function resolvedFrom(workflow: SystemWorkflow, rule: { op?: string; value?: string; application?: BehaviorApplication; scope?: BehaviorScope } | null, summary: string): ResolvedSystemRequest {
  return { workflow, at: new Date().toISOString(), summary, scope: rule?.scope ?? null, application: rule?.application ?? null, value: rule?.value ?? null, op: (rule?.op as 'suffix' | 'prefix' | 'tone' | 'constraint' | undefined) ?? null, module: null, entity_id: null };
}
async function executeSystemInput(service: GameService, raw: unknown, context: SystemExecutionContext,
  semantic?:import('../agent/semantic-entry.js').SemanticDecision,recoveryAttempted=false): Promise<SystemResult> {
  const body = safeParse(z.strictObject({ input: z.string().min(1).max(2000), confirmed: z.boolean().default(false), request_id: z.string().uuid().optional(), expected_revision: z.number().int().nonnegative().optional(),game_id:z.string().optional() }), raw);
  context.requestEnvelope={request_id:body.request_id,expected_revision:body.expected_revision,game_id:body.game_id};
  const save = await service.current(), view = service.project(save), toolsList = toolAvailability(view.capabilities);
  const plan = planMeta(body.input, view.capabilities);
  if(semantic?.goal_spec?.goal_control){
    if(semantic.kind!=='system_operation'||semantic.operation_plane!=='system_management')return {
      category:'EXECUTION_FAILURE',tool_id:null,side_effect_level:'none',needs_confirmation:false,message:'这项目标管理操作未获得系统管理授权，尚未执行。'};
    return delegateGoalManagement(service,{...body,input:context.latest??body.input},semantic.goal_spec.goal_control,semantic.goal_spec);
  }
  // A live semantic decision is the authority for the operation plane. Capability handlers
  // can fill parameters, but an unavailable world edit cannot become a development request.
  if(semantic?.operation_plane==='world_authoring'){
    if(!semantic.goal_spec)return {category:'USER_AMBIGUITY',tool_id:null,side_effect_level:'none',needs_confirmation:false,
      message:'这次还不能确认要修改的世界目标，世界没有改变。请补充具体对象和期望变化。'};
    const authorized=semantic.goal_spec.world_mutation&&
      !semantic.goal_spec.desired_outputs.some(output=>output.kind==='feature');
    if(!authorized){
      if(!recoveryAttempted){
        const revised=await interpretSemanticEntry(service,view,body.input,'SYSTEM',null,context.session,
          {failure_code:'authorization_mismatch',failure_stage:'world_authoring_precommit'});
        if(revised?.kind==='system_operation'&&revised.operation_plane==='world_authoring')
          return executeSystemInput(service,body,context,revised,true);
      }
      return {category:'USER_AMBIGUITY',tool_id:null,side_effect_level:'none',needs_confirmation:false,
        message:'拟修改的对象或结果没有得到这条请求的明确授权，世界没有改变。请确认具体目标。'};
    }
    const resolution=await resolveUniversalGoal(service,body.input,
      {request_id:body.request_id,expected_revision:body.expected_revision},
      {external_effects_confirmed:body.confirmed,authoritativeGoal:semantic.goal_spec});
    if(resolution.handled&&resolution.kind==='CAPABILITY_GAP'&&resolution.recoverable&&!recoveryAttempted){
      currentTrace()?.warn('system.goal_recovery',{metadata:{failure_code:'goal_capability_coverage',
        stage:'world_authoring_precommit',missing:resolution.missing,revision:save.state_revision}});
      const revised=await interpretSemanticEntry(service,view,body.input,'SYSTEM',null,context.session,
        {failure_code:'goal_capability_coverage',failure_stage:'world_authoring_precommit',
          detail:resolution.missing.join('；').slice(0,400)});
      if(revised?.kind==='system_operation'&&revised.operation_plane==='world_authoring')
        return executeSystemInput(service,body,context,revised,true);
    }
    if(resolution.handled&&resolution.kind==='EXECUTION_FAILURE'&&resolution.recoverable&&!recoveryAttempted){
      currentTrace()?.warn('system.goal_recovery',{metadata:{failure_code:'profile_parameters_invalid',
        stage:'world_authoring_precommit',reason:resolution.reason??null,revision:save.state_revision}});
      const revised=await interpretSemanticEntry(service,view,body.input,'SYSTEM',null,context.session,
        {failure_code:'profile_parameters_invalid',failure_stage:'world_authoring_precommit',
          detail:resolution.reason??'人物资料字段无效'});
      if(revised?.kind==='system_operation'&&revised.operation_plane==='world_authoring')
        return executeSystemInput(service,body,context,revised,true);
    }
    if(!resolution.handled)return {category:'CAPABILITY_GAP',tool_id:null,side_effect_level:'none',needs_confirmation:false,
      message:'目前没有可验证的世界编辑能力完成这项目标；世界没有改变。不会自动创建框架开发任务。'};
    return universalSystemResult(resolution);
  }
  if(semantic?.operation_plane==='framework_development'){
    const selected=['EXTENSION_REQUEST','FRAMEWORK_DEVELOPMENT'].includes(plan.category)?plan:
      {...plan,category:'EXTENSION_REQUEST' as const,tool_id:'extension.create',args:{request:body.input},
        needs_confirmation:true,reply:null};
    return executeTool(service,selected,body,context,toolsList,context.entityId);
  }
  const entityId = context.entityId;
  // The session goal is what the tool layer executes; understanding always reads what the player just said.
  const latest = context.latest ?? body.input;
  // This is a System-only semantic compiler. It never routes a game action or edits the baseline.
  // The provider owns the distinction between persistent runtime guidance, a style
  // configuration, and ordinary discussion. This compiler only proposes advisory patches;
  // it cannot execute a world action or create a patch unless it returns `create`.
  const providerName=service.ai.adapter.name;
  const liveProvider=!['mock','fixture'].includes(providerName);
  const freshConfiguration=plan.tool_id!=='behavior.clear'&&!context.answeringClarification&&!context.behaviorScope;
  const configurationUnderstanding=liveProvider&&freshConfiguration
    ?(await understandSystemRequest(service,view,save,latest,null)).understanding:undefined;
  // Control delegation precedes the advisory behavior compiler. The latter must
  // neither swallow an executable management request nor add an unrelated call.
  if(configurationUnderstanding&&(configurationUnderstanding.goal_control||configurationUnderstanding.likely_workflow==='goal_management'||
    configurationUnderstanding.likely_workflow==='unclear'&&configurationUnderstanding.confidence>=.8&&configurationUnderstanding.understood.length)){
    const delegated=await resolveUnderstanding(service,view,save,toolsList,latest,context,configurationUnderstanding);
    if(delegated)return delegated;
  }
  if(semantic?.operation_plane==='system_management'&&
    (['EXTENSION_REQUEST','FRAMEWORK_DEVELOPMENT'].includes(plan.category)||
      configurationUnderstanding?.likely_workflow==='development_task'))
    return {category:'USER_AMBIGUITY',tool_id:null,side_effect_level:'none',needs_confirmation:false,
      message:'这次配置请求与拟执行的开发操作不一致，世界和框架都没有改变。请说明要调整的现有设置。'};
  const configuredPreference=Boolean(configurationUnderstanding&&configurationUnderstanding.confidence>=0.8
    &&(['style','topic'].includes(configurationUnderstanding.configuration_kind??'')
      ||(configurationUnderstanding.configuration_kind===null
        &&configurationUnderstanding.style_target!=='character'
        &&Boolean(configurationUnderstanding.narrative_preference?.tone||configurationUnderstanding.narrative_preference?.mode))));
  const behaviorCandidate=liveProvider&&freshConfiguration&&!configuredPreference;
  if(behaviorCandidate){
    const feedback=await compileBehaviorFeedback(service,latest,body.request_id);
    if(feedback.kind==='create'){
      const saved=await service.putBehaviorPatch(feedback.patch);
      return {category:'AI_BEHAVIOR_FEEDBACK',tool_id:'behavior.guidance',side_effect_level:'configuration',needs_confirmation:false,
        title:'AI 行为指导',message:`已保存「${feedback.patch.title}」（${feedback.patch.scope==='global'?'全局':feedback.patch.scope==='world'?'当前世界':'当前会话'}）。${feedback.overridden?`它覆盖了「${feedback.overridden}」。`:''}这只指导后续判断，不能改变世界事实或绕过结算。`,
        view:saved.view,advanced:{behavior_patches:saved.patches}};
    }
    if(feedback.kind==='rejected')return {category:'AI_BEHAVIOR_FEEDBACK',tool_id:null,side_effect_level:'none',needs_confirmation:false,
      title:'AI 行为指导',message:feedback.reason};
    // A prose or topic configuration is deliberately "discussion" to the patch compiler;
    // let the existing System configuration model handle it instead of stopping here.
  }
  // A second-person question is about this Assistant: a recently talked-to NPC must not supply its subject.
  if(asksAboutAssistant(latest)){context.preferredNames=undefined;context.entityId=undefined;}
  // A goal that is still waiting for a clarification keeps its original request: short answers fill it in,
  // they are not understood again from zero (and never become a different goal).
  const pendingGoal = context.session.pending_goal;
  const answersPending = Boolean(pendingGoal) && isClarificationReply(latest);
  let universalInput = pendingGoal && answersPending ? [pendingGoal.original_input, ...pendingGoal.clarifications, latest].join('；') : latest;
  if(pendingGoal&&isDelegateAnswer(latest)){
    const delegated=await service.ai.systemAgent(z.strictObject({resolved_request:z.string().min(1).max(600)}),save.definition.prompt_profile,{
      instruction:'玩家已把一个低风险选择交给你。根据原请求和待回答问题自行选一个合理具体值，返回一条可执行的自然语言请求。保留原目标与对象；不要请求随机工具，不要反问，不要添加新功能或重大后果。只输出 JSON。',
      original_request:pendingGoal.original_input,question:pendingGoal.question,player_reply:latest,
    },save);
    if(delegated)universalInput=delegated.resolved_request;
    else return {category:'EXECUTION_FAILURE',tool_id:null,side_effect_level:'none',needs_confirmation:false,message:'这次没能完成你委托的选择，世界状态没有改变；稍后可以重试。',pending_goal:pendingGoal};
  }
  const explicitPreference=shallowUnderstanding(universalInput,view).narrative_preference;
  const universal = semantic?.operation_plane==='system_management'||explicitPreference?{handled:false as const}:
    await resolveUniversalGoal(service, universalInput, { request_id: body.request_id, expected_revision: body.expected_revision }, { external_effects_confirmed: body.confirmed });
  // Existing local media fallbacks (for example cropping an already stored full-body image) remain usable even
  // when the requested generation chain reports a missing provider capability.
  const mediaGap = universal.handled && universal.kind === 'CAPABILITY_GAP'
    && universal.goal.desired_outputs.some(output => output.kind === 'media_asset');
  if (universal.handled && !mediaGap) {
    const base = universalSystemResult(universal);
    const revision = (await service.current()).state_revision;
    const nextPending = universal.kind === 'USER_AMBIGUITY'
      ? {
        goal_id: pendingGoal?.goal_id ?? crypto.randomUUID(),
        original_input: pendingGoal?.original_input ?? latest,
        clarifications: [...(pendingGoal?.clarifications ?? []), latest].slice(-6),
        question: universal.question,
        created_revision: pendingGoal?.created_revision ?? revision,
      }
      : null;
    return { ...base, pending_goal: nextPending };
  }
  // A System write may only run for the sentence the player just sent, for a confirmation of it, or as the answer
  // to a clarification that the write itself asked for. A planned write left over from an earlier request is
  // never replayed because a later, unrelated message kept the session alive.
  const planned = toolsList.find(tool => tool.tool_id === plan.tool_id);
  const writeLevels = ['configuration', 'canonical-management', 'canonical-state', 'development'];
  const ownClarificationFields = ['要调整的系统', '作用范围', '人物', '展示位置'];
  const boundToCurrentRequest = body.input === latest || body.confirmed === true || context.behaviorScope !== undefined || Boolean(context.session.guide)
    || (context.answeringClarification === true && ownClarificationFields.includes(context.session.pending_field ?? ''))
    || (context.answeringClarification === true && context.session.workflow === 'development_task' && plan.tool_id === 'extension.create');
  if (planned && writeLevels.includes(planned.side_effect_level) && !boundToCurrentRequest) {
    context.session.pending_confirmation = null;
    context.session.pending_field = null;
    return {
      category: plan.category, tool_id: null, side_effect_level: 'none', needs_confirmation: false,
      message: '当前待处理的修改与刚才的需求不一致，因此没有执行。你可以把想改的东西重新说一遍；如果确实要执行刚才那件事，请直接说明要确认它。',
    };
  }
  if ((plan.tool_id==='behavior.configure'&&!context.behaviorScope)||explicitPreference||needsUnderstanding(plan, latest, context)) {
    const resolved = await resolveUnderstanding(service, view, save, toolsList, latest, context,configurationUnderstanding);
    if (resolved) {
      if(mediaGap&&universal.handled&&universal.kind==='CAPABILITY_GAP')return {...resolved,category:'CAPABILITY_GAP',advanced:{...resolved.advanced,resolution_kind:universal.kind,missing:universal.missing,goal:universal.goal,plan:universal.plan}};
      return resolved;
    }
  }

  const executed = await executeTool(service, plan, body, context, toolsList, entityId);
  // Optional second call: only to phrase a real execution result, never to change its semantics.
  return express(service, view, save, body.input, executed, context);
}

async function delegateGoalManagement(service:GameService,body:{input:string;request_id?:string;expected_revision?:number;game_id?:string},control:OpenGoalControl,goal?:GoalSpec):Promise<SystemResult>{
 if(goal&&(!goal.goal_control||goal.goal_control.kind!==control.kind||goal.goal_control.target!==control.target)){
   const reason_code='goal_control_source_conflict';
   const issues=[{field:'goal.goal_control',expected:control,actual:goal.goal_control}];
   currentTrace()?.warn('system.goal_control.rejected',{metadata:{reason_code,issues}});
   return {category:'EXECUTION_FAILURE',tool_id:null,side_effect_level:'none',needs_confirmation:false,
     message:'目标管理语义来源不一致，尚未执行。',advanced:{reason_code,authorization_issues:issues}};
 }
 const authoritativeGoal=goal??goalSpecSchema.parse({objective:body.input.slice(0,600),goal_control:control,
   persistence:'session',world_mutation:false,external_artifact:false,multi_step:false});
 const resolution=await resolveUniversalGoal(service,body.input,body,{authoritativeGoal,capabilityScope:'open_goals'});
 return resolution.handled?universalSystemResult(resolution):{category:'EXECUTION_FAILURE',tool_id:null,side_effect_level:'none',needs_confirmation:false,
   message:'这项目标管理操作尚未形成可验证的执行契约，尚未执行。'};
}
function universalSystemResult(resolution: Exclude<UniversalResolution, { handled: false }>): SystemResult {
  if (resolution.kind === 'EXECUTED') return { category: resolution.goal.goal_control?'OPEN_GOAL_CONTROL':'UNIVERSAL_GOAL', tool_id: resolution.plan.steps.at(-1)?.capability_id ?? null, side_effect_level:resolution.goal.goal_control&&['queried','already_terminal'].includes(String((resolution.details?.goal_control as any)?.status))?'none':'canonical-state', needs_confirmation: false, message: resolution.message, view: resolution.view, ...(resolution.goal.goal_control?{workflow:'goal_management' as const}:{}), resolved: resolvedFrom(resolution.goal.goal_control?'goal_management':'capability_question',null,resolution.goal.objective), advanced: { resolution_kind: resolution.kind, goal: resolution.goal, plan: resolution.plan, ...(resolution.details ?? {}) } };
  if (resolution.kind === 'USER_AMBIGUITY') return { category: 'USER_AMBIGUITY', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: resolution.candidates.length ? `${resolution.question}\n${resolution.candidates.join('、')}` : resolution.question, clarification: 'universal_goal', pending_field: '具体目标', advanced: { resolution_kind: resolution.kind } };
  if (resolution.kind === 'CAPABILITY_GAP') return { category: 'CAPABILITY_GAP', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: resolution.message, advanced: { resolution_kind: resolution.kind, missing: resolution.missing, goal: resolution.goal, plan: resolution.plan } };
  return { category: 'EXECUTION_FAILURE', tool_id: null, side_effect_level: 'none', needs_confirmation: false, message: resolution.message,view:resolution.view, advanced: { ...(resolution.details??{}),resolution_kind: resolution.kind, retryable: resolution.retryable, goal: resolution.goal, plan: resolution.plan, reason:resolution.reason??null } };
}
const expressionSchema = z.strictObject({ message: z.string().min(1).max(800) });
async function express(service: GameService, view: ReturnType<typeof publicView>, save: Awaited<ReturnType<GameService['current']>>, text: string, executed: SystemResult, context: SystemExecutionContext): Promise<SystemResult> {
  const adapter = (service.ai as unknown as { adapter?: { name?: string } } | undefined)?.adapter;
  const executor = (service.ai as unknown as { systemAgent?: unknown });
  if (!adapter || adapter.name === 'mock' || typeof executor.systemAgent !== 'function') return executed;
  if(executed.category==='OPEN_GOAL_CONTROL'||executed.advanced?.goal_control)return executed;
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

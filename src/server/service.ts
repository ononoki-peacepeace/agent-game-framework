import {failureReason,ProviderError} from '../ai/failures.js';
import {sparseStep} from '../routine/scheduler.js';
import {updateInteraction} from '../core/interaction.js';
import {checkpointTurn,canUndo,historyAvailable,imageHash,worldImage,worldKeys} from '../core/turn-history.js';
import {avatarCropSchema,type AvatarCropMetadata} from '../shared/avatar.js';
import {calendarSchema} from '../routine/schema.js';
import {migrateInstalledWorld,type InstalledWorld} from '../routine/migration.js';
import { settleRoutine,applyLifePatches } from './routine-controller.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GameError, assert, safeParse, profileSchema, worldCreationProvenanceSchema, type SavePackage, type WorldCreationProvenance } from '../core/schema.js';
import { normalizeProvenance } from '../core/provenance.js';
import { exportSave, importSave, newSave, publicView, validateSave } from '../core/state.js';
import { executeFreeform,isPhysicalAction,assertFreeformGoalEvidence } from '../core/freeform.js';
import {applyNarrativeClaims} from '../core/narrative-claims.js';
import {NarrativePatternError,validateResolvedNarrative} from '../core/narrative-firewall.js';
import {makeCompiledChoiceOffers} from '../core/choice-offer.js';
import { executeAction, applyPatches } from '../core/runtime.js';
import { routineModule } from '../modules/routine.js';
import { capabilityList, createRegistry, moduleStatuses } from '../modules/index.js';
import type { PendingTurn,SaveStorage } from '../storage/json-store.js';
import type { AIRuntime } from '../ai/runtime.js';
import type { WorldPackage } from '../core/schema.js';
import { normalizeCharacterCard } from '../compat/character-card.js';
import { emptyWorld } from '../ai/authoring.js';
import { blankWorldIntent } from '../shared/world-intent.js';
import { parseBehaviorRule } from '../ai/behavior.js';
import {CapabilityRegistry,capabilityRegistry} from '../system/capabilities.js';
import {applyStoryCommand,noteMeaningfulTurn,observeCanonicalTurn,type StoryCommand} from '../narrative/runtime.js';
import {drainBackgroundDisplay} from '../background/runtime.js';
import {roleplayConfigSchema,type RoleplayConfig} from '../narrative/schema.js';
import type {ImageAssetRuntime, PersistedImage} from '../media/image.js';

import { getLogger, observe, startTrace, runWithTrace, currentTrace, summarizeSaveDiff, errorText, type StructuredLogger } from '../observability/index.js';
const optionalEnrichmentOps = new Set(['relationship_delta']);
function compoundStepId(requestId:string,index:number){
  const hex=createHash('sha256').update(`${requestId}:local-compound:${index}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/**
 * Optional narrator enrichment (for example a relationship delta) is applied per patch. A rejected enrichment is
 * dropped with a structured log so it can never discard valid prose; an unknown operation still throws, so a real
 * transaction problem can never be swallowed.
 */
function applyOptionalEnrichment(save: SavePackage, patches: unknown[], action: Parameters<typeof applyPatches>[2], registry: Parameters<typeof applyPatches>[3], requestId: string) {
  let next = save;
  for (const patch of patches ?? []) {
    const op = (patch as { op?: string }).op ?? '';
    try { next = applyPatches(next, [patch], action, registry); }
    catch (error) {
      if (!optionalEnrichmentOps.has(op)) throw error;
      observe('warn','enrichment.dropped',{module:'turn',request_id:requestId,metadata:{op,reason:errorText(error).slice(0,220),target_id:(patch as {target_id?:string}).target_id??null}});
    }
  }
  return next;
}
/** Player-facing prose for the rare case where narration itself failed: never a tool summary, never an internal id. */
function narrationFallback(save: SavePackage, action: Parameters<typeof applyPatches>[2]) {
  const target = action.target_id ? save.entities.find(entity => entity.id === action.target_id) : undefined;
  const targetName = String(target?.components.identity?.name ?? '对方');
  if (action.type === 'TALK' || action.type === 'SOCIAL_INTERACT') return `你把话说出口了；${targetName}这一刻的反应没有来得及写出来。事情已经发生，世界时间按规则向前走了一小段。`;
  return '这个动作已经完成，但这一刻的场景描写没有生成。世界状态已经按规则保存。';
}

export const requestSchema = z.strictObject({ request_id: z.string().uuid(), game_id: z.string().uuid(), expected_revision: z.number().int().min(0), action: z.unknown().optional(), input: z.string().min(1).max(2000).optional(), end_conversation:z.boolean().optional() }).refine(x => (x.action !== undefined) !== (x.input !== undefined), '必须提供 action 或 input 中的一项');
// Media fields live in the save for portability, but they are not canonical gameplay state.
function preservePresentation(source: SavePackage, target: SavePackage) {
  for (const entity of target.entities) {
    const from = source.entities.find(item => item.id === entity.id);
    if (!from) continue;
    if (entity.components.identity && from.components.identity && 'avatar_id' in from.components.identity) entity.components.identity.avatar_id = from.components.identity.avatar_id;

    if (from.components.visual_assets) entity.components.visual_assets = structuredClone(from.components.visual_assets);
  }
}
export class GameService {
  private busy = false;
  private readonly pendingTurns=new Map<string,PendingTurn>();
  private mediaQueue:Promise<unknown>=Promise.resolve();
  private imageRuntime:ImageAssetRuntime|null=null;
  private readonly runtimeCapabilities=new Set<string>();
  routineLease:string|null=null;
  // Presentation-only writes (avatars, full-body art) run on their own short queue: they never take the
  // canonical gameplay lock, so they stay usable while a routine job is compiling or waiting for AI.
  private media<T>(fn:()=>Promise<T>):Promise<T>{
    const run=this.mediaQueue.then(()=>fn(),()=>fn());
    this.mediaQueue=run.catch(()=>undefined);
    return run;
  }
  // A routine may only take over at a safe handoff point. Enabling it never preempts a foreground transaction.
  async handoffBlocker(): Promise<{kind:'foreground_busy'|'player_decision';reason:string}|null>{
    if(this.busy)return {kind:'foreground_busy',reason:'当前玩家行动或世界指令正在结算'};
    const raw=await this.storage.read();
    if(!raw)return null;
    if(Object.values(raw.extensions??{}).some(e=>e.state&&typeof e.state==='object'&&!Array.isArray(e.state)&&e.state.phase==='playing'))return {kind:'player_decision',reason:'当前小游戏尚未结束，请先完成或撤退'};
    // Narrator suggestions are optional affordances, not a canonical player decision gate.
    if(raw.foreground?.blocker)return {kind:'player_decision',reason:raw.foreground.reason||'当前事务尚未完成'};
    if(raw.last_turn?.speaker && /[？?]|等待.{0,12}(回答|答复|决定)|你(是否|愿意|打算)/.test(raw.last_turn.dialogue??''))return {kind:'player_decision',reason:'当前人物仍在等待你的答复'};
    const routine=raw.entities.find(entity=>entity.id===raw.player_state.entity_id)?.components.routine as {interrupted?:boolean;last_interrupt?:string|null}|undefined;
    if(routine?.interrupted&&routine.last_interrupt)return {kind:'player_decision',reason:String(routine.last_interrupt).slice(0,180)};
    return null;
  }
  private ensureBaseFeatures(save: SavePackage) {
    let changed = false;
    if (save.definition.enabled_modules.includes('routine')) {
      // Every save that has the routine module also has a routine component, so state is explicit.
      const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
      if (player && !player.components.routine) { routineModule.manifest?.setup?.(save); changed = true; }
    }

    // Normalisation always runs last, so a save is only ever returned and persisted in its current shape.
    const migrated = migrateInstalledWorld(save, this.installedWorlds);
    return { save: validateSave(migrated.save), changed: changed || migrated.changed };
  }
  constructor(readonly storage: SaveStorage, readonly ai: AIRuntime, readonly demo: WorldPackage, readonly installedWorlds:InstalledWorld[] = [], readonly logger: StructuredLogger = getLogger(),readonly systemCapabilities:CapabilityRegistry=new CapabilityRegistry(capabilityRegistry.all())) {}
  configureImageGeneration(runtime:ImageAssetRuntime){
    this.imageRuntime=runtime;this.runtimeCapabilities.add('media.image_generation');
    this.systemCapabilities.activate(['media.image.generate','asset.persist','character.avatar.assign']);
  }
  async imageProviderStatus(){
    if(!this.imageRuntime)return {status:'adapter_missing' as const,configured:false,provider:null,reason:'当前没有图片生成服务'};
    const availability=await this.imageRuntime.available();
    if(availability.available)return {status:'available' as const,configured:true,provider:this.imageRuntime.provider.id,reason:null};
    const reason=availability.reason??'图片服务当前不可用';
    return {status:/credential|api[ _-]?key|token|凭证|密钥|认证/i.test(reason)?'credential_missing' as const:'provider_failure' as const,configured:true,provider:this.imageRuntime.provider.id,reason};
  }  runtimeProviderStatus(){
    const text=this.ai.adapter.providerInfo?.()??{};
    return {
      text:{provider:text.provider??this.ai.adapter.name,model:text.model??null},
      image:this.imageRuntime?{configured:true,provider:this.imageRuntime.provider.id}:{configured:false,provider:null},
    };
  }
  project(save:SavePackage){const view=publicView(save);view.capabilities=[...new Set([...view.capabilities,...this.runtimeCapabilities])];return view;}
  async hasPendingTurn(requestId:string){return Boolean(await this.storage.readPending?.(requestId)??this.pendingTurns.get(requestId));}
  private async localCompoundCandidate(current:SavePackage,requestId:string,steps:readonly string[]){
    assert(steps.length>=2&&steps.length<=4&&steps.every(step=>step.trim().length>0),'局部复合行动步骤无效');
    const location=current.entities.find(entity=>entity.id===current.player_state.entity_id)?.components.location?.location_id;
    let candidate=current,last:ReturnType<typeof executeAction>|undefined;
    const receipts:NonNullable<SavePackage['resolution_receipts']>=[];
    const facts:string[]=[];
    for(const [index,step] of steps.entries()){
      assert(!candidate.foreground?.blocker,'局部复合行动中途出现需要玩家决定的事项；世界状态没有改变。');
      const stepId=compoundStepId(requestId,index);
      const input=await this.ai.interpret(candidate,step);
      assert(input.type!=='MOVE'&&!['START_ROUTINE','CONTINUE_ROUTINE'].includes(input.type),
        '行动需要进入另一场景，不能作为局部复合行动提交。');
      const generic=input.type==='FREEFORM_ACTION';
      const turn=generic?executeFreeform(candidate,step,await this.ai.freeform(candidate,step),stepId):
        executeAction(candidate,input,stepId,'ai');
      const receipt=turn.save.resolution_receipts?.find(entry=>entry.request_id===stepId);
      assert(receipt&&['success','strong_success'].includes(receipt.outcome),'局部复合行动有步骤未完成；世界状态没有改变。');
      // A registered action must satisfy the same player-goal evidence checks as a freeform step.
      assertFreeformGoalEvidence(turn.save,step,stepId);
      assert(turn.save.entities.find(entity=>entity.id===current.player_state.entity_id)?.components.location?.location_id===location,
        '行动已离开当前场景，不能作为局部复合行动提交。');
      assert(!turn.save.foreground?.blocker,'局部复合行动被世界事件打断；世界状态没有改变。');
      assert(!turn.save.resolution_history?.find(entry=>entry.check_id===receipt.check_id)?.hidden,
        '行动结果尚未公开，不能继续局部复合行动。');
      candidate=turn.save;last=turn;receipts.push(receipt);facts.push(...turn.facts);
    }
    assert(last,'局部复合行动缺少程序结算');
    const allFacts=receipts.flatMap(receipt=>receipt.canonical_facts);
    // The receipt schema caps the Narrator projection at 12 facts. Drop only generic attempt/time
    // boilerplate when needed; never hide a mechanical or background-world fact to fit that cap.
    const canonicalFacts=allFacts.length<=12?allFacts:allFacts.filter(fact=>
      !fact.startsWith('尝试行动：')&&!fact.startsWith('本次行动经过 '));
    assert(canonicalFacts.length<=12,'局部复合行动凭据超过单回合上限；世界状态没有改变。');
    const totalMinutes=receipts.reduce((sum,receipt)=>sum+receipt.time_cost,0);
    const aggregate={...receipts.at(-1)!,request_id:requestId,action_id:requestId,
      semantic_action:steps.join('，').slice(0,1000),time_cost:totalMinutes,canonical_facts:canonicalFacts,
      effects:[...new Set(receipts.flatMap(receipt=>receipt.effects))],activity:undefined,storage:undefined,
      progress_changes:receipts.flatMap(receipt=>receipt.progress_changes??[]),commit_status:'pending' as const};
    candidate.resolution_receipts=[...(candidate.resolution_receipts??[]),aggregate].slice(-200);
    return {turn:{...last,save:candidate,action:{...last.action,id:requestId,time_cost:totalMinutes},facts},receipts};
  }
  async exclusive<T>(fn: () => Promise<T>,owner?:string): Promise<T> {
    if(this.routineLease && owner!==this.routineLease)throw new GameError('后台生活模式正在运行：查看与图片上传不受影响；需要修改世界的行动请先在生活模式面板请求安全暂停',409);
    if (this.busy) throw new GameError('当前有行动或存档操作正在执行，请稍后重试', 409);
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  async current() {
    const raw = await this.storage.read(); assert(raw, '请先开始新游戏或导入存档');
    const upgraded = this.ensureBaseFeatures(raw);
    if (upgraded.changed) await this.storage.write(upgraded.save);
    return upgraded.save;
  }
  async view() {
    const raw = await this.storage.read();
    if (!raw) return null;
    const upgraded = this.ensureBaseFeatures(raw);
    if (upgraded.changed) await this.storage.write(upgraded.save);
    return this.project(upgraded.save);
  }
  async newGame(description?: string, promptText?: string, promptProfile?: unknown, provenance?: WorldCreationProvenance, roleplayConfig?:RoleplayConfig) {
    return this.exclusive(async () => {
      let profile = promptProfile ? safeParse(profileSchema, promptProfile) : structuredClone(this.demo.prompt_profile);
      if (promptText) profile = { ...profile, id: 'imported_prompt', version: 'user-1', engine_policy: promptText };
      // Every creation entry (HTTP, service, future routes) resolves EMPTY_WORLD / FRAMEWORK_TEST here.
      const blank = description ? blankWorldIntent(description) : null;
      const save = blank ? newSave(emptyWorld(profile)) : description ? await this.ai.initialize(description, profile,roleplayConfig) : newSave(this.demo);
      if(roleplayConfig)save.definition.roleplay_config=roleplayConfigSchema.parse(roleplayConfig);
      if(provenance){
        const generated=[...save.entities.map(entity=>({kind:'entity' as const,id:entity.id})),...(save.definition.map?.locations??[]).map(location=>({kind:'location' as const,id:location.id}))];
        // Provenance records are atomic cells (a statement may be quoted back to the player). A long premise is split
// loss-free here, so one over-long sentence can never fail an otherwise valid world creation.
save.definition.provenance=worldCreationProvenanceSchema.parse(normalizeProvenance({...provenance,generated_canonical_fact_refs:generated}));
      }
      if (blank) save.last_turn = { narrative: '', speaker: null, dialogue: null, choices: [], context_actions: [] };
      if (!save.last_turn) save.last_turn = { narrative: save.definition.meta.description, speaker: null, dialogue: null, choices: [], context_actions: [] };
      await this.storage.write(save); return publicView(save);
    });
  }
  async turn(raw: unknown,owner?:string,signal?:AbortSignal,onPhase?:(phase:string)=>void,compileOnly=false,completeFutureId?:string,compoundSteps?:readonly string[],forceFreeform=false,
    goalCommit?:(before:SavePackage,next:SavePackage,requestId:string)=>void) {
    return this.exclusive(async () => {
      const request = safeParse(requestSchema, raw);
      const trace = currentTrace()??startTrace({ module: 'turn', logger: this.logger, request_id: request.request_id, game_id: request.game_id });
      return runWithTrace(trace, async () => {
      const req = request, current = await this.current();
      const beforeTurn=structuredClone(current);
      const fingerprint = createHash('sha256').update(JSON.stringify({ action: req.action, input: req.input,...(req.end_conversation?{end_conversation:true}:{}),...(completeFutureId?{complete_future:completeFutureId}:{}),...(compoundSteps?{compound_steps:compoundSteps}:{}) })).digest('hex');
      if (req.game_id !== current.game_id) { trace.warn('save.conflict', { revision: current.state_revision, metadata: { reason: 'game_id_mismatch' } }); throw new GameError('游戏已切换，请刷新后操作', 409); }
      const receipt = current.runtime.receipts.find(r => r.id === req.request_id);
      if (receipt) { assert(receipt.fingerprint === fingerprint, '请求 ID 已用于另一行动');this.pendingTurns.delete(req.request_id);await this.storage.clearPending?.(req.request_id).catch(()=>undefined); return publicView(current); }
      if (req.expected_revision !== current.state_revision) { trace.warn('save.conflict', { revision: current.state_revision, metadata: { reason: 'expected_revision_mismatch', expected_revision: req.expected_revision, actual_revision: current.state_revision } }); throw new GameError('状态已更新，请刷新后重试', 409); }
      const pending=await this.storage.readPending?.(req.request_id)??this.pendingTurns.get(req.request_id);
      let generic:boolean,turn:ReturnType<typeof executeAction>;
      if(pending){
        assert(pending.game_id===current.game_id&&pending.expected_revision===current.state_revision&&pending.fingerprint===fingerprint,'待完成判定与当前请求不一致');
        generic=pending.generic;turn={save:validateSave(pending.candidate),action:pending.action,facts:pending.facts,events:[],registry:createRegistry(current.definition.enabled_modules)};
      }else{
        let input = req.action;
        if (req.input) input = compoundSteps||forceFreeform?{type:'FREEFORM_ACTION',parameters:{}}:
          await trace.measure('intent.compile', () => this.ai.interpret(current, req.input as string));
        if(req.input&&isPhysicalAction(req.input)&&(input as {type:string}).type!=='FREEFORM_ACTION'){
          trace.warn('intent.action_mismatch',{metadata:{interpreted_type:(input as {type:string}).type,expected_family:'physical'}});
          throw new GameError('这次行动没有正常完成，世界状态没有改变，可以安全重试。',503);
        }
        if(req.input&&['START_ROUTINE','CONTINUE_ROUTINE'].includes((input as {type:string}).type))throw new GameError('请在生活模式面板提交此计划，或输入“开始生活模式：你的计划”，以后台运行。');
        if(completeFutureId){const intent=current.future_intents?.find(i=>i.id===completeFutureId);const action=input as {type:string;target_id?:string};assert(intent?.status==='due'&&['TALK','SOCIAL_INTERACT'].includes(action.type)&&intent.target_entities.includes(action.target_id??''),'计划缺少有效的到期社交行动证据');}
        trace.info('agent.action_selected',{metadata:{step_request_id:req.request_id,
          source:req.input?'interpreted':'provided_action',action_type:(input as {type:string}).type,
          target_id:(input as {target_id?:string}).target_id??null}});
        generic=Boolean(compoundSteps||forceFreeform)||!!req.input && (input as {type?:string})?.type === 'FREEFORM_ACTION';
        turn=compoundSteps?(await this.localCompoundCandidate(current,req.request_id,compoundSteps)).turn:
          generic ? executeFreeform(current, req.input!, await this.ai.freeform(current,req.input!), req.request_id) : executeAction(current, input, req.request_id, req.input ? 'ai' : 'player');
        if(generic)assert(turn.save.resolution_receipts?.some(entry=>entry.request_id===req.request_id),'开放世界行动缺少程序判定凭据');
        if(!generic||turn.save.resolution_receipts?.some(entry=>entry.request_id===req.request_id)){
          const staged:PendingTurn={game_id:current.game_id,request_id:req.request_id,fingerprint,expected_revision:current.state_revision,candidate:turn.save,action:turn.action,facts:turn.facts,generic};
          await this.storage.writePending?.(staged);this.pendingTurns.set(req.request_id,structuredClone(staged));
        }
      }
      let next = turn.save;
      const notices: string[] = [];
      let interaction: {target_id:string;status:'active'|'ended'}|null=null;
      if (['START_ROUTINE','CONTINUE_ROUTINE'].includes(turn.action.type)) {
        const maxMinutes = Math.min(Number(turn.action.parameters.max_minutes ?? 1440), 1440, next.definition.ruleset.minutes_per_day);
        const actor=next.entities.find(e=>e.id===next.player_state.entity_id)!;
        if(!actor.components.routine.plan){onPhase?.('compiler');const plan=await this.ai.compileRoutine(next,signal);actor.components.routine.plan=plan;actor.components.routine.plan_revision=Number(plan.source_revision??0);actor.components.routine.status=plan.clarification?'interrupted':'armed';}
        signal?.throwIfAborted();
        const clarification=(actor.components.routine.plan as {clarification?:string|null}).clarification;
        if(clarification){actor.components.routine.active=false;actor.components.routine.enabled=true;actor.components.routine.status='interrupted';actor.components.routine.interrupted=true;actor.components.routine.last_interrupt=clarification;next.last_turn={narrative:clarification,speaker:null,dialogue:null,choices:[],context_actions:[]};}
        else if(!compileOnly) next = await trace.measure('routine.scheduler', () => sparseStep(next, this.ai, next.runtime.time.day*next.definition.ruleset.minutes_per_day+next.runtime.time.minute+maxMinutes,signal,onPhase));
      } else if(['SAVE_ROUTINE','CLEAR_ROUTINE','CANCEL_ROUTINE','PAUSE_ROUTINE'].includes(turn.action.type)) {
        next.last_turn=structuredClone(current.last_turn);
        notices.push(...turn.facts);
      } else try {
        const receipt=generic?next.resolution_receipts?.find(entry=>entry.request_id===req.request_id):undefined;
        if(generic)assert(receipt,'开放行动缺少程序判定凭据');
        if(generic&&!compoundSteps)assertFreeformGoalEvidence(next,req.input!,req.request_id);
        const compoundReceipts=compoundSteps?.map((_,index)=>next.resolution_receipts?.find(entry=>entry.request_id===compoundStepId(req.request_id,index)));
        if(compoundSteps)assert(compoundReceipts?.every(Boolean),'局部复合行动缺少步骤凭据');
        const check=next.resolution_history?.find(entry=>entry.request_id===req.request_id);
        const narrateValidated=async()=>{
          let repair: {reason:string;pattern_kind?:string;match_index?:number;snippet?:string;allowed_effects?:string[]}|undefined;
          for(let attempt=1;attempt<=3;attempt++){
            observe('info','narrative.attempt',{module:'turn',request_id:req.request_id,
              metadata:{narrator_attempt:attempt,retry:attempt>1,
                ...(repair?.pattern_kind?{previous_rejected_pattern_kind:repair.pattern_kind}:{})}});
            // Discarded narration must not alter even the candidate's AI thread metadata.
            const narrationCandidate=structuredClone(next);
            const result=await this.ai.narrate(narrationCandidate,turn.action,turn.facts,receipt,repair,
              compoundReceipts as NonNullable<SavePackage['resolution_receipts']>|undefined);
            if(check&&/(?:掷出|骰出|骰点|掷得|\bd(?:20|6|100)\b|rolled?\s+\d+)/i.test(result.narrative)){
              observe('warn','narrative.unverified_dice_claim',{module:'turn',request_id:req.request_id,metadata:{check_id:check.check_id}});
              result.narrative=check.hidden?'你完成了这次尝试；目前还不能确认结果。':
                ['success','strong_success'].includes(check.outcome)?'你完成了这次尝试，结果符合预期。':
                check.outcome==='partial_success'?'这次尝试取得了部分进展。':'这次尝试没有达到预期。';
            }
            if(receipt)try{
              validateResolvedNarrative(receipt,result,Boolean(check?.hidden),
                compoundReceipts as NonNullable<SavePackage['resolution_receipts']>|undefined);
            }catch(error){
              if(!(error instanceof GameError))throw error;
              const reason=errorText(error);
              observe('warn','narrative.mechanical_claim_discarded',{module:'turn',request_id:req.request_id,
                metadata:{reason:reason.slice(0,200),narrator_attempt:attempt,retry:attempt>1,
                  ...(error instanceof NarrativePatternError?{pattern_kind:error.patternKind,
                    match_index:error.matchIndex,snippet:error.snippet,allowed_effects:receipt.effects}: {})}});
              if(attempt===3){
                observe('warn','narrative.retry_exhausted',{module:'turn',request_id:req.request_id,
                  metadata:{attempts_used:attempt,reason:reason.slice(0,200)}});
                throw error;
              }
              repair={reason,...(error instanceof NarrativePatternError?{
                pattern_kind:error.patternKind,match_index:error.matchIndex,snippet:error.snippet,
                allowed_effects:[...receipt.effects]}:{})};
              continue;
            }
            if(narrationCandidate.ai.threads.narrator)
              next.ai.threads.narrator=narrationCandidate.ai.threads.narrator;
            if(attempt>1){
              observe('info','narrative.regenerated',{module:'turn',request_id:req.request_id,
                metadata:{attempts_used:attempt,check_id:receipt?.check_id??null}});
              observe('info','narrative.mechanical_claim_regenerated',{module:'turn',request_id:req.request_id,
                metadata:{check_id:receipt?.check_id??null,attempts_used:attempt}});
            }
            return result;
          }
          throw new GameError('场景描写未通过结算校验，本回合尚未提交，可以安全重试。',503);
        };
        const result=await narrateValidated();
        interaction=result.interaction??null;
        try{
          if(check&&((result.item_claims??[]).length||(result.stable_locations??[]).length))throw new GameError('判定后的描写不能补造新的世界实体');
          next=applyNarrativeClaims(next,result);
        }
        catch(error){observe('warn','narrative.claims.rejected',{module:'turn',request_id:req.request_id,metadata:{reason:errorText(error).slice(0,220)}});throw new GameError('这次场景描写没有通过世界状态校验，本回合尚未结算，可以安全重试。',503);}
        // Valid prose and optional enrichment are separate concerns: a rejected enrichment must never discard the narration.
        next = applyOptionalEnrichment(next, result.patches, turn.action, turn.registry, req.request_id);
        const offers=await makeCompiledChoiceOffers(next,result.choices,result.choice_semantics??[],this.ai);
        next.last_turn = { narrative: result.narrative, speaker: result.speaker, dialogue: result.dialogue,
          choices:offers.filter(offer=>offer.availability_at_generation!=='UNSUPPORTED').map(offer=>offer.text),choice_offers:offers,context_actions: result.context_actions };
      } catch (error) {
        if(error instanceof GameError)throw error;
        if (!['refusal','content_filter'].includes(failureReason(error))) {
          observe('warn','narration.aborted_before_commit',{module:'turn',request_id:req.request_id,metadata:{action:turn.action.type,reason:failureReason(error),detail:errorText(error).slice(0,240)}});
          // An unclassified narration failure may still be a transient provider error.
          // Only a structured contract validation failure is deterministic here.
          const retryable=!(error instanceof z.ZodError);
          const failure=new GameError(retryable?
            error instanceof ProviderError?
              '叙事服务暂时未完成，本回合尚未结算，可从当前目标继续。':
              '叙事生成未完整完成，本回合尚未结算，可从当前目标继续。':
            '候选内容未通过程序校验，本回合尚未结算；需要修复后再继续当前目标。',503) as GameError&{
              retry_policy:'safe'|'manual'};
          failure.retry_policy=retryable?'safe':'manual';
          throw failure;
        }
        // Explicit provider refusal permits a neutral, player-facing safety fallback.
        observe('warn','narration.safety_degraded',{module:'turn',request_id:req.request_id,metadata:{action:turn.action.type,reason:failureReason(error)}});
        delete next.ai.threads.narrator;
        next.last_turn = { narrative: narrationFallback(next, turn.action), speaker: null, dialogue: null, choices: [], context_actions: [] };
        notices.push('本次行动已完成并保存；这一刻的场景描写暂时没有生成。');
      }
      const exposed=drainBackgroundDisplay(next);
      if(exposed.length&&next.last_turn){
        const missing=exposed.filter(text=>!next.last_turn!.narrative.includes(text));
        if(missing.length)next.last_turn.narrative=[next.last_turn.narrative,...missing].join('\n');
      }
      return this.media(async()=>{
      onPhase?.('validating');
      // A presentation-only write may have committed while this turn ran: keep it and never write a lower revision.
      const latest = await this.storage.read();
      if (latest) { preservePresentation(latest, next); next.state_revision = Math.max(current.state_revision, latest.state_revision) + 1; }
      else next.state_revision = current.state_revision + 1;
      if(next.last_turn?.choice_offers)for(const offer of next.last_turn.choice_offers){
        offer.source_revision=next.state_revision;
        if(offer.goal_contract?.contract){
          offer.goal_contract.contract.source_revision=next.state_revision;
          offer.goal_contract.contract.last_observed_revision=next.state_revision;
        }
      }
      next.runtime.receipts = [...next.runtime.receipts, { id: req.request_id, fingerprint, revision: next.state_revision }].slice(-100);
      if(completeFutureId){const intent=next.future_intents!.find(i=>i.id===completeFutureId)!;intent.status='completed';intent.completed_by_request=req.request_id;}
      const worldTurn=!compileOnly&&!['SAVE_ROUTINE','CLEAR_ROUTINE','CANCEL_ROUTINE','PAUSE_ROUTINE'].includes(turn.action.type);
      if(worldTurn){
        updateInteraction(next,turn.action,beforeTurn,interaction);
        if(req.end_conversation&&next.interaction_context)next.interaction_context.status='ended';
        next.narrative_history=[...(beforeTurn.narrative_history??[]),{request_id:req.request_id,narrative:next.last_turn?.narrative??'',dialogue:next.last_turn?.dialogue??null,speaker:next.last_turn?.speaker??null,facts:turn.facts.slice(0,12).map(f=>f.slice(0,2000))}].slice(-8);
        if(!['MOVE','WAIT','INSPECT','SAVE_ROUTINE','CONTINUE_ROUTINE'].includes(turn.action.type)){observeCanonicalTurn(next,req.request_id,turn.facts);noteMeaningfulTurn(next);}
      }
      const resolutionReceipt=next.resolution_receipts?.find(entry=>entry.request_id===req.request_id);
      if(generic)assert(resolutionReceipt,'开放世界行动缺少程序判定凭据');
      if(generic&&!compoundSteps)assertFreeformGoalEvidence(next,req.input!,req.request_id);
      if(req.input&&isPhysicalAction(req.input)&&(!resolutionReceipt||turn.action.type!=='FREEFORM_ACTION')){
        trace.warn('turn.physical_consistency_rejected',{metadata:{action:turn.action.type,effects:resolutionReceipt?.effects??[]}});
        throw new GameError('这次行动没有正常完成，世界状态没有改变，可以安全重试。',503);
      }
      if(resolutionReceipt)resolutionReceipt.commit_status='committed';
      if(compoundSteps)for(const index of compoundSteps.keys()){
        const stepReceipt=next.resolution_receipts?.find(entry=>entry.request_id===compoundStepId(req.request_id,index));
        assert(stepReceipt,'局部复合行动步骤凭据丢失');stepReceipt.commit_status='committed';
      }
      // The committed action, its receipt and the plan step it satisfies share one atomic save image.
      goalCommit?.(beforeTurn,next,req.request_id);
      signal?.throwIfAborted();
      const validated = trace.span('patch.validation');
      try { next = validateSave(next); }
      catch (error) { trace.warn('patch.validation.rejected', { metadata: { stage: 'commit', reason: errorText(error) } }); throw error; }
      finally { validated.end({ revision: next.state_revision }); }
      if(worldTurn)checkpointTurn(beforeTurn,next,req.request_id);
      onPhase?.('committing');
      const diff = summarizeSaveDiff(current, next), commit = trace.span('save.commit');
      await this.storage.write(next);
      this.pendingTurns.delete(req.request_id);await this.storage.clearPending?.(req.request_id).catch(error=>observe('warn','resolution.pending_cleanup_failed',{module:'turn',request_id:req.request_id,metadata:{reason:errorText(error)}}));
      trace.info('save.commit', { revision: next.state_revision, metadata: { step_request_id:req.request_id,revision_before: current.state_revision, revision_after: next.state_revision, validation: 'accepted', action: turn.action.type, source: turn.action.source, ...diff } });
      commit.end(diff);
      return { ...publicView(next), notices };
      });
      });
    },owner);
  }
  async configureCalendar(raw:unknown,gameId:string,revision:number){return this.exclusive(async()=>{const save=await this.current();assert(save.game_id===gameId&&save.state_revision===revision,'状态已更新，请刷新后重试');save.calendar=safeParse(calendarSchema,raw);migrateInstalledWorld(save,this.installedWorlds);save.state_revision++;await this.storage.write(validateSave(save));return publicView(save);});}
  async acknowledgeTask(_id:string,_gameId:string,_revision:number,_outcome:'completed'|'cancelled'='completed'):Promise<never>{throw new GameError('不能手工标记任务完成或取消日历事件；任务结果必须由已登记的任务规则结算',410);}
  async checkpoint() { return this.exclusive(async () => { const save = await this.current(); await this.storage.write(save, 'checkpoint'); return publicView(save); }); }
  async narrativeCommand(raw:{request_id:string;game_id:string;expected_revision:number},command:StoryCommand){
    return this.exclusive(async()=>{
      const current=await this.current(),fingerprint=`narrative:${command}`;
      assert(raw.game_id===current.game_id,'游戏已切换，请刷新');
      const receipt=current.runtime.receipts.find(entry=>entry.id===raw.request_id);if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return {view:publicView(current),message:''};}
      if(raw.expected_revision!==current.state_revision)throw new GameError('状态已更新，请刷新后重试',409);
      const before=structuredClone(current),next=structuredClone(current),message=applyStoryCommand(next,command);
      next.state_revision=current.state_revision+1;next.runtime.receipts=[...next.runtime.receipts,{id:raw.request_id,fingerprint,revision:next.state_revision}].slice(-100);
      next.last_turn={narrative:message,speaker:null,dialogue:null,choices:[],context_actions:[]};
      checkpointTurn(before,next,raw.request_id);const validated=validateSave(next);await this.storage.write(validated);return {view:publicView(validated),message};
    });
  }
  async undo(raw:unknown){
    const req=safeParse(z.strictObject({request_id:z.string().uuid(),game_id:z.string().uuid(),expected_revision:z.number().int().min(0)}),raw);
    return this.exclusive(()=>this.media(async()=>{
      const current=await this.current(),fingerprint='undo';
      assert(req.game_id===current.game_id,'游戏已切换，请刷新');
      const receipt=current.runtime.receipts.find(r=>r.id===req.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(current);}
      if(req.expected_revision!==current.state_revision)throw new GameError('状态已更新，请刷新后重试',409);
      assert(canUndo(current),'当前没有可安全撤回的世界回合，或之后已有其他世界状态修改');
      const cp=current.turn_checkpoint!,next=structuredClone(current);
      assert(cp.before.game_id===current.game_id&&Object.keys(cp.before).every(key=>(worldKeys as readonly string[]).includes(key)),'撤回快照边界校验失败');
      // Replace the complete world image, including keys absent before the turn, while preserving external state.
      for(const key of Object.keys(worldImage(next)))delete (next as any)[key];
      Object.assign(next,structuredClone(cp.before));
      next.runtime.receipts=[...current.runtime.receipts,{id:req.request_id,fingerprint,revision:current.state_revision+1}].slice(-100);
      next.state_revision=current.state_revision+1;next.ai={threads:{}};
      preservePresentation(current,next);
      next.turn_audit=[...(current.turn_audit??[]),{turn_id:cp.turn_id,parent_turn_id:cp.parent_turn_id,reverted_at:next.state_revision,before:cp.before,after:worldImage(current)}];
      next.turn_history=(current.turn_history??[]).filter(entry=>entry.turn_id!==cp.turn_id);
      next.active_turn_id=cp.parent_turn_id;
      const previous=next.turn_history.at(-1);
      if(previous){
        assert(previous.after_hash===imageHash(next),'撤回后的历史快照不一致');
        next.turn_checkpoint={turn_id:previous.turn_id,parent_turn_id:previous.parent_turn_id,before:structuredClone(previous.before),after_hash:previous.after_hash};
      }else delete next.turn_checkpoint;
      const validated=validateSave(next);await this.storage.write(validated);
      this.logger.info('turn.reverted',{module:'turn',request_id:req.request_id,revision:validated.state_revision,metadata:{turn_id:cp.turn_id}});
      return publicView(validated);
    }));
  }
  async restoreTurn(raw:unknown){
    const req=safeParse(z.strictObject({request_id:z.string().uuid(),game_id:z.string().uuid(),expected_revision:z.number().int().min(0),turn_id:z.string().uuid()}),raw);
    return this.exclusive(()=>this.media(async()=>{
      const current=await this.current(),fingerprint='history:'+req.turn_id;
      assert(req.game_id===current.game_id,'游戏已切换，请刷新');
      const receipt=current.runtime.receipts.find(r=>r.id===req.request_id);if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(current);}
      if(req.expected_revision!==current.state_revision)throw new GameError('状态已更新，请刷新后重试',409);
      assert(historyAvailable(current),'当前历史之后已有其他世界状态修改，不能安全回溯');
      const history=current.turn_history!,index=history.findIndex(entry=>entry.turn_id===req.turn_id);
      assert(index>=0&&index<history.length-1,'请选择当前回合之前的历史');
      const target=history[index],snapshot=history[index+1].before,next=structuredClone(current);
      assert(snapshot.game_id===current.game_id&&Object.keys(snapshot).every(key=>(worldKeys as readonly string[]).includes(key)),'历史快照边界校验失败');
      for(const key of Object.keys(worldImage(next)))delete (next as any)[key];Object.assign(next,structuredClone(snapshot));
      next.turn_history=structuredClone(history.slice(0,index+1));next.active_turn_id=target.turn_id;delete next.turn_checkpoint;
      next.runtime.receipts=[...current.runtime.receipts,{id:req.request_id,fingerprint,revision:current.state_revision+1}].slice(-100);next.state_revision=current.state_revision+1;next.ai={threads:{}};preservePresentation(current,next);
      assert(imageHash(next)===target.after_hash,'历史快照完整性校验失败');
      next.turn_audit=[...(current.turn_audit??[]),{turn_id:current.active_turn_id!,parent_turn_id:target.turn_id,reverted_at:next.state_revision,before:snapshot,after:worldImage(current)}];
      const validated=validateSave(next);await this.storage.write(validated);this.logger.info('turn.history_restored',{module:'turn',request_id:req.request_id,revision:validated.state_revision,metadata:{turn_id:target.turn_id,discarded:history.length-index-1}});return publicView(validated);
    }));
  }
  async load() { return this.exclusive(async () => {
    const raw = await this.storage.read('checkpoint'); assert(raw, '还没有手动保存的检查点');
    const save = this.ensureBaseFeatures(raw).save;
    save.game_id = randomUUID(); save.ai.threads = {}; save.runtime.receipts = [];
    await this.storage.write(save); return publicView(save);
  }); }
  async import(raw: unknown) { return this.exclusive(async () => {
    const isSave = !!raw && typeof raw === 'object' && 'state_revision' in raw;
    let save = isSave ? importSave(migrateInstalledWorld(structuredClone(raw) as SavePackage,this.installedWorlds).save) : newSave(raw);
    save = this.ensureBaseFeatures(save).save;
    if (!save.last_turn) save.last_turn = { narrative: save.definition.meta.description, speaker: null, dialogue: null, choices: [], context_actions: [] };
    await this.storage.write(save); return publicView(save);
  }); }
  async importCharacterCard(raw: unknown, gameId: string, expectedRevision: number) {
    return this.exclusive(async () => {
      const save = await this.current();
      if (save.game_id !== gameId) throw new GameError('游戏已切换，请刷新后操作', 409);
      if (save.state_revision !== expectedRevision) throw new GameError('状态已更新，请刷新后重试', 409);
      assert(save.definition.enabled_modules.includes('characters'), '当前世界未启用 characters 模块');
      assert(save.entities.length < 1000, '实体数量已达到存档上限');
      const card = normalizeCharacterCard(raw);
      const player = save.entities.find(e => e.id === save.player_state.entity_id)!;
      const locationId = String(player.components.location?.location_id ?? '');
      assert(locationId, '玩家当前位置无效，无法放置导入角色');
      const entityId = `card_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const summary = (card.description || card.personality || '由角色卡导入的人物').slice(0, 2000);
      save.entities.push({
        id: entityId,
        type: 'character',
        components: {
          identity: { name: card.name, description: summary, avatar_id: null, gender: null, age: null },
          location: { location_id: locationId },
          character: { role: '导入角色卡人物', traits: [] },
          character_card: structuredClone(card) as unknown as SavePackage['entities'][number]['components'][string],
        },
      });
      save.state_revision++;
      const next = validateSave(save);
      await this.storage.write(next);
      const view = publicView(next);
      view.notices.push(`已导入角色卡：${card.name}。已放置在玩家当前位置；导入本身不推进时间，也不会调用 AI。`);
      return view;
    });
  }
  // Avatar and full-body art are presentation data: they use the media queue and ignore stale revisions,
  // so uploading a portrait works even while a routine job is compiling or calling AI.
  async generateAvatar(entityId:string,prompt:string,gameId:string,expectedRevision?:number):Promise<{view:ReturnType<GameService['project']>;artifact:PersistedImage}>{
    assert(this.imageRuntime,'当前没有配置图片生成 Provider');
    const before=await this.current();
    if(before.game_id!==gameId)throw new GameError('游戏已切换，请刷新后操作',409);
    if(expectedRevision!==undefined&&before.state_revision!==expectedRevision)throw new GameError('状态已更新，请刷新后重试',409);
    const entity=before.entities.find(item=>item.id===entityId);
    assert(entity?.components.identity,'目标没有可设置头像的身份信息');
    const identity=entity.components.identity as {name?:unknown;description?:unknown};
    const description=[String(identity.name??''),String(identity.description??''),prompt].filter(Boolean).join('；').slice(0,3000);
    const artifact=await this.imageRuntime.generateAndPersist({prompt:description,usage:'avatar',aspect:'square',entity_id:entityId});
    try{return {view:await this.setAvatar(entityId,artifact.asset_id,gameId,expectedRevision),artifact};}
    catch(error){await this.imageRuntime.discard(artifact);throw error;}
  }
  async setAvatar(entityId: string, avatarId: string | null, gameId: string, _expectedRevision?: number,crop?:AvatarCropMetadata) {
    return this.media(async () => {
      const save = await this.current();
      if (save.game_id !== gameId) throw new GameError('游戏已切换，请刷新后操作', 409);
      const entity = save.entities.find(e => e.id === entityId);
      assert(entity?.components.identity, '目标没有可设置头像的身份信息');
      entity.components.identity.avatar_id = avatarId;
      if(crop){const parsed=safeParse(avatarCropSchema,crop);assert(entity.components.visual_assets?.images&&((entity.components.visual_assets.images as Record<string,unknown>).fullbody===parsed.source_asset_id),'全身图已更换，请重新裁剪');entity.components.visual_assets.avatar_crop=parsed;}else if(entity.components.visual_assets)delete entity.components.visual_assets.avatar_crop;
      save.state_revision++;
      const next = validateSave(save);
      await this.storage.write(next);
      return this.project(next);
    });
  }
  async setVisualAsset(entityId: string, slot: string, assetId: string, gameId: string, _expectedRevision?: number) {
    return this.media(async () => {
      const save = await this.current();
      if (save.game_id !== gameId) throw new GameError('游戏已切换，请刷新后操作', 409);
      const entity = save.entities.find(e => e.id === entityId);
      assert(entity?.components.identity, '目标没有可设置人物图片的身份信息');
      const visual = (entity.components.visual_assets ??= {}) as Record<string, unknown>;
      const images = (visual.images && typeof visual.images === 'object' ? visual.images : {}) as Record<string, unknown>;
      images[slot] = assetId;
      visual.images = images;
      save.state_revision++;
      const next = validateSave(save);
      await this.storage.write(next);
      return this.project(next);
    });
  }
  async performDeclaredActivity(raw:{activity_id:string;game_id:string;expected_revision:number;request_id:string}){
    return this.exclusive(async()=>{
      const input=safeParse(z.strictObject({activity_id:z.string().min(1).max(80),game_id:z.string().uuid(),expected_revision:z.number().int().nonnegative(),request_id:z.string().uuid()}),raw);
      const current=await this.current(),fingerprint=createHash('sha256').update(JSON.stringify({activity_id:input.activity_id})).digest('hex');
      assert(current.game_id===input.game_id,'Game changed; refresh and retry');
      const receipt=current.runtime.receipts.find(item=>item.id===input.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'Request id already used');return this.project(current);}
      assert(current.state_revision===input.expected_revision,'State changed; refresh and retry');
      const rule=current.definition.routine_rules?.activities.find(item=>item.id===input.activity_id);assert(rule,'World does not declare this activity');
      const player=current.entities.find(entity=>entity.id===current.player_state.entity_id)!;
      assert(!rule.location_id||player.components.location?.location_id===rule.location_id,'Reach the activity location first');
      const effects=rule.effects.filter(effect=>effect.op!=='condition_delta'||Boolean(player.components.condition));
      const proposal={patches:effects} as import('../ai/routine.js').RoutineResult;
      applyLifePatches(structuredClone(current),proposal);
      let next=structuredClone(current);applyLifePatches(next,proposal);
      const original=next.definition.ruleset.max_wait_minutes;next.definition.ruleset.max_wait_minutes=Math.max(original,rule.duration);
      next=executeAction(next,{type:'WAIT',parameters:{minutes:rule.duration}},input.request_id,'player',undefined,undefined,false).save;
      next.definition.ruleset.max_wait_minutes=original;next.state_revision=current.state_revision+1;
      next.runtime.receipts=[...next.runtime.receipts,{id:input.request_id,fingerprint,revision:next.state_revision}].slice(-100);
      next.last_turn={narrative:rule.label+' completed.',speaker:null,dialogue:null,choices:[],context_actions:[]};
      await this.storage.write(validateSave(next));return this.project(next);
    });
  }
  async modules() {
    const save = await this.current();
    return { modules: moduleStatuses(save), capabilities: [...new Set([...capabilityList(createRegistry(save.definition.enabled_modules)),...this.runtimeCapabilities])], installed: save.modules };
  }
  /** Module lifecycle is a canonical mutation: same revision/idempotency rules as a turn. */
  async manageModule(raw: unknown, command: 'enable' | 'disable' | 'remove') {
    return this.exclusive(async () => {
      const body = safeParse(z.strictObject({ module: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), confirmed: z.boolean(), game_id: z.string().uuid(), expected_revision: z.number().int().min(0), request_id: z.string().uuid() }), raw);
      const current = await this.current();
      if (current.game_id !== body.game_id) throw new GameError('游戏已切换，请刷新后操作', 409);
      if (current.state_revision !== body.expected_revision) throw new GameError('状态已更新，请刷新后重试', 409);
      const action = { type: command === 'enable' ? 'ENABLE_MODULE' : command === 'disable' ? 'DISABLE_MODULE' : 'REMOVE_MODULE', parameters: { module: body.module, confirmed: body.confirmed } };
      // Removal is destructive: keep a checkpoint of the pre-removal state first.
      if (command === 'remove' && body.confirmed) {
        const checkpoint = structuredClone(current);
        checkpoint.runtime.receipts = [];
        await this.storage.write(checkpoint, 'checkpoint');
      }
      const turn = executeAction(current, action, body.request_id, 'player');
      const next = turn.save;
      next.state_revision = current.state_revision + 1;
      next.runtime.receipts = [...next.runtime.receipts, { id: body.request_id, fingerprint: createHash('sha256').update(JSON.stringify({ module_action: action })).digest('hex'), revision: next.state_revision }].slice(-100);
      await this.storage.write(validateSave(next));
      const view = publicView(next);
      view.notices.push(turn.facts.join(' '));
      this.logger.info('module.lifecycle', { module: 'framework', request_id: body.request_id, revision: next.state_revision, metadata: { command, target: body.module } });
      return view;
    });
  }
  async behaviorConfig() {
    return (await this.current()).behavior_config;
  }
  /** Per-character expression guidance. This is a canonical, revision-bound configuration edit, not a world turn. */
  async setCharacterPersona(raw:unknown){
    const body=safeParse(z.strictObject({game_id:z.string().uuid(),expected_revision:z.number().int().nonnegative(),request_id:z.string().uuid(),entity_id:z.string(),
      personality:z.string().max(2000),speech_style:z.string().max(2000),verbal_habits:z.string().max(2000)}),raw);
    return this.agentTransaction(body,{character_persona:body},save=>{
      const entity=save.entities.find(item=>item.id===body.entity_id);
      assert(entity&&entity.id!==save.player_state.entity_id&&entity.components.character,'请选择一个有效的世界人物');
      entity.components.character={...entity.components.character,personality:body.personality.trim(),speech_style:body.speech_style.trim(),verbal_habits:body.verbal_habits.trim()};
    });
  }
  async narrativeDebug(){const save=await this.current(),truth=save.gm_state.hidden_truth?.commitments??[];return {roleplay_config:save.definition.roleplay_config??null,narrative_state:save.narrative_state??null,hidden_truth_summary:{count:truth.length,commitments:Object.fromEntries(['HARD_TRUTH','SEEDED_TRUTH','UNDEFINED'].map(kind=>[kind,truth.filter(item=>item.commitment===kind).length])),evidence_count:truth.reduce((sum,item)=>sum+item.evidence.length,0),content:'仅保存在 GM 存档；此诊断接口不返回秘密正文'}};}
  /** Style configuration is framework configuration: it never advances time and never touches world facts. */
  async setBehaviorConfig(raw: unknown) {
    const input = safeParse(z.strictObject({
      scope: z.enum(['narration','dialogue','assistant']),
      instruction: z.string().min(1).max(200).optional(),
      // A contextual correction already resolved by the System Agent arrives as a structured rule, because the
      // value (for example 「喵~」) may not survive a round-trip through prose parsing.
      rule: z.strictObject({
        op: z.enum(['suffix','prefix','tone','constraint']),
        value: z.string().min(1).max(120),
        application: z.enum(['per_sentence','per_paragraph','per_message','final_sentence']).default('per_message'),
      }).optional(),
    }), raw);
    assert(input.rule || input.instruction, '缺少风格要求');
    return this.exclusive(async () => {
      const save = await this.current();
      const rule = input.rule
        ? {...input.rule, scope: input.scope, raw: (input.instruction ?? `${input.rule.op} ${input.rule.value}`).slice(0, 200), enabled: true, created_at: new Date().toISOString()}
        : parseBehaviorRule(input.instruction!, input.scope);
      save.behavior_config = [...(save.behavior_config ?? []).filter(existing => !(existing.scope === rule.scope && existing.op === rule.op)), rule].slice(-20);
      save.state_revision++;
      await this.storage.write(validateSave(save));
      this.logger.info('behavior.config.updated', { module: 'framework', revision: save.state_revision, metadata: { scope: rule.scope, op: rule.op, value: rule.value } });
      const view = publicView(save); view.notices.push('已更新运行时风格配置。'); return view;
    });
  }
  async clearBehaviorConfig(scope?: string) {
    return this.exclusive(async () => {
      const save = await this.current();
      save.behavior_config = (save.behavior_config ?? []).filter(rule => scope ? rule.scope !== scope : false);
      save.state_revision++;
      await this.storage.write(validateSave(save));
      const view = publicView(save); view.notices.push(scope ? '已恢复该范围的默认风格。' : '已恢复全部默认风格。'); return view;
    });
  }
  async export() { return exportSave(await this.current()); }

  async agentTransaction(raw:{game_id:string;expected_revision:number;request_id:string},operation:unknown,mutate:(save:SavePackage)=>void){
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=createHash('sha256').update(JSON.stringify({agent_operation:operation})).digest('hex');
      assert(save.game_id===raw.game_id,'游戏已切换');const receipt=save.runtime.receipts.find(r=>r.id===raw.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
      assert(save.state_revision===raw.expected_revision,'状态已更新，请重新规划');const before=structuredClone(save);mutate(save);save.state_revision++;
      save.runtime.receipts=[...save.runtime.receipts,{id:raw.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      checkpointTurn(before,save,raw.request_id);
      await this.storage.write(validateSave(save));this.logger.info('agent.transaction',{module:'agent',request_id:raw.request_id,revision:save.state_revision});return publicView(save);
    }));
  }
  async extensionTransaction(raw:{game_id:string;expected_revision:number;request_id:string},operation:unknown,mutate:(save:SavePackage)=>void){
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=createHash('sha256').update(JSON.stringify({extension_operation:operation})).digest('hex');
      assert(save.game_id===raw.game_id,'游戏已切换');const receipt=save.runtime.receipts.find(r=>r.id===raw.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
      if(save.state_revision!==raw.expected_revision)throw new GameError('状态已更新，请刷新后重试',409);
      mutate(save);save.state_revision++;save.runtime.receipts=[...save.runtime.receipts,{id:raw.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      await this.storage.write(validateSave(save));this.logger.info('extension.transaction',{module:'extension',request_id:raw.request_id,revision:save.state_revision,metadata:{operation}});
      return publicView(save);
    }));
  }
}

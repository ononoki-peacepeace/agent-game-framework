import {failureReason} from '../ai/failures.js';
import {sparseStep} from '../routine/scheduler.js';
import {updateInteraction} from '../core/interaction.js';
import {checkpointTurn,canUndo,worldImage,worldKeys} from '../core/turn-history.js';
import {avatarCropSchema,type AvatarCropMetadata} from '../shared/avatar.js';
import {calendarSchema} from '../routine/schema.js';
import {migrateInstalledWorld,type InstalledWorld} from '../routine/migration.js';
import { settleRoutine } from './routine-controller.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GameError, assert, safeParse, profileSchema, type SavePackage } from '../core/schema.js';
import { exportSave, importSave, newSave, publicView, validateSave } from '../core/state.js';
import { executeFreeform } from '../core/freeform.js';
import { executeAction, applyPatches } from '../core/runtime.js';
import { routineModule } from '../modules/routine.js';
import { capabilityList, createRegistry, moduleStatuses } from '../modules/index.js';
import type { SaveStorage } from '../storage/json-store.js';
import type { AIRuntime } from '../ai/runtime.js';
import type { WorldPackage } from '../core/schema.js';
import { normalizeCharacterCard } from '../compat/character-card.js';
import { emptyWorld } from '../ai/authoring.js';
import { blankWorldIntent } from '../shared/world-intent.js';
import { parseBehaviorRule } from '../ai/behavior.js';

import { getLogger, observe, startTrace, runWithTrace, summarizeSaveDiff, errorText, type StructuredLogger } from '../observability/index.js';
const optionalEnrichmentOps = new Set(['relationship_delta']);
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
  private mediaQueue:Promise<unknown>=Promise.resolve();
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
    if(raw.last_turn?.choices.length)return {kind:'player_decision',reason:'当前场景有尚未回答的选择'};
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
  constructor(readonly storage: SaveStorage, readonly ai: AIRuntime, readonly demo: WorldPackage, readonly installedWorlds:InstalledWorld[] = [], readonly logger: StructuredLogger = getLogger()) {}
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
    return publicView(upgraded.save);
  }
  async newGame(description?: string, promptText?: string, promptProfile?: unknown) {
    return this.exclusive(async () => {
      let profile = promptProfile ? safeParse(profileSchema, promptProfile) : structuredClone(this.demo.prompt_profile);
      if (promptText) profile = { ...profile, id: 'imported_prompt', version: 'user-1', engine_policy: promptText };
      // Every creation entry (HTTP, service, future routes) resolves EMPTY_WORLD / FRAMEWORK_TEST here.
      const blank = description ? blankWorldIntent(description) : null;
      const save = blank ? newSave(emptyWorld(profile)) : description ? await this.ai.initialize(description, profile) : newSave(this.demo);
      if (blank) save.last_turn = { narrative: '', speaker: null, dialogue: null, choices: [], context_actions: [] };
      if (!save.last_turn) save.last_turn = { narrative: save.definition.meta.description, speaker: null, dialogue: null, choices: [], context_actions: [] };
      await this.storage.write(save); return publicView(save);
    });
  }
  async turn(raw: unknown,owner?:string,signal?:AbortSignal,onPhase?:(phase:string)=>void,compileOnly=false,completeFutureId?:string) {
    return this.exclusive(async () => {
      const request = safeParse(requestSchema, raw);
      const trace = startTrace({ module: 'turn', logger: this.logger, request_id: request.request_id, game_id: request.game_id });
      return runWithTrace(trace, async () => {
      const req = request, current = await this.current();
      const beforeTurn=structuredClone(current);
      const fingerprint = createHash('sha256').update(JSON.stringify({ action: req.action, input: req.input,...(req.end_conversation?{end_conversation:true}:{}),...(completeFutureId?{complete_future:completeFutureId}:{}) })).digest('hex');
      if (req.game_id !== current.game_id) { trace.warn('save.conflict', { revision: current.state_revision, metadata: { reason: 'game_id_mismatch' } }); throw new GameError('游戏已切换，请刷新后操作', 409); }
      const receipt = current.runtime.receipts.find(r => r.id === req.request_id);
      if (receipt) { assert(receipt.fingerprint === fingerprint, '请求 ID 已用于另一行动'); return publicView(current); }
      if (req.expected_revision !== current.state_revision) { trace.warn('save.conflict', { revision: current.state_revision, metadata: { reason: 'expected_revision_mismatch', expected_revision: req.expected_revision, actual_revision: current.state_revision } }); throw new GameError('状态已更新，请刷新后重试', 409); }
      let input = req.action;
      if (req.input) input = await trace.measure('intent.compile', () => this.ai.interpret(current, req.input as string));
      if(req.input&&['START_ROUTINE','CONTINUE_ROUTINE'].includes((input as {type:string}).type))throw new GameError('请在生活模式面板提交此计划，或输入“开始生活模式：你的计划”，以后台运行。');
      if(completeFutureId){const intent=current.future_intents?.find(i=>i.id===completeFutureId);const action=input as {type:string;target_id?:string};assert(intent?.status==='due'&&['TALK','SOCIAL_INTERACT'].includes(action.type)&&intent.target_entities.includes(action.target_id??''),'计划缺少有效的到期社交行动证据');}
      const generic = !!req.input && (input as {type?:string})?.type === 'FREEFORM_ACTION';
      const turn = generic ? executeFreeform(current, req.input!, await this.ai.freeform(current,req.input!), req.request_id) : executeAction(current, input, req.request_id, req.input ? 'ai' : 'player');
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
      } else if(generic) { /* validated freeform outcome already supplies the story */
      } else try {
        const result = await this.ai.narrate(next, turn.action, turn.facts);
        interaction=result.interaction??null;
        // Valid prose and optional enrichment are separate concerns: a rejected enrichment must never discard the narration.
        next = applyOptionalEnrichment(next, result.patches, turn.action, turn.registry, req.request_id);
        next.last_turn = { narrative: result.narrative, speaker: result.speaker, dialogue: result.dialogue, choices: result.choices, context_actions: result.context_actions }; 
      } catch (error) {
        // Only a real narration failure reaches here; the fallback is player-facing prose, never a tool summary.
        observe('warn',['refusal','content_filter'].includes(failureReason(error))?'narration.safety_degraded':'narration.failed',{module:'turn',request_id:req.request_id,metadata:{action:turn.action.type,reason:errorText(error).slice(0,240)}});
        delete next.ai.threads.narrator;
        next.last_turn = { narrative: narrationFallback(next, turn.action), speaker: null, dialogue: null, choices: [], context_actions: [] };
        notices.push('本次行动已完成并保存；这一刻的场景描写暂时没有生成。');
      }
      return this.media(async()=>{
      onPhase?.('validating');
      // A presentation-only write may have committed while this turn ran: keep it and never write a lower revision.
      const latest = await this.storage.read();
      if (latest) { preservePresentation(latest, next); next.state_revision = Math.max(current.state_revision, latest.state_revision) + 1; }
      else next.state_revision = current.state_revision + 1;
      next.runtime.receipts = [...next.runtime.receipts, { id: req.request_id, fingerprint, revision: next.state_revision }].slice(-100);
      if(completeFutureId){const intent=next.future_intents!.find(i=>i.id===completeFutureId)!;intent.status='completed';intent.completed_by_request=req.request_id;}
      const worldTurn=!compileOnly&&!['SAVE_ROUTINE','CLEAR_ROUTINE','CANCEL_ROUTINE','PAUSE_ROUTINE'].includes(turn.action.type);
      if(worldTurn){
        updateInteraction(next,turn.action,beforeTurn,interaction);
        if(req.end_conversation&&next.interaction_context)next.interaction_context.status='ended';
        next.narrative_history=[...(beforeTurn.narrative_history??[]),{request_id:req.request_id,narrative:next.last_turn?.narrative??'',dialogue:next.last_turn?.dialogue??null,speaker:next.last_turn?.speaker??null,facts:turn.facts.slice(0,12).map(f=>f.slice(0,2000))}].slice(-8);
      }
      signal?.throwIfAborted();
      const validated = trace.span('patch.validation');
      try { next = validateSave(next); }
      catch (error) { trace.warn('patch.validation.rejected', { metadata: { stage: 'commit', reason: errorText(error) } }); throw error; }
      finally { validated.end({ revision: next.state_revision }); }
      if(worldTurn)checkpointTurn(beforeTurn,next,req.request_id);
      onPhase?.('committing');
      const diff = summarizeSaveDiff(current, next), commit = trace.span('save.commit');
      await this.storage.write(next);
      trace.info('save.commit', { revision: next.state_revision, metadata: { revision_before: current.state_revision, revision_after: next.state_revision, validation: 'accepted', action: turn.action.type, source: turn.action.source, ...diff } });
      commit.end(diff);
      return { ...publicView(next), notices };
      });
      });
    },owner);
  }
  async configureCalendar(raw:unknown,gameId:string,revision:number){return this.exclusive(async()=>{const save=await this.current();assert(save.game_id===gameId&&save.state_revision===revision,'状态已更新，请刷新后重试');save.calendar=safeParse(calendarSchema,raw);migrateInstalledWorld(save,this.installedWorlds);save.state_revision++;await this.storage.write(validateSave(save));return publicView(save);});}
  async acknowledgeTask(_id:string,_gameId:string,_revision:number,_outcome:'completed'|'cancelled'='completed'):Promise<never>{throw new GameError('不能手工标记任务完成或取消日历事件；任务结果必须由已登记的任务规则结算',410);}
  async checkpoint() { return this.exclusive(async () => { const save = await this.current(); await this.storage.write(save, 'checkpoint'); return publicView(save); }); }
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
      next.active_turn_id=cp.parent_turn_id;delete next.turn_checkpoint;
      const validated=validateSave(next);await this.storage.write(validated);
      this.logger.info('turn.reverted',{module:'turn',request_id:req.request_id,revision:validated.state_revision,metadata:{turn_id:cp.turn_id}});
      return publicView(validated);
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
          identity: { name: card.name, description: summary, avatar_id: null },
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
      return publicView(next);
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
      return publicView(next);
    });
  }
  async modules() {
    const save = await this.current();
    return { modules: moduleStatuses(save), capabilities: capabilityList(createRegistry(save.definition.enabled_modules)), installed: save.modules };
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
      assert(save.state_revision===raw.expected_revision,'状态已更新，请重新规划');mutate(save);save.state_revision++;
      save.runtime.receipts=[...save.runtime.receipts,{id:raw.request_id,fingerprint,revision:save.state_revision}].slice(-100);
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

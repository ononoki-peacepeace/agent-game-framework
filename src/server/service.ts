import {CandidateValidationError,generationRepair,schemaIssues,type GenerationRepair} from '../ai/failures.js';
import {failureReason,ProviderError,NarratorSchemaError} from '../ai/failures.js';
import {sparseStep} from '../routine/scheduler.js';
import {updateInteraction} from '../core/interaction.js';
import {checkpointTurn,canUndo,historyAvailable,imageHash,worldImage,worldKeys} from '../core/turn-history.js';
import {avatarCropSchema,type AvatarCropMetadata} from '../shared/avatar.js';
import {calendarSchema} from '../routine/schema.js';
import {migrationReasons,migrateInstalledWorld,type InstalledWorld} from '../routine/migration.js';
import { settleRoutine,applyLifePatches } from './routine-controller.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GameError, assert, safeParse, profileSchema, worldCreationProvenanceSchema, type SavePackage, type WorldCreationProvenance } from '../core/schema.js';
import { normalizeProvenance } from '../core/provenance.js';
import { exportSave, importSave, newSave, publicView, validateSave } from '../core/state.js';
import { unbackedPossessionClaims } from '../core/possession-claims.js';
import { executeFreeform,isPhysicalAction,assertFreeformGoalEvidence,FreeformRepairableError,environmentQueryForProposal,localSceneQuery } from '../core/freeform.js';
import {EnvironmentQueryError,EnvironmentAdmissionError,executeSceneSurvey,isBroadSceneObservation,broadContainerObservation} from '../core/environment.js';
import {repairOpeningPossessionsForAction} from '../core/initial-possession-repair.js';
import {reconcileDuplicateActivePlans} from '../core/pending-repair.js';
import {applyNarrativeClaims} from '../core/narrative-claims.js';
import {NarrativePatternError,physicalNarrativeFallback,canonicalResolutionNarrative,canonicalPerceptionNarrative,isSettledPerception,canonicalMovementNarrative,canonicalCompoundNarrative,validateMovementNarrative,validateResolvedNarrative,validateScenePresenceNarrative} from '../core/narrative-firewall.js';
import {isActivePerception} from '../agent/perception.js';
import {makeCompiledChoiceOffers} from '../core/choice-offer.js';
import { executeAction, applyPatches } from '../core/runtime.js';
import { routineModule } from '../modules/routine.js';
import { capabilityList, createRegistry, moduleStatuses } from '../modules/index.js';
import type { PendingTurn,SaveStorage } from '../storage/json-store.js';
import type { AIRuntime } from '../ai/runtime.js';
import {withRequestBudget,generateWithinRequestBudget} from '../ai/request-budget.js';
import {prepareRequestCommit} from '../recovery/request-context.js';
import {GuidanceRequests} from '../recovery/guidance-request.js';
import type { WorldPackage } from '../core/schema.js';
import {prepareCharacterImport,adaptationSchema,type ImportCandidate} from '../characters/import.js';
import {authoredCharacter} from '../characters/authoring.js';
import {emptyNpcAgentState} from '../agent/npc-state.js';
import {applyDepartureTravelDecisions} from '../agent/travel-decision.js';
import { emptyWorld } from '../ai/authoring.js';
import { blankWorldIntent } from '../shared/world-intent.js';
import { parseBehaviorRule } from '../ai/behavior.js';
import {CapabilityRegistry,capabilityRegistry} from '../system/capabilities.js';
import {applyStoryCommand,noteMeaningfulTurn,observeCanonicalTurn,type StoryCommand} from '../narrative/runtime.js';
import {drainBackgroundDisplay} from '../background/runtime.js';
import {proposeValidatedBackground} from '../background/generation.js';
import {settleAutonomousNpcTurn,settlePhysicalNpcReactions} from '../agent/npc-agent.js';
import {roleplayConfigSchema,type RoleplayConfig} from '../narrative/schema.js';
import {defaultRoleplayConfig} from '../narrative/policy.js';
import {behaviorPatchSchema,type BehaviorPatch} from '../ai/guidance.js';
import type {ImageAssetRuntime, PersistedImage} from '../media/image.js';

import { getLogger, observe, startTrace, runWithTrace, currentTrace, summarizeSaveDiff, errorText, type StructuredLogger } from '../observability/index.js';
const optionalEnrichmentOps = new Set(['relationship_delta']);
const perceptionProseAuditSchema=z.strictObject({grounded:z.boolean(),reports_result:z.boolean(),reason:z.string().max(240),
  unsupported_claims:z.array(z.string().max(160)).max(8)});
function compoundStepId(requestId:string,index:number){
  const hex=createHash('sha256').update(`${requestId}:local-compound:${index}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** A degradation reason must say which check failed, not only that one did. REV435
 * recorded just "Narrator structured result failed validation", which cannot be
 * diagnosed afterwards. Prose excerpts stay in the observability log, never in the save. */
function narrationFailureReason(error:unknown){
  if(error instanceof NarrativePatternError)return `${error.message}（校验项：${error.patternKind}）`.slice(0,500);
  if(error instanceof ProviderError&&error.detail)return `${error.message}（${error.reason}）：${error.detail}`.slice(0,500);
  return errorText(error);
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
function narrationFallback(save: SavePackage, action: Parameters<typeof applyPatches>[2],prior:SavePackage,compound?:readonly string[]):
  Pick<NonNullable<SavePackage['last_turn']>,'narrative'|'scene_beats'> {
  const receipt=save.resolution_receipts?.find(entry=>entry.request_id===action.id);
  if(receipt){
    const hidden=Boolean(save.resolution_history?.find(check=>check.check_id===receipt.check_id||check.request_id===receipt.request_id)?.hidden);
    const related=save.resolution_receipts?.filter(entry=>!prior.resolution_receipts?.some(old=>old.request_id===entry.request_id))??[];
    const steps=compound?.map((_,index)=>save.resolution_receipts?.find(entry=>entry.request_id===compoundStepId(action.id,index)))
      .filter((entry):entry is NonNullable<typeof entry>=>Boolean(entry));
    if(steps&&steps.length>1){
      const narrative=canonicalCompoundNarrative(save,hidden,steps);
      const speech=receipt.physical_outcome?physicalNarrativeFallback(save,receipt,hidden,related).scene_beats.filter(beat=>beat.kind==='speech'):[];
      return {narrative,scene_beats:speech.length?[
        ...(narrative.match(/[\s\S]{1,1200}/g)??[]).map(text=>({kind:'narration' as const,text})),...speech]:[]};
    }
    if(receipt.physical_outcome)return physicalNarrativeFallback(save,receipt,hidden,related);
    if(receipt.movement_route)return {narrative:canonicalMovementNarrative(receipt,save)};
    if(isSettledPerception(save,receipt))return {narrative:canonicalPerceptionNarrative(save,receipt,hidden)};
    const target=save.entities.find(entity=>entity.id===receipt.target_id);
    const name=String(target?.components.identity?.name??'对方');
    if(receipt.semantic_action==='TALK')return {narrative:`你向${name}开了口。`};
    if(receipt.semantic_action==='WAIT')return {narrative:receipt.time_cost>0?`你等了${receipt.time_cost}分钟。`:'你停下来，等了一会儿。'};
    return {narrative:canonicalResolutionNarrative(receipt,hidden)};
  }
  return {narrative:'你试着按眼前的打算行动。'};
}

export const requestSchema = z.strictObject({ request_id: z.string().uuid(), game_id: z.string().uuid(), expected_revision: z.number().int().min(0), action: z.unknown().optional(), input: z.string().min(1).max(2000).optional(), end_conversation:z.boolean().optional(),
  preceding_scene_request_id:z.string().uuid().optional(),arrival_scene_pending:z.boolean().optional(),
  // A player-initiated MOVE may carry the player's own public words and the id of the request they belong to. The
  // turn is the single MOVE choke point, so the optional pair lets a conditional companion re-decide exactly once
  // per player request without turning a planning convention into an Action DSL.
  player_input: z.string().min(1).max(2000).optional(), player_request_id: z.string().uuid().optional() }).refine(x => (x.action !== undefined) !== (x.input !== undefined), '必须提供 action 或 input 中的一项');
const behaviorScopeSchema=z.enum(['narration','dialogue','assistant']);
const behaviorOpSchema=z.enum(['suffix','prefix','tone','constraint']);
const behaviorSettingSchema=z.strictObject({scope:behaviorScopeSchema,instruction:z.string().min(1).max(200).optional(),
  rule:z.strictObject({op:behaviorOpSchema,value:z.string().min(1).max(120),
    application:z.enum(['per_sentence','per_paragraph','per_message','final_sentence']).default('per_message')}).optional()});
type ConfigurationRequest={game_id?:string;expected_revision?:number;request_id?:string};
const configurationRequestSchema=z.strictObject({game_id:z.string().uuid().optional(),expected_revision:z.number().int().nonnegative().optional(),request_id:z.string().uuid().optional()});
type GuidanceRequest=ConfigurationRequest&{scope?:BehaviorPatch['scope']};
const guidanceRequestSchema=configurationRequestSchema.extend({scope:z.enum(['world','global','session']).optional()});
function behaviorInputFingerprint(input:string){
  return 'behavior-config:input:'+createHash('sha256').update(safeParse(z.string().min(1).max(2000),input)).digest('hex');
}
function guidanceFingerprint(operation:unknown,sourceInput?:string){
  return sourceInput===undefined?'behavior-guidance:changes:'+createHash('sha256').update(JSON.stringify(operation)).digest('hex'):
    'behavior-guidance:input:'+createHash('sha256').update(safeParse(z.string().min(1).max(2000),sourceInput)).digest('hex');
}
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
  private globalGuidanceLoaded=false;
  private globalGuidanceLoading:Promise<void>|null=null;
  private readonly pendingTurns=new Map<string,PendingTurn>();
  private readonly characterImportPreviews=new Map<string,ImportCandidate>();
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
    // Consume the storage proof immediately, before this method can normalize
    // anything. It applies only to this isolated object, once, on this read.
    const readValidated=this.storage.consumeReadValidation?.(save)===true;
    let changed = false;
    if (save.definition.enabled_modules.includes('routine')) {
      // Every save that has the routine module also has a routine component, so state is explicit.
      const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
      if (player && !player.components.routine) { routineModule.manifest?.setup?.(save); changed = true; }
    }

    this.reportUnbackedPossessions(save);

    // Normalisation always runs last, so a save is only ever returned and persisted in its current shape.
    const migrated = migrateInstalledWorld(save, this.installedWorlds);
    return { save: readValidated&&!changed&&!migrated.changed?migrated.save:validateSave(migrated.save), changed: changed || migrated.changed };
  }
  /**
   * A world whose characters state possessions that exist as no item at all is already shipped and
   * cannot be repaired from prose, so it is reported rather than fixed, once per game per process
   * because `ensureBaseFeatures` runs on every read. This is how the live world's camera — described
   * by the Narrator, present in no inventory, defined by no entity — becomes visible to an operator
   * instead of surfacing only as a player noticing the story used something they do not have.
   */
  private reportedPossessionGaps=new Set<string>();
  private reportUnbackedPossessions(save: SavePackage) {
    if (this.reportedPossessionGaps.has(save.game_id)) return;
    this.reportedPossessionGaps.add(save.game_id);
    const unbacked = unbackedPossessionClaims(save);
    if (!unbacked.length) return;
    this.logger.warn('world.possession_unbacked', {module:'world',metadata:{
      game_id:save.game_id,count:unbacked.length,claims:unbacked.slice(0,12),
      detail:'人物设定里明确声明的随身物品在世界里没有对应物品实体；叙事可能描述玩家使用并不存在的物品。补齐属于世界数据迁移，需要授权，框架不会自动创建。'}});
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
      let turn:ReturnType<typeof executeAction>;
      if(generic){
        let repair:FreeformRepairableError|undefined,feedback:GenerationRepair|null=null;
        let accepted:ReturnType<typeof executeFreeform>|undefined;
        for(let attempt=1;attempt<=2;attempt++){
          let rejectedProposal:unknown;
          try{
            const proposal=await this.ai.freeform(candidate,step,repair?{
              failure_code:repair.failure_code,public_targets:repair.public_targets,
              diagnostics:repair.diagnostics,...(feedback?{generation_repair:feedback}:{})}:undefined);
            rejectedProposal=proposal;
            const query=environmentQueryForProposal(step,proposal);
            const localQuery=!query?localSceneQuery(candidate,step):null;
            const environment=query||localQuery?await this.ai.assessEnvironment(candidate,step,
              query??localQuery!,Boolean(localQuery)):undefined;
            accepted=executeFreeform(candidate,step,proposal,stepId,undefined,false,undefined,environment);
            assertFreeformGoalEvidence(accepted.save,step,stepId);
            if(attempt>1)currentTrace()?.info('agent.recovery.completed',{metadata:{
              stage:'local_compound_freeform',attempts_used:attempt,step_index:index}});
            break;
          }catch(error){
            if(error instanceof CandidateValidationError){
              feedback=generationRepair(error);
              error=new FreeformRepairableError('proposal_contract_invalid',error.detail,[],
                error.issues.map(issue=>({path:issue.path,code:issue.code,expected:issue.expected??issue.message})));
            }
            if(!(error instanceof FreeformRepairableError))throw error;
            currentTrace()?.warn('agent.recovery.decision',{metadata:{attempt,
              failure_stage:'local_compound_freeform',failure_code:error.failure_code,
              step_index:index,recoverable:attempt<2,strategy:attempt<2?'repair_proposal':'stop'}});
            if(attempt===2)throw error;
            feedback??=generationRepair(new CandidateValidationError('freeform',
              error.diagnostics.map(issue=>({...issue,message:issue.expected})),rejectedProposal));
            repair=error;
          }
        }
        assert(accepted,'局部行动提案未能完成校验，世界没有改变。');
        turn=accepted;
      }else turn=executeAction(candidate,input,stepId,'ai');
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
    await this.ensureGlobalGuidance();
    const raw = await this.storage.read('current','service_current'); assert(raw, '请先开始新游戏或导入存档');
    return this.normalizeCurrentRead(raw,'service_current');
  }
  /** Already owned by the presentation queue: normalize in memory and commit with that media write. */
  private async presentationCurrent(){
    await this.ensureGlobalGuidance();
    const raw=await this.storage.read('current','service_current');assert(raw,'请先开始新游戏或导入存档');
    return this.ensureBaseFeatures(raw).save;
  }
  private async normalizeCurrentRead(raw:SavePackage,source:'service_current'|'service_view'){
    // The owning mutation will persist this normalization with its prepared
    // transaction. Concurrent projections must never write a stale world image.
    if(this.busy||this.routineLease)return this.ensureBaseFeatures(raw).save;
    // Inspect without migrating: otherwise the discarded snapshot emits a
    // second completed migration before the locked reread does the real work.
    const missingRoutine=raw.definition.enabled_modules.includes('routine')&&
      !raw.entities.find(entity=>entity.id===raw.player_state.entity_id)?.components.routine;
    if(!missingRoutine&&!migrationReasons(raw,this.installedWorlds).length)return this.ensureBaseFeatures(raw).save;
    return this.exclusive(()=>this.media(async()=>{
      // A world transaction may have committed while the original read awaited
      // I/O. Re-read under the mutation lock before deciding what to persist.
      const latest=await this.storage.read('current',source);assert(latest,'请先开始新游戏或导入存档');
      const normalized=this.ensureBaseFeatures(latest);
      if(normalized.changed)await this.storage.write(normalized.save);
      return normalized.save;
    }));
  }
  private async ensureGlobalGuidance(){
    if(this.globalGuidanceLoaded)return;
    this.globalGuidanceLoading??=(async()=>{
      this.ai.globalPatches=this.storage.readGlobalGuidance?await this.storage.readGlobalGuidance():[];
      this.globalGuidanceLoaded=true;
    })().finally(()=>{this.globalGuidanceLoading=null;});
    await this.globalGuidanceLoading;
  }
  async behaviorGuidance(){
    const save=await this.current();
    return [...this.ai.globalPatches,...(save.behavior_patches??[]),...this.ai.sessionPatches];
  }
  private guidanceResult(save:SavePackage){
    return {view:publicView(save),patches:[...this.ai.globalPatches,...(save.behavior_patches??[]),...this.ai.sessionPatches]};
  }
  private guidanceRequests?:GuidanceRequests;
  private guidanceJournal(){return this.guidanceRequests??=new GuidanceRequests(this.storage);}
  private async guidanceReplayed(save:SavePackage,request:ConfigurationRequest|undefined,fingerprint:string){
    const tx=this.guidanceIdentity(save,request,fingerprint);
    return tx.replayed||!!request?.request_id&&await this.guidanceJournal().recover(tx.game_id,tx.request_id,fingerprint);
  }
  private async writeNonWorldGuidance(save:SavePackage,request:ConfigurationRequest|undefined,fingerprint:string,
    scope:'global'|'session',mutate:()=>Promise<void>){
    const tx=this.guidanceIdentity(save,request,fingerprint);
    if(request?.request_id)await this.guidanceJournal().run(tx.game_id,tx.request_id,fingerprint,scope,mutate);
    else await mutate();
    return this.guidanceResult(save);
  }
  private guidanceIdentity(save:SavePackage,request:ConfigurationRequest|undefined,fingerprint:string){
    const tx=safeParse(configurationRequestSchema,{game_id:request?.game_id??save.game_id,
      expected_revision:request?.expected_revision??save.state_revision,request_id:request?.request_id??randomUUID()});
    assert(tx.game_id===save.game_id,'游戏已切换');
    const receipt=save.runtime.receipts.find(entry=>entry.id===tx.request_id);
    if(receipt)assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');
    return {game_id:tx.game_id!,expected_revision:tx.expected_revision!,request_id:tx.request_id!,replayed:!!receipt};
  }
  private guidanceCandidates(save:SavePackage,id:string,scope?:BehaviorPatch['scope']){
    safeParse(z.string().uuid(),id);
    const candidates=[...this.ai.globalPatches.map(patch=>({scope:'global' as const,patch})),
      ...(save.behavior_patches??[]).map(patch=>({scope:'world' as const,patch})),
      ...this.ai.sessionPatches.map(patch=>({scope:'session' as const,patch}))].filter(item=>item.patch.id===id&&(!scope||item.scope===scope));
    assert(candidates.every(item=>item.scope===item.patch.scope),'指导记录的存储范围不一致');
    return candidates;
  }
  private async writeWorldGuidance(save:SavePackage,request:ConfigurationRequest|undefined,fingerprint:string,mutate:()=>void){
    const tx=this.guidanceIdentity(save,request,fingerprint);
    if(tx.replayed)return this.guidanceResult(save);
    if(save.state_revision!==tx.expected_revision)throw new GameError('状态已更新，请刷新后重试',409);
    mutate();save.state_revision++;
    save.runtime.receipts=[...save.runtime.receipts,{id:tx.request_id,fingerprint,revision:save.state_revision}].slice(-100);
    const validated=validateSave(save);
    await prepareRequestCommit(tx.game_id,tx.request_id,fingerprint,tx.expected_revision);
    await this.storage.write(validated);
    this.logger.info('behavior.patch.updated',{module:'framework',request_id:tx.request_id,revision:validated.state_revision});
    return this.guidanceResult(validated);
  }
  private async writeGlobalGuidance(next:BehaviorPatch[]){
    assert(this.storage.writeGlobalGuidance&&this.storage.readGlobalGuidance,'全局指导持久化不可用');
    try{await this.storage.writeGlobalGuidance(next);this.ai.globalPatches=next;}
    catch(error){
      // The file may already contain the complete edit. Re-read its authority;
      // if that also fails, future service reads must retry instead of serving a known-stale cache.
      this.globalGuidanceLoaded=false;await this.ensureGlobalGuidance().catch(()=>undefined);throw error;
    }
  }
  async putBehaviorPatch(raw:unknown,request?:ConfigurationRequest,sourceInput?:string){
    const patch=behaviorPatchSchema.parse(raw);
    assert(patch.overrides!==patch.id,'行为指导不能覆盖自身');
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=guidanceFingerprint({put:patch},sourceInput);
      if(await this.guidanceReplayed(save,request,fingerprint))return this.guidanceResult(save);
      assert(!this.guidanceCandidates(save,patch.id).some(item=>item.scope!==patch.scope),'指导 ID 已存在于另一范围，请明确处理原范围');
      if(patch.scope==='world'){
        return this.writeWorldGuidance(save,request,fingerprint,()=>{
          save.behavior_patches=[...(save.behavior_patches??[]).filter(item=>item.id!==patch.id),patch].slice(-100);
        });
      }
      return this.writeNonWorldGuidance(save,request,fingerprint,patch.scope,async()=>{
        if(patch.scope==='session')this.ai.sessionPatches=[...this.ai.sessionPatches.filter(item=>item.id!==patch.id),patch].slice(-100);
        else{
          const next=[...this.ai.globalPatches.filter(item=>item.id!==patch.id),patch].slice(-100);
          if(JSON.stringify(next)!==JSON.stringify(this.ai.globalPatches))await this.writeGlobalGuidance(next);
        }
        this.logger.info('behavior.patch.updated',{module:'framework',revision:save.state_revision,metadata:{id:patch.id,scope:patch.scope,category:patch.category,enabled:patch.enabled}});
      });
    }));
  }
  async removeBehaviorPatch(id:string,request?:GuidanceRequest){
    const options=safeParse(guidanceRequestSchema,request??{});
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=guidanceFingerprint({remove:id,scope:options.scope??null});
      if(await this.guidanceReplayed(save,options,fingerprint))return this.guidanceResult(save);
      const candidates=this.guidanceCandidates(save,id,options.scope);
      assert(candidates.length<=1,'多个范围存在同一指导 ID，请指定范围');
      const scope=candidates[0]?.scope??options.scope;
      if(scope==='world')return this.writeWorldGuidance(save,options,fingerprint,()=>{save.behavior_patches=(save.behavior_patches??[]).filter(item=>item.id!==id);});
      if(scope==='global'||scope==='session')return this.writeNonWorldGuidance(save,options,fingerprint,scope,async()=>{
        if(scope==='global'&&candidates.length)await this.writeGlobalGuidance(this.ai.globalPatches.filter(item=>item.id!==id));
        if(scope==='session')this.ai.sessionPatches=this.ai.sessionPatches.filter(item=>item.id!==id);
      });
      return this.guidanceResult(save);
    }));
  }
  async setBehaviorPatchEnabled(id:string,enabled:boolean,request?:GuidanceRequest){
    safeParse(z.boolean(),enabled);const options=safeParse(guidanceRequestSchema,request??{});
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=guidanceFingerprint({enabled,id,scope:options.scope??null});
      if(await this.guidanceReplayed(save,options,fingerprint))return this.guidanceResult(save);
      const candidates=this.guidanceCandidates(save,id,options.scope);
      assert(candidates.length<=1,'多个范围存在同一指导 ID，请指定范围');
      const found=candidates[0];assert(found,'行为指导不存在');
      const update=(items:BehaviorPatch[])=>items.map(item=>item.id===id?{...item,enabled}:item);
      if(found.scope==='world')return this.writeWorldGuidance(save,options,fingerprint,()=>{save.behavior_patches=update(save.behavior_patches??[]);});
      return this.writeNonWorldGuidance(save,options,fingerprint,found.scope,async()=>{
        if(found.scope==='global'&&found.patch.enabled!==enabled)await this.writeGlobalGuidance(update(this.ai.globalPatches));
        if(found.scope==='session')this.ai.sessionPatches=update(this.ai.sessionPatches);
      });
    }));
  }
  async view() {
    const raw = await this.storage.read('current','service_view');
    if (!raw) return null;
    return this.project(await this.normalizeCurrentRead(raw,'service_view'));
  }
  /** Clarification is request metadata, but its whole-save write still needs the canonical mutation lock. */
  async updateWorldClarification(gameId:string,revision:number,value:SavePackage['pending_world_clarification']){
    return this.exclusive(()=>this.media(async()=>{
      const latest=await this.storage.read('current','semantic_context');
      if(!latest||latest.game_id!==gameId||latest.state_revision!==revision)return false;
      assert(!value||value.created_revision===revision,'澄清上下文版本不一致');
      if(value)latest.pending_world_clarification=value;else delete latest.pending_world_clarification;
      await this.storage.write(validateSave(latest));return true;
    }));
  }
  async newGame(description?: string, promptText?: string, promptProfile?: unknown, provenance?: WorldCreationProvenance, roleplayConfig?:RoleplayConfig) {
    return withRequestBudget(()=>this.exclusive(async () => {
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
      await this.media(()=>this.storage.write(save)); return publicView(save);
    }));
  }
  async turn(raw: unknown,owner?:string,signal?:AbortSignal,onPhase?:(phase:string)=>void,compileOnly=false,completeFutureId?:string,compoundSteps?:readonly string[],forceFreeform=false,
    goalCommit?:(before:SavePackage,next:SavePackage,requestId:string)=>void,perceptionAuthorized=false,
    repetition?:import('../system/goals.js').GoalSpec['repetition'],binding?:{target_ids:readonly string[];physical_intent?:import('../system/goals.js').GoalSpec['physical_intent']}) {
    return withRequestBudget(()=>this.exclusive(async () => {
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
      let pending=await this.storage.readPending?.(req.request_id)??this.pendingTurns.get(req.request_id);
      if(pending?.generic&&req.input&&!compoundSteps){
        assert(pending.game_id===current.game_id&&pending.expected_revision===current.state_revision&&
          pending.fingerprint===fingerprint,'待完成判定与当前请求不一致');
        try{assertFreeformGoalEvidence(pending.candidate,req.input,req.request_id);}
        catch(error){
          if(!(error instanceof FreeformRepairableError))throw error;
          trace.warn('agent.recovery.decision',{metadata:{failure_stage:'pending_freeform_evidence',
            failure_code:error.failure_code,recoverable:true,strategy:'regenerate_uncommitted_candidate',
            revision:current.state_revision}});
          // The formal revision still matches: discard only the uncommitted candidate.
          // The original request and its fixed request ID will be rebuilt below.
          await this.storage.clearPending?.(req.request_id);
          this.pendingTurns.delete(req.request_id);
          pending=undefined;
        }
      }
      let actionBase=current;
      let openingRepairIds:string[]=[];
      if(!pending&&current.background_state?.needs_generation){
        try{
          actionBase=await proposeValidatedBackground(current,repair=>this.ai.proposeBackgroundContinuation(current,repair));
          trace.info('background.proposal_validated',{metadata:{
            incident_count:(actionBase.definition.background_incidents??[]).length,
            source_revision:current.state_revision}});
        }catch(error){
          trace.warn('background.proposal_rejected',{metadata:{reason:errorText(error).slice(0,300),source_revision:current.state_revision}});
          // A failed provider/validation attempt is not a reason to block the player's
          // action or invoke the same proposal on every movement at the same game time.
          actionBase=structuredClone(current);
          if(actionBase.background_state){actionBase.background_state.needs_generation=false;
            actionBase.background_state.last_generation_at=structuredClone(current.runtime.time);}
        }
      }
      if(!pending&&req.input){
        const repaired=repairOpeningPossessionsForAction(actionBase,req.input);
        if(repaired){actionBase=repaired.save;openingRepairIds=repaired.itemIds;}
      }
      const containerSurveyId=req.input?broadContainerObservation(actionBase,req.input):null;
      let generic:boolean,turn:ReturnType<typeof executeAction>;
      let travelDecisionLines:{speaker_id:string;utterance:string}[]=[];
      let travelDecisionReceipt:{id:string;fingerprint:string}|null=null;
      if(pending){
        assert(pending.game_id===current.game_id&&pending.expected_revision===current.state_revision&&pending.fingerprint===fingerprint,'待完成判定与当前请求不一致');
        generic=pending.generic;
        let candidate:SavePackage;
        try{
          candidate=validateSave(pending.candidate);
        }catch(loadError){
          // An uncommitted candidate from an earlier attempt can carry a known
          // corruption (duplicate same-route NPC departure plans) that the
          // deterministic Core repair can fix without re-rolling the player's
          // already-settled action. Persist the repaired candidate so a later
          // crash cannot re-enter the same invalid image.
          const reconciled=reconcileDuplicateActivePlans(pending.candidate as SavePackage,req.request_id);
          if(!reconciled.repaired)throw loadError;
          candidate=validateSave(reconciled.save);
          const repairedPending:PendingTurn={...pending,candidate};
          await this.storage.writePending?.(repairedPending);
          this.pendingTurns.set(req.request_id,structuredClone(repairedPending));
          trace.warn('pending.candidate_repaired',{metadata:{request_id:req.request_id,reason:errorText(loadError),
            stage:'pending_reconciliation',revision:current.state_revision}});
        }
        turn={save:candidate,action:pending.action,facts:pending.facts,events:[],registry:createRegistry(current.definition.enabled_modules)};
      }else{
        let input = req.action;
        if (req.input) {
          if(compoundSteps||forceFreeform||isBroadSceneObservation(req.input)||containerSurveyId)input={type:'FREEFORM_ACTION',parameters:{}};
          else {
            let repair:{failure_code:string;previous_action?:string;generation_repair?:GenerationRepair}|undefined;
            for(let attempt=1;attempt<=2;attempt++){
              try{
                input=await trace.measure('intent.compile', () => this.ai.interpret(actionBase, req.input as string,repair));
                const proposed=input as {type:string;parameters:unknown};
                 const actions=createRegistry(actionBase.definition.enabled_modules).actions;
                const action=proposed.type==='FREEFORM_ACTION'?null:
                   actions.has(proposed.type)?actions.get(proposed.type):null;
                 if(proposed.type!=='FREEFORM_ACTION'&&!action)
                   throw new CandidateValidationError('action_type',[{path:'type',code:'unregistered_action',
                     expected:'当前世界已注册的 Core 动作或 FREEFORM_ACTION',message:`${proposed.type} 未在当前世界注册`}],proposed);
                 if(isPhysicalAction(req.input as string)&&proposed.type!=='FREEFORM_ACTION')
                   throw new CandidateValidationError('action_family',[{path:'type',code:'physical_action_mismatch',
                     expected:'FREEFORM_ACTION 以便交给受控身体行动裁决',message:'玩家要求身体行动，候选却选择了非身体行动'}],proposed);
                if(action&&!action.parameters.safeParse(proposed.parameters).success){
                  const checked=action.parameters.safeParse(proposed.parameters);
                  if(!checked.success)throw new CandidateValidationError('action_parameters',schemaIssues(checked.error),proposed);
                }
                if(attempt>1)trace.info('agent.recovery.completed',{metadata:{stage:'action_parameters',attempts_used:attempt,
                  revision:current.state_revision}});
                break;
              }catch(error){
                const feedback=generationRepair(error);
                if(!feedback)throw error;
                 repair={failure_code:error instanceof CandidateValidationError&&error.stage==='action_type'?'action_type_invalid':
                   error instanceof CandidateValidationError&&error.stage==='action_family'?'action_family_mismatch':'action_parameters_invalid',
                   ...(feedback.previous_output&&typeof feedback.previous_output==='object'&&typeof (feedback.previous_output as {type?:unknown}).type==='string'?{previous_action:(feedback.previous_output as {type:string}).type}:{}),generation_repair:feedback};
                trace.warn('agent.recovery.decision',{metadata:{attempt,failure_stage:'action_parameters',
                  failure_code:repair.failure_code,recoverable:attempt<2,strategy:attempt<2?'repair_interpretation':'stop',
                  revision:current.state_revision}});
                 if(attempt===2)throw new GameError('行动参数未能通过校验，世界状态没有改变。',503);
              }
            }
          }
        }
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
        // The player is about to leave. A person who merely asked for a condition is not a companion yet, so give them
        // one bounded, public-information-only re-decision here — inside the very transaction that settles the MOVE.
        // It is skipped for replays/pending turns, for internal planning steps (no player words, no request id) and for
        // any journey whose eligible candidate set is empty, so ordinary solo movement costs no model call.
        if(!pending&&!generic&&(input as {type:string}).type==='MOVE'&&req.player_input!==undefined&&req.player_request_id){
          try{
            const applied=await applyDepartureTravelDecisions(this,actionBase,this.project(actionBase),
              {actorId:actionBase.player_state.entity_id,requestId:req.player_request_id,
               playerInput:req.player_input,moveDestinationId:(input as {target_id?:string}).target_id??null});
            if(applied){actionBase=applied.save;travelDecisionLines=applied.lines;
              travelDecisionReceipt={id:applied.receiptId,fingerprint:applied.fingerprint};}
          }catch(error){
            trace.warn('travel.decision.failed',{metadata:{reason:errorText(error).slice(0,200)}});
          }
        }
        if(compoundSteps)turn=(await this.localCompoundCandidate(actionBase,req.request_id,compoundSteps)).turn;
        else if(req.input&&(isBroadSceneObservation(req.input)||containerSurveyId)){
          const here=actionBase.entities.find(e=>e.id===actionBase.player_state.entity_id)?.components.location?.location_id;
          const priorSurvey=actionBase.environment_state?.surveys?.filter(s=>s.location_id===here&&
            (s.container_id??null)===(containerSurveyId??null)).at(-1);
          const exhaustive=Boolean(containerSurveyId&&/(?:彻底|仔细|逐一)(?:检查|查看)/.test(req.input)&&
            /(?:空|全部|所有|有些什么|有什么东西)/.test(req.input));
           const needsProposal=!priorSurvey||exhaustive&&!priorSurvey.complete_empty&&!priorSurvey.complete_contents;
           let repair:GenerationRepair|null=null;
           let surveyed:ReturnType<typeof executeSceneSurvey>|null=null;
           for(let attempt=1;attempt<=2;attempt++){
             const proposal=needsProposal?await trace.measure('environment.survey',()=>
               this.ai.surveyEnvironment(actionBase,req.input!,undefined,containerSurveyId,repair)):undefined;
             try{surveyed=executeSceneSurvey(actionBase,req.input,proposal,req.request_id,undefined,containerSurveyId);break;}
             catch(error){
               const rejected=error instanceof EnvironmentAdmissionError?
                 new CandidateValidationError('environment_survey',[{path:error.field,code:error.failure_code,
                   expected:'原始检查授权与当前权威场景、容器和历史观察范围',message:error.message}],proposal):
                 error instanceof z.ZodError?new CandidateValidationError('environment_survey',schemaIssues(error),proposal):null;
               repair=rejected?generationRepair(rejected):null;
               const recoverable=Boolean(repair&&needsProposal&&attempt<2);
               trace.warn('agent.recovery.decision',{metadata:{attempt,failure_stage:'environment_survey_admission',
                 failure_code:error instanceof EnvironmentAdmissionError?error.failure_code:'survey_candidate_invalid',
                 recoverable,strategy:recoverable?'repair_survey':'stop',revision:current.state_revision}});
               if(!recoverable)throw error;
             }
           }
           if(!surveyed)throw new GameError('环境概览候选未能通过校验，世界没有改变。',503);
           turn=surveyed;
        }
        else if(generic){
          let repair:FreeformRepairableError|undefined;let proposalFeedback:GenerationRepair|null=null;
          let proposedTurn:ReturnType<typeof executeFreeform>|undefined;
          for(let attempt=1;attempt<=2;attempt++){
            let rejectedProposal:unknown;
            try{
              const rawProposal=repair?await this.ai.freeform(actionBase,req.input!,{
                failure_code:repair.failure_code,public_targets:repair.public_targets,diagnostics:repair.diagnostics,...(proposalFeedback?{generation_repair:proposalFeedback}:{})}):
                await this.ai.freeform(actionBase,req.input!);
              // Only the unified semantic boundary supplies this constraint.
              // A downstream binding proposal cannot erase the duration/stop rule.
              rejectedProposal=rawProposal;
              const proposal={...rawProposal,repetition:repetition??null};
              trace.info('freeform.repetition.bound',{metadata:{attempt,proposal_repeat:Boolean(rawProposal.repetition),
                semantic_repeat:Boolean(repetition),duration_seconds:repetition?.duration_seconds??null,
                interval_seconds:repetition?.interval_seconds??null,stage_count:proposal.resolution?.stages.length??0,physical_kind:proposal.physical_action?.kind??null,
                action_forms:binding?.physical_intent?.forms??null,contact_stage:proposal.physical_action?.contact_stage_id??null,
                injury_stage:proposal.physical_action?.injury_stage_id??null}});
              const query=environmentQueryForProposal(req.input!,proposal,binding);
              const localQuery=!query?localSceneQuery(actionBase,req.input!):null;
              const environment=query||localQuery?await trace.measure('environment.adjudication',()=>
                this.ai.assessEnvironment(actionBase,req.input!,query??localQuery!,Boolean(localQuery))):undefined;
              proposedTurn=executeFreeform(actionBase,req.input!,proposal,req.request_id,undefined,perceptionAuthorized,binding,environment);
              assertFreeformGoalEvidence(proposedTurn.save,req.input!,req.request_id);
              if(attempt>1)trace.info('agent.recovery.completed',{metadata:{stage:'freeform_binding',
                attempts_used:attempt,revision:current.state_revision}});
              break;
            }catch(error){
              if(error instanceof CandidateValidationError){proposalFeedback=generationRepair(error);error=new FreeformRepairableError('proposal_contract_invalid',error.detail,[],error.issues.map(i=>({path:i.path,code:i.code,expected:i.expected??i.message})));}
              if(error instanceof EnvironmentQueryError)error=new FreeformRepairableError('proposal_contract_invalid',error.message,[],error.diagnostics);
              if(!(error instanceof FreeformRepairableError))throw error;
              trace.warn('agent.recovery.decision',{metadata:{attempt,failure_code:error.failure_code,
                failure_stage:'freeform_binding',recoverable:attempt<2,strategy:attempt<2?'repair_proposal':'stop',
                revision:current.state_revision}});
              if(attempt===2)throw error;
              proposalFeedback??=generationRepair(new CandidateValidationError('freeform',error.diagnostics.map(i=>({...i,message:i.expected})),rejectedProposal));
              repair=error;
            }
          }
          if(!proposedTurn)throw new GameError('行动提案未能完成校验，世界没有改变。',503);
          turn=proposedTurn;
        }else turn=executeAction(actionBase,input,req.request_id,req.input?'ai':'player');
        if(openingRepairIds.length){
          const receipt=turn.save.resolution_receipts?.find(entry=>entry.request_id===req.request_id);
          assert(receipt,'开局物品修复缺少原行动凭据');
          receipt.canonical_facts=[`依据结构化开局记录修复遗漏的初始物品：${openingRepairIds.join('、')}。`,...receipt.canonical_facts].slice(0,12);
          if(!receipt.effects.includes('inventory'))receipt.effects.push('inventory');
          turn.facts=[receipt.canonical_facts[0],...turn.facts];
        }
        if(generic)assert(turn.save.resolution_receipts?.some(entry=>entry.request_id===req.request_id),'开放世界行动缺少程序判定凭据');
        if(!generic||turn.save.resolution_receipts?.some(entry=>entry.request_id===req.request_id)){
          const staged:PendingTurn={game_id:current.game_id,request_id:req.request_id,fingerprint,expected_revision:current.state_revision,candidate:turn.save,action:turn.action,facts:turn.facts,generic};
          await this.storage.writePending?.(staged);this.pendingTurns.set(req.request_id,structuredClone(staged));
        }
      }
      let next = turn.save;
      const notices: string[] = [];
      let narrationPresentation:NonNullable<SavePackage['last_turn']>['presentation'];
      const degradeNarration=(reason:string)=>{
        narrationPresentation={status:'degraded',reasons:[...new Set([
          ...(narrationPresentation?.reasons??[]),reason.slice(0,500)||'narration_unavailable'])].slice(0,8)};
      };
      if(!compileOnly){
        const reactions=await settlePhysicalNpcReactions(this,next,req.request_id);
        next=reactions.save;turn.facts.push(...reactions.visibleFacts);
        const autonomous=await trace.measure('npc_agent.background_batch',()=>
          settleAutonomousNpcTurn(this,next,current.runtime.time,req.request_id,signal));
        next=autonomous.save;
        turn.facts.push(...autonomous.visibleFacts);
        if(autonomous.save!==turn.save){
          const staged:PendingTurn={game_id:current.game_id,request_id:req.request_id,fingerprint,
            expected_revision:current.state_revision,candidate:next,action:turn.action,facts:turn.facts,generic};
          await this.storage.writePending?.(staged);this.pendingTurns.set(req.request_id,structuredClone(staged));
        }
      }
      let interaction: {target_id:string;status:'active'|'ended'}|null=null;
      if (['START_ROUTINE','CONTINUE_ROUTINE'].includes(turn.action.type)) {
        const maxMinutes = Math.min(Number(turn.action.parameters.max_minutes ?? 1440), 1440, next.definition.ruleset.minutes_per_day);
        const actor=next.entities.find(e=>e.id===next.player_state.entity_id)!;
        if(!actor.components.routine.plan){onPhase?.('compiler');const plan=await this.ai.compileRoutine(next,signal);actor.components.routine.plan=plan;actor.components.routine.plan_revision=Number(plan.source_revision??0);actor.components.routine.status=plan.clarification?'interrupted':'armed';}
        signal?.throwIfAborted();
        const clarification=(actor.components.routine.plan as {clarification?:string|null}).clarification;
        if(clarification){actor.components.routine.active=false;actor.components.routine.enabled=true;actor.components.routine.status='interrupted';actor.components.routine.interrupted=true;actor.components.routine.last_interrupt=clarification;next.last_turn={narrative:clarification,speaker:null,dialogue:null,choices:[],context_actions:[]};}
        else if(!compileOnly){
          const startedAt=structuredClone(next.runtime.time);
          const minutesPerDay=next.definition.ruleset.minutes_per_day;
          const alreadyAdvanced=Boolean(pending&&
            next.runtime.time.day*minutesPerDay+next.runtime.time.minute>
            current.runtime.time.day*minutesPerDay+current.runtime.time.minute);
          if(!alreadyAdvanced){
            next=await trace.measure('routine.scheduler', () => sparseStep(next, this.ai,
              next.runtime.time.day*minutesPerDay+next.runtime.time.minute+maxMinutes,signal,onPhase));
            const autonomous=await trace.measure('npc_agent.routine_batch',()=>
              settleAutonomousNpcTurn(this,next,startedAt,`${req.request_id}:routine`,signal,1));
            next=autonomous.save;turn.facts.push(...autonomous.visibleFacts);
            const staged:PendingTurn={game_id:current.game_id,request_id:req.request_id,fingerprint,
              expected_revision:current.state_revision,candidate:next,action:turn.action,facts:turn.facts,generic};
            await this.storage.writePending?.(staged);this.pendingTurns.set(req.request_id,structuredClone(staged));
          }
        }
      } else if(['SAVE_ROUTINE','CLEAR_ROUTINE','CANCEL_ROUTINE','PAUSE_ROUTINE'].includes(turn.action.type)) {
        next.last_turn=structuredClone(current.last_turn);
        notices.push(...turn.facts);
      } else try {
        narrationPresentation={status:'normal',reasons:[]};
        const receipt=(generic||turn.action.type==='MOVE')?next.resolution_receipts?.find(entry=>entry.request_id===req.request_id):undefined;
        if(generic)assert(receipt,'开放行动缺少程序判定凭据');
        if(generic&&!compoundSteps)assertFreeformGoalEvidence(next,req.input!,req.request_id);
        const compoundReceipts=compoundSteps?.map((_,index)=>next.resolution_receipts?.find(entry=>entry.request_id===compoundStepId(req.request_id,index)));
        if(compoundSteps)assert(compoundReceipts?.every(Boolean),'局部复合行动缺少步骤凭据');
        const check=next.resolution_history?.find(entry=>entry.request_id===req.request_id);
        const playerPlace=next.entities.find(e=>e.id===next.player_state.entity_id)?.components.location?.location_id;
        const visibleSteps=next.resolution_receipts?.filter(r=>!current.resolution_receipts?.some(old=>old.request_id===r.request_id)&&
          (r.actor_id===next.player_state.entity_id||r.movement_route?.location_ids[0]===playerPlace||r.movement_route?.location_ids.at(-1)===playerPlace));
        const narrativeSteps=compoundReceipts??(receipt?.physical_outcome?visibleSteps:undefined);
        if(receipt?.physical_outcome)for(const step of visibleSteps??[]){
          if(step.actor_id===receipt.actor_id||!step.movement_route)continue;
          const person=next.entities.find(e=>e.id===step.actor_id);
          const label=person?.components.discovery?.known_to_player===false?'附近的人':String(person?.components.identity?.name??'在场的人');
          const line=step.movement_route.location_ids[0]===playerPlace?`${label}沿实际路线离开了这里。`:`${label}来到了这里。`;
          if(!receipt.canonical_facts.includes(line))receipt.canonical_facts.push(line);
          if(!step.canonical_facts.includes(line))step.canonical_facts.push(line);
        }
        const narrateValidated=async()=>{
          let claimsRepairs=0;
          let repair: {reason:string;pattern_kind?:string;match_index?:number;snippet?:string;allowed_effects?:string[];
            schema_feedback?:{issues:NarratorSchemaError['issues'];previous_output:unknown}}|undefined;
          for(let attempt=1;attempt<=3;attempt++){
            observe('info','narrative.attempt',{module:'turn',request_id:req.request_id,
              metadata:{narrator_attempt:attempt,retry:attempt>1,
                ...(repair?.pattern_kind?{previous_rejected_pattern_kind:repair.pattern_kind}:{})}});
            // Discarded narration must not alter even the candidate's AI thread metadata.
            const narrationCandidate=structuredClone(next);
            let result:Awaited<ReturnType<AIRuntime['narrate']>>;
            try{result=await this.ai.narrate(narrationCandidate,turn.action,turn.facts,receipt,repair,
              narrativeSteps as NonNullable<SavePackage['resolution_receipts']>|undefined,req.arrival_scene_pending===true);}
            catch(error){
              const reason=failureReason(error);
              const recoverable=['max_output_tokens','length','invalid_json','missing_output_text','schema'].includes(reason);
              // A schema repair gets one fresh candidate; repeated invalid output is not an
              // excuse to re-run an already settled action or spend an unbounded token budget.
              const limit=reason==='schema'?2:3;
              observe('warn','agent.recovery.decision',{module:'turn',request_id:req.request_id,
                metadata:{attempt,failure_code:reason,failure_stage:'narrative_provider',recoverable:recoverable&&attempt<limit,
                  strategy:recoverable&&attempt<limit?'retry_narration_candidate':'stop',revision:current.state_revision}});
              if(recoverable&&attempt<limit){
                if(error instanceof NarratorSchemaError){
                  // The rejected output is data, never a new instruction. Omit oversized candidates;
                  // issue paths still let the model repair the same narrowly scoped generation.
                  const serialized=JSON.stringify(error.previousOutput);
                  repair={reason:'schema',schema_feedback:{issues:error.issues,
                    previous_output:serialized&&serialized.length<=6000?error.previousOutput:null}};
                }
                continue;
              }
              throw error;
            }
            if(!result.scene_beats?.some(beat=>beat.kind==='speech')){
              // Typed speech from this turn's validated NPC decisions is a
              // reliable identity source even when the prose model omitted beats.
              // Exact utterance anchors only: do not infer speakers from quotes.
              const speech=Object.entries(next.npc_agent_state??{}).flatMap(([speaker_id,mind])=>
                mind.last_decisions.filter(decision=>decision.event_ref.includes(req.request_id)&&
                  decision.revision===next.state_revision+1&&decision.speech&&result.narrative.includes(decision.speech))
                  .map(decision=>({kind:'speech' as const,speaker_id,utterance:decision.speech!.slice(0,1000)})))
                .sort((a,b)=>result.narrative.indexOf(a.utterance)-result.narrative.indexOf(b.utterance));
              if(speech.length)result.scene_beats=speech;
            }
            if(!receipt)try{validateScenePresenceNarrative(next,result.narrative,result.presence_claims);}
            catch(error){
              if(attempt<3){repair={reason:errorText(error),schema_feedback:{issues:[{path:'presence_claims',code:'presence_conflict',expected:'已结算在场事实',message:errorText(error)}],previous_output:generationRepair(new CandidateValidationError('narrator',[],result))!.previous_output}};continue;}
              observe('warn','narrative.safe_fallback',{module:'turn',request_id:req.request_id,
                metadata:{reason:'scene_presence_unverified',narrator_attempts:attempt}});
              return {...result,...narrationFallback(next,turn.action,current,compoundSteps),speaker:null,dialogue:null,
                scene_beats:[],choices:[],choice_semantics:[],context_actions:[],patches:[],interaction:null,
                item_claims:[],stable_locations:[],mechanical_claims:[],presence_claims:[]};
            }
            if(receipt)try{
              const here=next.entities.find(entity=>entity.id===next.player_state.entity_id)?.components.location?.location_id;
              if(receipt.physical_outcome)for(const npcId of receipt.physical_outcome.witness_ids){
                const said=next.npc_agent_state?.[npcId]?.last_decisions.findLast(decision=>
                  decision.event_ref===`reaction:${req.request_id}`)?.speech;
                if(said&&!result.scene_beats?.some(beat=>beat.kind==='speech'&&beat.speaker_id===npcId)&&
                  !(result.speaker===npcId&&result.dialogue?.trim()))
                  throw new GameError(`本轮已发生的人物发言缺少对应台词（speaker_id=${npcId}）；请在完整正文和有序对白中呈现已有回应，不能只写开口或说完。`,503);
              }
              for(const beat of result.scene_beats??[])if(beat.kind==='speech'){
                const speaker=next.entities.find(entity=>entity.id===beat.speaker_id&&entity.components.character);
                if(!speaker||speaker.components.location?.location_id!==here&&!visibleSteps?.some(step=>step.actor_id===speaker.id&&step.movement_route?.location_ids[0]===here))
                  throw new GameError('场景对白须绑定当前实际在场的人物，不能猜测说话人。',503);
                if(speaker.id===next.player_state.entity_id&&!(req.input??'').includes(beat.utterance)&&
                  !String(turn.action.parameters.topic??'').includes(beat.utterance))
                  throw new GameError('场景描写不能替玩家新增未授权的台词。',503);
              }
              if(!receipt.movement_route&&!compoundReceipts?.some(step=>step?.movement_route))
                validateScenePresenceNarrative(next,[result.narrative,...(result.scene_beats??[]).filter(beat=>beat.kind==='narration').map(beat=>beat.text)].join('\n'),result.presence_claims);
              if(req.arrival_scene_pending===true&&turn.action.type==='MOVE'&&
                (result.speaker!==null||result.dialogue!==null||result.scene_beats?.some(beat=>beat.kind==='speech')||/[：:]\s*[“\"]/.test(result.narrative)))
                throw new GameError('抵达后的直接对话应由到达场景生成，不能提前写入移动旁白',503);
              if(receipt.physical_outcome)for(const step of visibleSteps??[]){
                if(step.actor_id===receipt.actor_id||step.movement_route?.location_ids[0]!==here)continue;
                const person=next.entities.find(e=>e.id===step.actor_id),name=String(person?.components.identity?.name??'');
                if(name&&(!result.narrative.replace(/\s/g,'').includes(name.replace(/\s/g,''))||!/离开|离去|走出|退出|出去了/.test(result.narrative)))
                  throw new GameError('本轮在场人物已沿权威路线离开，正文须交代可观察的离场，不能只写攻击结果。',503);
              }
              const perception=(check?.spec?.domain==='perception'||
                isActivePerception(receipt.semantic_action))&&!['mock','fixture'].includes(this.ai.adapter.name);
              let ambiguousPattern:NarrativePatternError|null=null;
              try{validateResolvedNarrative(receipt,result,Boolean(check?.hidden),
                narrativeSteps as NonNullable<SavePackage['resolution_receipts']>|undefined,next);}
              catch(error){
                // A literal inventory/position claim still fails. For perception prose, let the
                // existing groundedness audit distinguish it from a metaphorical verb match.
                if(perception&&error instanceof NarrativePatternError&&
                  ['inventory','position'].includes(error.patternKind))ambiguousPattern=error;
                else throw error;
              }
              if(receipt.movement_route)validateMovementNarrative(receipt,result,next);
              if(perception){
                const actor=next.entities.find(entity=>entity.id===next.player_state.entity_id);
                const here=this.project(next).locations.find(location=>location.id===actor?.components.location?.location_id);
                const audit=await this.ai.systemAgent(perceptionProseAuditSchema,next.definition.prompt_profile,{
                  instruction:'只审核观察正文，不决定行动、不补写故事。reports_result 仅在正文明确交代玩家本次实际调查及其权威结果（新发现的证据、部分发现、受阻或在本次范围内无新发现）时为 true；只有 NPC 追问或反应、没有调查结果时为 false。逐句核对正文的具体存在、不存在、痕迹、声音、设施、人物、门窗状态及玩家动作断言，并在 unsupported_claims 列出每一项没有 canonical_time、地点描述、公开场景或 receipt 支持的断言；只要该数组非空 grounded=false。观察没有找到新线索，只证明本次范围没有新发现，不能据此断言房间没有摆设、从未有人留下痕迹或某处无人。canonical_time、地点描述和公开场景是权威资料；允许准确表达当前时刻、自然改写已知描述、感官注意和不主张世界变化的比喻。机械词匹配仅是待核对信号，先判断它是否真的声称玩家移动或取得物品，不因修辞动词直接拒绝。没有新发现的结论本身是合法的。只输出 JSON。',
                  location:{name:here?.name??null,description:here?.description??null},
                  expressive_behavior_policy:'已在场 NPC 的短暂视线、姿态、停顿、语气和微表情可自然演绎，不需要 receipt 逐项确认。不能因此新增道具、伤势、秘密、跨地点移动、持久关系变化或玩家未授权的操作。',
                  present_people:this.project(next).entities.filter(entity=>entity.components.character&&
                    entity.components.location?.location_id===actor?.components.location?.location_id)
                    .map(entity=>({id:entity.id,name:entity.components.identity?.name})),
                  canonical_time:next.runtime.time,
                  original_player_action:req.input??turn.action.type,
                  settled_action:turn.action.type,canonical_facts:receipt.canonical_facts,
                  effects:receipt.effects,narrative:result.narrative,
                  spatial_boundary:{location_id:actor?.components.location?.location_id??null,
                    position_changed:receipt.effects.includes('position'),
                    instruction:'没有 position 效果时不得把局部观察扩写为离开当前地点、深入远处小径、返程或与同行人物拉开未结算的距离。普通姿态与注意力可以表现，但不构成世界移动。'},
                  suspected_mechanical_claim:ambiguousPattern?{
                    kind:ambiguousPattern.patternKind,snippet:ambiguousPattern.snippet}:null,
                },{...next,ai:{threads:{}}});
                if(!audit?.grounded||!audit.reports_result||audit.unsupported_claims?.length)throw new GameError(
                  audit?.unsupported_claims?.[0]??audit?.reason??'观察正文未能交代已结算的调查结果',503);
              }
            }catch(error){
              if(!(error instanceof GameError))throw error;
              const reason=narrationFailureReason(error);
              observe('warn','narrative.mechanical_claim_discarded',{module:'turn',request_id:req.request_id,
                metadata:{reason:reason.slice(0,200),narrator_attempt:attempt,retry:attempt>1,
                  ...(error instanceof NarrativePatternError?{pattern_kind:error.patternKind,
                    match_index:error.matchIndex,snippet:error.snippet,allowed_effects:receipt.effects}: {})}});
                if(attempt===3){
                observe('warn','narrative.retry_exhausted',{module:'turn',request_id:req.request_id,
                  metadata:{attempts_used:attempt,reason:reason.slice(0,200)}});
                  if(compoundReceipts&&compoundReceipts.length>1){
                    degradeNarration(reason);
                    observe('warn','narrative.safe_fallback',{module:'turn',request_id:req.request_id,
                      metadata:{reason:'compound_steps_unverified',narrator_attempts:attempt}});
                    return {...result,...narrationFallback(next,turn.action,current,compoundSteps),
                      speaker:null,dialogue:null,choices:[],choice_semantics:[],context_actions:[],
                      patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],presence_claims:[]};
                  }
                  if(receipt.physical_outcome){
                    degradeNarration(reason);
                    observe('warn','narrative.safe_fallback',{module:'turn',request_id:req.request_id,
                      metadata:{reason:'physical_outcome_unverified',narrator_attempts:attempt}});
                    notices.push('场景描写校验未通过，本次展示采用已验证的场景与结算事实。');
                    return {...result,...physicalNarrativeFallback(next,receipt,Boolean(check?.hidden),next.resolution_receipts?.filter(r=>!current.resolution_receipts?.some(old=>old.request_id===r.request_id))),
                      speaker:null,dialogue:null,choices:[],choice_semantics:[],context_actions:[],
                      patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],presence_claims:[]};
                  }
                  if(check?.spec?.domain==='perception'||isActivePerception(receipt.semantic_action)){
                    degradeNarration(reason);
                    const canonical=canonicalPerceptionNarrative(next,receipt,Boolean(check?.hidden));
                    observe('warn','narrative.safe_fallback',{module:'turn',request_id:req.request_id,
                      metadata:{reason:'perception_prose_unverified',narrator_attempts:attempt}});
                    return {...result,narrative:canonical,scene_beats:[],presence_claims:[],speaker:null,dialogue:null,choices:[],
                      choice_semantics:[],context_actions:[],patches:[],interaction:null,
                      item_claims:[],stable_locations:[],mechanical_claims:[]};
                  }
                  if(receipt.movement_route){
                    degradeNarration(reason);
                    observe('warn','narrative.safe_fallback',{module:'turn',request_id:req.request_id,
                      metadata:{reason:'movement_route_unverified',narrator_attempts:attempt}});
                    return {...result,narrative:canonicalMovementNarrative(receipt,next),speaker:null,dialogue:null,choices:[],
                      choice_semantics:[],context_actions:[],patches:[],interaction:null,
                      item_claims:[],stable_locations:[],mechanical_claims:[]};
                  }
                throw error;
              }
              repair={reason,schema_feedback:{issues:[{path:'narrative',code:'fact_conflict',expected:'已结算Receipt及公开现场事实',message:reason.slice(0,500)}],previous_output:generationRepair(new CandidateValidationError('narrator',[],result))!.previous_output},...(error instanceof NarrativePatternError?{
                pattern_kind:error.patternKind,match_index:error.matchIndex,snippet:error.snippet,
                allowed_effects:[...receipt.effects]}:{})};
              continue;
            }
            // Claims validation belongs to the same uncommitted generation, not a later
            // terminal save error. Apply once to an isolated candidate; invalid partial
            // materialization is discarded, and no Core action/RNG is repeated.
            try{
              if(check&&((result.item_claims??[]).length||(result.stable_locations??[]).length))throw new GameError('判定后的描写不能补造新的世界实体');
              const withClaims=applyNarrativeClaims(structuredClone(next),result);next=withClaims;
            }catch(error){
              if(!(error instanceof GameError))throw error;
              observe('warn','narrative.claims.rejected',{module:'turn',request_id:req.request_id,metadata:{attempt,reason:errorText(error).slice(0,220),recoverable:claimsRepairs<1&&attempt<3}});
              if(claimsRepairs>=1||attempt===3)throw error;
              claimsRepairs++;repair={reason:'narrative_claims_invalid',schema_feedback:{issues:[{path:'item_claims/stable_locations',code:'claim_contract',expected:'与正文、当前地点、已有能力及Receipt一致，不补造未授权实体',message:errorText(error).slice(0,500)}],previous_output:generationRepair(new CandidateValidationError('narrator_claims',[],result))!.previous_output}};
              continue;
            }
            // The prompt already contains the authoritative scene/history; narrator calls are stateless.
            delete next.ai.threads.narrator;
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
        // Valid prose and optional enrichment are separate concerns: a rejected enrichment must never discard the narration.
        next = applyOptionalEnrichment(next, result.patches, turn.action, turn.registry, req.request_id);
        const offers=await makeCompiledChoiceOffers(next,result.choices,result.choice_semantics??[],this.ai,true);
        next.last_turn = { narrative: result.narrative, speaker: result.speaker, dialogue: result.dialogue,
          ...(result.scene_beats?.length?{scene_beats:result.scene_beats}:{}),
          choices:offers.filter(offer=>offer.availability_at_generation!=='UNSUPPORTED').map(offer=>offer.text),choice_offers:offers,context_actions: result.context_actions };
      } catch (error) {
        if(error instanceof GameError)throw error;
        if (!['refusal','content_filter'].includes(failureReason(error))) {
          observe('warn','narration.aborted_before_commit',{module:'turn',request_id:req.request_id,metadata:{action:turn.action.type,reason:failureReason(error),detail:errorText(error).slice(0,240)}});
          const settledReceipt=(generic||turn.action.type==='MOVE')?
            next.resolution_receipts?.find(entry=>entry.request_id===req.request_id):undefined;
          if(settledReceipt&&error instanceof ProviderError&&
            ['schema','timeout','server_error','max_output_tokens','length','invalid_json','missing_output_text'].includes(error.reason)){
            degradeNarration(narrationFailureReason(error));
            // The candidate action and receipt have already passed authoritative validation.
            // A failed prose service must not discard a deterministic, grounded settlement.
            observe('warn','narrative.safe_fallback',{module:'turn',request_id:req.request_id,
              metadata:{reason:failureReason(error),action:turn.action.type,receipt_id:settledReceipt.request_id}});
            delete next.ai.threads.narrator;
            const degraded=narrationFallback(next,turn.action,current,compoundSteps);
            next.last_turn={...degraded,speaker:null,dialogue:null,choices:[],context_actions:[]};
            notices.push('本次行动已完成并保存；场景描写暂时采用已验证的结算结果。');
          }else{
          // An unclassified narration failure may still be a transient provider error.
          // Only a structured contract validation failure is deterministic here.
          const retryable=!(error instanceof z.ZodError);
          const failure=new GameError(retryable?
            error instanceof ProviderError?
              '叙事服务暂时未完成，本回合尚未结算，可从当前目标继续。':
              '叙事生成未完整完成，本回合尚未结算，可从当前目标继续。':
            '候选内容未通过程序校验，本回合尚未结算；需要修复后再继续当前目标。',503) as GameError&{
              retry_policy:'safe'|'manual';failure_stage:string;failure_engine_code:'provider_failure'|'schema_failure'};
          failure.retry_policy=retryable?'safe':'manual';
          failure.failure_stage='narrative_provider';
          failure.failure_engine_code=retryable?'provider_failure':'schema_failure';
          throw failure;
          }
        }else{
        // Explicit provider refusal permits a neutral, player-facing safety fallback.
        observe('warn','narration.safety_degraded',{module:'turn',request_id:req.request_id,metadata:{action:turn.action.type,reason:failureReason(error)}});
        degradeNarration(failureReason(error));
        delete next.ai.threads.narrator;
        next.last_turn = { ...narrationFallback(next, turn.action,current,compoundSteps), speaker: null, dialogue: null, choices: [], context_actions: [] };
        notices.push('本次行动已完成并保存；这一刻的场景描写暂时没有生成。');
        }
      }
      if(narrationPresentation&&next.last_turn)next.last_turn.presentation=narrationPresentation;
      const exposed=drainBackgroundDisplay(next);
      if(exposed.length&&next.last_turn){
        const missing=exposed.filter(text=>!next.last_turn!.narrative.includes(text));
        if(missing.length)next.last_turn.narrative=[next.last_turn.narrative,...missing].join('\n');
      }
      return this.media(async()=>{
      onPhase?.('validating');
      // A presentation-only write may have committed while this turn ran: keep it and never write a lower revision.
      const latest = await this.storage.read('current','turn_commit_check');
      if (latest) { preservePresentation(latest, next); next.state_revision = Math.max(current.state_revision, latest.state_revision) + 1; }
      else next.state_revision = current.state_revision + 1;
      if(next.last_turn?.choice_offers)for(const offer of next.last_turn.choice_offers){
        offer.source_revision=next.state_revision;
        if(offer.goal_contract?.contract){
          offer.goal_contract.contract.source_revision=next.state_revision;
          offer.goal_contract.contract.last_observed_revision=next.state_revision;
        }
      }
      next.runtime.receipts = [...next.runtime.receipts,
        ...(travelDecisionReceipt?[{...travelDecisionReceipt,revision:next.state_revision}]:[]),
        { id: req.request_id, fingerprint, revision: next.state_revision }].slice(-100);
      if(completeFutureId){const intent=next.future_intents!.find(i=>i.id===completeFutureId)!;intent.status='completed';intent.completed_by_request=req.request_id;}
      const worldTurn=!compileOnly&&!['SAVE_ROUTINE','CLEAR_ROUTINE','CANCEL_ROUTINE','PAUSE_ROUTINE'].includes(turn.action.type);
      if(worldTurn){
        updateInteraction(next,turn.action,beforeTurn,interaction);
        if(req.end_conversation&&next.interaction_context)next.interaction_context.status='ended';
        // A companion's own words at departure are public history: they explain the recorded intention later and never
        // become authoritative prose of an uncommitted effect.
        const movementNarrative=next.last_turn?.narrative??'';
        const movementSpeech=(next.last_turn?.scene_beats??[]).flatMap(beat=>beat.kind==='speech'?[{
          speaker_id:beat.speaker_id,utterance:beat.utterance,
          provenance:beat.speaker_id===next.player_state.entity_id?'verbatim_player_input' as const:'npc_response' as const,
          source_intent:beat.speaker_id===next.player_state.entity_id?req.player_input??req.input??null:null}]:[]);
        const departureLines=travelDecisionLines.map(line=>
          `${String(next.entities.find(entity=>entity.id===line.speaker_id)?.components.identity?.name??line.speaker_id)}：“${line.utterance}”`);
        if(departureLines.length&&next.last_turn){
          // Said before they set off, so it reads before the journey prose rather than as an afterthought.
          next.last_turn.narrative=[...departureLines,movementNarrative].filter(Boolean).join('\n');
        }
        // Preserve the immediately preceding, committed scene as ordered dialogue cards
        // when this MOVE belongs to the same compound request. The request ID guard keeps
        // an older conversation from being replayed as part of an unrelated move.
        if(turn.action.type==='MOVE'&&req.preceding_scene_request_id&&next.last_turn&&
          beforeTurn.narrative_history?.at(-1)?.request_id===req.preceding_scene_request_id){
          if(beforeTurn.last_turn?.scene_beats?.length){
            const movementBeats=[...(next.last_turn.scene_beats??[])];
            if(!movementBeats.length)for(let offset=0;offset<movementNarrative.length;offset+=1200)
              movementBeats.push({kind:'narration',text:movementNarrative.slice(offset,offset+1200)});
            const composed=[...beforeTurn.last_turn.scene_beats,
              ...travelDecisionLines.map(line=>({kind:'speech' as const,speaker_id:line.speaker_id,utterance:line.utterance})),
              ...movementBeats!];
            if(composed.length<=96)next.last_turn.scene_beats=composed;
          }
          next.last_turn.narrative=[beforeTurn.last_turn?.narrative,...departureLines,movementNarrative]
            .filter(Boolean).join('\n');
          next.last_turn.speaker=null;
          next.last_turn.dialogue=null;
        }
        const departureEvent=departureLines.length?{
          request_id:travelDecisionReceipt?.id??req.request_id,narrative:departureLines.join('\n'),
          dialogue:null,speaker:null,facts:[],revision:next.state_revision,
          time:structuredClone(beforeTurn.runtime.time),
          location_id:beforeTurn.entities.find(entity=>entity.id===beforeTurn.player_state.entity_id)?.components.location?.location_id==null?
            null:String(beforeTurn.entities.find(entity=>entity.id===beforeTurn.player_state.entity_id)?.components.location?.location_id),
          speech_events:travelDecisionLines.map(line=>({speaker_id:line.speaker_id,utterance:line.utterance,
            provenance:'npc_response' as const,source_intent:null}))}:null;
        next.narrative_history=[...(beforeTurn.narrative_history??[]),...(departureEvent?[departureEvent]:[]),
          {request_id:req.request_id,narrative:movementNarrative,dialogue:next.last_turn?.dialogue??null,speaker:next.last_turn?.speaker??null,facts:turn.facts.slice(0,12).map(f=>f.slice(0,2000)),
          player_input:req.player_input??req.input,revision:next.state_revision,
          ...(movementSpeech.length?{speech_events:movementSpeech}:{}),
          time:structuredClone(next.runtime.time),
          location_id:next.entities.find(entity=>entity.id===next.player_state.entity_id)?.components.location?.location_id==null?
            null:String(next.entities.find(entity=>entity.id===next.player_state.entity_id)?.components.location?.location_id),
          }].slice(-8);
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
      for(const childId of resolutionReceipt?.repetition?.attempt_ids??[]){
        const child=next.resolution_receipts?.find(entry=>entry.request_id===childId);
        assert(child,'连续行动的阶段凭据丢失');child.commit_status='committed';
      }
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
      // Media may advance revision during model work. Recovery matches the
      // actual receipt predecessor, rather than the original pre-narration view.
      await prepareRequestCommit(req.game_id,req.request_id,fingerprint,next.state_revision-1);
      signal?.throwIfAborted();
      await this.storage.write(next);
      this.pendingTurns.delete(req.request_id);await this.storage.clearPending?.(req.request_id).catch(error=>observe('warn','resolution.pending_cleanup_failed',{module:'turn',request_id:req.request_id,metadata:{reason:errorText(error)}}));
      trace.info('save.commit', { revision: next.state_revision, metadata: { step_request_id:req.request_id,revision_before: current.state_revision, revision_after: next.state_revision, validation: 'accepted', action: turn.action.type, source: turn.action.source, ...diff } });
      commit.end(diff);
      return { ...publicView(next), notices };
      });
      });
    },owner));
  }
  async configureCalendar(raw:unknown,gameId:string,revision:number,requestId=randomUUID()){
    const calendar=safeParse(calendarSchema,raw),tx=safeParse(z.strictObject({game_id:z.string().uuid(),expected_revision:z.number().int().nonnegative(),request_id:z.string().uuid()}),
      {game_id:gameId,expected_revision:revision,request_id:requestId});
    const fingerprint=createHash('sha256').update(JSON.stringify({calendar_configuration:calendar})).digest('hex');
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current();assert(save.game_id===tx.game_id,'游戏已切换');
      const receipt=save.runtime.receipts.find(entry=>entry.id===tx.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
      assert(save.state_revision===tx.expected_revision,'状态已更新，请刷新后重试');
      save.calendar=calendar;migrateInstalledWorld(save,this.installedWorlds);save.state_revision++;
      save.runtime.receipts=[...save.runtime.receipts,{id:tx.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      const validated=validateSave(save);
      await prepareRequestCommit(tx.game_id,tx.request_id,fingerprint,tx.expected_revision);
      await this.storage.write(validated);return publicView(validated);
    }));
  }
  async acknowledgeTask(_id:string,_gameId:string,_revision:number,_outcome:'completed'|'cancelled'='completed'):Promise<never>{throw new GameError('不能手工标记任务完成或取消日历事件；任务结果必须由已登记的任务规则结算',410);}
  async checkpoint() { return this.exclusive(async () => { const save = await this.current(); await this.storage.write(save, 'checkpoint'); return publicView(save); }); }
  async narrativeCommand(raw:{request_id:string;game_id:string;expected_revision:number},command:StoryCommand){
    return this.exclusive(()=>this.media(async()=>{
      const current=await this.current(),fingerprint=`narrative:${command}`;
      assert(raw.game_id===current.game_id,'游戏已切换，请刷新');
      const receipt=current.runtime.receipts.find(entry=>entry.id===raw.request_id);if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return {view:publicView(current),message:''};}
      if(raw.expected_revision!==current.state_revision)throw new GameError('状态已更新，请刷新后重试',409);
      const before=structuredClone(current),next=structuredClone(current),message=applyStoryCommand(next,command);
      next.state_revision=current.state_revision+1;next.runtime.receipts=[...next.runtime.receipts,{id:raw.request_id,fingerprint,revision:next.state_revision}].slice(-100);
      next.last_turn={narrative:message,speaker:null,dialogue:null,choices:[],context_actions:[]};
      checkpointTurn(before,next,raw.request_id);const validated=validateSave(next);
      await prepareRequestCommit(raw.game_id,raw.request_id,fingerprint,current.state_revision);
      await this.storage.write(validated);return {view:publicView(validated),message};
    }));
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
      const validated=validateSave(next);
      await prepareRequestCommit(req.game_id,req.request_id,fingerprint,current.state_revision);
      await this.storage.write(validated);
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
      const validated=validateSave(next);
      await prepareRequestCommit(req.game_id,req.request_id,fingerprint,current.state_revision);
      await this.storage.write(validated);this.logger.info('turn.history_restored',{module:'turn',request_id:req.request_id,revision:validated.state_revision,metadata:{turn_id:target.turn_id,discarded:history.length-index-1}});return publicView(validated);
    }));
  }
  async load() { return this.exclusive(async () => {
    const raw = await this.storage.read('checkpoint'); assert(raw, '还没有手动保存的检查点');
    const save = this.ensureBaseFeatures(raw).save;
    save.game_id = randomUUID(); save.ai.threads = {}; save.runtime.receipts = [];
    await this.media(()=>this.storage.write(save)); return publicView(save);
  }); }
  async import(raw: unknown) { return this.exclusive(async () => {
    const isSave = !!raw && typeof raw === 'object' && 'state_revision' in raw;
    let save = isSave ? importSave(migrateInstalledWorld(structuredClone(raw) as SavePackage,this.installedWorlds).save) : newSave(raw);
    save = this.ensureBaseFeatures(save).save;
    if (!save.last_turn) save.last_turn = { narrative: save.definition.meta.description, speaker: null, dialogue: null, choices: [], context_actions: [] };
    await this.media(()=>this.storage.write(save)); return publicView(save);
  }); }
  async previewCharacterCard(raw:unknown,gameId:string,expectedRevision:number){
    return withRequestBudget(async()=>{
    const save=await this.current();
    if(save.game_id!==gameId||save.state_revision!==expectedRevision)throw new GameError('世界状态已更新，请刷新后重新预览',409);
    assert(save.definition.enabled_modules.includes('characters'),'当前世界未启用人物模块');
    assert(save.entities.length<1000,'实体数量已达到存档上限');
    observe('info','character_card.import.started',{module:'characters',revision:save.state_revision});
    const adapter=this.ai.adapter;
    const generate=adapter.name!=='mock'?(request:{role:string;prompt:string;schema:typeof adaptationSchema})=>
      generateWithinRequestBudget(adapter,{...request,role:'gm_reasoning',maxOutputTokens:4000}):undefined;
    const {candidate,preview}=await prepareCharacterImport(save,raw,generate);
    this.characterImportPreviews.set(candidate.preview_id,candidate);
    for(const [id,value] of this.characterImportPreviews)if(Date.now()-value.created_at>15*60_000)this.characterImportPreviews.delete(id);
    observe('info','character_card.preview_created',{module:'characters',revision:save.state_revision,
      metadata:{preview_id:candidate.preview_id,source_hash:candidate.source_hash}});
    return preview;
    });
  }
  cancelCharacterCardPreview(previewId:string){
    const removed=this.characterImportPreviews.delete(previewId);
    if(removed)observe('info','character_card.cancelled',{module:'characters',metadata:{preview_id:previewId}});
    return {cancelled:removed};
  }
  async commitCharacterCard(previewId:string,gameId:string,expectedRevision:number,requestId:string){
    const candidate=this.characterImportPreviews.get(previewId);
    if(!candidate||Date.now()-candidate.created_at>15*60_000)throw new GameError('导入预览已失效，请重新预览',409);
    if(candidate.game_id!==gameId||candidate.revision!==expectedRevision)throw new GameError('世界状态已更新，请重新预览',409);
    const out=await this.agentTransaction({game_id:gameId,expected_revision:expectedRevision,request_id:requestId},
      {character_import:previewId,source_hash:candidate.source_hash},save=>{
        assert(save.definition.enabled_modules.includes('characters'),'当前世界未启用人物模块');
        assert(save.entities.length<1000,'实体数量已达到存档上限');
        const player=save.entities.find(e=>e.id===save.player_state.entity_id);
        assert(player?.components.location?.location_id===candidate.location_id,'玩家位置已改变，请重新预览');
        const entityId=`card_${randomUUID().replaceAll('-','').slice(0,24)}`;
        save.entities.push({id:entityId,type:'character',components:{
          identity:{name:candidate.name,description:'新加入当前世界的人物。',avatar_id:null,gender:null,age:null},
          location:{location_id:candidate.location_id},
          character:authoredCharacter('新加入的人物',candidate.persona),
          character_import:{source_format:candidate.source_spec,source_hash:candidate.source_hash,
            adapted_at:{...save.runtime.time},adaptation_summary:[...candidate.adapted,...candidate.rejected].join('；').slice(0,500)},
          discovery:{known_to_player:true},
          ...(save.definition.enabled_modules.includes('relationships')?{relationships:{entries:{}}}:{}),
        }});
        save.npc_agent_state??={};save.npc_agent_state[entityId]=emptyNpcAgentState();
      });
    out.notices.push(`已导入 ${candidate.name}；人物资料已按当前世界约束适配，可使用 Undo 撤销。`);
    observe('info','character_card.committed',{module:'characters',revision:out.revision,
      metadata:{preview_id:previewId,source_hash:candidate.source_hash}});
    return out;
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
    // Content-addressed bytes may already be shared, or the binding may commit
    // before its response fails. Keep them across failures and reference clears.
    return {view:await this.setAvatar(entityId,artifact.asset_id,gameId,expectedRevision),artifact};
  }
  async setAvatar(entityId: string, avatarId: string | null, gameId: string, _expectedRevision?: number,crop?:AvatarCropMetadata) {
    return this.media(async () => {
      const save = await this.presentationCurrent();
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
      const save = await this.presentationCurrent();
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
    return this.exclusive(()=>this.media(async()=>{
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
      await prepareRequestCommit(input.game_id,input.request_id,fingerprint,current.state_revision);
      await this.storage.write(validateSave(next));return this.project(next);
    }));
  }
  async modules() {
    const save = await this.current();
    return { modules: moduleStatuses(save), capabilities: [...new Set([...capabilityList(createRegistry(save.definition.enabled_modules)),...this.runtimeCapabilities])], installed: save.modules };
  }
  /** Module lifecycle is a canonical mutation: same revision/idempotency rules as a turn. */
  async manageModule(raw: unknown, command: 'enable' | 'disable' | 'remove') {
    return this.exclusive(()=>this.media(async () => {
      const body = safeParse(z.strictObject({ module: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), confirmed: z.boolean(), game_id: z.string().uuid(), expected_revision: z.number().int().min(0), request_id: z.string().uuid() }), raw);
      const current = await this.current();
      if (current.game_id !== body.game_id) throw new GameError('游戏已切换，请刷新后操作', 409);
      const action = { type: command === 'enable' ? 'ENABLE_MODULE' : command === 'disable' ? 'DISABLE_MODULE' : 'REMOVE_MODULE', parameters: { module: body.module, confirmed: body.confirmed } };
      const fingerprint=createHash('sha256').update(JSON.stringify({module_action:action})).digest('hex');
      const receipt=current.runtime.receipts.find(entry=>entry.id===body.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(current);}
      if (current.state_revision !== body.expected_revision) throw new GameError('状态已更新，请刷新后重试', 409);
      const turn = executeAction(current, action, body.request_id, 'player');
      const next = turn.save;
      next.state_revision = current.state_revision + 1;
      next.runtime.receipts = [...next.runtime.receipts, { id: body.request_id, fingerprint, revision: next.state_revision }].slice(-100);
      const validated=validateSave(next);
      await prepareRequestCommit(body.game_id,body.request_id,fingerprint,current.state_revision);
      // Removal is destructive: keep a checkpoint of the pre-removal state first.
      if (command === 'remove' && body.confirmed) {
        const checkpoint = structuredClone(current);
        checkpoint.runtime.receipts = [];
        await this.storage.write(checkpoint, 'checkpoint');
      }
      await this.storage.write(validated);
      const view = publicView(next);
      view.notices.push(turn.facts.join(' '));
      this.logger.info('module.lifecycle', { module: 'framework', request_id: body.request_id, revision: next.state_revision, metadata: { command, target: body.module } });
      return view;
    }));
  }
  async behaviorConfig() {
    return (await this.current()).behavior_config;
  }
  async contentAllowances(){return (await this.current()).definition.roleplay_config?.content_allowances??[];}
  /** One revision for a System preference request; no world turn or action resolution. */
  async setNarrativePreferences(raw:unknown,request?:{game_id?:string;expected_revision?:number;request_id?:string}){
    const input=safeParse(z.strictObject({
      scopes:z.array(z.enum(['narration','dialogue','assistant'])).max(3),
      tone:z.enum(['literary','concise','natural','plain','first_person','third_person','mature']).nullable(),
      allowed_topics:z.array(z.enum(['violence','crime','romance','adult_intimacy','substance_use','politics','trauma'])).max(7),
    }),raw);
    assert((input.tone&&input.scopes.length)||input.allowed_topics.length,'缺少可保存的叙事偏好');
    const fingerprint=createHash('sha256').update(JSON.stringify({narrative_preferences:{...input,
      scopes:[...new Set(input.scopes)].sort(),allowed_topics:[...new Set(input.allowed_topics)].sort()}})).digest('hex');
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),now=new Date().toISOString();
      const tx=request?.request_id?safeParse(z.strictObject({game_id:z.string().uuid(),expected_revision:z.number().int().nonnegative(),request_id:z.string().uuid()}),
        {game_id:request.game_id??save.game_id,expected_revision:request.expected_revision??save.state_revision,request_id:request.request_id}):undefined;
      if(tx){
        assert(save.game_id===tx.game_id,'游戏已切换');
        const receipt=save.runtime.receipts.find(item=>item.id===tx.request_id);
        if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
        assert(save.state_revision===tx.expected_revision,'状态已更新，请刷新后重试');
      }
      if(input.tone)for(const scope of input.scopes){
        const rule={scope,op:'tone' as const,value:input.tone,application:'per_message' as const,
          raw:`tone:${input.tone}`,enabled:true,created_at:now};
        save.behavior_config=[...(save.behavior_config??[]).filter(existing=>!(existing.scope===scope&&existing.op==='tone')),rule].slice(-20);
      }
      if(input.allowed_topics.length){
        const config=save.definition.roleplay_config??defaultRoleplayConfig();
        config.content_allowances=[...new Set([...(config.content_allowances??[]),...input.allowed_topics])];
        save.definition.roleplay_config=config;
      }
      save.state_revision++;
      if(tx)save.runtime.receipts=[...save.runtime.receipts,{id:tx.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      const validated=validateSave(save);
      if(tx)await prepareRequestCommit(tx.game_id,tx.request_id,fingerprint,tx.expected_revision);
      await this.storage.write(validated);
      this.logger.info('narrative.preferences.updated',{module:'framework',revision:save.state_revision,
        metadata:{scopes:input.scopes,tone:input.tone,allowed_topics:input.allowed_topics}});
      return publicView(save);
    }));
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
  async narrativeDebug(){const save=await this.current(),truth=save.gm_state.hidden_truth?.commitments??[];return {roleplay_config:save.definition.roleplay_config??null,narrative_state:publicView(save).story??null,hidden_truth_summary:{count:truth.length,commitments:Object.fromEntries(['HARD_TRUTH','SEEDED_TRUTH','UNDEFINED'].map(kind=>[kind,truth.filter(item=>item.commitment===kind).length])),evidence_count:truth.reduce((sum,item)=>sum+item.evidence.length,0),content:'仅返回玩家可见的叙事状态与 GM 计数，不返回秘密正文'}};}
  /** Style configuration is framework configuration: it never advances time and never touches world facts. */
  async setBehaviorConfig(raw:unknown,request?:ConfigurationRequest,sourceInput?:string){
    return this.updateBehaviorConfig({set:[raw]},request,sourceInput);
  }
  async clearBehaviorConfig(scope?:string,request?:ConfigurationRequest,sourceInput?:string){
    return this.updateBehaviorConfig({remove:[scope===undefined?{}:{scope}]},request,sourceInput);
  }
  /** System replay is bound to the original user text, before deriving rules from volatile conversation context. */
  async recoverBehaviorConfigRequest(input:string,request:ConfigurationRequest){
    const replay=await this.recoverSystemConfigurationRequest(input,request);
    return replay?.kind==='style'?replay.view:null;
  }
  async recoverSystemConfigurationRequest(input:string,request:ConfigurationRequest){
    const tx=safeParse(configurationRequestSchema,{game_id:request.game_id,expected_revision:request.expected_revision,request_id:request.request_id});
    if(!tx.request_id)return null;
    const save=await this.storage.read('current','request_recovery');
    if(!save)return null;
    const receipt=save.runtime.receipts.find(item=>item.id===tx.request_id);
    const kind=receipt?.fingerprint.startsWith('behavior-config:input:')?'style':
      receipt?.fingerprint.startsWith('behavior-guidance:input:')?'guidance':null;
    assert(tx.game_id===undefined||tx.game_id===save.game_id,'游戏已切换');
    if(!kind)return await this.guidanceJournal().recover(save.game_id,tx.request_id,guidanceFingerprint(null,input))?
      {kind:'guidance' as const,view:publicView(save)}:null;
    assert(receipt!.fingerprint===(kind==='style'?behaviorInputFingerprint(input):guidanceFingerprint(null,input)),'请求 ID 已用于另一操作');
    return {kind,view:publicView(save)};
  }
  /** Validate the complete edit, then prepare and save one image using the existing receipt protocol. */
  async updateBehaviorConfig(raw:unknown,request?:ConfigurationRequest,sourceInput?:string){
    const input=safeParse(z.strictObject({set:z.array(behaviorSettingSchema).max(3).default([]),
      remove:z.array(z.strictObject({scope:behaviorScopeSchema.optional(),op:behaviorOpSchema.optional()})).max(4).default([])}),raw);
    assert(input.set.length||input.remove.length,'缺少风格要求');
    for(const setting of input.set)assert(setting.rule||setting.instruction,'缺少风格要求');
    const now=new Date().toISOString(),rules=input.set.map(setting=>setting.rule?
      {...setting.rule,scope:setting.scope,raw:(setting.instruction??`${setting.rule.op} ${setting.rule.value}`).slice(0,200),enabled:true,created_at:now}:
      parseBehaviorRule(setting.instruction!,setting.scope,now));
    assert(new Set(rules.map(rule=>`${rule.scope}:${rule.op}`)).size===rules.length,'同一范围的风格规则冲突');
    // Direct service calls bind the complete edit. System calls bind immutable user text instead:
    // replay must not reinterpret a correction against a later or missing conversation context.
    const fingerprint=sourceInput===undefined?'behavior-config:changes:'+createHash('sha256').update(JSON.stringify(input)).digest('hex'):
      behaviorInputFingerprint(sourceInput);
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),tx=safeParse(z.strictObject({game_id:z.string().uuid(),expected_revision:z.number().int().nonnegative(),request_id:z.string().uuid()}),
        {game_id:request?.game_id??save.game_id,expected_revision:request?.expected_revision??save.state_revision,request_id:request?.request_id??randomUUID()});
      assert(save.game_id===tx.game_id,'游戏已切换');
      const receipt=save.runtime.receipts.find(item=>item.id===tx.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
      if(save.state_revision!==tx.expected_revision)throw new GameError('状态已更新，请刷新后重试',409);
      save.behavior_config=save.behavior_config.filter(rule=>!input.remove.some(selector=>
        (selector.scope===undefined||selector.scope===rule.scope)&&(selector.op===undefined||selector.op===rule.op)));
      for(const rule of rules)save.behavior_config=[...save.behavior_config.filter(existing=>!(existing.scope===rule.scope&&existing.op===rule.op)),rule];
      save.state_revision++;
      save.runtime.receipts=[...save.runtime.receipts,{id:tx.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      const validated=validateSave(save);
      await prepareRequestCommit(tx.game_id,tx.request_id,fingerprint,tx.expected_revision);
      await this.storage.write(validated);
      this.logger.info('behavior.config.updated',{module:'framework',request_id:tx.request_id,revision:save.state_revision,
        metadata:{set:rules.map(rule=>({scope:rule.scope,op:rule.op})),remove:input.remove}});
      const view=publicView(validated);view.notices.push(rules.length?'已更新运行时风格配置。':'已恢复所选范围的默认风格。');return view;
    }));
  }
  async export() { return exportSave(await this.current()); }

  async agentTransaction(raw:{game_id:string;expected_revision:number;request_id:string},operation:unknown,mutate:(save:SavePackage)=>void){
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=createHash('sha256').update(JSON.stringify({agent_operation:operation})).digest('hex');
      assert(save.game_id===raw.game_id,'游戏已切换');const receipt=save.runtime.receipts.find(r=>r.id===raw.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
      assert(save.state_revision===raw.expected_revision,'状态已更新，请重新规划');const before=structuredClone(save);mutate(save);
      if(save.runtime.time.day!==before.runtime.time.day||save.runtime.time.minute!==before.runtime.time.minute){
        const autonomous=await settleAutonomousNpcTurn(this,save,before.runtime.time,raw.request_id);
        Object.assign(save,autonomous.save);
      }
      save.state_revision++;
      save.runtime.receipts=[...save.runtime.receipts,{id:raw.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      const validated=validateSave(save);
      checkpointTurn(before,validated,raw.request_id);
      // JsonStore performs the full final validation including the newly attached
      // checkpoint. Other storage adapters retain the explicit final check.
      await prepareRequestCommit(raw.game_id,raw.request_id,fingerprint,before.state_revision);
      await this.storage.write(this.storage.validatesWrites?validated:validateSave(validated));this.logger.info('agent.transaction',{module:'agent',request_id:raw.request_id,revision:validated.state_revision});return publicView(validated);
    }));
  }
  async extensionTransaction(raw:{game_id:string;expected_revision:number;request_id:string},operation:unknown,mutate:(save:SavePackage)=>void){
    return this.exclusive(()=>this.media(async()=>{
      const save=await this.current(),fingerprint=createHash('sha256').update(JSON.stringify({extension_operation:operation})).digest('hex');
      assert(save.game_id===raw.game_id,'游戏已切换');const receipt=save.runtime.receipts.find(r=>r.id===raw.request_id);
      if(receipt){assert(receipt.fingerprint===fingerprint,'请求 ID 已用于另一操作');return publicView(save);}
      if(save.state_revision!==raw.expected_revision)throw new GameError('状态已更新，请刷新后重试',409);
      mutate(save);save.state_revision++;save.runtime.receipts=[...save.runtime.receipts,{id:raw.request_id,fingerprint,revision:save.state_revision}].slice(-100);
      const validated=validateSave(save);
      await prepareRequestCommit(raw.game_id,raw.request_id,fingerprint,raw.expected_revision);
      await this.storage.write(validated);this.logger.info('extension.transaction',{module:'extension',request_id:raw.request_id,revision:save.state_revision,metadata:{operation}});
      return publicView(save);
    }));
  }
}

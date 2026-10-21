import {resolveActionEntities} from '../agent/entities.js';
import { z } from 'zod';
import { GameError, assert, id, providerEmptyArray, providerFalseBoolean, type SavePackage } from './schema.js';
import {isActivePerception} from '../agent/perception.js';
import { observe } from '../observability/index.js';
import { publicView } from './state.js';
import { createRegistry } from '../modules/index.js';
import { executeAction, applyPatches,advanceWorldSegment } from './runtime.js';
import {putItemInInventory,putItemInScene,putItemInSceneContainer,setItemCondition,type Inventory} from '../modules/inventory.js';
import {bindStorageAction} from './action-binding.js';
import {activityEvidence,interruptedActivityFact,enumeratedInspectionItems,inspectionEvidence,progressChanges,requiresPersistentProgress,type InspectionResult} from './completion-evidence.js';
import {difficultyBandSchema,prepareCheck,resolutionKindSchema,resolveCheck} from './resolution.js';
import {secureRng,type RNG} from './dice.js';
import {normalizeProviderCollections} from '../ai/provider-schema.js';
import {evaluateWorldPrerequisites,requirementSchema} from './prerequisites.js';
import {emptyNpcAgentState} from '../agent/npc-state.js';
import {repetitionSchema} from './schema.js';
import {createHash} from 'node:crypto';
import {recentReferent} from './recent-referent.js';
import {readPhysicalState,releaseTransient,struckWithoutSight,writePhysicalState} from './perception-state.js';
import {capabilityDomainNames} from './capability.js';
import type {GoalSpec} from '../system/goals.js';
import {WorldBlockedError} from '../agent/outcome.js';
import {environmentQuerySchema,type EnvironmentAssessment} from './environment-schema.js';
import {executeEnvironmentQuery,resolveLocalSceneAnchor,validateEnvironmentQuery} from './environment.js';
import {currentMap} from './map.js';
import {settleRelationshipOutcomes} from '../agent/npc-relations.js';
import {unsealedContainerAncestors} from './item-access.js';

/** An outcome proposal, never a save patch. Numeric mechanics remain owned by modules. */
export const freeformSchema = z.strictObject({
  narrative: z.string().min(1).max(4000),
  minutes: z.number().int().min(1).max(240),
  environment_query:environmentQuerySchema.nullish(),
  repetition:repetitionSchema.nullish(),
  target_id: id.nullable(),
  facts: providerEmptyArray(z.array(z.string().min(1).max(300)).max(4)),
  inspection_results: providerEmptyArray(z.array(z.strictObject({item:z.string().min(1).max(120),result:z.enum(['found','nothing','blocked','not_checked']),detail:z.string().max(300)})).max(12)).optional(),
  relationship: z.strictObject({ dimension: id, delta: z.number().int().min(-2).max(2) }).nullable(),
  item_move:z.strictObject({item_id:id,to:z.enum(['held','scene','target']),position_label:z.string().max(80).nullable()}).nullable().optional(),
  item_change:z.strictObject({item_id:id,condition:z.enum(['damaged','destroyed']),source_quote:z.string().min(2).max(1000)}).nullable().optional(),
  storage_move:z.strictObject({item_name:z.string().min(2).max(100),item_id:id.nullable(),container_name:z.string().min(2).max(100),container_id:id.nullable()}).nullable().optional(),
  completion_quote:z.string().min(3).max(120).nullable().optional(),
  required_conditions:providerEmptyArray(z.array(requirementSchema).max(12)).optional(),
  blocker:z.strictObject({type:z.enum(['CAPABILITY_GAP','USER_AMBIGUITY','PREREQUISITE_FAILURE']),reason:z.string().min(1).max(300)}).nullable().optional(),
  physical_action:z.strictObject({kind:z.enum(['harm','restrain']),source_quote:z.string().min(2).max(1000),
    contact_stage_id:id,control_stage_id:id.nullish(),injury_stage_id:id.nullable(),harm_level:z.enum(['minor','serious']),surprise_attempt:z.boolean(),
    mechanism:z.enum(['direct_force','environment']).default('direct_force'),
    hazard_source:z.strictObject({source_id:id,quote:z.string().min(2).max(300)}).nullable().default(null)}).nullish(),
  resolution:z.strictObject({type:resolutionKindSchema.exclude(['EVENT_ROLL']),domain:id,opposition_domain:id.nullable().optional(),band:difficultyBandSchema,
    visibility:z.enum(['public','hidden']),stakes:z.string().max(300),stages:providerEmptyArray(z.array(z.strictObject({id,band:difficultyBandSchema})).max(8)),
    evidence_ids:providerEmptyArray(z.array(id).max(20)),discover_facts:providerFalseBoolean()}).nullish(),
});
const maxFactCount = 4, maxFactLength = 300;
/** Invalid model proposal rejected before a candidate or world effect exists. */
export class FreeformRepairableError extends GameError {
  readonly name='FreeformRepairableError';
  readonly failure_stage='freeform_binding';
  readonly failure_engine_code='schema_failure';
  constructor(readonly failure_code:'proposal_contract_invalid'|'target_binding_invalid'|'opponent_binding_invalid',message:string,
    readonly public_targets:{id:string;name:string}[]=[],
    readonly diagnostics:{path:string;code:string;expected:string}[]=[]){super(message,503);}
}
/**
 * Deterministic robustness for slightly over-sized model proposals: extra facts are merged into the
 * last allowed entry instead of failing the whole turn. Anything else (unknown fields, numeric combat
 * state, patches) still fails validation, and minutes are clamped to the documented 1–5 range.
 */
export function normalizeFreeformProposal(raw: unknown,input?:string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const proposal = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(proposal.facts)) {
    const cleaned = proposal.facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0).map(fact => fact.trim());
    if (cleaned.length > maxFactCount) {
      const head = cleaned.slice(0, maxFactCount - 1);
      const merged = cleaned.slice(maxFactCount - 1).join('；').slice(0, maxFactLength);
      proposal.facts = [...head, merged];
    } else proposal.facts = cleaned;
  }
  const stated=input?explicitDurationMinutes(input):null;
  if(stated!==null)proposal.minutes=stated;
  else if(typeof proposal.minutes === 'number' && Number.isFinite(proposal.minutes))proposal.minutes=Math.max(1,Math.min(5,Math.trunc(proposal.minutes)));
  return proposal;
}
export function parseFreeformProposal(raw: unknown,input?:string) {
  const normalized = normalizeFreeformProposal(normalizeProviderCollections('freeform',raw),input);
  const parsed = freeformSchema.safeParse(normalized);
  if (parsed.success && (parsed.data.resolution || parsed.data.blocker)) {
    return parsed.data;
  }
  if(parsed.success)throw new FreeformRepairableError('proposal_contract_invalid','行动提案缺少判定方案。');
  // Internal schema detail stays in the log; the player only sees an actionable sentence.
  observe('warn', 'freeform.proposal.rejected', { module: 'framework', metadata: { issues: parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}:${issue.code}`) } });
  throw new FreeformRepairableError('proposal_contract_invalid','行动提案未通过结构校验，世界状态没有改变。',[],
    parsed.error.issues.slice(0,8).map(issue=>({path:issue.path.join('.'),code:issue.code,expected:issue.message})));
}
export function localDestination(input: string) {
  // A local scene position is only inferred from travel language, never from a physical interaction.
  if (isPhysicalAction(input)) return null;
  // A combined walk-and-sit/rest instruction is settled as an activity. Its
  // furniture mention does not by itself authorize a durable position label.
  if(/(?:走到|回到|来到).{0,80}(?:坐下|躺下|休息)/.test(input))return null;
  const entering=/进去|进入|走进|推门|^(?:我)?(?:现在)?(?:直接)?\s*进(?!度|行|展|步|化|阶)\S{1,10}/.test(input);
  const actualExit=/出门/.test(input)&&!/(?:准备|打算|计划|将要)出门/.test(input);
  if (!entering&&!/(?:出去|走|去|移动|靠近|到)/.test(input)&&!actualExit) return null;
  const named=input.match(/(?:回到|走到|走向|来到|移到|移动到|去到)([^，,。；;!！?？]{1,80})/)?.[1]
    ?.split(/(?:把|将|并|再|然后|接着|顺便|(?:时|后|就)?停下|(?:时|后|就)?停止)/,1)[0]?.trim()
    .replace(/(前|旁|边|口|处|里|内|上|下)(?:坐下|站住|站定|站着|待一会儿|歇一会儿|休息|停下).*$/,'$1');
  if(named)return named;
  return input.match(/屋外街边|屋外|屋内|门口|厨房|窗边|院子|走廊/)?.[0] ?? (actualExit ? '屋外' : entering?'内部':null);
}
/** The grammar helper proposes text, never a spatial registry entry. Only an
 * existing non-character anchor in this location can name a local position.
 * Map destinations still require MOVE / location lifecycle and real routes. */
export function boundLocalDestination(save:SavePackage,input:string){
  if(/出门|走出|出去|离开/.test(input))return null;
  const proposed=localDestination(input);
  if(!proposed)return null;
  const here=save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id;
   // A position beside/in front of an already registered local object remains
   // anchored to that object. The relational label is not a new world object.
   const base=proposed.replace(/(?:的)?(?:旁|边|前|附近)$/,'');
   const names=base&&base!==proposed?[proposed,base]:[proposed];
   const anchors=publicView(save).entities.filter(e=>!e.components.character&&e.components.location?.location_id===here&&
     names.includes(String(e.components.identity?.name??'')));
   if(anchors.length===1)return proposed;
  return save.environment_state?.resolutions.some(record=>record.location_id===here&&
    record.status==='present'&&record.classification==='environment_detail'&&
    (!record.known_by||record.known_by.includes(save.player_state.entity_id))&&
     [record.name,...record.aliases].some(name=>names.includes(name)))?proposed:null;
}
/** An unregistered local anchor needs the existing World Gap adjudication. */
export function localSceneQuery(save:SavePackage,input:string){
  // Exiting a room/building requires the map route and cannot create an
  // "outside" scene detail while another step (for example taking a key) runs.
  if(/出门|走出|出去|离开/.test(input))return null;
  const proposed=localDestination(input);
  if(!proposed||boundLocalDestination(save,input)||currentMap(save).locations.some(place=>place.name===proposed))return null;
  return validateEnvironmentQuery(input,{name:proposed,source_quote:input.trim(),intent:'observe'});
}
export const requestsCompletedActivity=(input:string)=>/(?:写完|做完|读完|吃完|喝完|看完|收拾完|整理完|完成|办妥|做好)/.test(input);
export const requestsItemRelocation=(input:string)=>/(?:收|放|装|塞)(?:进|入|到)/.test(input);
/** A persistent item transfer cannot be settled by an activity receipt. */
export const requiresCanonicalItemMutation=(input:string)=>requestsItemRelocation(input)||
  /(?:交给|递给|卖掉|出售|拿走|取走|拿起|取出|拾起|捡起|丢弃|扔掉|买下)/.test(input);

/** Resource-dependent activities use public scene facts, not an invented inventory entity. */
export function activityRequirement(save:SavePackage,input:string){
  if(requiresCanonicalItemMutation(input)||requiresPersistentProgress(input)||localDestination(input)||isPhysicalAction(input))
    return {kind:'mechanical' as const,available:true};
  const segment=input.match(/(?:^|[，,。；;])(?:我)?(?:想|要|去)?(?:弹|演奏|练|使用|操作|驾驶|骑)([^，,。；;!?？]{1,35})/)?.[1];
  const resource=segment?.replace(/^(?:[零一二两三四五六七八九十百\d半]{1,5}(?:分钟|个?小时)|一会儿|一阵子|一下)/,'')
    .replace(/(?:[零一二两三四五六七八九十百\d半]{1,5}(?:分钟|个?小时)|一会儿|一阵子|一段时间)$/,'').trim()??'';
  if(!resource)return {kind:'generic' as const,available:true};
  const view=publicView(save),actor=view.entities.find(entity=>entity.id===view.player_id);
  const here=actor?.components.location?.location_id;
  const location=view.locations.find(place=>place.id===here);
  const nearby=view.entities.filter(entity=>entity.components.item&&
    (entity.components.location?.location_id===here||
      ((actor?.components.inventory as Inventory|undefined)?.items[entity.id]??0)>0)&&
    String(entity.components.identity?.name??'').includes(resource));
  // A static scene description cannot restore a known broken or sealed tool.
  // A described resource without a registered item remains valid scenery.
  const available=nearby.length?nearby.some(entity=>{
    const canonical=save.entities.find(item=>item.id===entity.id);
    return Boolean(canonical&&canonical.components.item?.condition!=='destroyed'&&unsealedContainerAncestors(save,canonical));
  }):Boolean(location?.description.includes(resource));
  return {kind:'environmental' as const,available,resource};
}
export function assertFreeformGoalEvidence(save:SavePackage,input:string,requestId:string){
  const receipt=save.resolution_receipts?.find(entry=>entry.request_id===requestId);
  if(!receipt)throw new GameError('开放行动缺少程序判定凭据，本回合尚未提交，可以安全重试。',503);
  const expectedPosition=boundLocalDestination(save,input);
  const actor=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  if(localDestination(input)&&!expectedPosition&&['success','strong_success'].includes(receipt.outcome)&&
    !receipt.effects.includes('position'))
    throw new FreeformRepairableError('proposal_contract_invalid',
      '局部移动尚无权威位置或受阻凭据，不能宣称已抵达。',[],
      [{path:'resolution.local_position',code:'missing_core_evidence',
        expected:'保留原始局部移动目标；由同场景权威对象或 World Gap 确立位置，并由 Core 产生 position 凭据'}]);
  if(expectedPosition&&(!receipt.effects.includes('position')||actor?.components.scene_position?.label!==expectedPosition))
    throw new FreeformRepairableError('proposal_contract_invalid',
      '局部位置尚未结算，本回合尚未提交，可以安全重试。',[],
      [{path:'resolution.local_position',code:'position_receipt_mismatch',
        expected:'Core 的 position 效果与玩家 scene_position 必须指向同一权威局部位置'}]);
  if(requiresPersistentProgress(input)){
    if(!receipt.effects.includes('progress')||!receipt.progress_changes?.some(change=>
      change.after>change.before&&save.task_progress?.[change.key]===change.after))
      throw new GameError('行动目标尚无完成凭据，本回合尚未提交，可以安全重试。',503);
  }
  if(requestsItemRelocation(input)){
    const actorInventory=actor?.components.inventory as Inventory|undefined;
    if(!receipt.effects.includes('inventory')||!receipt.storage||
      actorInventory?.placements?.[receipt.storage.item_id]!==receipt.storage.container_id||
      (actorInventory?.items[receipt.storage.item_id]??0)<1||
      (actorInventory?.items[receipt.storage.container_id]??0)<1)
      throw new GameError('物品位置尚无完成凭据，本回合尚未提交，可以安全重试。',503);
  }
  if(requestsItemRelocation(input)&&/准备|[，,]/.test(input)&&!receipt.activity?.occurred)
    throw new GameError('后续准备目标尚无完成凭据，本回合尚未提交，可以安全重试。',503);
  if(receipt.effects.includes('activity')&&(!receipt.activity?.occurred||
    receipt.activity.duration_minutes!==receipt.time_cost||
    receipt.activity.location_id!==(actor?.components.location?.location_id??null)))
    throw new GameError('普通活动缺少程序判定凭据，本回合尚未提交，可以安全重试。',503);
}
export function knownDestination(save: SavePackage, input: string) {
  if(isPhysicalAction(input))return undefined;
  if(!/去|到|前往|走向|进(?:入|去)?|推门/.test(input))return undefined;
  const view=publicView(save);
  return view.locations.filter(place=>input.includes(place.name)).sort((a,b)=>b.name.length-a.name.length)[0];
}
const durationNumber=(raw:string)=>{
  const digits:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  if(/^\d+$/.test(raw))return Number(raw);
  if(raw==='半')return .5;
  if(raw.includes('十')){const [head,tail]=raw.split('十');return (head?digits[head]??0:1)*10+(tail?digits[tail]??0:0);}
  return digits[raw]??NaN;
};
export function explicitDurationMinutes(input:string){
  const amount=input.match(/([0-9]+|[零一二两三四五六七八九十]+|半)\s*(个)?\s*(小时|分钟)/);
  if(!amount)return null;
  const value=durationNumber(amount[1])*(amount[3]==='小时'?60:1);
  return Number.isFinite(value)&&value>=1&&value<=240?Math.ceil(value):null;
}
/** A stay/hold with an explicit duration is local even if "到晚上" contains a travel-like word. */
export function localDurationIntent(input:string,time?:SavePackage['runtime']['time'],minutesPerDay=1440){
  if(!/原地|这里|保持|等待|等|休息|躺|坐|站|不动|沉默/.test(input))return null;
  if(/(?:一整天|一天|整天)/.test(input))return {minutes:minutesPerDay,activity:input.slice(0,500)};
  const amount=input.match(/([0-9]+|[零一二两三四五六七八九十]+|半)\s*(个)?\s*(小时|分钟)/);
  if(amount){const value=durationNumber(amount[1]);if(Number.isFinite(value)&&value>0)return {minutes:Math.ceil(value*(amount[3]==='小时'?60:1)),activity:input.slice(0,500)};}
  if(time&&/直到晚上|等到晚上|待到晚上/.test(input)){
    const evening=18*60,remaining=(evening-time.minute+minutesPerDay)%minutesPerDay||minutesPerDay;
    return {minutes:remaining,activity:input.slice(0,500)};
  }
  return null;
}
export function needsFreeform(input: string) {
  return isPhysicalAction(input) || /拥抱|抱住|扔|丢|爬|喊|大叫|出门/.test(input) || !!localDestination(input);
}
export function isPhysicalAction(input:string){return /揍|殴打|拳击|挥拳|打.{0,15}一拳|踢|踹|推(?!门|进|迟|断|荐|算|测)|攻击|袭击|掐|扇.{0,8}耳光/.test(input);}
/** Pure checks run before a conditional adjudication call and again at the Core boundary. */
export function environmentQueryForProposal(input:string,proposal:ReturnType<typeof parseFreeformProposal>,
  binding?:{physical_intent?:GoalSpec['physical_intent']}){
  if(!proposal.environment_query)return null;
  if(proposal.blocker||binding?.physical_intent||proposal.repetition||proposal.physical_action||proposal.relationship||
    proposal.item_move||proposal.item_change||proposal.storage_move||proposal.target_id||proposal.required_conditions?.length)
    throw new FreeformRepairableError('proposal_contract_invalid','环境对象查询不能吞掉其他独立动作或绕过其前置条件；请保留独立阶段。',[],
      [{path:'environment_query',code:'mixed_effects',expected:'只包含查找及可选合法拿取；其他动作或已知阻碍由原有阶段处理'}]);
  return validateEnvironmentQuery(input,proposal.environment_query);
}
export function executeFreeform(current: SavePackage, input: string, raw: unknown, requestId: string,rng:RNG=secureRng,perceptionAuthorized=false,binding?:{target_ids:readonly string[];physical_intent?:GoalSpec['physical_intent']},environmentAssessment?:EnvironmentAssessment) {
  const proposal=parseFreeformProposal(raw,input);
  const environmentQuery=environmentQueryForProposal(input,proposal,binding);
  if(environmentQuery)return executeEnvironmentQuery(current,input,environmentQuery,proposal.minutes,environmentAssessment,requestId);
  if(!proposal.repetition)return executeFreeformAttempt(current,input,proposal,requestId,rng,perceptionAuthorized,undefined,binding,environmentAssessment);
  const repeat=proposal.repetition;
  if(proposal.physical_action&&!proposal.target_id){
    const people=resolveActionEntities(publicView(current),input,binding?.target_ids,recentReferent(current).primary?.id).matches.filter(entity=>entity.id!==current.player_state.entity_id&&entity.components.character);
    if(people.length===1)proposal.target_id=people[0].id;
  }
  if(!input.includes(repeat.source_quote))throw new FreeformRepairableError('proposal_contract_invalid','连续尝试须引用原始授权，不得自行添加重复行动。');
  const secondsQuote=input.match(/([0-9]+|[零一二两三四五六七八九十]+)\s*秒/);
  const statedSeconds=secondsQuote?durationNumber(secondsQuote[1]):null;
  if(statedSeconds!==null&&repeat.duration_seconds!==statedSeconds)
    throw new FreeformRepairableError('proposal_contract_invalid','连续尝试的秒数与原始请求不一致。');
  // Every iteration uses the existing executor, prerequisites and RNG. No model
  // call or commit occurs inside this loop; the enclosing transaction owns both.
  const requested=repeat.duration_seconds??10,interval=Math.max(proposal.physical_action?2:1,repeat.interval_seconds);
  let candidate=current,elapsed=0,stopped:NonNullable<NonNullable<SavePackage['resolution_receipts']>[number]['repetition']>['stopped_by']='budget';
  const ids:string[]=[],receipts:NonNullable<SavePackage['resolution_receipts']>=[];
  let last:ReturnType<typeof executeFreeformAttempt>|undefined;
  for(let index=0;index<8&&elapsed<requested;index++){
    const actor=candidate.entities.find(entity=>entity.id===candidate.player_state.entity_id)!;
    const target=candidate.entities.find(entity=>entity.id===proposal.target_id);
    if(Number(actor.components.condition?.hp??100)<=0){stopped='actor_unable';break;}
    if(proposal.target_id&&(!target||target.components.location?.location_id!==actor.components.location?.location_id||
      Boolean(proposal.physical_action)&&Number(target.components.condition?.hp??100)<=0)){
      stopped='target_unavailable';break;
    }
    if(candidate.foreground?.blocker){stopped='interrupted';break;}
    const hash=createHash('sha256').update(`${requestId}:attempt:${index}`).digest('hex');
    const child=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const seconds=Math.min(interval,requested-elapsed);
    try{last=executeFreeformAttempt(candidate,input,{...proposal,repetition:null},child,rng,perceptionAuthorized,seconds,binding,undefined,false);}
    catch(error){if(last&&error instanceof WorldBlockedError){stopped='interrupted';break;}throw error;}
    candidate=last.save;elapsed+=seconds;ids.push(child);
    const receipt=candidate.resolution_receipts!.find(entry=>entry.request_id===child)!;receipts.push(receipt);
    if(candidate.foreground?.blocker){stopped='interrupted';break;}
    if(repeat.termination_mode==='until_unsuccessful_result'&&['failure','critical_failure'].includes(receipt.outcome)){stopped='failed_attempt';break;}
    if(elapsed===requested)stopped='duration';
  }
  if(!last)throw new WorldBlockedError('unavailable',stopped==='actor_unable'?'当前身体状态不允许开始这次连续动作。':
    stopped==='target_unavailable'?'目标当前不在可接触的位置或不能继续这一动作。':'请先处理眼前需要回应的情况。');
  const totalMinutes=(candidate.runtime.time.day-current.runtime.time.day)*1440+candidate.runtime.time.minute-current.runtime.time.minute;
  const aggregateType=ids.length>1?'EXTENDED_CHECK':proposal.resolution!.type;
  const repeatedPerception=!proposal.physical_action&&(perceptionAuthorized||isActivePerception(input));
  const aggregateCheck=prepareCheck(current,requestId,{type:aggregateType,domain:repeatedPerception?'perception':proposal.resolution!.domain,band:'normal',
    target_id:receipts[0].target_id,visibility:repeatedPerception?'public':proposal.resolution!.visibility,
    stakes:'汇总已结算的有限重复尝试；不追加掷骰',stages:ids.length>1?ids.map((_,index)=>({id:`attempt_${index+1}`,band:'normal'})):proposal.resolution!.stages});
  const aggregate={...receipts.at(-1)!,request_id:requestId,action_id:requestId,time_cost:totalMinutes,
    kind:aggregateType,check_id:aggregateCheck.check_id,rolls:[],
    repetition:{requested_seconds:requested,elapsed_seconds:elapsed,attempt_ids:ids,stopped_by:stopped,termination_mode:repeat.termination_mode},
    effects:[...new Set(receipts.flatMap(receipt=>receipt.effects))],
    canonical_facts:[`本次连续尝试进行了 ${ids.length} 次，共 ${elapsed} 秒；停止原因：${stopped}。`,
      ...receipts.map((receipt,index)=>`第 ${index+1} 次：${receipt.physical_outcome?
        receipt.canonical_facts.find(fact=>fact.startsWith('身体行动结算：')):
        receipt.canonical_facts.filter(fact=>!fact.startsWith('尝试行动：')&&!fact.startsWith('本次行动经过')&&!fact.startsWith('进行了活动：')).join('；')||'本次尝试已执行，未新增持久变化。'}`.slice(0,500)).slice(0,8)]};
  // The batch's duration proof is repetition.elapsed_seconds, not the last
  // sub-attempt's whole-minute activity receipt (which may be zero).
  delete aggregate.activity;aggregate.effects=aggregate.effects.filter(effect=>effect!=='activity');
  if(receipts.some(receipt=>['success','strong_success','partial_success'].includes(receipt.outcome))&&
     receipts.some(receipt=>['failure','critical_failure','partial_success'].includes(receipt.outcome)))aggregate.outcome='partial_success';
  if((stopped==='budget'||stopped==='interrupted')&&elapsed<requested)aggregate.outcome='partial_success';
  if(aggregate.physical_outcome){aggregate.physical_outcome={...aggregate.physical_outcome,
    contact:receipts.some(receipt=>receipt.physical_outcome?.contact),harmed:receipts.some(receipt=>receipt.physical_outcome?.harmed),
    damage:receipts.reduce((sum,receipt)=>sum+(receipt.physical_outcome?.damage??0),0)};}
  candidate.resolution_receipts=[...candidate.resolution_receipts!,aggregate].slice(-200);
  candidate.resolution_history=[...(candidate.resolution_history??[]),{request_id:requestId,check_id:aggregateCheck.check_id,
    spec:{...aggregateCheck,attempt_check_ids:receipts.map(receipt=>receipt.check_id)},rolls:[],outcome:aggregate.outcome,
    stage_results:ids.length===1?candidate.resolution_history?.find(record=>record.check_id===receipts[0].check_id)?.stage_results:receipts.map((receipt,index)=>({id:`attempt_${index+1}`,
      passed:['success','strong_success'].includes(receipt.outcome),
      margin:candidate.resolution_history?.find(record=>record.check_id===receipt.check_id)?.stage_results?.at(-1)?.margin??0})),
    hidden:aggregateCheck.visibility==='hidden'}].slice(-200);
  last.action.id=requestId;last.action.time_cost=totalMinutes;last.facts=aggregate.canonical_facts;
  // The attempts are one authorized request. Fold contact/harm first, then apply
  // one bounded social consequence rather than multiplying it by the roll count.
  last.save=settleRelationshipOutcomes(candidate,last.action,last.registry);
  return last;
}
function executeFreeformAttempt(current: SavePackage, input: string, raw: unknown, requestId: string,rng:RNG,perceptionAuthorized:boolean,seconds?:number,binding?:{target_ids:readonly string[];physical_intent?:GoalSpec['physical_intent']},localAssessment?:EnvironmentAssessment,settleRelations=true) {
  const proposal = parseFreeformProposal(raw,input), view = publicView(current);
  if(proposal.blocker?.type==='PREREQUISITE_FAILURE')throw new WorldBlockedError('prerequisite',proposal.blocker.reason);
  if(proposal.blocker)throw new GameError(proposal.blocker.type==='USER_AMBIGUITY'?proposal.blocker.reason:
    proposal.blocker.type==='CAPABILITY_GAP'?`当前世界缺少所需能力：${proposal.blocker.reason}`:`行动前置条件尚未成立：${proposal.blocker.reason}`);
  const semantic=proposal.resolution!;
  const observing=!proposal.physical_action&&(perceptionAuthorized||isActivePerception(input));

  const player = current.entities.find(e => e.id === current.player_state.entity_id)!;
  assert(!Object.values(current.extensions??{}).some(e=>e.enabled&&e.installed&&e.state&&typeof e.state==='object'&&!Array.isArray(e.state)&&e.state.phase==='playing'),'请先完成当前正在进行的活动。');
  assert(!current.foreground?.blocker, '请先处理眼前尚未结束的事情。');
  assert(Number(player.components.condition?.hp ?? 1) > 0, '你现在的身体状况无法行动。');
  const named=resolveActionEntities(view,input,binding?.target_ids,recentReferent(current).primary?.id).matches.filter(e=>e.id!==player.id);
  const people=named.filter(e=>Boolean(e.components.character));
  // Ambient perception has no object binding requirement. An incidental model ID
  // cannot turn the room itself into a missing named target.
  if(observing&&!named.length)proposal.target_id=null;
  if(people.length===1&&proposal.target_id===null)proposal.target_id=people[0].id;
  const mentionedItem=named.find(entity=>entity.components.item&&entity.id===proposal.item_move?.item_id)
    ??named.find(entity=>entity.components.item&&entity.components.identity?.name&&input.includes(String(entity.components.identity.name)));
  const activityContract=activityRequirement(current,input);
  if(proposal.item_change&&(!mentionedItem||mentionedItem.id!==proposal.item_change.item_id||
    !input.includes(proposal.item_change.source_quote)||proposal.physical_action))
    throw new FreeformRepairableError('proposal_contract_invalid','物品损坏须绑定本次明确提及的可接触物品及原始授权，不能改成对人物的身体结果。');
  if(proposal.item_change)assert(mentionedItem?.components.item?.condition!=='destroyed','该物品已经损毁，不能再次将其变成完好或受损物品');
  if(!activityContract.available)throw new GameError('当前公开场景没有支持这项活动的必要条件，世界状态没有改变。',503);
  if(requiresCanonicalItemMutation(input)&&!mentionedItem&&!requestsItemRelocation(input))
    throw new GameError('要移动的物品没有可接触的登记实体，世界状态没有改变。',503);
  if(proposal.item_move&&!mentionedItem){
    // A model's incidental handling of a prop is not player authorization to relocate inventory.
    if(/拿|取|捡|放|递|交给|收起|掏出|丢|扔/.test(input))
      throw new GameError('请明确这次要移动哪件物品；世界状态没有改变。');
    proposal.item_move=null;
  }
  const ownedBefore=(player.components.inventory as Inventory|undefined)?.items[mentionedItem?.id??'']??0;
  if(mentionedItem&&(/放(?:到|在|下)|递给|交给/.test(input)||ownedBefore===0&&/拿|取|拾起|捡起|收起/.test(input))&&!proposal.item_move)
    throw new GameError('这次物品位置没有得到完整确认，本回合尚未结算，可以安全重试。',503);
  if(requiresCanonicalItemMutation(input)&&!requestsItemRelocation(input)&&!proposal.item_move)
    throw new GameError('物品变更尚无可执行的结算方案，世界状态没有改变。',503);
  if(people.length>1)throw new WorldBlockedError('unavailable','当前可指代的人物不唯一，请明确这次行动的对象。');
  if(people.length===1&&proposal.target_id!==people[0].id)
    throw new FreeformRepairableError('target_binding_invalid','提案行动对象与玩家指定的人物不一致，世界状态没有改变。',
      people.map(entity=>({id:entity.id,name:String(entity.components.identity?.name??'公开人物')})));
  const target = proposal.target_id ? view.entities.find(e => e.id === proposal.target_id) : undefined;
  if (proposal.target_id) {
    if(!target||target.id===player.id||!named.some(e=>e.id===target.id))
      throw new FreeformRepairableError('target_binding_invalid','提案目标没有被玩家本次输入指明。',
        named.map(entity=>({id:entity.id,name:String(entity.components.identity?.name??'公开实体')})));
    const here = player.components.location?.location_id, there = target.components.location?.location_id;
    if(here&&there&&here!==there)throw new WorldBlockedError('unavailable','对方不在当前场景，无法在这里接触对方。');
  }
  const destination = observing?null:boundLocalDestination(current,input);
  const localQuery=observing?null:localSceneQuery(current,input);
  let settledDestination:string|null=destination;
  const mentionedName=(name:string)=>input.includes(name)?name:
    (name.split(/[/／、]|(?:或者|或)/).map(part=>part.trim()).find(part=>part.length>=2&&input.includes(part))??name);
  const storage=proposal.storage_move?{
    ...proposal.storage_move,
    item_name:mentionedName(proposal.storage_move.item_name),
    container_name:mentionedName(proposal.storage_move.container_name),
  }:null;
  const storageVerb=requestsItemRelocation(input);
  if(storageVerb&&!storage&&!proposal.item_move)
    throw new GameError('这次物品收纳尚无可执行的结算方案，世界状态没有改变，可以安全重试。',503);
  let sourceItem:SavePackage['entities'][number]|undefined,containerItem:SavePackage['entities'][number]|undefined;
  if(storage){
    const binding=bindStorageAction(current,input,{itemName:storage.item_name,containerName:storage.container_name,
      itemId:storage.item_id,containerId:storage.container_id});
    if(!binding.usableForAction)throw new GameError(`${binding.reason??'物品收纳条件不成立'}，世界状态没有改变。`,503);
    sourceItem=binding.item.entity;
    containerItem=binding.container.entity;
  }
  // Storage roles are bound canonically above. Unknown provider IDs cannot override that binding;
  // requirements naming real entities remain authoritative, including inaccessible entities.
  const incidentalConditions=(proposal.required_conditions??[]).filter(condition=>
    condition.kind==='entity_exists'&&activityContract.kind!=='mechanical'&&!observing&&!condition.scene_reference&&
      !proposal.target_id&&!proposal.item_move&&!proposal.storage_move&&!proposal.relationship&&!mentionedItem&&
      !current.entities.some(entity=>entity.id===condition.subject_id));
  if(incidentalConditions.length)observe('info','freeform.prerequisite.downgraded',{
    module:'framework',metadata:{kind:'entity_exists',reason:'unbound_activity_detail',count:incidentalConditions.length}});
  const requiredConditions=(proposal.required_conditions??[]).filter(condition=>
    !incidentalConditions.includes(condition)&&
    !(storage&&condition.kind==='item_accessible'&&!current.entities.some(entity=>entity.id===condition.subject_id))&&
    !(storage&&condition.kind==='entity_exists'&&
      [storage.item_name,storage.container_name].includes(condition.subject_id)&&
      !current.entities.some(entity=>entity.id===condition.subject_id)));
  const livePrerequisites=(save:SavePackage)=>evaluateWorldPrerequisites(save,{target_id:proposal.target_id,
    scene_description_access:(observing||activityContract.kind!=='mechanical')&&!proposal.item_move&&!storage&&!proposal.item_change&&!proposal.relationship,
    requirements:[...requiredConditions,...(mentionedItem?[{kind:'item_accessible' as const,subject_id:mentionedItem.id}]:[]),
      ...(sourceItem?[{kind:'item_accessible' as const,subject_id:sourceItem.id}]:[]),
      ...(containerItem?[{kind:'item_accessible' as const,subject_id:containerItem.id}]:[])],item_move:proposal.item_move});
  const prerequisites=livePrerequisites(current);
  if(prerequisites.status!=='EXECUTABLE'&&observing&&requiredConditions.some(condition=>
    ['entity_exists','same_location'].includes(condition.kind)&&!current.entities.some(entity=>entity.id===condition.subject_id)))
    throw new FreeformRepairableError('proposal_contract_invalid','观察对象需来自当前权威地点描述或真实在场实体，不能臆造对象ID。',[],[
      {path:'required_conditions',code:'scene_reference_invalid',expected:'现有实体ID，或当前地点描述中可逐字核验的 scene_reference 与物体名称'}]);
  if(prerequisites.status!=='EXECUTABLE')throw new WorldBlockedError('prerequisite',prerequisites.reason??'行动前置条件尚未成立');
  if(proposal.item_move?.to==='target')assert(target?.components.character,'接收物品的人尚未确定');
  if(semantic.type==='OPPOSED_CHECK'&&!target?.components.character)
    throw new FreeformRepairableError('opponent_binding_invalid',
      '对抗提案缺少真实在场的对手；重新判断这是否其实是无需对抗的普通场景互动。',
      named.filter(entity=>entity.components.character).map(entity=>({id:entity.id,
        name:String(entity.components.identity?.name??'公开人物')})));
  const physical=proposal.physical_action,authorized=binding?.physical_intent;
  if(authorized&&(!input.includes(authorized.source_quote)||!physical||
    physical.kind==='restrain'&&!authorized.forms.includes('restrain')))
    throw new FreeformRepairableError('proposal_contract_invalid','身体动作类型须保持本次语义授权，不能用抓握替换打击或省略真实身体结算。',[],
      [{path:'physical_action.kind',code:'semantic_mismatch',expected:JSON.stringify(authorized.forms)}]);
  if(physical){
    const diagnostics:{path:string;code:string;expected:string}[]=[];
    const issue=(path:string,expected:string)=>diagnostics.push({path,code:'physical_contract',expected});
    // A world that declared no domains used to accept any invented physical domain, which then
    // resolved against no ability data at all. The framework's generic domains are the floor.
    const domains=capabilityDomainNames(current);
    if(!domains.includes(semantic.domain))issue('resolution.domain',`使用本世界可用的能力领域：${domains.join(',')}`);
    if(semantic.opposition_domain&&!domains.includes(semantic.opposition_domain))issue('resolution.opposition_domain',`使用本世界可用的对手能力领域（${domains.join(',')}），不能用不存在的领域绕过实际能力`);
    if(!target?.components.character)issue('target_id','本次明确提及且真实在场的人物 ID');
    if(!input.includes(physical.source_quote))issue('physical_action.source_quote','当前原始输入中逐字连续出现的授权原文，不得改写或引用历史');
    if(semantic.type!=='OPPOSED_CHECK')issue('resolution.type','OPPOSED_CHECK');
    const contact=semantic.stages.findIndex(stage=>stage.id===physical.contact_stage_id);
    if(contact<0)issue('physical_action.contact_stage_id','resolution.stages 中实际存在的接触阶段 ID');
    if(authorized?.forms.includes('restrain')&&physical.kind==='harm'&&!physical.control_stage_id)
      issue('physical_action.control_stage_id','本次明确授权先控制后实施后续动作；必须登记实际控制阶段，不能省略或假定已经成立');
    if(physical.control_stage_id){
      const control=semantic.stages.findIndex(stage=>stage.id===physical.control_stage_id);
      if(control<contact||!authorized?.forms.includes('restrain'))issue('physical_action.control_stage_id','本次明确授权且位于接触之后的控制阶段，不能由旧控制或单纯打击推导');
    }
    if(physical.kind==='harm'){
      const injury=semantic.stages.findIndex(stage=>stage.id===physical.injury_stage_id);
      if(!physical.injury_stage_id||injury<0||injury<contact||physical.control_stage_id&&injury<semantic.stages.findIndex(s=>s.id===physical.control_stage_id))
        issue('physical_action.injury_stage_id','实际存在且不早于接触的阶段 ID；直接打击可共用接触阶段，不能把最终失能目标当作本次保证结果');
    }
    if(diagnostics.length){
      observe('warn','freeform.physical_contract.rejected',{module:'framework',metadata:{issues:diagnostics}});
      throw new FreeformRepairableError('proposal_contract_invalid','身体行动须保留原始授权、真实对手及有序的接触与伤害判定阶段。',
        people.map(entity=>({id:entity.id,name:String(entity.components.identity?.name??'公开人物')})),diagnostics);
    }
  }
  if(physical?.kind==='harm'&&!current.definition.enabled_modules.includes('routine'))
    throw new FreeformRepairableError('proposal_contract_invalid','当前世界没有可结算伤势的 condition 能力，不能只靠叙事宣告伤害。');
  let unverifiedEnvironment=false;
  let environmentSourceValid=(_save:SavePackage)=>true;
  if(physical?.mechanism==='environment'){
    const source=physical.hazard_source;
    environmentSourceValid=save=>{
      if(!source)return true;
      const here=save.entities.find(entity=>entity.id===player.id)?.components.location?.location_id;
      const sourceEntity=publicView(save).entities.find(entity=>entity.id===source.source_id&&
        entity.components.location?.location_id===here);
      const sourcePlace=[...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations]
        .find(place=>place.id===source.source_id&&place.id===here);
      return (sourcePlace?.description??String(sourceEntity?.components.identity?.description??'')).includes(source.quote);
    };
    if(!environmentSourceValid(current))
      throw new FreeformRepairableError('proposal_contract_invalid','环境伤害需要当前位置或可接触对象已有描述中的危险来源，不能仅引用玩家的假定。');
    unverifiedEnvironment=!source;
    if(unverifiedEnvironment&&physical.kind==='harm'&&physical.injury_stage_id===physical.contact_stage_id)
      throw new FreeformRepairableError('proposal_contract_invalid','危险属性尚未确认；须将可独立尝试的人物接触与依赖环境的伤害分为不同阶段，不能同时宣告命中与伤害。');
  }
  const checkInput:Parameters<typeof prepareCheck>[2]={type:semantic.type,domain:observing?'perception':semantic.domain,opposition_domain:semantic.opposition_domain,band:semantic.band,
    target_id:proposal.target_id,visibility:observing?'public':semantic.visibility,stakes:semantic.stakes,stages:semantic.stages,discover_facts:observing||semantic.discover_facts,
    physical:Boolean(physical),surprise_attempt:physical?.surprise_attempt,
    ...(unverifiedEnvironment&&physical?.kind==='harm'&&physical.injury_stage_id?{blocked_stages:[{
      id:physical.injury_stage_id,reason:'环境致伤条件尚无可验证依据；仅结算独立接触尝试，不确认环境伤害。'}]}:{})};
  let check=prepareCheck(current,requestId,checkInput);
  const registry = createRegistry(current.definition.enabled_modules);
  // Pure deterministic activity intervals share HOLD's existing foreground
  // boundaries. Mechanical, targeted, perceptual and uncertain attempts retain
  // their own atomic settlement paths.
  const ordinaryInterval=activityContract.kind==='generic'&&semantic.type==='DETERMINISTIC'&&semantic.domain==='general'&&
    seconds===undefined&&!observing&&!physical&&!proposal.target_id&&!proposal.item_move&&!proposal.item_change&&
    !storage&&!proposal.relationship&&!proposal.completion_quote&&!semantic.discover_facts&&!semantic.stages.length&&
    !proposal.required_conditions?.length&&!localQuery;
  let activityInterrupted=false;
  // This action exists only inside this invocation; HTTP action payloads cannot provide outcomes.
  registry.actions.register('FREEFORM_ACTION', { resolution_mode:'self', parameters: z.strictObject({}), execute(c) {
    const carried=seconds===undefined?0:(c.save.runtime.scene_seconds??0)+seconds;
    const minutes=seconds===undefined?proposal.minutes:Math.floor(carried/60);
    if(minutes&&ordinaryInterval){
      assert(!c.save.foreground?.blocker,'眼前还有需要处理的事情，无法继续这段活动');
      const limit=Math.max(1,Math.min(60,c.save.definition.ruleset.max_wait_minutes));let elapsed=0;
      while(elapsed<minutes){
        const segment=advanceWorldSegment(c,Math.min(minutes-elapsed,limit));elapsed+=segment.elapsed;
        if(segment.interrupted){activityInterrupted=elapsed<minutes;break;}
      }
    }else if(minutes)c.advance(minutes);
    // Time hooks can move people/items, seal containers or destroy resources.
    // Validate against the isolated settlement state before any action result;
    // a failed candidate must not pull a remote item back or report an activity.
    const liveActor=c.save.entities.find(entity=>entity.id===c.action.actor_id);
    if(!liveActor||Number(liveActor.components.condition?.hp??1)<=0)
      throw new WorldBlockedError('prerequisite','这次行动的时间推进会使身体状态无法行动；本次行动未提交。');
    const live=livePrerequisites(c.save);
    if(live.status!=='EXECUTABLE'||!activityRequirement(c.save,input).available)
      throw new WorldBlockedError('prerequisite',
        `这次行动的时间推进会使前置条件失效（${live.reason??'现场资源不可用'}）；本次行动未提交。`);
    if(destination&&boundLocalDestination(c.save,input)!==destination)
      throw new WorldBlockedError('prerequisite','局部移动所依据的现场位置已经改变；本次行动未提交。');
    if(!environmentSourceValid(c.save))
      throw new WorldBlockedError('prerequisite','环境危险来源已经改变或无法接触；本次行动未提交。');
    // Ability, fatigue and discoverable evidence can also change during the
    // interval. Bind every result to the state that will actually be settled.
    check=prepareCheck(c.save,requestId,checkInput);
    if(seconds!==undefined)c.save.runtime.scene_seconds=carried%60;
    if(localQuery){
      const present=resolveLocalSceneAnchor(c.save,localQuery,localAssessment,requestId);
      if(present)settledDestination=localQuery.name;
      else c.facts.push(`这次行动没有确认可到达的${localQuery.name}，局部位置未改变。`);
    }
    if (settledDestination) c.store.entity(c.action.actor_id).components.scene_position = { label: settledDestination };
    const result=resolveCheck(c.save,check,c.rng);
    c.facts.push(`尝试行动：${input.slice(0,160)}。${check.visibility==='public'?`程序判定：${result.outcome}。`:'结果尚未可确认。'}`);
    const discovered=(c.save.gm_state.hidden_truth?.commitments??[]).flatMap(truth=>truth.evidence)
      .filter(evidence=>check.evidence_ids.includes(evidence.id)&&evidence.discovered_by.includes(player.id));
    if(check.visibility==='public')c.facts.push(...discovered.slice(0,2).map(evidence=>`发现已存在的证据：${evidence.description.slice(0,200)}`));
    if(observing&&!discovered.length)c.facts.push('你进行了观察或搜索，在这次检查范围内没有发现明显异常或新的线索。');
    c.save.action_facts = [...(c.save.action_facts ?? []), { request_id: requestId, actor_id: player.id,
      target_id: proposal.target_id, input, facts: c.facts.slice(0,4).map(fact=>fact.slice(0,300)), time: { ...c.save.runtime.time } }].slice(-100);
  } });
  const turn = executeAction(current, { type: 'FREEFORM_ACTION', ...(target ? { target_id: target.id } : {}), parameters: {} }, requestId, 'ai', rng, registry);
  if(activityInterrupted)turn.facts.unshift(interruptedActivityFact(turn.action.time_cost));
  turn.facts.push(`本次行动经过 ${turn.action.time_cost} 分钟。`);
  if(settledDestination)turn.facts.push(`局部位置已更新：${settledDestination}`);
  const record=turn.save.resolution_history?.find(entry=>entry.check_id===check.check_id);
  assert(record,'行动判定没有产生程序记录');
  if(localQuery&&!settledDestination)record.outcome='failure';
  const succeeded=record.outcome==='success'||record.outcome==='strong_success';
  // An enumerated self-inspection names several things to verify. A single
  // generic perception result does not prove all of them, so the turn must
  // neither claim an occurred activity nor silently complete the whole list.
  const items=enumeratedInspectionItems(input);
  // The model reports specific findings through proposal.facts. A single
  // generic perception with no findings is not per-item evidence, so the
  // enumerated list stays unverified rather than being silently completed.
  const inspection=observing&&items.length>=2?inspectionEvidence(input,proposal.facts??[],proposal.inspection_results as InspectionResult[]|undefined):{items:[],status:null};
  const unverified=inspection.items.filter(entry=>entry.result==='not_checked'||entry.result==='blocked').map(entry=>entry.item);
  if(unverified.length)turn.facts.push(`本次观察没有逐项确认：${unverified.join('、')}。`);
  if(inspection.items.length)turn.facts.push(`逐项检查结果：${inspection.items.map(entry=>`${entry.item}=${entry.result}`).join('；')}。`);
  const durableProgress=progressChanges(current,turn.save);
  if(!physical&&requiresPersistentProgress(input)&&(!succeeded||!durableProgress.length))
    throw new GameError('这次行动尚未完成玩家提出的完整目标，世界状态没有改变，可以安全重试。',503);
  if(succeeded&&mentionedItem?.components.item?.tracking==='incidental')turn.save.entities.find(entity=>entity.id===mentionedItem.id)!.components.item.tracking='tracked';
  if(succeeded&&proposal.item_move){
    const item=mentionedItem?.id===proposal.item_move.item_id?mentionedItem:null;
    assert(item,'请明确要移动哪件当前可见的物品');
    if(proposal.item_move.to==='held')putItemInInventory(turn.save,item.id);
    else if(proposal.item_move.to==='scene'){
      const inventory=turn.save.entities.find(entity=>entity.id===player.id)!.components.inventory as Inventory;
      if((inventory.items[item.id]??0)!==1)putItemInInventory(turn.save,item.id);
      putItemInScene(turn.save,item.id,proposal.item_move.position_label);
    }
    else{
      assert(target?.components.character&&target.components.location?.location_id===player.components.location?.location_id,'接收物品的人不在眼前');
      const holder=turn.save.entities.find(entity=>entity.id===target.id)!,itemEntity=turn.save.entities.find(entity=>entity.id===item.id)!;
      const playerInventory=turn.save.entities.find(entity=>entity.id===player.id)!.components.inventory as Inventory|undefined;
      assert(playerInventory?.items[item.id]===1,'角色没有持有这件物品');
      assert(!Object.values(player.components.equipment?.slots??{}).includes(item.id),'请先卸下这件物品');
      assert(!Object.entries(playerInventory.placements??{}).some(([child,parent])=>parent===item.id&&
        (playerInventory.items[child]??0)>0),'请先取出容器里的物品');
      delete playerInventory.items[item.id];if(playerInventory.placements)delete playerInventory.placements[item.id];
      holder.components.inventory??={items:{}};(holder.components.inventory as Inventory).items[item.id]=1;
      delete itemEntity.components.location;delete itemEntity.components.scene_position;itemEntity.components.item.tracking='tracked';
      itemEntity.components.item.owner_id=holder.id;
    }
  }
  if(succeeded&&storage){
    const item=turn.save.entities.find(entity=>entity.id===sourceItem!.id)!;
    const container=turn.save.entities.find(entity=>entity.id===containerItem!.id)!;
    const inventory=turn.save.entities.find(entity=>entity.id===player.id)!.components.inventory as Inventory;
    const carryContainer=/(?:准备出门|带走|背上|拎起|提起)/.test(input);
    if(container.components.location?.location_id===player.components.location?.location_id&&!carryContainer){
      if((inventory.items[item.id]??0)!==1)putItemInInventory(turn.save,item.id);
      putItemInSceneContainer(turn.save,item.id,container.id);
    }else{
      if((inventory.items[container.id]??0)!==1)putItemInInventory(turn.save,container.id);
      putItemInInventory(turn.save,item.id,container.id);
    }
    const fact=`物品已收纳：${storage.item_name} → ${storage.container_name}`;
    turn.facts.push(fact);
    const actionFact=turn.save.action_facts?.find(entry=>entry.request_id===requestId);
    if(actionFact)actionFact.facts=[...actionFact.facts,fact].slice(0,4);
  }
  // Perception still completes a real activity even when discovery is empty.
  // The activity contract is independent of whether any new evidence was found.
  const activity=!(activityInterrupted&&turn.action.time_cost===0)&&!physical&&succeeded&&(!inspection.items.length||inspection.status==='complete')&&!unverified.length&&(!proposal.item_move&&!storage||Boolean(storage&&/准备|[，,]/.test(input)))
    ?activityEvidence(turn.save,input,turn.action.time_cost):undefined;
  if(activity){
    const fact=`进行了活动：${activity.description}（${activity.duration_minutes} 分钟）。`;
    if(activityInterrupted)turn.facts.splice(1,0,fact);else turn.facts.push(fact);
    const actionFact=turn.save.action_facts?.find(entry=>entry.request_id===requestId);
    if(actionFact)actionFact.facts=[...actionFact.facts,fact.slice(0,300)].slice(0,4);
  }
  // A relationship change proposed by the model is optional enrichment for a physical action. A dimension
  // this world does not track (or any other invalid enrichment) is dropped with a structured log — it must
  // never fail the otherwise valid action, and it must never extend the canonical relationship schema.
  let relationshipChanged=false;
  if (succeeded&&proposal.relationship) {
    const providerDimension = proposal.relationship.dimension;
    try {
      assert(target, '本次行动没有确定的对象');
      assert(current.definition.enabled_modules.includes('relationships'), 'relationships 模块未启用');
      turn.save = applyPatches(turn.save, [{ op: 'relationship_delta', entity_id: player.id, target_id: target.id, ...proposal.relationship }], turn.action, registry);
      relationshipChanged=true;
    } catch (error) {
      observe('warn', 'relationship_mutation_dropped', { module: 'framework', request_id: requestId, metadata: {
        provider_dimension: providerDimension,
        reason: error instanceof Error ? error.message : String(error),
        target_id: proposal.target_id ?? target?.id ?? null,
        canonical_dimensions: Object.keys(current.definition.ruleset.relationship_dimensions),
      } });
    }
  }
  const effects:Array<'time'|'activity'|'position'|'inventory'|'relationship'|'evidence'|'progress'|'injury'|'state'>=[];
  if(succeeded&&proposal.item_change){
    setItemCondition(turn.save,proposal.item_change.item_id,proposal.item_change.condition,requestId);
    effects.push('state');
    if(proposal.item_change.condition==='destroyed'&&(turn.save.gm_state.hidden_truth?.commitments??[])
      .some(truth=>truth.evidence.some(evidence=>evidence.placement?.anchor_entity_id===proposal.item_change!.item_id)))effects.push('evidence');
    turn.facts.push(proposal.item_change.condition==='destroyed'?'已登记物品被损毁。':'已登记物品受到损坏。');
  }
  let physicalOutcome:NonNullable<SavePackage['resolution_receipts']>[number]['physical_outcome'];
  if(physical&&target){
    const victim=turn.save.entities.find(entity=>entity.id===target.id)!;
    const passed=(id:string|null)=>Boolean(id&&record.stage_results?.some(stage=>stage.id===id&&stage.passed));
    const contact=passed(physical.contact_stage_id),harmed=physical.kind==='harm'&&passed(physical.injury_stage_id);
    // Touching a target is not sustained control: every planned restraint stage must pass.
    const controlEstablished=contact&&(physical.kind==='restrain'&&succeeded||Boolean(physical.control_stage_id&&passed(physical.control_stage_id)));
    const rules=current.definition.ruleset.physical_rules??{minor_damage:5,serious_damage:20};
    const damage=harmed?Math.min(Number(victim.components.condition?.hp??100),
      physical.harm_level==='serious'?rules.serious_damage:rules.minor_damage):0;
    if(harmed){victim.components.condition??={hp:100,stamina:100,stress:0};
      victim.components.condition.hp=Math.max(0,Number(victim.components.condition.hp)-damage);effects.push('injury');}
    const witnesses=turn.save.entities.filter(entity=>entity.id!==player.id&&entity.components.character&&
      entity.components.location?.location_id===player.components.location?.location_id&&
      Number(entity.components.condition?.hp??100)>0).slice(0,30);
    // Who actually had sight of this action is decided here, before the event itself
    // opens anyone's eyes. Without this record an NPC who was blind at settlement
    // could still claim to have watched it happen (REV435).
    const sightBlockedIds=witnesses.filter(entity=>struckWithoutSight(entity)).map(entity=>entity.id);
    const victimState=readPhysicalState(victim);
    writePhysicalState(victim,{awareness:'alert',
      alert_to_ids:[...new Set([...victimState.alert_to_ids,player.id])].slice(-20),
      restrained_by:controlEstablished?player.id:victimState.restrained_by});effects.push('state');
    physicalOutcome={...(authorized?{action_forms:authorized.forms}:{}),kind:physical.kind,target_id:target.id,contact,harmed,damage,control_established:controlEstablished,
      contact_stage_id:physical.contact_stage_id,injury_stage_id:physical.injury_stage_id,witness_ids:witnesses.map(entity=>entity.id),
      ...(sightBlockedIds.length?{sight_blocked_ids:sightBlockedIds}:{})};
    const fact=`身体行动结算：${contact?'接触已成立':'未能建立接触'}；${physical.kind==='restrain'?(controlEstablished?'本次控制已成立；':'本次未能建立持续控制；'):''}${harmed?`伤害已结算，生命值减少 ${damage}`:'没有结算伤害'}。`;
    turn.facts.push(fact);
    for(const blind of sightBlockedIds){
      const name=String(turn.save.entities.find(entity=>entity.id===blind)?.components.identity?.name??blind);
      turn.facts.push(`${name}在本次动作发生时没有视觉信息，没有看见动作过程。`);
      // A forced physical event in the same scene ends a voluntary eyes-closed state.
      releaseTransient(turn.save,blind,'eyes',`亲历或在场经历强制身体事件（${requestId}）`);
    }
    if(unverifiedEnvironment)turn.facts.push('环境致伤条件尚未确认；本次没有结算环境伤害，也不代表该环境已经确认安全。');
    for(const witness of witnesses){
      const witnessState=readPhysicalState(witness);
      writePhysicalState(witness,{awareness:'alert',
        alert_to_ids:[...new Set([...witnessState.alert_to_ids,player.id])].slice(-20),
        restrained_by:witnessState.restrained_by});
      const mind=turn.save.npc_agent_state?.[witness.id]??emptyNpcAgentState(),eventRef=`physical:${requestId}`;
      if(witness.id===target.id){
        delete mind.travel_intent;
        for(const task of mind.social_tasks)if(task.status==='active'){
          task.status='blocked';task.condition='亲历强制身体事件，需本人重新确认原有安排';
        }
      }
      mind.memories=[...mind.memories.filter(memory=>memory.event_ref!==eventRef),{event_ref:eventRef,
        kind:witness.id===target.id?'participated' as const:'observed' as const,
        summary:`${witness.id===target.id?'亲历':'目击'} ${player.id} 对 ${target.id} 发起强制身体行动；${fact}`.slice(0,500),
        participant_ids:[player.id,target.id],at:structuredClone(turn.save.runtime.time),importance:3}];
      while(mind.memories.length>60){const least=Math.min(...mind.memories.map(memory=>memory.importance));
        mind.memories.splice(mind.memories.findIndex(memory=>memory.importance===least),1);}
      turn.save.npc_agent_state??={};turn.save.npc_agent_state[witness.id]=mind;
    }
  }
  if(turn.action.time_cost||(seconds??0)>0)effects.push('time');
  if(activity)effects.push('activity');
  if(settledDestination)effects.push('position');
  if(durableProgress.length)effects.push('progress');
  if(succeeded&&proposal.item_move){
    effects.push('inventory');const fact='已登记的物品位置发生变化。';turn.facts.push(fact);
    const actionFact=turn.save.action_facts?.find(entry=>entry.request_id===requestId);
    if(actionFact)actionFact.facts=[...actionFact.facts,fact].slice(0,4);
  }
  if(succeeded&&storage)effects.push('inventory');
  if(check.evidence_ids.some(item=>turn.save.gm_state.hidden_truth?.commitments.some(truth=>truth.evidence.some(evidence=>evidence.id===item&&evidence.discovered_by.includes(player.id)))))effects.push('evidence');
  if(relationshipChanged)effects.push('relationship');
  turn.save.resolution_receipts=[...(turn.save.resolution_receipts??[]),{
    request_id:requestId,action_id:turn.action.id,actor_id:player.id,target_id:proposal.target_id,semantic_action:input.slice(0,1000),
    kind:semantic.type,prerequisites:prerequisites.checked,check_id:check.check_id,rolls:record.rolls,outcome:record.outcome,
    time_cost:turn.action.time_cost,canonical_facts:turn.facts.slice(0,12).map(fact=>fact.slice(0,500)),effects,
    ...(inspection.items.length&&inspection.status?{inspection_results:inspection.items,inspection_status:inspection.status}:{}),
    ...(activity?{activity}:{}),
    ...(succeeded&&storage?{storage:{item_id:sourceItem!.id,container_id:containerItem!.id}}:{}),
    ...(durableProgress.length?{progress_changes:durableProgress}:{}),
    ...(physicalOutcome?{physical_outcome:physicalOutcome}:{}),
    at:structuredClone(turn.save.runtime.time),commit_status:'pending' as const,
  }].slice(-200);
  turn.save.last_turn = { narrative:turn.facts.join(' '), speaker: null, dialogue: null, choices: [], context_actions: [] };
  if(settleRelations)turn.save=settleRelationshipOutcomes(turn.save,turn.action,turn.registry);
  return turn;
}

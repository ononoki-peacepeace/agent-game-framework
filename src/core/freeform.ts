import {resolveEntities} from '../agent/entities.js';
import { z } from 'zod';
import { GameError, assert, id, providerEmptyArray, providerFalseBoolean, type SavePackage } from './schema.js';
import {isActivePerception} from '../agent/perception.js';
import { observe } from '../observability/index.js';
import { publicView } from './state.js';
import { createRegistry } from '../modules/index.js';
import { executeAction, applyPatches } from './runtime.js';
import {putItemInInventory,putItemInScene,type Inventory} from '../modules/inventory.js';
import {bindStorageAction} from './action-binding.js';
import {activityEvidence,progressChanges,requiresPersistentProgress} from './completion-evidence.js';
import {difficultyBandSchema,prepareCheck,resolutionKindSchema,resolveCheck} from './resolution.js';
import {secureRng,type RNG} from './dice.js';
import {normalizeProviderCollections} from '../ai/provider-schema.js';
import {evaluateWorldPrerequisites,requirementSchema} from './prerequisites.js';

/** An outcome proposal, never a save patch. Numeric mechanics remain owned by modules. */
export const freeformSchema = z.strictObject({
  narrative: z.string().min(1).max(4000),
  minutes: z.number().int().min(1).max(240),
  target_id: id.nullable(),
  facts: providerEmptyArray(z.array(z.string().min(1).max(300)).max(4)),
  relationship: z.strictObject({ dimension: id, delta: z.number().int().min(-2).max(2) }).nullable(),
  item_move:z.strictObject({item_id:id,to:z.enum(['held','scene','target']),position_label:z.string().max(80).nullable()}).nullable().optional(),
  storage_move:z.strictObject({item_name:z.string().min(2).max(100),item_id:id.nullable(),container_name:z.string().min(2).max(100),container_id:id.nullable()}).nullable().optional(),
  completion_quote:z.string().min(3).max(120).nullable().optional(),
  required_conditions:providerEmptyArray(z.array(requirementSchema).max(12)).optional(),
  blocker:z.strictObject({type:z.enum(['CAPABILITY_GAP','USER_AMBIGUITY','PREREQUISITE_FAILURE']),reason:z.string().min(1).max(300)}).nullable().optional(),
  resolution:z.strictObject({type:resolutionKindSchema.exclude(['EVENT_ROLL']),domain:id,opposition_domain:id.nullable().optional(),band:difficultyBandSchema,
    visibility:z.enum(['public','hidden']),stakes:z.string().max(300),stages:providerEmptyArray(z.array(z.strictObject({id,band:difficultyBandSchema})).max(8)),
    evidence_ids:providerEmptyArray(z.array(id).max(20)),discover_facts:providerFalseBoolean()}).nullish(),
});
const maxFactCount = 4, maxFactLength = 300;
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
  if (parsed.success && (parsed.data.resolution || parsed.data.blocker)) return parsed.data;
  if(parsed.success)throw new GameError('这次行动尚未得到可执行的判定方案，世界状态没有改变；可以安全重试。',503);
  // Internal schema detail stays in the log; the player only sees an actionable sentence.
  observe('warn', 'freeform.proposal.rejected', { module: 'framework', metadata: { issues: parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}:${issue.code}`) } });
  throw new GameError('这次行动没有正常完成，世界状态没有改变，可以安全重试。',503);
}
export function localDestination(input: string) {
  // A local scene position is only inferred from travel language, never from a physical interaction.
  if (isPhysicalAction(input)) return null;
  const entering=/进去|进入|走进|推门|^(?:我)?(?:现在)?(?:直接)?\s*进(?!度|行|展|步|化|阶)\S{1,10}/.test(input);
  const actualExit=/出门/.test(input)&&!/(?:准备|打算|计划|将要)出门/.test(input);
  if (!entering&&!/(?:出去|走|去|移动|靠近|到)/.test(input)&&!actualExit) return null;
  const named=input.match(/(?:回到|走到|走向|来到|移到|移动到|去到)([^，,。；;!！?？]{1,80})/)?.[1]
    ?.split(/(?:把|将|并|再|然后|接着|顺便)/,1)[0]?.trim()
    .replace(/(前|旁|边|口|处|里|内|上|下)(?:坐下|站住|站定|站着|待一会儿|歇一会儿|休息|停下).*$/,'$1');
  if(named)return named;
  return input.match(/屋外街边|屋外|屋内|门口|厨房|窗边|院子|走廊/)?.[0] ?? (actualExit ? '屋外' : entering?'内部':null);
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
  const nearby=view.entities.some(entity=>entity.components.item&&
    (entity.components.location?.location_id===here||
      ((actor?.components.inventory as Inventory|undefined)?.items[entity.id]??0)>0)&&
    String(entity.components.identity?.name??'').includes(resource));
  return {kind:'environmental' as const,available:Boolean(location?.description.includes(resource)||nearby),resource};
}
export function assertFreeformGoalEvidence(save:SavePackage,input:string,requestId:string){
  const receipt=save.resolution_receipts?.find(entry=>entry.request_id===requestId);
  if(!receipt)throw new GameError('开放行动缺少程序判定凭据，本回合尚未提交，可以安全重试。',503);
  const expectedPosition=localDestination(input);
  const actor=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  if(expectedPosition&&(!receipt.effects.includes('position')||actor?.components.scene_position?.label!==expectedPosition))
    throw new GameError('局部位置尚未结算，本回合尚未提交，可以安全重试。',503);
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
export function executeFreeform(current: SavePackage, input: string, raw: unknown, requestId: string,rng:RNG=secureRng) {
  const proposal = parseFreeformProposal(raw,input), view = publicView(current);
  if(proposal.blocker)throw new GameError(proposal.blocker.type==='USER_AMBIGUITY'?proposal.blocker.reason:
    proposal.blocker.type==='CAPABILITY_GAP'?`当前世界缺少所需能力：${proposal.blocker.reason}`:`行动前置条件尚未成立：${proposal.blocker.reason}`);
  const semantic=proposal.resolution!;
  const observing=isActivePerception(input);

  const player = current.entities.find(e => e.id === current.player_state.entity_id)!;
  assert(!Object.values(current.extensions??{}).some(e=>e.enabled&&e.installed&&e.state&&typeof e.state==='object'&&!Array.isArray(e.state)&&e.state.phase==='playing'),'请先完成当前正在进行的活动。');
  assert(!current.foreground?.blocker, '请先处理眼前尚未结束的事情。');
  assert(Number(player.components.condition?.hp ?? 1) > 0, '你现在的身体状况无法行动。');
  const named=resolveEntities(view,input).matches.filter(e=>e.id!==player.id),people=named.filter(e=>Boolean(e.components.character));
  if(people.length===1&&proposal.target_id===null)proposal.target_id=people[0].id;
  const mentionedItem=named.find(entity=>entity.components.item&&entity.id===proposal.item_move?.item_id)
    ??named.find(entity=>entity.components.item&&entity.components.identity?.name&&input.includes(String(entity.components.identity.name)));
  const activityContract=activityRequirement(current,input);
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
  assert(people.length<2,'请说明这次要接近哪一个对象。');
  if(people.length===1)assert(proposal.target_id===people[0].id,'行动对象尚未确定，请重试。');
  const target = proposal.target_id ? view.entities.find(e => e.id === proposal.target_id) : undefined;
  if (proposal.target_id) {
    assert(target && target.id !== player.id && named.some(e=>e.id===target.id), '请明确你想接近的人或物。');
    const here = player.components.location?.location_id, there = target.components.location?.location_id;
    assert(!here || !there || here === there, '对方不在眼前，你需要先找到对方。');
  }
  const destination = localDestination(input);
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
    condition.kind==='entity_exists'&&activityContract.kind!=='mechanical'&&
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
  const prerequisites=evaluateWorldPrerequisites(current,{target_id:proposal.target_id,
    requirements:[...requiredConditions,...(mentionedItem?[{kind:'item_accessible' as const,subject_id:mentionedItem.id}]:[]),
      ...(sourceItem?[{kind:'item_accessible' as const,subject_id:sourceItem.id}]:[]),
      ...(containerItem?[{kind:'item_accessible' as const,subject_id:containerItem.id}]:[])],item_move:proposal.item_move});
  assert(prerequisites.status==='EXECUTABLE',prerequisites.reason??'行动前置条件尚未成立');
  if(proposal.item_move?.to==='target')assert(target?.components.character,'接收物品的人尚未确定');
  const check=prepareCheck(current,requestId,{type:semantic.type,domain:semantic.domain,opposition_domain:semantic.opposition_domain,band:semantic.band,
    target_id:proposal.target_id,visibility:observing?'public':semantic.visibility,stakes:semantic.stakes,stages:semantic.stages,discover_facts:observing||semantic.discover_facts});
  const registry = createRegistry(current.definition.enabled_modules);
  // This action exists only inside this invocation; HTTP action payloads cannot provide outcomes.
  registry.actions.register('FREEFORM_ACTION', { resolution_mode:'self', parameters: z.strictObject({}), execute(c) {
    c.advance(proposal.minutes);
    if (destination) c.store.entity(c.action.actor_id).components.scene_position = { label: destination };
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
  turn.facts.push(`本次行动经过 ${turn.action.time_cost} 分钟。`);
  if(destination)turn.facts.push(`局部位置已更新：${destination}`);
  const record=turn.save.resolution_history?.find(entry=>entry.check_id===check.check_id);
  assert(record,'行动判定没有产生程序记录');
  const succeeded=record.outcome==='success'||record.outcome==='strong_success';
  const durableProgress=progressChanges(current,turn.save);
  if(requiresPersistentProgress(input)&&(!succeeded||!durableProgress.length))
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
      delete playerInventory.items[item.id];if(playerInventory.placements)delete playerInventory.placements[item.id];
      holder.components.inventory??={items:{}};(holder.components.inventory as Inventory).items[item.id]=1;
      delete itemEntity.components.location;delete itemEntity.components.scene_position;itemEntity.components.item.tracking='tracked';
    }
  }
  if(succeeded&&storage){
    const item=turn.save.entities.find(entity=>entity.id===sourceItem!.id)!;
    const container=turn.save.entities.find(entity=>entity.id===containerItem!.id)!;
    const inventory=turn.save.entities.find(entity=>entity.id===player.id)!.components.inventory as Inventory;
    if((inventory.items[container.id]??0)!==1)putItemInInventory(turn.save,container.id);
    putItemInInventory(turn.save,item.id,container.id);
    const fact=`物品已收纳：${storage.item_name} → ${storage.container_name}`;
    turn.facts.push(fact);
    const actionFact=turn.save.action_facts?.find(entry=>entry.request_id===requestId);
    if(actionFact)actionFact.facts=[...actionFact.facts,fact].slice(0,4);
  }
  const activity=succeeded&&(!proposal.item_move&&!storage&&!destination||Boolean(storage&&/准备|[，,]/.test(input)))
    ?activityEvidence(turn.save,input,turn.action.time_cost):undefined;
  if(activity){
    const fact=`进行了活动：${activity.description}（${activity.duration_minutes} 分钟）。`;
    turn.facts.push(fact);
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
  const effects:Array<'time'|'activity'|'position'|'inventory'|'relationship'|'evidence'|'progress'>=[];
  if(turn.action.time_cost)effects.push('time');
  if(activity)effects.push('activity');
  if(destination)effects.push('position');
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
    ...(activity?{activity}:{}),
    ...(succeeded&&storage?{storage:{item_id:sourceItem!.id,container_id:containerItem!.id}}:{}),
    ...(durableProgress.length?{progress_changes:durableProgress}:{}),
    commit_status:'pending' as const,
  }].slice(-200);
  turn.save.last_turn = { narrative:turn.facts.join(' '), speaker: null, dialogue: null, choices: [], context_actions: [] };
  return turn;
}

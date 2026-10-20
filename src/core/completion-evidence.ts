import type {SavePackage} from './schema.js';

export const interruptedActivityFact=(minutes:number)=>`本次普通活动因需要处理的事情而暂停，实际经过 ${minutes} 分钟。`;
export const interruptedHoldFact=(minutes:number)=>`持续活动因需要处理的事情而暂停，实际经过 ${minutes} 分钟。`;
/** An occurred interval is not completion of the requested activity after a foreground handoff. */
export function interruptedActivity(receipt:NonNullable<SavePackage['resolution_receipts']>[number]){
  if(receipt.semantic_action==='HOLD'&&receipt.kind==='DETERMINISTIC'&&receipt.outcome==='success')
    return receipt.canonical_facts.includes(interruptedHoldFact(receipt.time_cost))||receipt.canonical_facts.some(fact=>{
      const match=/^在当前位置持续进行「[\s\S]+」，实际经过 (\d+) 分钟，因需要处理的事情而暂停$/.exec(fact);
      return Boolean(match&&Number(match[1])===receipt.time_cost);
    });
  return receipt.kind==='DETERMINISTIC'&&receipt.outcome==='success'&&
    receipt.canonical_facts.includes(interruptedActivityFact(receipt.time_cost))&&
    (receipt.time_cost===0&&!receipt.activity&&!receipt.effects.includes('activity')||
     Boolean(receipt.activity?.occurred)&&receipt.effects.includes('activity')&&receipt.activity!.duration_minutes===receipt.time_cost);
}

/** A quantified or formal milestone is durable progress, not merely time spent on an activity. */
export const persistentProgressPattern=/(?:第\s*)?(?:[0-9零一二两三四五六七八九十]+|上|下|这)(?:一|整)?(?:页|章|节|题|段).{0,24}(?:写完|做完|读完|完成)|(?:写完|做完|读完|完成).{0,24}(?:第\s*)?(?:[0-9零一二两三四五六七八九十]+|上|下|这)(?:一|整)?(?:页|章|节|题|段)|(?:全部|整份|整个).{0,24}(?:写完|做完|读完|完成)|(?:写完|做完|读完|完成).{0,24}(?:全部|整份|整个)|(?:正式任务|任务目标).{0,24}(?:完成|做完)/;
export const requiresPersistentProgress=(input:string)=>persistentProgressPattern.test(input);

/**
 * An enumerated self-inspection names several specific things to check at once
 * (e.g. "检查鞋底、身体疲劳眩晕、湿滑地面"). Each named item is part of the
 * player's completion contract: one generic "no discovery" must not satisfy all.
 */
export function enumeratedInspectionItems(input:string):string[]{
  if(!/(?:检查|查看|观察|看看|留意|确认|核对|自查)/.test(input))return [];
  const body=input.replace(/^(?:我(?:现在)?(?:要|想|先|再)?)?(?:先|再)?(?:仔细|逐一)?(?:检查|查看|观察|看看|留意|确认|核对|自查)(?:一下)?(?:自己|自身|我的)?(?:的)?/,'');
  // An ambient census is one semantic inspection even though Chinese uses
  // "和" inside it.  Other explicit check lists may use 和/以及/同时 and are
  // split so each independently requested item receives evidence.
  const ambient=/有哪些(?:人在活动|人(?:在场|出现|活动))|在场人物/.test(body);
  const separator=ambient?/[、，,；;]/:/[、，,；;]|以及|还有|并且|同时|和|与|及/;
  return body.split(separator)
    .map(item=>item.replace(/^(?:以及|还有|并且|同时|和|与|及|检查|查看|观察|看看|留意|确认|核对|自查)/,'').trim())
    .filter(item=>item.length>=2);
}

export type InspectionResult = { item:string; result:'found'|'nothing'|'blocked'|'not_checked'; detail:string };

/** Map structured per-item inspection claims to the original player list. */
export function inspectionEvidence(input:string, facts:string[], proposed:InspectionResult[]|undefined){
  const items=enumeratedInspectionItems(input);
  if(items.length<2)return {items:[],status:null};
  const normalize=(value:string)=>value.replace(/[，。；、,;：:！？!?\s]/g,'').trim();
  const match=(mention:string)=>{const key=normalize(mention);const found=items.filter(item=>{const candidate=normalize(item);return candidate===key||candidate.includes(key)||key.includes(candidate);});return found.length===1?found[0]:null;};
  const resolved:InspectionResult[]=[];
  for(const result of proposed??[]){const item=match(result.item);if(item&&!resolved.some(entry=>entry.item===item))resolved.push({item,result:result.result,detail:result.detail?.trim().slice(0,300)??''});}
  // Backward compatibility is safe only when each fact names one distinct item.
  for(const fact of facts){const key=normalize(fact);const found=items.filter(item=>{const candidate=normalize(item);return candidate.length>=2&&(key.includes(candidate)||key.includes(candidate.slice(0,2))||key.includes(candidate.slice(-2)));});if(found.length===1&&!resolved.some(entry=>entry.item===found[0]))resolved.push({item:found[0],result:'found',detail:fact.slice(0,300)});}
  const results=items.map(item=>resolved.find(entry=>entry.item===item)??{item,result:'not_checked' as const,detail:''});
  const checked=results.filter(entry=>entry.result==='found'||entry.result==='nothing'),blocked=results.filter(entry=>entry.result==='blocked');
  const status:'complete'|'partial'|'world_blocked'|'not_executed'=checked.length===results.length?'complete':blocked.length===results.length?'world_blocked':checked.length===0&&blocked.length===0?'not_executed':'partial';
  return {items:results,status};
}

export function progressChanges(before:SavePackage,after:SavePackage){
  return Object.entries(after.task_progress??{}).flatMap(([key,value])=>{
    const previous=before.task_progress?.[key]??0;
    return Number.isInteger(value)&&value>previous?[{key,before:previous,after:value}]:[];
  }).slice(0,12);
}

/** This evidence records an occurred activity, never an object or task-state mutation. */
export function activityEvidence(save:SavePackage,input:string,minutes:number){
  const actor=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const location=actor?.components.location?.location_id;
  return {description:input.trim().slice(0,300),location_id:typeof location==='string'?location:null,
    duration_minutes:minutes,occurred:true as const};
}

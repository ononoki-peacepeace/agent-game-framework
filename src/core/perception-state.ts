import {z} from 'zod';
import {id,type SavePackage} from './schema.js';

/** Short-term bodily state that the world — not narration — owns.
 *
 * REV427/428 and REV434/435 both failed the same way: an NPC's posture or eyes
 * were established only inside Narrator prose, so nothing downstream could read
 * them. Adjudication saw no posture, the NPC's own reaction saw no blindness,
 * and the next turn's prose was free to contradict the previous one.
 *
 * Every transient here therefore carries provenance and a lifetime. Narration is
 * never a source: only an NPC's own structured decision, a Core action, or a
 * settled world event may write one. */
export const transientKinds=['posture','eyes','attention','holding','impairment'] as const;
export type TransientKind=typeof transientKinds[number];
export const transientSources=['npc_decision','core_action','world_event','player_action'] as const;

const worldTime=z.strictObject({day:z.number().int().nonnegative(),minute:z.number().int().nonnegative()});
export const physicalTransientSchema=z.strictObject({
  kind:z.enum(transientKinds),
  value:z.string().min(1).max(60),
  statement:z.string().min(1).max(200),
  source:z.enum(transientSources),
  source_ref:z.string().min(1).max(200),
  established_at:worldTime,
  expires_at:worldTime.nullable().default(null),
  /** A condition the owner themselves declared for ending it, e.g. "对方开口说话". */
  release_condition:z.string().max(200).nullable().default(null),
});
export type PhysicalTransient=z.infer<typeof physicalTransientSchema>;

export const postures=['unknown','standing','sitting','lying','kneeling'] as const;
export const eyeStates=['unknown','open','closed'] as const;
export const MAX_TRANSIENTS=12;

export const physicalStateSchema=z.strictObject({
  awareness:z.enum(['unknown','unaware','alert']).default('unknown'),
  alert_to_ids:z.array(id).max(20).default([]),
  restrained_by:id.nullable().default(null),
  posture:z.enum(postures).default('unknown'),
  eyes:z.enum(eyeStates).default('unknown'),
  transients:z.array(physicalTransientSchema).max(MAX_TRANSIENTS).default([]),
});
export type PhysicalState=z.infer<typeof physicalStateSchema>;

type Entity=SavePackage['entities'][number];

export function absoluteMinute(save:SavePackage,time:{day:number;minute:number}){
  return time.day*save.definition.ruleset.minutes_per_day+time.minute;
}

/** Older saves carry only the three original fields; reads never rewrite them. */
export function readPhysicalState(entity:Entity|undefined):PhysicalState{
  const raw=(entity?.components.physical_state??{}) as Partial<PhysicalState>;
  return {
    awareness:postureSafe(raw.awareness,['unknown','unaware','alert'],'unknown') as PhysicalState['awareness'],
    alert_to_ids:Array.isArray(raw.alert_to_ids)?raw.alert_to_ids.filter(item=>typeof item==='string'):[],
    restrained_by:typeof raw.restrained_by==='string'?raw.restrained_by:null,
    posture:postureSafe(raw.posture,postures,'unknown') as PhysicalState['posture'],
    eyes:postureSafe(raw.eyes,eyeStates,'unknown') as PhysicalState['eyes'],
    transients:Array.isArray(raw.transients)?raw.transients.filter(item=>physicalTransientSchema.safeParse(item).success):[],
  };
}
function postureSafe(value:unknown,allowed:readonly string[],fallback:string){
  return typeof value==='string'&&allowed.includes(value)?value:fallback;
}

/** Merge-write. Callers that only know about awareness must not silently erase
 * posture, eyes or transient provenance recorded by another subsystem. */
export function writePhysicalState(entity:Entity,patch:Partial<PhysicalState>){
  const next={...readPhysicalState(entity),...patch};
  next.transients=next.transients.slice(-MAX_TRANSIENTS);
  entity.components.physical_state=next as unknown as Entity['components']['physical_state'];
  return next;
}

function withoutKind(transients:PhysicalTransient[],kind:TransientKind){
  return transients.filter(item=>item.kind!==kind);
}

/** The single authorized entry point for establishing a transient. */
export function establishTransient(save:SavePackage,entityId:string,input:{
  kind:TransientKind;value:string;statement:string;source:PhysicalTransient['source'];source_ref:string;
  duration_minutes?:number|null;release_condition?:string|null;
}){
  const entity=save.entities.find(candidate=>candidate.id===entityId);
  if(!entity)return null;
  const established=structuredClone(save.runtime.time);
  const record=physicalTransientSchema.parse({
    kind:input.kind,value:input.value.slice(0,60),statement:input.statement.slice(0,200),
    source:input.source,source_ref:input.source_ref.slice(0,200),established_at:established,
    expires_at:input.duration_minutes&&input.duration_minutes>0
      ?absoluteToWorld(save,absoluteMinute(save,established)+input.duration_minutes):null,
    release_condition:input.release_condition?input.release_condition.slice(0,200):null,
  });
  const state=readPhysicalState(entity);
  const transients=[...withoutKind(state.transients,record.kind),record];
  writePhysicalState(entity,{
    transients,
    ...(record.kind==='posture'&&(postures as readonly string[]).includes(record.value)?{posture:record.value as PhysicalState['posture']}:{}),
    ...(record.kind==='eyes'&&(eyeStates as readonly string[]).includes(record.value)?{eyes:record.value as PhysicalState['eyes']}:{}),
  });
  return record;
}

export function absoluteToWorld(save:SavePackage,absolute:number){
  const perDay=save.definition.ruleset.minutes_per_day;
  return {day:Math.floor(absolute/perDay),minute:absolute%perDay};
}

/** A transient whose declared lifetime has passed stops constraining the world.
 * Called after world time advances, never from narration. */
export function expirePhysicalTransients(save:SavePackage,now=save.runtime.time){
  const at=absoluteMinute(save,now);
  const expired:{entity_id:string;transient:PhysicalTransient}[]=[];
  for(const entity of save.entities){
    if(!entity.components.physical_state)continue;
    const state=readPhysicalState(entity);
    const live=state.transients.filter(item=>!item.expires_at||absoluteMinute(save,item.expires_at)>at);
    if(live.length===state.transients.length)continue;
    const patch:Partial<PhysicalState>={transients:live};
    for(const item of state.transients.filter(entry=>!live.includes(entry))){
      expired.push({entity_id:entity.id,transient:item});
      if(item.kind==='posture'&&!live.some(entry=>entry.kind==='posture'))patch.posture='unknown';
      if(item.kind==='eyes'&&!live.some(entry=>entry.kind==='eyes'))patch.eyes='open';
    }
    writePhysicalState(entity,patch);
  }
  return expired;
}

/** Release a transient because its owner-declared condition actually occurred. */
export function releaseTransient(save:SavePackage,entityId:string,kind:TransientKind,reason:string){
  const entity=save.entities.find(candidate=>candidate.id===entityId);
  if(!entity)return null;
  const state=readPhysicalState(entity);
  const target=state.transients.find(item=>item.kind===kind);
  if(!target)return null;
  const patch:Partial<PhysicalState>={transients:withoutKind(state.transients,kind)};
  if(kind==='eyes')patch.eyes='open';
  if(kind==='posture')patch.posture='unknown';
  writePhysicalState(entity,patch);
  return {released:target,reason};
}

export type VisionBlock={blocked:boolean;reason:string;transient:PhysicalTransient|null};
/** Whether this entity can currently take in visual information. */
export function visionBlocked(entity:Entity|undefined):VisionBlock{
  const state=readPhysicalState(entity);
  if(state.eyes==='closed')
    return {blocked:true,reason:'本人当前闭着眼，没有视觉信息',transient:state.transients.find(item=>item.kind==='eyes')??null};
  const impairment=state.transients.find(item=>item.kind==='impairment'&&/盲|失明|蒙眼|看不见/.test(item.value+item.statement));
  if(impairment)return {blocked:true,reason:impairment.statement,transient:impairment};
  return {blocked:false,reason:'',transient:null};
}

/** Visual-observation assertions that an entity without sight cannot make.
 * Only used to constrain generated text; it never changes a world outcome. */
const visualAssertion=/(?:我|本人)?(?:都)?(?:看[得见清到](?:很)?(?:清楚|清|见|到)|看在眼里|亲眼(?:看见|见到|所见)|眼睁睁(?:地)?看|目睹|看得真真切切|全都看见|看清了)/g;
export function visualClaimIssues(text:string,vision:VisionBlock){
  if(!vision.blocked||!text)return [] as {match:string;index:number}[];
  const issues:{match:string;index:number}[]=[];
  for(const match of text.matchAll(visualAssertion)){
    const before=text.slice(Math.max(0,match.index-6),match.index);
    // "我没有看见" / "我看不清" are consistent with being unable to see.
    if(/(?:没有|没|并未|未曾|不曾|无法|不能|看不)$/.test(before))continue;
    if(/^看不/.test(match[0]))continue;
    issues.push({match:match[0],index:match.index});
  }
  return issues;
}

/** Circumstance modifiers for a physical attempt, derived only from recorded state. */
export function posturePerceptionCircumstances(target:Entity|undefined,amount:number){
  const state=readPhysicalState(target);
  const vision=visionBlocked(target);
  const out:{side:'actor'|'opponent';amount:number;reason:string}[]=[];
  if(vision.blocked)out.push({side:'actor',amount,reason:`目标已登记无视觉状态：${vision.reason}`});
  if(state.posture==='sitting'||state.posture==='kneeling')
    out.push({side:'actor',amount,reason:'目标已登记为坐姿/跪姿，身体回避余地受限'});
  else if(state.posture==='lying')
    out.push({side:'actor',amount:amount*2,reason:'目标已登记为卧倒，难以有效回避'});
  return out;
}

/** True when the target had no sight at the moment a physical action settled, so
 * they felt it without seeing it. Drives both NPC context and claim validation. */
export function struckWithoutSight(target:Entity|undefined){
  return visionBlocked(target).blocked;
}

export function physicalStateSummary(entity:Entity|undefined){
  const state=readPhysicalState(entity);
  const parts:string[]=[];
  if(state.posture!=='unknown')parts.push(({standing:'站立',sitting:'坐着',lying:'卧倒',kneeling:'跪着',unknown:''})[state.posture]);
  if(state.eyes!=='unknown')parts.push(state.eyes==='closed'?'闭着眼':'睁着眼');
  for(const item of state.transients)if(item.kind!=='posture'&&item.kind!=='eyes')parts.push(item.statement);
  return parts.filter(Boolean).join('；');
}

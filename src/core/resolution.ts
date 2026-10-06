import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assert,id,type SavePackage} from './schema.js';
import {rollDice,type RNG} from './dice.js';

export const resolutionKindSchema=z.enum(['DETERMINISTIC','SIMPLE_CHECK','OPPOSED_CHECK','GRADED_CHECK','EXTENDED_CHECK','EVENT_ROLL']);
export const difficultyBandSchema=z.enum(['trivial','easy','normal','hard','very_hard','extreme']);
export const checkSpecSchema=z.strictObject({
  check_id:z.string().min(1).max(100),request_id:z.string().uuid(),
  resolution_type:resolutionKindSchema,profile:z.enum(['classic_d20','bell_2d6','percentile_d100']),
  actor_id:id,target_id:id.nullable(),domain:id,opposition_domain:id.nullable(),difficulty_band:difficultyBandSchema,
  actor_modifier:z.number().int().min(-20).max(20),opponent_modifier:z.number().int().min(-20).max(20),
  visibility:z.enum(['public','hidden']),stakes:z.string().max(300),
  stages:z.array(z.strictObject({id,band:difficultyBandSchema})).max(8),
  evidence_ids:z.array(id).max(20),
});
export type CheckSpec=z.infer<typeof checkSpecSchema>;
export type ResolutionOutcome=SavePackage['resolution_history'] extends (infer T)[]|undefined?T:never;
const bands=difficultyBandSchema.options;
const profiles={
  classic_d20:{expression:'1d20',thresholds:[5,10,15,20,25,30],strong:5,critical:10},
  bell_2d6:{expression:'2d6',thresholds:[3,5,7,9,11,13],strong:3,critical:5},
  percentile_d100:{expression:'1d100',thresholds:[10,30,50,70,85,95],strong:20,critical:30},
} as const;
export function resolutionProfile(save:SavePackage){
  const fixed=save.definition.ruleset.resolution_profile?.kind;if(fixed)return fixed;
  // Old worlds retain their existing dice family without rewriting their saves on every read.
  const die=save.definition.ruleset.default_check.toLowerCase();
  return /^2d6(?:[+-]\d+)?$/.test(die)?'bell_2d6':/^1d100(?:[+-]\d+)?$/.test(die)?'percentile_d100':'classic_d20';
}
function capability(save:SavePackage,entityId:string,domain:string){
  const entity=save.entities.find(candidate=>candidate.id===entityId);assert(entity,'判定对象不存在');
  const attrs=(entity.components.attributes?.values??{}) as Record<string,unknown>;
  const skill=(entity.components.skills?.entries??{}) as Record<string,{level?:number}>;
  const raw=typeof attrs[domain]==='number'?attrs[domain] as number:skill[domain]?.level??0;
  return Math.max(-5,Math.min(5,Math.trunc(raw)));
}
/** Locks every rule field from canonical state and a bounded semantic suggestion before any RNG call. */
export function prepareCheck(save:SavePackage,requestId:string,input:{type:z.infer<typeof resolutionKindSchema>;domain:string;opposition_domain?:string|null;band:z.infer<typeof difficultyBandSchema>;target_id?:string|null;visibility?:'public'|'hidden';stakes?:string;stages?:{id:string;band:z.infer<typeof difficultyBandSchema>}[];evidence_ids?:string[];discover_facts?:boolean}){
  const actor=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const target=input.target_id?save.entities.find(entity=>entity.id===input.target_id):null;
  if(input.target_id)assert(target,'判定目标不存在');
  if(input.type==='OPPOSED_CHECK'){
    assert(target&&target.components.character,'对抗判定需要真实在场的对手');
    assert(target.components.location?.location_id===actor.components.location?.location_id,'对手不在当前场景');
  }
  if(input.type==='EXTENDED_CHECK')assert(input.stages?.length&&input.stages.length>=2,'长期判定必须包含至少两个阶段');
  const here=actor.components.location?.location_id;
  const scene=String(actor.components.scene_position?.label??'');
  const reachableEvidence=(save.gm_state.hidden_truth?.commitments??[]).flatMap(truth=>truth.evidence).filter(entry=>{
    const placement=entry.placement;
    if(entry.status==='DESTROYED'||!placement||placement.discoverability.domain!==input.domain)return false;
    if(bands.indexOf(placement.discoverability.difficulty)>bands.indexOf(input.band))return false;
    if(placement.location_id&&placement.location_id!==here)return false;
    if(placement.scene_scope&&placement.scene_scope!==scene)return false;
    if(placement.anchor_entity_id){
      const anchor=save.entities.find(entity=>entity.id===placement.anchor_entity_id);
      if(!anchor||(!anchor.components.location&&anchor.id!==actor.id))return false;
      if(anchor.components.location?.location_id!==here&&anchor.id!==actor.id)return false;
    }
    return Boolean(placement.location_id||placement.anchor_entity_id||placement.scene_scope);
  });
  const eligible=new Set(reachableEvidence.map(entry=>entry.id));
  assert((input.evidence_ids??[]).every(item=>eligible.has(item)),'调查只能引用当前场景中已有的证据');
  const evidenceIds=input.evidence_ids?.length?input.evidence_ids:input.discover_facts?reachableEvidence.filter(entry=>!entry.discovered_by.includes(actor.id)).slice(0,2).map(entry=>entry.id):[];
  const spec=checkSpecSchema.parse({check_id:'check_'+createHash('sha256').update(requestId).digest('hex').slice(0,24),request_id:requestId,
    resolution_type:input.type,profile:resolutionProfile(save),actor_id:actor.id,target_id:target?.id??null,
    domain:input.domain,opposition_domain:input.opposition_domain??null,difficulty_band:input.band,actor_modifier:capability(save,actor.id,input.domain),
    opponent_modifier:target?capability(save,target.id,input.opposition_domain??input.domain):0,visibility:input.visibility??'public',stakes:input.stakes??'',
    stages:input.stages??[],evidence_ids:evidenceIds});
  return Object.freeze({...spec,stages:Object.freeze(spec.stages.map(stage=>Object.freeze(stage))),evidence_ids:Object.freeze([...spec.evidence_ids])}) as CheckSpec;
}
export function resolveCheck(save:SavePackage,spec:CheckSpec,rng:RNG){
  const profile=profiles[spec.profile],threshold=(band:z.infer<typeof difficultyBandSchema>)=>profile.thresholds[bands.indexOf(band)];
  const rolls:ReturnType<typeof rollDice>[]=[];
  const single=(band:z.infer<typeof difficultyBandSchema>)=>{
    const actor=rollDice(profile.expression,rng);rolls.push(actor);
    if(spec.resolution_type==='OPPOSED_CHECK'){
      const opponent=rollDice(profile.expression,rng);rolls.push(opponent);
      return actor.total+spec.actor_modifier-(opponent.total+spec.opponent_modifier);
    }
    return actor.total+spec.actor_modifier-threshold(band);
  };
  let margin=0;
  let completedStages=0;
  if(spec.resolution_type==='EXTENDED_CHECK'){
    for(const stage of spec.stages){margin=single(stage.band);completedStages++;if(margin<0)break;}
  }else if(spec.resolution_type!=='DETERMINISTIC')margin=single(spec.difficulty_band);
  const completed=spec.resolution_type!=='EXTENDED_CHECK'||completedStages===spec.stages.length;
  const outcome=spec.resolution_type==='DETERMINISTIC'?'success':!completed||margin<0
    ?margin<=-profile.critical?'critical_failure':spec.resolution_type==='GRADED_CHECK'&&margin>=-2?'partial_success':'failure'
    :spec.resolution_type==='GRADED_CHECK'&&margin>=profile.strong?'strong_success':'success';
  const record={request_id:spec.request_id,check_id:spec.check_id,spec:structuredClone(spec) as unknown as Record<string,unknown>,rolls,outcome,hidden:spec.visibility==='hidden'};
  save.resolution_history=[...(save.resolution_history??[]),record].slice(-200) as SavePackage['resolution_history'];
  if(['success','strong_success','partial_success'].includes(outcome)&&spec.evidence_ids.length){
    const allowed=outcome==='partial_success'?spec.evidence_ids.slice(0,1):spec.evidence_ids;
    for(const truth of save.gm_state.hidden_truth?.commitments??[])for(const evidence of truth.evidence)
      if(allowed.includes(evidence.id)&&evidence.status!=='DESTROYED'&&!evidence.discovered_by.includes(spec.actor_id))evidence.discovered_by.push(spec.actor_id);
  }
  return record;
}

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assert,id,type SavePackage} from './schema.js';
import {rollDice,type RNG} from './dice.js';
import {observe} from '../observability/index.js';
import {evidenceAccessible} from '../narrative/truth.js';
import {emptyNpcAgentState} from '../agent/npc-state.js';
import {posturePerceptionCircumstances,visionBlocked} from './perception-state.js';
import {capabilityRule} from './capability.js';

export const resolutionKindSchema=z.enum(['DETERMINISTIC','SIMPLE_CHECK','OPPOSED_CHECK','GRADED_CHECK','EXTENDED_CHECK','EVENT_ROLL']);
export const difficultyBandSchema=z.enum(['trivial','easy','normal','hard','very_hard','extreme']);
export const checkSpecSchema=z.strictObject({
  check_id:z.string().min(1).max(100),request_id:z.string().uuid(),
  resolution_type:resolutionKindSchema,profile:z.enum(['classic_d20','bell_2d6','percentile_d100']),
  actor_id:id,target_id:id.nullable(),domain:id,opposition_domain:id.nullable(),difficulty_band:difficultyBandSchema,
  actor_modifier:z.number().int().min(-20).max(20),opponent_modifier:z.number().int().min(-20).max(20),
  visibility:z.enum(['public','hidden']),stakes:z.string().max(300),
  stages:z.array(z.strictObject({id,band:difficultyBandSchema})).max(8),
  blocked_stages:z.array(z.strictObject({id,reason:z.string().min(1).max(300)})).max(8).optional(),
  exertion:z.strictObject({actor:z.number().int().min(0).max(10),opponent:z.number().int().min(0).max(10)}).optional(),
  evidence_ids:z.array(id).max(20),
  // Raised from 8 only because more *recorded* conditions now participate (posture, sight, reach);
  // the per-item bound and the ±20 total are unchanged, so no modifier grew in size.
  circumstance_modifiers:z.array(z.strictObject({side:z.enum(['actor','opponent']),amount:z.number().int(),reason:z.string().max(200)})).max(12).optional(),
  // What the ability half of the adjudication was actually read from. `recorded:false` on both
  // sides is the honest statement "no ability data exists in this world for this contest", which
  // REV435 could only express as an invisible debug log.
  ability_basis:z.array(z.strictObject({side:z.enum(['actor','opponent']),entity_id:id,domain:id,
    rule_source:z.enum(['world_rule','framework_default','legacy_value','undeclared']),
    recorded:z.boolean(),modifier:z.number().int().min(-10).max(10)})).max(2).optional(),
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
/**
 * Reads one side's ability for a domain and reports where it came from, so a receipt can prove
 * what the adjudication used. Precedence: the world's declared rule, then a legacy value recorded
 * under the domain's own key (its documented direct-modifier meaning), then the framework's
 * generic domain floor. Absent data is the neutral baseline; nothing is inferred from biography.
 */
function capability(save:SavePackage,entityId:string,domain:string){
  const entity=save.entities.find(candidate=>candidate.id===entityId);assert(entity,'判定对象不存在');
  const attrs=(entity.components.attributes?.values??{}) as Record<string,unknown>;
  const skill=(entity.components.skills?.entries??{}) as Record<string,{level?:number}>;
  const declared=save.definition.ruleset.capability_domains?.[domain];
  const resolved=declared?{rule:declared,source:'world_rule' as const}:null;
  const fromRule=(rule:NonNullable<typeof declared>)=>{
    const attribute=rule.attribute&&typeof attrs[rule.attribute]==='number'?Number(attrs[rule.attribute]):(rule.attribute_baseline??0);
    const training=Math.max(0,...rule.skills.map(key=>skill[key]?.level??0));
    const recorded=Boolean(rule.attribute&&typeof attrs[rule.attribute]==='number')||rule.skills.some(key=>typeof skill[key]?.level==='number');
    return {modifier:Math.max(-10,Math.min(10,Math.trunc((attribute-(rule.attribute_baseline??0))/(rule.attribute_step??1))+Math.min(5,Math.trunc(training)))),recorded};
  };
  if(resolved)return {...fromRule(resolved.rule),rule_source:resolved.source};
  const direct=typeof attrs[domain]==='number'?attrs[domain] as number:skill[domain]?.level;
  if(typeof direct==='number')
    return {modifier:Math.max(-5,Math.min(5,Math.trunc(direct))),rule_source:'legacy_value' as const,recorded:true};
  const fallback=capabilityRule(save,domain);
  if(fallback)return {...fromRule(fallback.rule),rule_source:fallback.source};
  return {modifier:0,rule_source:'undeclared' as const,recorded:false};
}
/** Locks every rule field from canonical state and a bounded semantic suggestion before any RNG call. */
export function prepareCheck(save:SavePackage,requestId:string,input:{type:z.infer<typeof resolutionKindSchema>;domain:string;opposition_domain?:string|null;band:z.infer<typeof difficultyBandSchema>;target_id?:string|null;visibility?:'public'|'hidden';stakes?:string;stages?:{id:string;band:z.infer<typeof difficultyBandSchema>}[];blocked_stages?:{id:string;reason:string}[];evidence_ids?:string[];discover_facts?:boolean;physical?:boolean;surprise_attempt?:boolean},actorId=save.player_state.entity_id){
  const actor=save.entities.find(entity=>entity.id===actorId);
  assert(actor,'判定行动者不存在');
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
    // A general scene search is not tied to the authoring-time skill/domain label of a clue.
    // It can only test evidence actually placed in this scene and within this check's difficulty.
    if(entry.status==='DESTROYED'||!placement||
      (input.domain!=='perception'&&placement.discoverability.domain!==input.domain))return false;
    if(bands.indexOf(placement.discoverability.difficulty)>bands.indexOf(input.band))return false;
    if(target&&placement.anchor_entity_id!==target.id)return false;
    return evidenceAccessible(save,actor.id,placement);
  });
  const eligible=new Set(reachableEvidence.map(entry=>entry.id));
  assert((input.evidence_ids??[]).every(item=>eligible.has(item)),'调查只能引用当前场景中已有的证据');
  const evidenceIds=input.evidence_ids?.length?input.evidence_ids:input.discover_facts?reachableEvidence.filter(entry=>!entry.discovered_by.includes(actor.id)).slice(0,2).map(entry=>entry.id):[];
  const circumstances:NonNullable<CheckSpec['circumstance_modifiers']>=[];
  const actorRule=capabilityRule(save,input.domain)?.rule;
  const targetRule=capabilityRule(save,input.opposition_domain??input.domain)?.rule;
  if(input.physical&&target){
    const amount=resolutionProfile(save)==='percentile_d100'?10:resolutionProfile(save)==='bell_2d6'?1:2;
    const state=target.components.physical_state;
    const close=Boolean(actor.components.scene_position?.label&&
      actor.components.scene_position.label===target.components.scene_position?.label)||
      save.npc_agent_state?.[target.id]?.contact_state?.status==='active'&&
      save.npc_agent_state[target.id].contact_state?.location_id===here;
    // Recorded posture and sight are real defensive conditions. Without them a
    // seated, eyes-closed target defended exactly as well as an alert one (REV435).
    const blindness=visionBlocked(target);
    circumstances.push(...posturePerceptionCircumstances(target,amount));
    if(input.surprise_attempt&&close&&(state?.awareness==='unaware'||blindness.blocked))
      circumstances.push({side:'actor',amount,reason:'已有近距离接触与目标无法察觉的状态支持突袭优势'});
    // Being generally alert cannot help a target who currently has no sight of the actor.
    if(!blindness.blocked&&state?.awareness!=='unaware'&&
      (state?.awareness==='alert'||(state?.alert_to_ids as string[]|undefined)?.includes(actor.id)))
      circumstances.push({side:'opponent',amount,reason:'目标已经警觉'});
    for(const [side,entity] of [['actor',actor],['opponent',target]] as const)
      if(typeof entity.components.condition?.hp==='number'&&entity.components.condition.hp<50||
        typeof entity.components.condition?.stamina==='number'&&entity.components.condition.stamina<20)
        circumstances.push({side,amount:-amount,reason:'已登记伤势或疲劳影响身体行动'});
    if(state?.restrained_by===actor.id)circumstances.push({side:'actor',amount,reason:'目标已被本人控制'});
    // Reach is a recorded condition too. Only *recorded* positions can disagree — an unknown
    // position is not evidence of distance, so it earns no modifier either way.
    const from=String(actor.components.scene_position?.label??''),to=String(target.components.scene_position?.label??'');
    if(!close&&from&&to&&from!==to)
      circumstances.push({side:'actor',amount:-amount,reason:`双方登记位置不同（${from}→${to}），需要先跨过距离`});
  }
  if(!input.physical&&actorRule?.condition_sensitive){
    const amount=resolutionProfile(save)==='percentile_d100'?10:resolutionProfile(save)==='bell_2d6'?1:2;
    if(Number(actor.components.condition?.hp??100)<50||Number(actor.components.condition?.stamina??100)<20)
      circumstances.push({side:'actor',amount:-amount,reason:'已登记伤势或疲劳影响这项体力活动'});
  }
  const opposingDomain=input.opposition_domain??input.domain;
  const actorCapability=capability(save,actor.id,input.domain);
  const targetCapability=target?capability(save,target.id,opposingDomain):null;
  const actorAbility=actorCapability.modifier,targetAbility=targetCapability?.modifier??0;
  const basis:NonNullable<CheckSpec['ability_basis']>=[
    {side:'actor',entity_id:actor.id,domain:input.domain,rule_source:actorCapability.rule_source,
      recorded:actorCapability.recorded,modifier:actorAbility},
    ...(target&&targetCapability?[{side:'opponent' as const,entity_id:target.id,domain:opposingDomain,
      rule_source:targetCapability.rule_source,recorded:targetCapability.recorded,modifier:targetAbility}]:[])];
  observe('debug','resolution.capability_bound',{module:'resolution',request_id:requestId,metadata:{
    actor_id:actor.id,target_id:target?.id??null,domain:input.domain,opposition_domain:opposingDomain,
    actor_ability:actorAbility,opponent_ability:targetAbility,
    actor_rule_source:actorCapability.rule_source,opponent_rule_source:targetCapability?.rule_source??null,
    actor_has_data:actorCapability.recorded,opponent_has_data:targetCapability?.recorded??false}});
  // A contested body with no recorded ability on either side is decided by dice and circumstance
  // alone. That is a real reliability gap in the world's data, so it is stated at a level an
  // operator actually sees instead of being buried at debug (REV435).
  if(input.physical&&target&&!actorCapability.recorded&&!targetCapability?.recorded)
    observe('warn','resolution.ability_data_absent',{module:'resolution',request_id:requestId,metadata:{
      actor_id:actor.id,target_id:target.id,domain:input.domain,opposition_domain:opposingDomain,
      rule_source:actorCapability.rule_source,
      detail:'双方都没有已登记的能力数据，本次身体对抗仅由骰子与已登记情境条件决定'}});
  const spec=checkSpecSchema.parse({check_id:'check_'+createHash('sha256').update(requestId).digest('hex').slice(0,24),request_id:requestId,
    resolution_type:input.type,profile:resolutionProfile(save),actor_id:actor.id,target_id:target?.id??null,
    domain:input.domain,opposition_domain:input.opposition_domain??null,difficulty_band:input.band,actor_modifier:Math.max(-20,Math.min(20,actorAbility+circumstances.filter(item=>item.side==='actor').reduce((sum,item)=>sum+item.amount,0))),
    opponent_modifier:Math.max(-20,Math.min(20,targetAbility+circumstances.filter(item=>item.side==='opponent').reduce((sum,item)=>sum+item.amount,0))),visibility:input.visibility??'public',stakes:input.stakes??'',
    stages:input.stages??[],evidence_ids:evidenceIds,
    ...(actorRule||target&&targetRule?{exertion:{actor:actorRule?.exertion_cost??0,opponent:target&&input.type==='OPPOSED_CHECK'?(targetRule?.exertion_cost??0):0}}:{}),...(input.blocked_stages?.length?{blocked_stages:input.blocked_stages}:{}),...(circumstances.length?{circumstance_modifiers:circumstances}:{}),ability_basis:basis});
  return Object.freeze({...spec,stages:Object.freeze(spec.stages.map(stage=>Object.freeze(stage))),
    ...(spec.blocked_stages?{blocked_stages:Object.freeze(spec.blocked_stages.map(stage=>Object.freeze(stage)))}:{}),
    evidence_ids:Object.freeze([...spec.evidence_ids])}) as CheckSpec;
}
export function resolveCheck(save:SavePackage,spec:CheckSpec,rng:RNG){
  const profile=profiles[spec.profile],threshold=(band:z.infer<typeof difficultyBandSchema>)=>profile.thresholds[bands.indexOf(band)];
  const rolls:ReturnType<typeof rollDice>[]=[];
  const stageResults:{id:string;passed:boolean;margin:number;blocked_reason?:string}[]=[];
  const single=(band:z.infer<typeof difficultyBandSchema>)=>{
    const actor=rollDice(profile.expression,rng);rolls.push(actor);
    if(spec.resolution_type==='OPPOSED_CHECK'){
      const opponent=rollDice(profile.expression,rng);rolls.push(opponent);
      return actor.total+spec.actor_modifier-(opponent.total+spec.opponent_modifier)-(threshold(band)-threshold('normal'));
    }
    return actor.total+spec.actor_modifier-threshold(band);
  };
  let margin=0;
  let completedStages=0;
  const staged=spec.resolution_type==='EXTENDED_CHECK'||spec.resolution_type==='OPPOSED_CHECK'&&spec.stages.length>0;
  if(staged){
    for(const stage of spec.stages){
      const blocked=spec.blocked_stages?.find(entry=>entry.id===stage.id);
      if(blocked){margin=-1;stageResults.push({id:stage.id,passed:false,margin,blocked_reason:blocked.reason});break;}
      margin=single(stage.band);completedStages++;
      stageResults.push({id:stage.id,passed:margin>=0,margin});if(margin<0)break;}
  }else if(spec.resolution_type!=='DETERMINISTIC')margin=single(spec.difficulty_band);
  const completed=!staged||completedStages===spec.stages.length&&margin>=0;
  const outcome=staged&&!completed&&stageResults.some(stage=>stage.passed)?'partial_success':spec.resolution_type==='DETERMINISTIC'?'success':!completed||margin<0
    ?margin<=-profile.critical?'critical_failure':spec.resolution_type==='GRADED_CHECK'&&margin>=-2?'partial_success':'failure'
    :spec.resolution_type==='GRADED_CHECK'&&margin>=profile.strong?'strong_success':'success';
  // A resolved attempt spends its declared exertion once; preparing/retrying prose never does.
  if(spec.resolution_type!=='DETERMINISTIC')for(const [entityId,cost] of [[spec.actor_id,spec.exertion?.actor??0],[spec.target_id,spec.exertion?.opponent??0]] as const){
    const entity=save.entities.find(e=>e.id===entityId);
    if(cost&&entity?.components.condition)entity.components.condition.stamina=Math.max(0,Number(entity.components.condition.stamina)-cost);
  }
  const record={request_id:spec.request_id,check_id:spec.check_id,spec:structuredClone(spec) as unknown as Record<string,unknown>,rolls,outcome,
    ...(stageResults.length?{stage_results:stageResults}:{}),hidden:spec.visibility==='hidden'};
  save.resolution_history=[...(save.resolution_history??[]),record].slice(-200) as SavePackage['resolution_history'];
  observe('info','resolution.completed',{module:'resolution',request_id:spec.request_id,revision:save.state_revision,
    metadata:{check_id:spec.check_id,resolution_type:spec.resolution_type,outcome,
      actor_modifier:spec.actor_modifier,opponent_modifier:spec.opponent_modifier,
      stage_results:stageResults,circumstance_modifiers:spec.circumstance_modifiers??[]}});
  if(['success','strong_success','partial_success'].includes(outcome)&&spec.evidence_ids.length){
    const allowed=outcome==='partial_success'?spec.evidence_ids.slice(0,1):spec.evidence_ids;
    for(const truth of save.gm_state.hidden_truth?.commitments??[])for(const evidence of truth.evidence)
      if(allowed.includes(evidence.id)&&evidence.status!=='DESTROYED'&&!evidence.discovered_by.includes(spec.actor_id)){
        evidence.discovered_by.push(spec.actor_id);
        if(spec.actor_id!==save.player_state.entity_id){
          save.npc_agent_state??={};const state=save.npc_agent_state[spec.actor_id]??emptyNpcAgentState();
          state.knowledge=[...state.knowledge.filter(item=>item.id!==evidence.id),{id:evidence.id,
            proposition:evidence.description.slice(0,500),source_type:'observed' as const,source_ref:spec.check_id,
            learned_at:structuredClone(save.runtime.time),confidence:1}].slice(-80);
          save.npc_agent_state[spec.actor_id]=state;
        }
      }
  }
  return record;
}

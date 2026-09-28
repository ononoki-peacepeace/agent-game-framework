import { createHash } from 'node:crypto';
import { assert, type SavePackage } from '../core/schema.js';
import { defaultRoleplayConfig } from './policy.js';
import { narrativeStateSchema, type DirectorDecision, type NarrativeArc, type NarrativeState } from './schema.js';

export type DirectorTrigger=DirectorDecision['trigger'];
export function ensureNarrativeState(save:SavePackage):NarrativeState{
  if(!save.definition.roleplay_config)save.definition.roleplay_config=defaultRoleplayConfig();
  if(!save.narrative_state)save.narrative_state={version:1,constitution_version:1,player_entity_ref:save.player_state.entity_id,current_saga:null,saga_history:[],arcs:[],open_loops:[],unpaid_setups:[],closure_pressure:0,director_phase:'IDLE',meaningful_turns_since_evaluation:0,recent_director_decisions:[]};
  narrativeStateSchema.parse(save.narrative_state);
  return save.narrative_state;
}
export function stableNarrativeId(prefix:string,value:string){return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0,12)}`;}

export function calculateClosurePressure(save:SavePackage,state:NarrativeState){
  const config=save.definition.roleplay_config??defaultRoleplayConfig();
  const active=state.arcs.filter(a=>['ACTIVE','CONVERGING','CLIMAX'].includes(a.status)).length;
  const majorLoops=state.open_loops.filter(l=>l.importance==='major'&&l.status==='OPEN').length;
  const stale=state.arcs.filter(a=>['ACTIVE','EMERGING'].includes(a.status)&&save.state_revision-a.last_meaningful_revision>=12).length;
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id),age=Number(player?.components.character?.age??player?.components.identity?.age??NaN);
  const horizon=config.life_horizon.kind==='open_ended'||config.life_horizon.kind==='immortal'?0:Number.isFinite(age)&&config.life_horizon.target_age_max?Math.max(0,Math.min(.3,(age/config.life_horizon.target_age_max-.65)*.8)):.08;
  return Math.min(1,Number((horizon+Math.max(0,active-config.major_arc_soft_cap)*.12+Math.max(0,majorLoops-config.major_open_loop_soft_cap)*.1+stale*.08).toFixed(3)));
}

/** Deterministic, cheap evaluation. A model may later rank these directives, but may never patch world truth. */
export function evaluateDirector(save:SavePackage,trigger:DirectorTrigger):DirectorDecision{
  const state=ensureNarrativeState(save),config=save.definition.roleplay_config??defaultRoleplayConfig();
  state.director_phase='EVALUATING';state.closure_pressure=calculateClosurePressure(save,state);
  const active=state.arcs.filter(a=>['ACTIVE','CONVERGING','CLIMAX'].includes(a.status));
  const emerging=state.arcs.filter(a=>a.status==='EMERGING');
  const directives:DirectorDecision['directives']=[];
  if(active.length>=config.major_arc_soft_cap&&emerging.length)directives.push({kind:'CLOSURE_OPPORTUNITY',arc_ref:active.sort((a,b)=>b.closure_priority-a.closure_priority)[0]?.id??null,reason:'主要故事线已达到软容量；让新事件保持真实存在，同时优先提供旧线的自然收束机会。'});
  for(const arc of active.filter(a=>a.accelerated_closure))directives.push({kind:'CONVERGE',arc_ref:arc.id,reason:'玩家已明确要求加速收束；仅使用已有矛盾、线索、压力和NPC目标。'});
  if(state.open_loops.filter(l=>l.importance==='major'&&l.status==='OPEN').length>=config.major_open_loop_soft_cap)directives.push({kind:'PAYOFF_OPPORTUNITY',arc_ref:null,reason:'重大未收束事项已达预算；优先回收、合并、失败或明确保持未知。'});
  if(!directives.length&&active.length&&config.narrative_mode!=='minimal')directives.push({kind:'FOCUS',arc_ref:active[0].id,reason:'保持当前真实故事焦点，不创造新的世界事实。'});
  const decision:DirectorDecision={revision:save.state_revision,trigger,directives,invalidated_decision_revisions:[]};
  state.recent_director_decisions=[...state.recent_director_decisions,decision].slice(-20);state.meaningful_turns_since_evaluation=0;state.director_phase=directives.some(d=>d.kind==='CONVERGE'||d.kind==='CLOSURE_OPPORTUNITY')?'CLOSING':'WAITING_FOR_WORLD';
  save.narrative_state=narrativeStateSchema.parse(state);return decision;
}

export function noteMeaningfulTurn(save:SavePackage,trigger?:DirectorTrigger){
  const state=ensureNarrativeState(save),config=save.definition.roleplay_config??defaultRoleplayConfig();state.meaningful_turns_since_evaluation++;
  if(trigger)return evaluateDirector(save,trigger);
  const threshold=config.narrative_mode==='story_focused'?4:config.narrative_mode==='minimal'?12:6;
  if(state.meaningful_turns_since_evaluation>=threshold)return evaluateDirector(save,'MEANINGFUL_TURNS');
  save.narrative_state=state;return null;
}

/** Promotes only committed, materially significant events into story focus. Quiet turns remain quiet. */
export function observeCanonicalTurn(save:SavePackage,eventRef:string,facts:string[]){
  const significant=facts.find(fact=>/发现|失踪|死亡|袭击|阴谋|秘密|异常|危机|战争|背叛|谋杀|感染|爆炸|政变|灾难|重大|真相/.test(fact));
  if(!significant)return null;
  const state=ensureNarrativeState(save);if(state.arcs.some(arc=>arc.canonical_event_refs.includes(eventRef)))return null;
  const arcId=stableNarrativeId('arc',eventRef),created=addArc(save,{id:arcId,title:significant.replace(/[。！？].*$/,'').slice(0,60),status:'EMERGING',summary:significant.slice(0,500),canonical_event_refs:[eventRef],truth_refs:[],participant_refs:[],closure_priority:.25,reveal_step:0,accelerated_closure:false,last_meaningful_revision:save.state_revision});
  const current=ensureNarrativeState(save);
  if(!current.current_saga)current.current_saga={id:stableNarrativeId('saga',eventRef),title:'正在形成的篇章',start_time:structuredClone(save.runtime.time),phase:'FORMING',arc_refs:[arcId],canonical_event_refs:[eventRef]};
  else {if(!current.current_saga.arc_refs.includes(arcId))current.current_saga.arc_refs.push(arcId);if(!current.current_saga.canonical_event_refs.includes(eventRef))current.current_saga.canonical_event_refs.push(eventRef);}
  evaluateDirector(save,'IMPORTANT_DISCOVERY');return created;
}

export type StoryCommand='DORMANT'|'ABANDON'|'ACCELERATE_CLOSURE'|'REACTIVATE'|'OVERLOAD_CONFIRMATION';
export function storyCommand(input:string):StoryCommand|null{
  const value=input.trim();
  if(/(?:不想管|不再参与|放弃).*(?:故事|这条|线)|(?:故事|这条|线).*(?:不想管|不再参与|放弃)/.test(value))return 'ABANDON';
  if(/(?:先放一放|暂时搁置|暂停).*(?:故事|这条|线)|(?:故事|这条|线).*(?:先放一放|暂时搁置|暂停)/.test(value))return 'DORMANT';
  if(/(?:赶快|加速|尽快).*(?:收尾|收束|结局)|(?:收尾|收束).*(?:快一点|加速)/.test(value))return 'ACCELERATE_CLOSURE';
  if(/(?:继续|重启|恢复).*(?:以前|之前|搁置).*(?:故事|线)/.test(value))return 'REACTIVATE';
  if(/(?:现在就|仍然|坚持).*(?:新|第四|第五).*(?:故事|大事|线)/.test(value))return 'OVERLOAD_CONFIRMATION';
  return null;
}
function targetArc(arcs:NarrativeArc[],command:StoryCommand){return command==='REACTIVATE'?arcs.find(a=>a.status==='DORMANT'):command==='OVERLOAD_CONFIRMATION'?arcs.find(a=>a.status==='EMERGING'):arcs.find(a=>['ACTIVE','CONVERGING','EMERGING'].includes(a.status));}
export function applyStoryCommand(save:SavePackage,command:StoryCommand){
  const state=ensureNarrativeState(save),arc=targetArc(state.arcs,command);assert(arc,'当前没有可执行该故事管理操作的主要故事线');
  if(command==='DORMANT')arc.status='DORMANT';
  if(command==='ABANDON')arc.status='ABANDONED';
  if(command==='ACCELERATE_CLOSURE'){arc.status='CONVERGING';arc.accelerated_closure=true;arc.closure_priority=1;}
  if(command==='REACTIVATE')arc.status='ACTIVE';
  if(command==='OVERLOAD_CONFIRMATION'){arc.status='ACTIVE';}
  arc.last_meaningful_revision=save.state_revision;save.narrative_state=state;
  evaluateDirector(save,'PLAYER_DIRECTION');
  return command==='ABANDON'?'你不再参与这条主要故事线。世界与NPC仍会继续，部分机会可能永久失去。':command==='DORMANT'?'这条主要故事线已暂时搁置；它仍会在世界中发展。':command==='ACCELERATE_CLOSURE'?'这条故事将基于已有矛盾、线索和压力加速收束；不保证胜利，也不会凭空制造答案。':command==='REACTIVATE'?'这条故事重新成为当前焦点。':'你选择在已有重大故事之外继续推进新的故事；焦点会更分散，旧线可能自行发展。';
}

export function addArc(save:SavePackage,arc:NarrativeArc,forceActive=false){
  const state=ensureNarrativeState(save),config=save.definition.roleplay_config??defaultRoleplayConfig();
  assert(!state.arcs.some(item=>item.id===arc.id),'故事线 ID 重复');
  const active=state.arcs.filter(item=>['ACTIVE','CONVERGING','CLIMAX'].includes(item.status)).length;
  const alreadyEnded=['RESOLVED','FAILED','ABANDONED','AFTERMATH','CLOSED'].includes(arc.status);
  const status=alreadyEnded?arc.status:forceActive||active<config.major_arc_soft_cap?'ACTIVE' as const:'EMERGING' as const;
  const next={...arc,status};state.arcs.push(next);save.narrative_state=state;return next;
}

const transitions: Record<NarrativeArc['status'], (NarrativeArc['status'])[]> = {SEED:['EMERGING','ABANDONED'],EMERGING:['ACTIVE','DORMANT','ABANDONED','FAILED'],ACTIVE:['DORMANT','CONVERGING','FAILED','ABANDONED'],DORMANT:['ACTIVE','ABANDONED','FAILED'],CONVERGING:['CLIMAX','DORMANT','FAILED'],CLIMAX:['RESOLVED','FAILED','AFTERMATH'],RESOLVED:['AFTERMATH','CLOSED'],FAILED:['AFTERMATH','CLOSED'],ABANDONED:['AFTERMATH','CLOSED'],AFTERMATH:['CLOSED'],CLOSED:[]};
export function transitionArc(save:SavePackage,arcId:string,status:NarrativeArc['status']){
  const state=ensureNarrativeState(save),arc=state.arcs.find(item=>item.id===arcId);assert(arc,'找不到主要故事线');assert(transitions[arc.status].includes(status),`不允许的故事线状态变化: ${arc.status} → ${status}`);arc.status=status;arc.last_meaningful_revision=save.state_revision;return arc;
}
export function invalidateDirectorPlan(save:SavePackage,reason:string){
  const state=ensureNarrativeState(save),previous=state.recent_director_decisions.at(-1);if(!previous)return null;
  const decision:DirectorDecision={revision:save.state_revision,trigger:'KEY_NPC_ACTION',directives:[{kind:'REPLAN',arc_ref:null,reason}],invalidated_decision_revisions:[previous.revision]};state.recent_director_decisions.push(decision);state.recent_director_decisions=state.recent_director_decisions.slice(-20);return decision;
}
export function completeSaga(save:SavePackage,input:{title?:string;outcome:string;failures?:string[];permanent_world_change_refs?:string[];continuation_hooks?:string[]}){
  const state=ensureNarrativeState(save),saga=state.current_saga;assert(saga,'当前没有可完成的篇章');
  const arcs=state.arcs.filter(a=>saga.arc_refs.includes(a.id));assert(arcs.every(a=>['RESOLVED','FAILED','ABANDONED','AFTERMATH','CLOSED'].includes(a.status)),'仍有活跃主要故事线，不能完成篇章');
  const knownEvents=new Set([...(save.action_facts??[]).map(item=>item.request_id),...(save.turn_history??[]).map(item=>item.turn_id)]);
  assert(saga.canonical_event_refs.every(ref=>knownEvents.has(ref))&&arcs.every(arc=>arc.canonical_event_refs.every(ref=>knownEvents.has(ref))),'篇章只能引用真实历史事件');
  assert((input.permanent_world_change_refs??[]).every(ref=>knownEvents.has(ref)),'永久世界变化必须引用真实历史事件');
  const record={id:saga.id,title:input.title??saga.title,start_time:saga.start_time,end_time:structuredClone(save.runtime.time),major_participant_refs:[...new Set(arcs.flatMap(a=>a.participant_refs))],major_arc_refs:arcs.map(a=>a.id),outcome:input.outcome,failures:input.failures??arcs.filter(a=>a.status==='FAILED').map(a=>a.title),permanent_world_change_refs:input.permanent_world_change_refs??[],unresolved_arc_refs:arcs.filter(a=>!['RESOLVED','CLOSED'].includes(a.status)).map(a=>a.id),continuation_hooks:input.continuation_hooks??[]};
  state.saga_history.push(record);state.current_saga=null;state.open_loops=state.open_loops.map(loop=>loop.status==='OPEN'?{...loop,status:'UNKNOWN' as const}:loop);save.narrative_state=state;return record;
}

function assertEvent(save:SavePackage,eventRef:string){assert((save.action_facts??[]).some(item=>item.request_id===eventRef)||(save.turn_history??[]).some(item=>item.turn_id===eventRef),'叙事技法必须引用真实历史事件');}
export function recordSetup(save:SavePackage,input:{id:string;label:string;source_event_ref:string;arc_ref?:string|null;truth_ref?:string|null}){assertEvent(save,input.source_event_ref);const state=ensureNarrativeState(save);assert(!state.unpaid_setups.some(item=>item.id===input.id),'伏笔 ID 重复');const setup={...input,arc_ref:input.arc_ref??null,truth_ref:input.truth_ref??null,status:'UNPAID' as const,payoff_event_ref:null};state.unpaid_setups.push(setup);return setup;}
export function payoffSetup(save:SavePackage,id:string,eventRef:string){assertEvent(save,eventRef);const setup=ensureNarrativeState(save).unpaid_setups.find(item=>item.id===id);assert(setup&&setup.status==='UNPAID','找不到未回收的伏笔');setup.status='PAID_OFF';setup.payoff_event_ref=eventRef;return setup;}
export function advanceReveal(save:SavePackage,arcId:string,eventRef:string){assertEvent(save,eventRef);const state=ensureNarrativeState(save),arc=state.arcs.find(item=>item.id===arcId);assert(arc,'找不到主要故事线');assert(arc.truth_refs.length>0,'揭示阶梯必须引用既有真相承诺');arc.reveal_step++;if(!arc.canonical_event_refs.includes(eventRef))arc.canonical_event_refs.push(eventRef);return arc.reveal_step;}
export function recordCharacterArcEvent(save:SavePackage,arcId:string,entityId:string,eventRef:string){assertEvent(save,eventRef);const arc=ensureNarrativeState(save).arcs.find(item=>item.id===arcId);assert(arc,'找不到主要故事线');assert(save.entities.some(entity=>entity.id===entityId),'人物变化必须引用真实人物');if(!arc.participant_refs.includes(entityId))arc.participant_refs.push(entityId);if(!arc.canonical_event_refs.includes(eventRef))arc.canonical_event_refs.push(eventRef);return arc;}
export function mergeArcs(save:SavePackage,targetId:string,sourceIds:string[]){const state=ensureNarrativeState(save),target=state.arcs.find(item=>item.id===targetId);assert(target,'找不到合并目标故事线');for(const id of sourceIds){const source=state.arcs.find(item=>item.id===id);assert(source&&source.id!==target.id,'找不到可合并的故事线');assert(source.canonical_event_refs.some(ref=>target.canonical_event_refs.includes(ref))||source.truth_refs.some(ref=>target.truth_refs.includes(ref)),'故事线缺少真实因果联系，不能合并');source.status='CLOSED';target.canonical_event_refs=[...new Set([...target.canonical_event_refs,...source.canonical_event_refs])];target.truth_refs=[...new Set([...target.truth_refs,...source.truth_refs])];state.open_loops=state.open_loops.map(loop=>loop.arc_ref===source.id?{...loop,status:'MERGED' as const,arc_ref:target.id}:loop);}return target;}

export function deathOutcomeAllowed(config:ReturnType<typeof defaultRoleplayConfig>,input:{explicit_extreme_risk:boolean;long_term_lethal_progression:boolean;ordinary_unwarned_accident:boolean}){
  if(config.death_policy==='immortal'||config.death_policy==='protected')return false;
  if(config.death_policy==='hardcore')return input.explicit_extreme_risk||input.long_term_lethal_progression||input.ordinary_unwarned_accident;
  return input.explicit_extreme_risk||input.long_term_lethal_progression;
}

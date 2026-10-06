import {assert,type SavePackage} from '../core/schema.js';
import type {ActionContext} from '../core/registry.js';
import {currentMap,revealLocation} from '../core/map.js';
import {observe} from '../observability/index.js';
import {ensureNarrativeState,observeCanonicalTurn,stableNarrativeId} from '../narrative/runtime.js';
import type {BackgroundIncident,BackgroundState,BackgroundTime} from './schema.js';

function absolute(save:SavePackage,time:BackgroundTime){return time.day*save.definition.ruleset.minutes_per_day+time.minute;}
function at(save:SavePackage,minute:number):BackgroundTime{const length=save.definition.ruleset.minutes_per_day;return {day:Math.floor(minute/length),minute:minute%length};}
const definitions=(save:SavePackage)=>save.definition.background_incidents??[];
const policy=(save:SavePackage)=>save.definition.background_event_policy;

/** Old saves have no seeds. Initializing this empty ledger never invents an incident. */
export function ensureBackgroundState(save:SavePackage):BackgroundState{
  save.background_state??={version:1,incidents:definitions(save).map(def=>({
    id:def.id,status:'dormant',stage_index:-1,activated_at:null,ended_at:null,missed:false,
    player_exposed:false,activation_roll:null,delivered_exposure_ids:[],
  })),macro_arcs:(save.definition.world_macro_arcs??[]).map(arc=>({id:arc.id,status:'latent',last_event_ref:null})),
    npc_status:{},event_log:[],exposure_log:[],pending_display_ids:[],
    last_evaluation:null,needs_generation:false,last_terminal_at:null,last_activation_at:null};
  return save.background_state;
}
function updateMacroArc(save:SavePackage,incidentId:string,eventRef:string){
  const state=ensureBackgroundState(save);
  for(const arc of save.definition.world_macro_arcs??[]){
    if(!arc.incident_refs.includes(incidentId))continue;
    const record=state.macro_arcs.find(item=>item.id===arc.id);if(!record)continue;
    const related=state.incidents.filter(item=>arc.incident_refs.includes(item.id));
    record.status=related.length&&related.every(item=>['resolved','expired','cancelled'].includes(item.status))?'resolved':'developing';
    record.last_event_ref=eventRef;
  }
}
function log(save:SavePackage,incident:BackgroundIncident,kind:BackgroundState['event_log'][number]['kind'],atTime:BackgroundTime,
  fromStage:string|null,toStage:string|null,trigger:'time_advance'|'location_enter',actorId:string|null,playerExposed:boolean){
  const state=ensureBackgroundState(save),id=stableNarrativeId('event',`${incident.id}:${kind}:${toStage??fromStage??''}:${atTime.day}:${atTime.minute}`);
  state.event_log.push({id,incident_id:incident.id,from_stage:fromStage,to_stage:toStage,at:atTime,trigger,actor_id:actorId,kind,player_exposed:playerExposed});
  state.event_log=state.event_log.slice(-300);
  observe('info',`background_event.${kind}`,{module:'background_event',revision:save.state_revision,
    metadata:{incident_id:incident.id,from_stage:fromStage,to_stage:toStage,game_time:atTime,trigger,player_exposure:playerExposed}});
  return id;
}
function npc(save:SavePackage,id:string,incident:BackgroundIncident){
  assert(incident.participants.includes(id),'案件动作引用未登记参与者');
  const found=save.entities.find(entity=>entity.id===id);
  assert(found&&found.id!==save.player_state.entity_id&&found.components.character,'案件动作只能作用于已登记 NPC');
  return found;
}
function applyEffects(save:SavePackage,incident:BackgroundIncident,stage:BackgroundIncident['stages'][number]){
  for(const effect of stage.effects){
    if(effect.kind==='set_flag')save.gm_state.flags[effect.flag]=true;
    else if(effect.kind==='clear_flag')delete save.gm_state.flags[effect.flag];
    else if(effect.kind==='reveal_location')revealLocation(save,effect.location_id);
    else if(effect.kind==='move_npc'){
      const entity=npc(save,effect.npc_id,incident);
      assert(currentMap(save).locations.some(location=>location.id===effect.location_id),'案件移动引用未知地点');
      entity.components.location={location_id:effect.location_id};
    }else{
      npc(save,effect.npc_id,incident);
      const state=ensureBackgroundState(save),current=state.npc_status[effect.npc_id]??{unavailable:false,markers:[]};
      if(effect.kind==='npc_unavailable')current.unavailable=effect.value;
      else if(effect.kind==='add_marker')current.markers=[...new Set([...current.markers,effect.marker])];
      else current.markers=current.markers.filter(marker=>marker!==effect.marker);
      state.npc_status[effect.npc_id]=current;
    }
  }
}
function terminal(save:SavePackage,incident:BackgroundIncident,record:BackgroundState['incidents'][number],
  status:'resolved'|'expired',time:BackgroundTime,trigger:'time_advance'|'location_enter'){
  const state=ensureBackgroundState(save);
  record.status=status;record.ended_at=time;record.missed=!record.player_exposed;state.last_terminal_at=time;
  const eventRef=log(save,incident,status,time,incident.stages[record.stage_index]?.id??null,null,trigger,null,record.player_exposed);
  updateMacroArc(save,incident.id,eventRef);
  // A story index may be closed only if the player has already seen it.
  if(record.player_exposed&&save.narrative_state){
    const arc=save.narrative_state.arcs.find(item=>item.canonical_event_refs.some(ref=>state.event_log.some(event=>event.id===ref&&event.incident_id===incident.id)));
    if(arc&&['ACTIVE','EMERGING','CONVERGING'].includes(arc.status))arc.status=status==='resolved'?'RESOLVED':'FAILED';
    for(const loop of save.narrative_state.open_loops)if(loop.arc_ref===arc?.id&&loop.status==='OPEN')loop.status=status==='resolved'?'RESOLVED':'UNKNOWN';
  }
}
function eligibleExposure(save:SavePackage,incident:BackgroundIncident,exposure:BackgroundIncident['stages'][number]['exposures'][number]){
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const here=String(player?.components.location?.location_id??'');
  const location=exposure.location_id??incident.locations[0]??null;
  if(!location||here!==location)return false;
  if(['related_npc','direct_contact'].includes(exposure.channel)){
    const contact=exposure.npc_id?save.entities.find(entity=>entity.id===exposure.npc_id):null;
    if(!contact||String(contact.components.location?.location_id??'')!==here||ensureBackgroundState(save).npc_status[contact.id]?.unavailable)return false;
    const relationships=player?.components.relationships as {entries?:Record<string,unknown>}|undefined;
    if(exposure.channel==='related_npc'&&!Object.hasOwn(relationships?.entries??{},contact.id))return false;
  }
  return true;
}
function expose(c:ActionContext,trigger:'time_advance'|'location_enter'){
  const save=c.save,state=ensureBackgroundState(save),now=structuredClone(save.runtime.time);
  for(const incident of definitions(save)){
    const record=state.incidents.find(item=>item.id===incident.id);
    if(!record||record.stage_index<0)continue;
    for(let i=0;i<=record.stage_index;i++)for(const exposure of incident.stages[i].exposures){
      const key=stableNarrativeId('exposure',`${incident.id}:${exposure.id}`);
      if(record.delivered_exposure_ids.includes(key)||!eligibleExposure(save,incident,exposure))continue;
      record.delivered_exposure_ids.push(key);record.player_exposed=true;
      state.exposure_log.push({id:key,incident_id:incident.id,text:exposure.text,channel:exposure.channel,at:now});
      state.exposure_log=state.exposure_log.slice(-100);state.pending_display_ids.push(key);
      c.facts.push(exposure.text);
      const eventRef=log(save,incident,'exposed',now,incident.stages[i].id,incident.stages[i].id,trigger,exposure.npc_id,true);
      const arc=observeCanonicalTurn(save,eventRef,[`发现：${exposure.text}`]);
      if(record.ended_at&&absolute(save,record.ended_at)===absolute(save,now))record.missed=false;
      if(arc&&['resolved','expired'].includes(record.status))arc.status=record.status==='resolved'?'RESOLVED':'FAILED';
      if(exposure.open_loop_label){
        const narrative=ensureNarrativeState(save),loopId=stableNarrativeId('loop',key);
        if(!narrative.open_loops.some(loop=>loop.id===loopId))narrative.open_loops.push({id:loopId,label:exposure.open_loop_label,importance:'major',status:'OPEN',source_event_ref:eventRef,truth_ref:null,arc_ref:arc?.id??null});
      }
      if(exposure.interrupt&&save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.routine?.active)
        c.emit({type:'on_interrupt',event_id:incident.id,reason:exposure.text});
    }
  }
}
/** Called inside the existing uncommitted action candidate, after the ordinary time hooks. */
export function evaluateBackgroundTime(c:ActionContext,from:BackgroundTime,to:BackgroundTime){
  const save=c.save,config=policy(save);if(!config?.enabled||!definitions(save).length)return;
  const state=ensureBackgroundState(save),now=absolute(save,to);
  for(const incident of definitions(save)){
    const record=state.incidents.find(item=>item.id===incident.id)!;
    if(record.status==='dormant'){
      const earliest=absolute(save,incident.earliest_activation),latest=incident.latest_activation?absolute(save,incident.latest_activation):Infinity;
      const active=state.incidents.filter(item=>item.status==='active').length;
      const gap=state.last_activation_at?now-absolute(save,state.last_activation_at):Infinity;
      if(now>=earliest&&now<=latest&&active<config.target_active_incidents&&gap>=config.minimum_gap_minutes&&
        incident.activation_flags.every(flag=>save.gm_state.flags[flag]===true)){
        if(!record.activation_roll){const sample=c.rng();assert(sample>=0&&sample<1,'案件随机样本无效');record.activation_roll={sample,probability:incident.activation_chance,passed:sample<incident.activation_chance};}
        if(record.activation_roll.passed){
          record.status='active';record.activated_at=at(save,Math.max(earliest,absolute(save,from)));
          state.last_activation_at=record.activated_at;
          const ref=log(save,incident,'activated',record.activated_at,null,incident.stages[0].id,'time_advance',null,false);
          updateMacroArc(save,incident.id,ref);
        }else record.status='cancelled';
      }
      if(record.status==='dormant'&&now>latest)terminal(save,incident,record,'expired',to,'time_advance');
    }
    if(record.status!=='active')continue;
    const activated=absolute(save,record.activated_at!);
    for(let i=record.stage_index+1;i<incident.stages.length;i++){
      const stage=incident.stages[i],earliest=activated+stage.earliest_after_minutes;
      if(now<earliest)break;
      const latest=stage.latest_after_minutes===null?Infinity:activated+stage.latest_after_minutes;
      if(now>latest){terminal(save,incident,record,'expired',at(save,latest),'time_advance');break;}
      if(!stage.required_flags.every(flag=>save.gm_state.flags[flag]===true))break;
      const previous=incident.stages[record.stage_index]?.id??null;
      applyEffects(save,incident,stage);record.stage_index=i;
      const stageTime=at(save,Math.max(earliest,absolute(save,from)));
      const ref=log(save,incident,'stage_advanced',stageTime,previous,stage.id,'time_advance',stage.actor_id,false);
      updateMacroArc(save,incident.id,ref);
      if(stage.terminal!=='none'){terminal(save,incident,record,stage.terminal,stageTime,'time_advance');break;}
    }
  }
  state.last_evaluation=to;
  if(config.replenishment&&!state.needs_generation&&state.incidents.filter(item=>item.status==='active').length<config.target_active_incidents&&
    !state.incidents.some(item=>item.status==='dormant')&&(!state.last_terminal_at||now-absolute(save,state.last_terminal_at)>=config.minimum_gap_minutes)){
    state.needs_generation=true;
    observe('info','background_event.replenishment_requested',{module:'background_event',revision:save.state_revision,metadata:{game_time:to,trigger:'time_advance',player_exposure:false}});
  }
  expose(c,'time_advance');
  observe('debug','background_event.evaluated',{module:'background_event',revision:save.state_revision,metadata:{game_time:to,trigger:'time_advance',player_exposure:state.exposure_log.some(item=>absolute(save,item.at)>=absolute(save,from))}});
}
export function evaluateBackgroundLocation(c:ActionContext){if(!policy(c.save)?.enabled)return;expose(c,'location_enter');}
export function drainBackgroundDisplay(save:SavePackage){
  const state=save.background_state;if(!state?.pending_display_ids.length)return [];
  const ids=new Set(state.pending_display_ids),texts=state.exposure_log.filter(item=>ids.has(item.id)).map(item=>item.text);
  state.pending_display_ids=[];return texts;
}

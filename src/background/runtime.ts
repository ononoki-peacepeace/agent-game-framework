import {assert,type SavePackage} from '../core/schema.js';
import type {ActionContext} from '../core/registry.js';
import {currentMap,revealLocation,routePath,localHierarchyTransition} from '../core/map.js';
import {commitProposedLocation,setLocationStatus} from '../core/location-lifecycle.js';
import {observe} from '../observability/index.js';
import {authoredCharacter} from '../characters/authoring.js';
import {ensureNarrativeState,observeCanonicalTurn,stableNarrativeId} from '../narrative/runtime.js';
import type {BackgroundIncident,BackgroundState,BackgroundTime} from './schema.js';
import {createHash} from 'node:crypto';
import {executeAction} from '../core/runtime.js';
import {WorldBlockedError} from '../agent/outcome.js';

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
    const progressed=related.some(item=>item.stage_index>=0);
    record.status=!progressed?'latent':related.every(item=>['resolved','expired','cancelled'].includes(item.status))?'resolved':'developing';
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
function applyEffects(save:SavePackage,incident:BackgroundIncident,stage:BackgroundIncident['stages'][number],stageTime:BackgroundTime,
  budget:number,rng:ActionContext['rng']){
  const spent=new Map<string,number>();
  for(const [index,effect] of stage.effects.entries()){
    if(effect.kind==='set_flag')save.gm_state.flags[effect.flag]=true;
    else if(effect.kind==='clear_flag')delete save.gm_state.flags[effect.flag];
    else if(effect.kind==='reveal_location')revealLocation(save,effect.location_id);
    else if(effect.kind==='create_location'){
      assert(incident.causal_basis,'后台地点需要已登记事件的因果依据');
      commitProposedLocation(save,effect,'world_event',`${incident.id}:${stage.id}`,effect.location_id,stageTime);
    }else if(effect.kind==='set_location_status'){
      assert(incident.causal_basis,'地点状态改变需要事件因果依据');
      setLocationStatus(save,effect.location_id,effect.status,`${incident.id}:${stage.id}`,stageTime);
    }
    else if(effect.kind==='spawn_character'){
      assert(save.definition.enabled_modules.includes('characters'),'当前世界没有人物模块');
      assert(incident.causal_basis&&effect.entrance_reason.trim()&&incident.participants.includes(effect.entity_id),
        '新增人物必须由已登记世界事件的因果需求引入');
      const state=ensureBackgroundState(save),gap=policy(save)?.minimum_gap_minutes??0;
      assert(!state.last_spawn_at||absolute(save,stageTime)-absolute(save,state.last_spawn_at)>=gap,'新增人物冷却期未结束');
      assert(save.entities.filter(entity=>entity.components.world_resident?.lifecycle==='active').length<60&&save.entities.length<1000,
        '当前世界人口预算已满');
      assert(save.entities.filter(entity=>entity.components.character&&entity.components.location?.location_id===effect.location_id).length<12,
        '这个地点的人物容量已满');
      assert(!save.entities.some(entity=>entity.id===effect.entity_id),'新增人物 ID 已存在');
      const components:SavePackage['entities'][number]['components']={
        identity:{name:effect.name,description:effect.public_description,avatar_id:null,gender:effect.gender,
          age:effect.age,age_as_of_day:effect.age===null?null:stageTime.day,birth:null,previous_names:[]},
        character:authoredCharacter(effect.role,effect.persona??{motivations:effect.motivation?[effect.motivation]:[]}),location:{location_id:effect.location_id},discovery:{known_to_player:false},
        world_resident:{origin_incident_id:incident.id,entrance_reason:effect.entrance_reason,
          created_at:incident.created_at,entered_world_at:stageTime,importance:effect.importance,
          lifecycle:'active',home_location_id:effect.home_location_id,motivation:effect.motivation},
      };
      if(save.definition.enabled_modules.includes('relationships'))components.relationships={entries:{}};
      save.entities.push({id:effect.entity_id,type:'character',components});
      state.last_spawn_at=stageTime;
      observe('info','background.character_created',{module:'background_event',revision:save.state_revision,
        metadata:{incident_id:incident.id,stage_id:stage.id,entity_id:effect.entity_id,reason:effect.entrance_reason,
          population_need:effect.population_need,game_time:stageTime,player_exposed:false}});
    }else if(effect.kind==='depart_character'){
      const entity=npc(save,effect.npc_id,incident);
      assert(entity.components.world_resident,'只能通过生命周期状态使后台新增人物离开');
      entity.components.world_resident.lifecycle='departed';delete entity.components.location;
    }else if(effect.kind==='relationship_seed'){
      assert(save.definition.enabled_modules.includes('relationships'),'当前世界没有关系模块');
      const from=npc(save,effect.from_id,incident),to=npc(save,effect.to_id,incident);
      const entries=(from.components.relationships as {entries:Record<string,Record<string,number>>}|undefined)?.entries;
      assert(entries,'关系来源没有关系组件');entries[to.id]??={};entries[to.id][effect.dimension]=effect.value;
    }else if(effect.kind==='move_npc'){
      npc(save,effect.npc_id,incident);
      assert(currentMap(save).locations.some(location=>location.id===effect.location_id),'案件移动引用未知地点');
      const map=currentMap(save),origin=String(save.entities.find(entity=>entity.id===effect.npc_id)?.components.location?.location_id??'');
      const closed=new Set(map.locations.filter(place=>place.lifecycle?.status==='closed').map(place=>place.id));
      const path=routePath(map.routes.filter(route=>!closed.has(route.from)&&!closed.has(route.to)&&
        route.conditions.every(condition=>save.gm_state.flags[condition.flag]===condition.equals)),origin,effect.location_id);
      const expectedCost=path?.length?path.reduce((sum,edge)=>sum+edge.travel_minutes,0):
        localHierarchyTransition(save,origin,effect.location_id)?1:0;
      if((spent.get(effect.npc_id)??0)+expectedCost>budget)
        throw new WorldBlockedError('prerequisite','后台移动尚未积累足够的世界时间');
      const hex=createHash('sha256').update(`incident:${incident.id}:${stage.id}:${index}`).digest('hex');
      const requestId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
      const result=executeAction(save,{type:'MOVE',target_id:effect.location_id,parameters:{companions:'none'}},
        requestId,'ai',rng,undefined,true,effect.npc_id,true);
      const cost=(spent.get(effect.npc_id)??0)+result.action.time_cost;
      if(cost>budget)throw new WorldBlockedError('prerequisite','后台移动尚未积累足够的世界时间');
      spent.set(effect.npc_id,cost);
      const state=save.background_state;Object.assign(save,result.save);save.background_state=state;
      const receipt=save.resolution_receipts?.find(item=>item.request_id===requestId);
      assert(receipt,'后台移动缺少 Core 凭据');receipt.commit_status='committed';
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
function discoverCoLocated(save:SavePackage){
  const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id;
  if(!here)return;
  for(const entity of save.entities)if(entity.id!==save.player_state.entity_id&&entity.components.discovery?.known_to_player===false&&
    entity.components.location?.location_id===here){
    entity.components.discovery.known_to_player=true;
    observe('info','background.character_discovered',{module:'background_event',revision:save.state_revision,
      metadata:{entity_id:entity.id,game_time:save.runtime.time,channel:'same_location'}});
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
function cancel(save:SavePackage,incident:BackgroundIncident,record:BackgroundState['incidents'][number],
  time:BackgroundTime){
  const state=ensureBackgroundState(save);
  record.status='cancelled';record.ended_at=time;record.missed=true;state.last_terminal_at=time;
  const ref=log(save,incident,'cancelled',time,null,null,'time_advance',null,false);
  updateMacroArc(save,incident.id,ref);
}
function sameParentArea(save:SavePackage,first:string,second:string){
  const locations=currentMap(save).locations;
  const a=locations.find(item=>item.id===first),b=locations.find(item=>item.id===second);
  return Boolean(a?.parent_id&&a.parent_id===b?.parent_id);
}
function eligibleExposure(save:SavePackage,incident:BackgroundIncident,exposure:BackgroundIncident['stages'][number]['exposures'][number]){
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const here=String(player?.components.location?.location_id??'');
  const location=exposure.location_id??incident.locations[0]??null;
  if(!location)return false;
  // A public notice is available in its registered facility by default, including older saves
  // without delivery_scope. Authors can explicitly anchor a notice to one place. Direct sight
  // and private contacts never gain this area reach.
  if(exposure.channel==='public_notice')return here===location||
    exposure.delivery_scope!=='anchor'&&sameParentArea(save,here,location);
  // A rumor needs an actual carrier at the player's location. Its origin is not a magic relay.
  if(exposure.channel==='rumor'){
    if(exposure.npc_id){const carrier=save.entities.find(item=>item.id===exposure.npc_id);
      return Boolean(carrier?.components.location?.location_id===here&&
        !ensureBackgroundState(save).npc_status[carrier.id]?.unavailable);}
    return here===location;
  }
  if(here!==location)return false;
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
  const save=c.save,config=policy(save);if(!config?.enabled)return;
  const state=ensureBackgroundState(save),now=absolute(save,to);
  if(!state.last_terminal_at&&state.incidents.length&&state.incidents.every(item=>
    ['resolved','expired','cancelled'].includes(item.status))){
    // Older saves recorded a cancelled roll without a terminal timestamp. The last
    // evaluation is a conservative cooldown anchor; do not revive the lost event.
    state.last_terminal_at=state.last_evaluation??from;
  }
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
        }else cancel(save,incident,record,to);
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
      const stageTime=stage.effects.some(effect=>effect.kind==='move_npc')?to:at(save,Math.max(earliest,absolute(save,from)));
      // A blocked NPC move must not partially apply the stage or fail a valid
      // player action. Retry that stage under its existing time/flag conditions.
      const candidate=structuredClone(save);
      try{applyEffects(candidate,incident,stage,stageTime,now-earliest,c.rng);}
      catch(error){
        if(!(error instanceof WorldBlockedError))throw error;
        observe('debug','background_event.stage_blocked',{module:'background_event',revision:save.state_revision,
          metadata:{incident_id:incident.id,stage_id:stage.id,reason:error.worldCode}});break;
      }
      const effectsState=candidate.background_state!;Object.assign(save,candidate);save.background_state=state;
      state.npc_status=effectsState.npc_status;state.last_spawn_at=effectsState.last_spawn_at;
      record.stage_index=i;
      const ref=log(save,incident,'stage_advanced',stageTime,previous,stage.id,'time_advance',stage.actor_id,false);
      updateMacroArc(save,incident.id,ref);
      if(stage.terminal!=='none'){terminal(save,incident,record,stage.terminal,stageTime,'time_advance');break;}
    }
  }
  // Empty pools used to return before requesting their first runtime candidate.
  // Reuse the persistent generation clock; quiet/rejected proposals also cool down.
  if(!state.last_terminal_at&&!state.last_generation_at)state.last_generation_at=structuredClone(from);
  state.last_evaluation=to;
  const generationAnchor=[state.last_terminal_at,state.last_generation_at].filter((item):item is BackgroundTime=>Boolean(item))
    .reduce((latest,item)=>Math.max(latest,absolute(save,item)),0);
  const dormant=state.incidents.filter(item=>item.status==='dormant');
  const imminent=dormant.some(item=>{const def=definitions(save).find(def=>def.id===item.id);
    return def&&absolute(save,def.earliest_activation)<=now+Math.max(1,config.minimum_gap_minutes);});
  if(config.replenishment&&config.max_dormant_incidents>0&&!state.needs_generation&&state.incidents.length<100&&
    state.incidents.filter(item=>item.status==='active').length<config.target_active_incidents&&
    (!dormant.length||dormant.length<config.max_dormant_incidents&&!imminent)&&
    now-generationAnchor>=Math.max(1,config.minimum_gap_minutes)){
    state.needs_generation=true;
    observe('info','background_event.replenishment_requested',{module:'background_event',revision:save.state_revision,metadata:{game_time:to,trigger:'time_advance',player_exposure:false}});
  }
  expose(c,'time_advance');
  discoverCoLocated(save);
  observe('debug','background_event.evaluated',{module:'background_event',revision:save.state_revision,metadata:{game_time:to,trigger:'time_advance',
    active:state.incidents.filter(item=>item.status==='active').length,dormant:state.incidents.filter(item=>item.status==='dormant').length,
    generation_pending:state.needs_generation,capacity_reached:state.incidents.length>=100,
    player_exposure:state.exposure_log.some(item=>absolute(save,item.at)>=absolute(save,from))}});
}
export function evaluateBackgroundLocation(c:ActionContext){discoverCoLocated(c.save);if(!policy(c.save)?.enabled)return;expose(c,'location_enter');}
export function drainBackgroundDisplay(save:SavePackage){
  const state=save.background_state;if(!state?.pending_display_ids.length)return [];
  const ids=new Set(state.pending_display_ids),texts=state.exposure_log.filter(item=>ids.has(item.id)).map(item=>item.text);
  state.pending_display_ids=[];return texts;
}

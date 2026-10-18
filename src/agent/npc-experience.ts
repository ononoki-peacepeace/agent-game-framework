import type {SavePackage} from '../core/schema.js';
import {emptyNpcAgentState, type NpcAgentState} from './npc-state.js';

type MoveRoute={origin_id:string;destination_id:string;location_ids:string[]};

const locationName=(save:SavePackage,id:string)=>
  [...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations].find(item=>item.id===id)?.name??id;

/** Record only movement actually settled in this candidate, never an invitation or planned route. */
export function recordNpcTravelExperience(save:SavePackage,actionId:string,actorId:string,
  companionIds:readonly string[],route:MoveRoute){
  const movers=[actorId,...companionIds];
  const eventRef=`move:${actionId}`;
  const routeNames=route.location_ids.map(id=>locationName(save,id));
  for(const npcId of movers){
    if(npcId===save.player_state.entity_id)continue;
    const entity=save.entities.find(item=>item.id===npcId&&item.components.character);
    if(entity?.components.location?.location_id!==route.destination_id)continue;
    const state=save.npc_agent_state?.[npcId]??emptyNpcAgentState();
    if(state.memories.some(item=>item.event_ref===eventRef))continue;
    const memory:NpcAgentState['memories'][number]={event_ref:eventRef,kind:'participated',
      summary:`自己从${routeNames[0]}${routeNames.length>2?`经${routeNames.slice(1,-1).join('、')}`:''}到达${routeNames.at(-1)}。`,
      participant_ids:movers.slice(0,12),at:structuredClone(save.runtime.time),importance:3};
    state.memories.push(memory);
    while(state.memories.length>60){
      const least=Math.min(...state.memories.map(item=>item.importance));
      state.memories.splice(state.memories.findIndex(item=>item.importance===least),1);
    }
    save.npc_agent_state??={};save.npc_agent_state[npcId]=state;
  }
}

/** A settled Core action is a personal experience even when no separate scene dialogue exists. */
export function recordNpcActionExperience(save:SavePackage,actionId:string,npcId:string,
  actionType:string,facts:readonly string[]){
  if(npcId===save.player_state.entity_id||actionType==='MOVE')return;
  if(!save.entities.some(item=>item.id===npcId&&item.components.character))return;
  const state=save.npc_agent_state?.[npcId]??emptyNpcAgentState(),eventRef=`action:${actionId}`;
  if(state.memories.some(item=>item.event_ref===eventRef))return;
  state.memories.push({event_ref:eventRef,kind:'participated',
    summary:(facts.join(' ').trim()||`自己执行了${actionType}`).slice(0,500),
    participant_ids:[npcId],at:structuredClone(save.runtime.time),importance:2});
  while(state.memories.length>60){
    const least=Math.min(...state.memories.map(item=>item.importance));
    state.memories.splice(state.memories.findIndex(item=>item.importance===least),1);
  }
  save.npc_agent_state??={};save.npc_agent_state[npcId]=state;
}

/** A bounded personal projection; older saves can use authoritative Undo snapshots without rewriting them. */
export function npcExperienceContext(save:SavePackage,npcId:string,query:string,max=10){
  const mind=save.npc_agent_state?.[npcId];
  const names=new Map(save.entities.map(item=>[item.id,String(item.components.identity?.name??'')]));
  const relevant=(memory:NpcAgentState['memories'][number])=>
    memory.summary.length>0&&query.length>0&&(
      [...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations]
        .some(location=>query.includes(location.name)&&memory.summary.includes(location.name))||
      memory.participant_ids.some(id=>Boolean(names.get(id)&&query.includes(names.get(id)!))));
  const all=mind?.memories??[];
  const chosen=[...all.map((memory,index)=>({memory,index}))]
    .sort((a,b)=>Number(relevant(b.memory))-Number(relevant(a.memory))||
      b.memory.importance-a.memory.importance||b.index-a.index)
    .slice(0,max).sort((a,b)=>a.index-b.index).map(item=>item.memory);
  // Turn history is a set of authoritative before-images. This supports legacy saves whose
  // MOVE settled a companion but did not write a personal memory at that time.
  const mentioned=[...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations]
    .filter(location=>location.name&&query.includes(location.name)).slice(0,3);
  const historicalPresence=mentioned.flatMap(location=>{
    const entry=(save.turn_history??[]).find(turn=>{
      const entities=turn.before.entities as SavePackage['entities']|undefined;
      return entities?.find(entity=>entity.id===npcId)?.components.location?.location_id===location.id;
    });
    return entry?[{location_id:location.id,location_name:location.name,at:entry.time,
      evidence_ref:`turn:${entry.turn_id}`}]:[];
  });
  const terms=[...(save.entities.map(item=>String(item.components.identity?.name??''))),
    ...(save.definition.map?.locations??[]).map(item=>item.name)]
    .flatMap(name=>name.split(/\s+/).filter(part=>part.length>=2&&query.includes(part)));
  const witnessedRefs=new Set(all.filter(item=>item.kind==='heard').map(item=>item.event_ref));
  const historicalScenes=new Map<string,NonNullable<SavePackage['narrative_history']>[number]>();
  for(const turn of save.turn_history??[]){
    const entries=turn.before.narrative_history as SavePackage['narrative_history']|undefined;
    for(const entry of entries??[])if(witnessedRefs.has(`scene:${entry.request_id}`))historicalScenes.set(entry.request_id,entry);
  }
  for(const entry of save.narrative_history??[])
    if(witnessedRefs.has(`scene:${entry.request_id}`))historicalScenes.set(entry.request_id,entry);
  const witnessedExchanges=[...historicalScenes.values()].filter(entry=>terms.some(term=>
    entry.speech_events?.some(speech=>speech.utterance.includes(term)))).slice(-3)
    .map(entry=>({event_ref:`scene:${entry.request_id}`,location_id:entry.location_id??null,
      speech_events:(entry.speech_events??[]).filter(speech=>terms.some(term=>speech.utterance.includes(term)))
        .slice(0,3).map(speech=>({speaker_id:speech.speaker_id,utterance:speech.utterance.slice(0,240)}))}));
  return {memories:chosen,historical_presence:historicalPresence,witnessed_exchanges:witnessedExchanges};
}

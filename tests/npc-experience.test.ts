import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {executeAction} from '../src/core/runtime.js';
import {validateSave,publicView} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {npcExperienceContext} from '../src/agent/npc-experience.js';
import {sceneEnsembleContext} from '../src/agent/scene-interaction.js';
import {recordSceneObservation,buildNpcAgentContext} from '../src/agent/npc-agent.js';

async function world(){
  const f=await sparseSetup(),save=await f.service.current();
  const player=save.entities.find(item=>item.id===save.player_state.entity_id)!;
  const origin=String(player.components.location!.location_id);
  save.definition.map!.locations.push({id:'library',name:'图书室',description:'一间图书室',tags:[]});
  save.definition.map!.routes.push({from:origin,to:'library',travel_minutes:4,conditions:[]});
  save.map_state.known_location_ids.push('library');
  const companion=save.entities.find(item=>item.id==='npc_lin')!;
  companion.components.location={location_id:origin};
  const resident=structuredClone(companion);resident.id='npc_resident';resident.components.identity.name='管理员';
  resident.components.location={location_id:'library'};save.entities.push(resident);
  const absent=structuredClone(companion);absent.id='npc_absent';absent.components.identity.name='远方人物';
  absent.components.location={location_id:origin};save.entities.push(absent);
  save.npc_agent_state={npc_lin:emptyNpcAgentState(),npc_resident:emptyNpcAgentState(),npc_absent:emptyNpcAgentState()};
  save.npc_agent_state.npc_lin.travel_intent={status:'willing',origin_location_id:origin,
    source_request_id:randomUUID(),recorded_revision:save.state_revision};
  return {f,save,origin};
}

describe('NPC personal authoritative experience',()=>{
  it('retains an answer preceding a new question after the short transcript window expires',async()=>{
    const {save}=await world(),requestId=randomUUID();
    const state=save.npc_agent_state!.npc_lin,before=structuredClone(state);
    const relationships=structuredClone(save.entities.find(entity=>entity.id==='npc_lin')!.components.relationships);
    recordSceneObservation(save,requestId,[
      {speaker_id:save.player_state.entity_id,utterance:'拍照前我会先问你，不经允许不会公开。'},
      {speaker_id:save.player_state.entity_id,utterance:'你想去散步吗？'},
      {speaker_id:'npc_lin',utterance:'今天不想出去。'},
      {speaker_id:'npc_lin',utterance:'我想安静待一会儿。'},
    ],['npc_lin']);
    const memory=state.memories.at(-1)!;
    expect(memory.summary).toContain('拍照前我会先问你，不经允许不会公开。');
    expect(memory.summary).toContain('你想去散步吗？');
    expect(memory.summary).toContain('今天不想出去。');
    expect(memory.summary).toContain('我想安静待一会儿。');
    expect(memory.summary.indexOf('拍照前')).toBeLessThan(memory.summary.indexOf('散步'));
    expect(memory.summary.length).toBeLessThanOrEqual(500);
    // Hearing a claim forms sourced hearsay, never a confirmed observation of its content.
    expect(state.knowledge.every(item=>item.source_type==='told_by'&&item.confidence<1)).toBe(true);
    expect(state.knowledge.map(item=>item.source_ref)).toEqual([save.player_state.entity_id]);
    expect(state.knowledge.at(-1)!.proposition).toContain('拍照前我会先问你');
    expect(state.knowledge.at(-1)!.proposition).not.toContain('你想去散步吗？');
    expect(state.knowledge.length).toBe(before.knowledge.length+1);
    expect(state.beliefs).toEqual(before.beliefs);
    expect(save.entities.find(entity=>entity.id==='npc_lin')!.components.relationships).toEqual(relationships);
    expect(save.npc_agent_state!.npc_absent.memories).toEqual([]);
    expect(save.npc_agent_state!.npc_absent.knowledge).toEqual([]);
    save.narrative_history=[];save.turn_history=[];
    const reloaded=validateSave(structuredClone(save));
    expect(JSON.stringify(buildNpcAgentContext(reloaded,'npc_lin',{kind:'direct_scene',description:'拍照前的约定'}).memories))
      .toContain('拍照前我会先问你');
    recordSceneObservation(save,requestId,[{speaker_id:save.player_state.entity_id,utterance:'不能覆盖的重放'}],['npc_lin']);
    expect(state.memories.filter(entry=>entry.event_ref==='scene:'+requestId)).toHaveLength(1);
    expect(state.memories.at(-1)).toEqual(memory);
  });
  it('shares bounded space across long utterances instead of deleting earlier answers or final boundaries',async()=>{
    const {save}=await world(),events=Array.from({length:12},(_,index)=>({
      speaker_id:index%2?'npc_lin':save.player_state.entity_id,
      utterance:'第'+index+'句开头'+('较长的发言'.repeat(100))+'第'+index+'句结束',
    }));
    recordSceneObservation(save,randomUUID(),events,['npc_lin']);
    const summary=save.npc_agent_state!.npc_lin.memories.at(-1)!.summary;
    expect(summary.length).toBeLessThanOrEqual(500);
    for(let index=0;index<12;index++){
      expect(summary).toContain('第'+index+'句开头');
      expect(summary).toContain('第'+index+'句结束');
    }
    expect(summary).toContain('…');
    expect(validateSave(save)).toBeDefined();
  });
  it('records only actual movers and retrieves their own travel without granting a resident name',async()=>{
    const {save}=await world(),actionId=randomUUID();
    const moved=executeAction(save,{type:'MOVE',target_id:'library',parameters:{}},actionId,'player',()=>0.5).save;
    const receipt=moved.resolution_receipts!.at(-1)!;
    expect(receipt.result_entities?.moved_companions).toEqual(['npc_lin']);
    expect(receipt.movement_route?.destination_id).toBe('library');
    const memory=moved.npc_agent_state?.npc_lin.memories.find(item=>item.event_ref===`move:${actionId}`);
    expect(memory).toMatchObject({kind:'participated',importance:3,participant_ids:[save.player_state.entity_id,'npc_lin']});
    expect(memory?.summary).toContain('图书室');
    expect(memory?.summary).not.toContain('管理员');
    expect(moved.npc_agent_state?.npc_absent.memories).toEqual([]);
    expect(moved.npc_agent_state?.npc_resident.memories).toEqual([]);
    const queried=npcExperienceContext(moved,'npc_lin','我们去过图书室吗');
    expect(queried.memories.some(item=>item.event_ref===`move:${actionId}`)).toBe(true);
    expect(JSON.stringify(sceneEnsembleContext(moved,publicView(moved).entities.filter(item=>item.id==='npc_lin'),'图书室')))
      .toContain(`move:${actionId}`);
    expect(validateSave(moved).npc_agent_state?.npc_lin.memories).toContainEqual(memory);
  });

  it('keeps relevant old travel after many later exchanges and supports legacy authority snapshots',async()=>{
    const {save}=await world();
    const moved=executeAction(save,{type:'MOVE',target_id:'library',parameters:{}},randomUUID(),'player',()=>0.5).save;
    const state=moved.npc_agent_state!.npc_lin;
    for(let index=0;index<20;index++)state.memories.push({event_ref:`scene:${index}`,kind:'heard',
      summary:`普通对话 ${index}`,participant_ids:['npc_lin'],at:moved.runtime.time,importance:1});
    expect(npcExperienceContext(moved,'npc_lin','之前去过图书室吗').memories.some(item=>item.kind==='participated')).toBe(true);
    const legacy=structuredClone(moved);legacy.npc_agent_state!.npc_lin.memories=[];
    const sceneId=randomUUID();
    legacy.npc_agent_state!.npc_lin.memories.push({event_ref:`scene:${sceneId}`,kind:'heard',
      summary:'听到当时的交谈',participant_ids:['npc_lin','npc_resident'],at:moved.runtime.time,importance:1});
    legacy.turn_history=[{turn_id:randomUUID(),parent_turn_id:null,before:{entities:structuredClone(moved.entities),
      narrative_history:[{request_id:sceneId,narrative:'',dialogue:null,speaker:null,facts:[],
        location_id:'library',speech_events:[{speaker_id:'npc_resident',utterance:'管理员说书架在左边。',
          provenance:'npc_response',source_intent:null}]}]},
      after_hash:'old',label:'old snapshot',time:structuredClone(moved.runtime.time)}];
    const context=npcExperienceContext(legacy,'npc_lin','我们去过图书室吗');
    expect(context.historical_presence).toMatchObject([{location_id:'library'}]);
    expect(npcExperienceContext(legacy,'npc_lin','管理员说了什么').witnessed_exchanges[0].speech_events[0].speaker_id)
      .toBe('npc_resident');
    expect(npcExperienceContext(legacy,'npc_absent','我们去过图书室吗').historical_presence).toEqual([]);
  });
  it('persists a companion experience with the MOVE and restores it with Undo',async()=>{
    const {f,save}=await world();await f.store.write(validateSave(save));
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你们到了图书室。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
    const requestId=randomUUID();
    await f.service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId,
      action:{type:'MOVE',target_id:'library',parameters:{}}});
    const after=await f.service.current();
    expect(after.npc_agent_state?.npc_lin.memories.some(item=>item.event_ref===`move:${requestId}`)).toBe(true);
    expect(after.resolution_receipts?.find(item=>item.request_id===requestId)?.commit_status).toBe('committed');
    await f.service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
    const undone=await f.service.current();
    expect(undone.npc_agent_state?.npc_lin.memories.some(item=>item.event_ref===`move:${requestId}`)).toBe(false);
    expect(undone.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id).toBe(save.entities.find(item=>item.id==='npc_lin')?.components.location?.location_id);
  });
});

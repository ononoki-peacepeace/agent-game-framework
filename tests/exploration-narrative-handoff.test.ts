import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {interpretSemanticEntry,type SemanticDecision} from '../src/agent/semantic-entry.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {validateSave} from '../src/core/state.js';
import {anchoredStoryBeats} from '../src/client/story-beats.js';

const input='沿设施外侧探索未登记的庭院，保持室外，遇到新的区域就停下。';
const scope={kind:'local_area' as const,reference:'设施外侧的庭院',source_quote:input,
  anchor_id:'facility',excluded_destination_ids:['facility']};
const semantic:SemanticDecision={kind:'world_action',domain:'world',operation_plane:'play',
  original_user_request:input,confidence:0.95,answer:null,answer_basis:null,evidence_ids:[],
  clarification:null,speech_target_id:null,interaction_lane:'open_goal',player_speech_mode:'none',
  goal_spec:{objective:input,play_action:'move',targets:[{kind:'location',reference:'设施',entity_id:'facility'}],
    constraints:['保持室外','遇到新区域停止'],desired_state:[],desired_outputs:[],persistence:'none',
    temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null},
  open_goal_context:{destination:'设施',continuation:'none',search_query:null,travel_after_discovery:true,
    spatial_scope:scope}};
const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],patches:[],context_actions:[]});
const proposal={narrative:'检查当前区域',minutes:5,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'perception',band:'normal' as const,
    visibility:'public' as const,stakes:'普通巡视',stages:[],evidence_ids:[]}};

async function setup(choice:'none'|'known'|'propose'|'discover'){
  const f=await sparseSetup(),save=await f.service.current();
  save.definition.map!.locations.push({id:'facility',name:'设施',description:'一栋建筑的入口。',
    kind:'building',parent_id:'square',known_by_default:true,tags:[]});
  save.definition.map!.routes.push({from:'square',to:'facility',travel_minutes:2,conditions:[]});
  save.map_state.known_location_ids.push('facility');
  if(choice==='discover'){
    save.definition.map!.locations.push({id:'yard',name:'外侧庭院',description:'设施外侧已有的普通庭院。',
      kind:'courtyard',parent_id:'square',known_by_default:false,tags:[]});
    save.definition.map!.routes.push({from:'square',to:'yard',travel_minutes:2,conditions:[]});
  }
  await f.store.write(save);
  const search=vi.spyOn(f.ai,'systemAgent').mockImplementation(async schema=>{
    const keys=Object.keys((schema as any).shape??{});
    if(keys.includes('location_id'))return {decision:choice,location_id:choice==='known'?'facility':choice==='discover'?'yard':null,
      proposal:choice==='propose'?{name:'外侧庭院',category:'courtyard',description:'设施外侧的普通庭院。',
        parent_id:'square',anchor_id:'square',travel_minutes:2,visibility:'public',source_ref:'square',
        creation_reason:'广场旁既有设施保留的一处普通室外庭院，与现有地理相容。'}:null,
      method:choice==='none'?'none':'local_exploration',reason:'检查现有地理。'} as never;
    if(keys.includes('supported'))return {supported:true,reason:'现有地理支持。'} as never;
    throw Error('No additional planner or scene call is authorized');
  });
  vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
  vi.spyOn(f.ai,'narrate').mockImplementation(async(_save,action)=>narration(action.type==='MOVE'?
    '你沿着实际路径来到外侧庭院，在这里停下。':'你巡视了眼前的区域，这次没有发现新的线索。') as never);
  return {...f,save,search};
}
async function submit(f:Awaited<ReturnType<typeof setup>>){
  return handleAgentInput(f.service,{game_id:f.save.game_id,expected_revision:f.save.state_revision,
    request_id:randomUUID(),input},undefined,null,false,semantic);
}

describe('spatial exploration and narrative handoff',()=>{
  it.each(['none','known'] as const)('does not replace a local area with its anchor (%s)',async choice=>{
    const f=await setup(choice),result=await submit(f),after=await f.service.current();
    expect(after.entities.find(e=>e.id===after.player_state.entity_id)?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts?.filter(r=>r.movement_route)).toHaveLength(0);
    expect(after.map_state.dynamic_locations).toHaveLength(0);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed_no_result'});
    expect(result.story).toContain('没有发现');
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(f.search.mock.calls[0][2]).toMatchObject({authorization:{source_quote:input}});
  });
  it.each(['propose','discover'] as const)('uses the existing %s lifecycle, settles MOVE once, reloads and undoes',async choice=>{
    const f=await setup(choice);await submit(f);
    const after=await f.service.current(),reloaded=validateSave(JSON.parse(JSON.stringify(after)));
    const id=choice==='discover'?'yard':after.map_state.dynamic_locations[0]?.id;
    expect(id).toBeTruthy();
    expect(reloaded.map_state.known_location_ids).toContain(id);
    expect(reloaded.entities.find(e=>e.id===reloaded.player_state.entity_id)?.components.location?.location_id).toBe(id);
    const moves=after.resolution_receipts?.filter(r=>r.movement_route)??[];
    expect(moves).toHaveLength(1);
    expect(moves[0].movement_route).toMatchObject({destination_id:id,total_minutes:2});
    expect(after.runtime.time.minute-f.save.runtime.time.minute).toBe(2);
    expect(f.search).toHaveBeenCalledTimes(2);
    await f.service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    const undone=await f.service.current();
    expect(undone.entities.find(e=>e.id===undone.player_state.entity_id)?.components.location?.location_id).toBe('square');
    await f.service.undo({game_id:undone.game_id,expected_revision:undone.state_revision,request_id:randomUUID()});
    const original=await f.service.current();
    expect(original.map_state.dynamic_locations).toHaveLength(0);
    if(choice==='discover')expect(original.map_state.known_location_ids).not.toContain('yard');
  });
  it('retains typed perception and current environment on outer Narrator schema failure',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
    vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('schema','bad schema','结构失败'));
    await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'仔细观察这间房间'},undefined,undefined,undefined,false,undefined,undefined,true);
    const after=await f.service.current();
    expect(after.last_turn?.narrative).toContain('这次检查范围内');
    expect(after.last_turn?.narrative).toContain(before.definition.map!.locations.find(l=>l.id==='square')!.description);
    expect(after.last_turn?.narrative).not.toContain('没有达到预期');
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(5);
    expect(after.state_revision).toBe(before.state_revision+1);
  });
  it('keeps MOVE speech beats and their identities when prepending a committed departure scene',async()=>{
    const f=await sparseSetup(),before=await f.service.current(),preceding=randomUUID();
    before.last_turn={narrative:'“准备好了。”',speaker:null,dialogue:null,choices:[],context_actions:[],
      scene_beats:[{kind:'speech',speaker_id:'npc_lin',utterance:'准备好了。'}]};
    before.narrative_history=[{request_id:preceding,narrative:before.last_turn.narrative,speaker:null,
      dialogue:null,facts:[],location_id:'square'}];
    await f.store.write(before);
    vi.spyOn(f.ai,'narrate').mockResolvedValue({...narration('你来到街角商店。\n“就在这里停下吧。”'),
      scene_beats:[{kind:'narration',text:'你来到街角商店。'},
        {kind:'speech',speaker_id:'npc_qiao',utterance:'就在这里停下吧。'}]} as never);
    await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),preceding_scene_request_id:preceding,action:{type:'MOVE',target_id:'market',parameters:{companions:'none'}}});
    const after=await f.service.current(),beats=anchoredStoryBeats(after.last_turn!,f.service.project(after).entities);
    expect(beats.filter(b=>b.kind==='speech').map(b=>b.speaker_id)).toEqual(['npc_lin','npc_qiao']);
    expect(after.last_turn?.narrative.match(/准备好了/g)).toHaveLength(1);
    expect(after.narrative_history?.at(-1)?.speech_events).toEqual(expect.arrayContaining([
      expect.objectContaining({speaker_id:'npc_qiao',utterance:'就在这里停下吧。'})]));
  });
  it('projects only the current parent environment while retaining located historical dialogue',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.definition.map!.locations.push({id:'child_room',name:'内部房间',description:'只有子房间才有的特殊摆设。',
      parent_id:'square',kind:'room',known_by_default:true,tags:[]});
    save.map_state.known_location_ids.push('child_room');
    save.narrative_history=[{request_id:randomUUID(),narrative:'只有子房间才有的特殊摆设。',facts:[],
      dialogue:null,speaker:null,location_id:'child_room',speech_events:[{speaker_id:'npc_lin',utterance:'刚才说过的话。',
        provenance:'npc_response',source_intent:null}]}];
    save.last_turn={narrative:'只有子房间才有的特殊摆设。',speaker:null,dialogue:null,choices:[],context_actions:[]};
    let prompt='';const ai=new AIRuntime({name:'fixture',generate:async request=>{
      prompt=request.prompt;return {data:narration('你留意着广场上的情形。')};
    }});
    await ai.narrate(save,{id:randomUUID(),actor_id:save.player_state.entity_id,type:'WAIT',source:'player',
      time_cost:1,parameters:{minutes:1}},['等待一分钟']);
    expect(prompt).not.toContain('只有子房间才有的特殊摆设');
    expect(prompt).toContain('刚才说过的话');
    expect(prompt).toContain('父级地点可以停留');
    expect(prompt).toContain('"location_id":"child_room"');
  });
  it('rejects a spatial substitution in the existing semantic fidelity audit and repairs once',async()=>{
    const f=await sparseSetup();let interpretations=0,audits=0;
    const save=await f.service.current();
    save.definition.map!.locations.push({id:'facility',name:'设施',description:'建筑入口',tags:[],known_by_default:true});
    save.map_state.known_location_ids.push('facility');await f.store.write(save);
    const call=vi.spyOn(f.ai,'systemAgent').mockImplementation(async(schema,_profile,data)=>{
      if('preserved' in (schema as any).shape){
        audits++;expect((data as any).instruction).toContain('合法地图路径不证明玩家授权');
        return {preserved:audits>1,reason:'局部区域不能替换为参照建筑'} as never;
      }
      interpretations++;
      if(interpretations===2)expect((data as any).semantic_recovery).toMatchObject({failure_code:'semantic_goal_mismatch'});
      return {...semantic,open_goal_context:interpretations===1?
        {...semantic.open_goal_context,spatial_scope:null}:semantic.open_goal_context} as never;
    });
    const result=await interpretSemanticEntry(f.service,f.service.project(save),input,'WORLD');
    expect(result?.open_goal_context?.spatial_scope).toEqual(scope);
    expect(interpretations).toBe(2);expect(audits).toBe(2);expect(call).toHaveBeenCalledTimes(4);
    expect((await f.service.current()).state_revision).toBe(save.state_revision);
  });
});

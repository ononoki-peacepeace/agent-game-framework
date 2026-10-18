import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';

type Event={kind:'speech'|'move';timing:'before_move'|'during_move'|'after_move'|null;text:string|null};

async function fixture(badOrigin=false,effectMove=false,invalidArrival=false){
  const scenes:{input:string;location:string;people:string[];partner:string|null;publicMapGuidance:boolean}[]=[];
  const f=await sparseSetup(async request=>{
    const schema=request.schema as {properties?:Record<string,unknown>};
    if(schema.properties?.understanding){
      if(request.prompt.includes('"scene_phase":"arrival"')){
        scenes.push({input:'arrival',location:'街角商店',people:['npc_qiao'],partner:'npc_qiao',
          publicMapGuidance:request.prompt.includes('玩家界面已公开的地图地点名称')});
        return {data:{understanding:'到达后的新场景',narrative:'街角商店里的人看向来客。',
          dialogue:'你们来了。',speech_events:[{speaker_id:'npc_qiao',utterance:'你们来了。',provenance:'npc_response'}],
          beats:[{kind:'narration',text:'街角商店里的人看向来客。'},{kind:'speech',speech_index:0}],
          travel_intents:[],effects:invalidArrival?[{kind:'wait',minutes:5}]:[]}} as never;
      }
      const encoded=request.prompt.match(/"player_input":("(?:[^"\\]|\\.)*")/)?.[1]??'""';
      const input=JSON.parse(encoded) as string;
      const atOrigin=request.prompt.includes('"location":"中央广场"');
      const onRoute=request.prompt.includes('"location":"河岸车站"');
      const location=atOrigin?'中央广场':onRoute?'河岸车站':'街角商店';
      const listeners=atOrigin?['npc_lin','npc_origin_1','npc_origin_2','npc_origin_3']:
        onRoute?['npc_lin','npc_origin_1']:['npc_qiao'];
      const partner=request.prompt.match(/"partner"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/)?.[1]??null;
      scenes.push({input,location,people:listeners,partner,
        publicMapGuidance:request.prompt.includes('玩家界面已公开的地图地点名称')});
      if(badOrigin&&atOrigin)return {data:{understanding:'错误现场',narrative:'',dialogue:'不在场',
        speech_events:[{speaker_id:'npc_absent',utterance:'不在场',provenance:'npc_response'}],
        travel_intents:[],effects:[]}} as never;
      const replies=atOrigin?listeners.map((id,index)=>({speaker_id:id,
        utterance:index<2?'我愿意一起去。':'我留在这里。',provenance:'npc_response'})):
        [{speaker_id:listeners[0],utterance:'这里有一些资料。',provenance:'npc_response'}];
      const spoken=atOrigin&&effectMove?'一起去街角商店吧。':input;
      return {data:{understanding:'现场交谈',narrative:atOrigin?'大厅里的人各自答复。':'店里的人抬起头。',
        dialogue:replies.at(-1)!.utterance,
        speech_events:[{speaker_id:'player',utterance:spoken,provenance:'verbatim_player_input'},...replies],
        ...(atOrigin&&effectMove?{beats:[{kind:'narration',text:'大厅里的人各自答复。'},
          ...Array.from({length:replies.length+1},(_,speech_index)=>({kind:'speech',speech_index}))]}:{}),
        travel_intents:atOrigin?listeners.map((id,index)=>({npc_id:id,status:index<2?'willing':'declined'})):[],
        effects:atOrigin&&effectMove?[{kind:'move',destination:'街角商店'}]:[]}} as never;
    }
    if(schema.properties?.authorized)return {data:{authorized:true,explanation:'玩家明确授权出发。'}} as never;
    if(request.role==='narrator')return {data:{narrative:'你沿路来到街角商店。',speaker:null,
      dialogue:null,choices:[],patches:[]}} as never;
    throw new Error(`unexpected ${request.role}`);
  });
  const save=await f.service.current();
  const origin=save.entities.find(entity=>entity.id==='npc_lin')!;
  origin.components.location={location_id:'square'};
  for(let index=1;index<4;index++){
    const npc=structuredClone(origin);npc.id=`npc_origin_${index}`;
    npc.components.identity.name=`大厅人物${index}`;
    save.entities.push(npc);
    save.npc_agent_state={...save.npc_agent_state,[npc.id]:emptyNpcAgentState()};
  }
  save.npc_agent_state={...save.npc_agent_state,npc_lin:emptyNpcAgentState()};
  await f.store.write(save);
  return {f,scenes};
}

async function submit(f:Awaited<ReturnType<typeof fixture>>['f'],input:string,events:Event[],
  travelParty:'solo'|'willing_companions'|null=null,
  speechMode:'verbatim'|'intent'|'none'='verbatim'){
  const before=await f.service.current();
  const semantic={kind:'world_action',interaction_lane:'open_goal',player_speech_mode:speechMode,
    open_goal_context:{destination:'街角商店',continuation:'none',event_sequence:events,
      travel_party:travelParty},
    goal_spec:{play_action:'move',objective:input,targets:[],desired_state:[],desired_outputs:[],
      constraints:[],persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],
      world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null}};
  const result=await handleAgentInput(f.service,{game_id:before.game_id,
    expected_revision:before.state_revision,request_id:randomUUID(),input},
    undefined,null,false,semantic as never);
  return {before,after:await f.service.current(),result};
}
const speech=(text:string,timing:'before_move'|'after_move'|'during_move'):Event=>({kind:'speech',timing,text});
const move:Event={kind:'move',timing:null,text:null};

describe('compound speech and travel event order',()=>{
  it('commits origin speech and travel intent before a scene-proposed MOVE',async()=>{
    const {f,scenes}=await fixture(false,true);
    const before=await f.service.current();
    const input='我对大家说：“一起去街角商店吧。”然后出发。';
    const result=await handleAgentInput(f.service,{game_id:before.game_id,
      expected_revision:before.state_revision,request_id:randomUUID(),input},
      undefined,null,false,{kind:'world_action',interaction_lane:'natural_scene',
        player_speech_mode:'verbatim'} as never);
    const after=await f.service.current();
    expect(scenes).toMatchObject([{location:'中央广场',publicMapGuidance:true},
      {location:'街角商店',publicMapGuidance:true}]);
    expect(after.state_revision).toBe(before.state_revision+3);
    expect(after.narrative_history?.at(-3)).toMatchObject({location_id:'square',
      revision:before.state_revision+1});
    expect(after.narrative_history?.at(-3)?.speech_events?.[0]?.utterance).toBe('一起去街角商店吧。');
    expect(after.narrative_history?.at(-2)).toMatchObject({location_id:'market',
      revision:before.state_revision+2});
    expect(after.narrative_history?.at(-1)).toMatchObject({location_id:'market',
      revision:before.state_revision+3});
    expect(after.narrative_history?.at(-1)?.speech_events?.map(event=>event.speaker_id)).toEqual(['npc_qiao']);
    expect(after.npc_agent_state?.npc_lin.travel_intent?.origin_location_id).toBe('market');
    expect(after.npc_agent_state?.npc_origin_2.travel_intent?.origin_location_id).toBe('square');
    expect(after.entities.find(entity=>entity.id==='npc_lin')?.components.location?.location_id).toBe('market');
    expect(after.entities.find(entity=>entity.id==='npc_origin_2')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(result.story).toContain('大厅里的人各自答复');
    expect(result.story).toContain('街角商店');
    expect(after.last_turn?.scene_beats?.some(beat=>beat.kind==='speech'&&beat.utterance==='一起去街角商店吧。')).toBe(true);
    expect(after.last_turn?.scene_beats?.at(-1)).toMatchObject({kind:'speech',speaker_id:'npc_qiao'});
    expect(after.last_turn?.scene_beats?.some(beat=>beat.kind==='narration'&&beat.text==='你沿路来到街角商店。')).toBe(true);
    expect(after.last_turn?.narrative).toContain('大厅里的人各自答复');
    await f.service.undo({game_id:after.game_id,expected_revision:after.state_revision,
      request_id:randomUUID()});
    const beforeArrival=await f.service.current();
    expect(beforeArrival.entities.find(entity=>entity.id==='npc_lin')?.components.location?.location_id).toBe('market');
    await f.service.undo({game_id:beforeArrival.game_id,expected_revision:beforeArrival.state_revision,
      request_id:randomUUID()});
    const beforeMove=await f.service.current();
    expect(beforeMove.npc_agent_state?.npc_lin.travel_intent?.origin_location_id).toBe('square');
    expect(beforeMove.entities.find(entity=>entity.id==='npc_lin')?.components.location?.location_id).toBe('square');
  });
  it('keeps the MOVE and origin speech when both bounded arrival proposals are invalid',async()=>{
    const {f,scenes}=await fixture(false,true,true);
    const before=await f.service.current();
    const input='我对大家说：“一起去街角商店吧。”然后出发。';
    const result=await handleAgentInput(f.service,{game_id:before.game_id,
      expected_revision:before.state_revision,request_id:randomUUID(),input},
      undefined,null,false,{kind:'world_action',interaction_lane:'natural_scene',
        player_speech_mode:'verbatim'} as never);
    const after=await f.service.current();
    expect(scenes.filter(scene=>scene.input==='arrival')).toHaveLength(2);
    expect(result.outcome).toMatchObject({type:'engine_failure',stage:'arrival_scene'});
    expect(after.state_revision).toBe(before.state_revision+2);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(after.last_turn?.scene_beats?.some(beat=>beat.kind==='speech'&&beat.speaker_id==='player')).toBe(true);
    expect(after.narrative_history?.at(-2)?.location_id).toBe('square');
    expect(after.narrative_history?.at(-1)?.location_id).toBe('market');
  });

  it('does not infer a departure order when explicit speech has no event sequence',async()=>{
    const {f,scenes}=await fixture();
    const {before,after,result}=await submit(f,'我对大家说：“我打算去街角商店。”',[]);
    expect(result.intent).toBe('CLARIFICATION');
    expect(scenes).toHaveLength(0);
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });

  it('records a stated future plan where it was said without departing',async()=>{
    const {f,scenes}=await fixture();
    const text='我打算去街角商店，你们要一起吗？';
    const {before,after,result}=await submit(f,text,[speech(text,'before_move')]);
    expect(scenes).toMatchObject([{input:text,location:'中央广场'}]);
    expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(after.narrative_history?.at(-1)).toMatchObject({location_id:'square',player_input:text});
    expect(after.npc_agent_state?.npc_lin.travel_intent?.status).toBe('willing');
  });

  it('settles invitations before MOVE and carries only willing witnesses',async()=>{
    const {f,scenes}=await fixture();
    const words='大家愿意一起去街角商店吗？';
    const {after,result}=await submit(f,`我先问：${words} 然后出发。`,[speech(words,'before_move'),move]);
    expect(scenes[0]).toMatchObject({input:words,location:'中央广场'});
    const origin=after.narrative_history?.find(entry=>entry.speech_events?.some(event=>event.utterance===words));
    expect(origin?.location_id).toBe('square');
    expect(after.narrative_history?.at(-1)?.location_id).toBe('market');
    expect(origin?.revision??0).toBeLessThan(after.narrative_history?.at(-1)?.revision??0);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.entities.filter(entity=>['npc_lin','npc_origin_1'].includes(entity.id))
      .every(entity=>entity.components.location?.location_id==='market')).toBe(true);
    expect(after.entities.filter(entity=>['npc_origin_2','npc_origin_3'].includes(entity.id))
      .every(entity=>entity.components.location?.location_id==='square')).toBe(true);
    expect(result.story).toContain('大厅里的人各自答复');
    expect(result.story).toContain('街角商店');
  });

  it('undoes the MOVE without relocating the earlier conversation',async()=>{
    const {f}=await fixture();
    const words='大家愿意一起去街角商店吗？';
    const {after}=await submit(f,`我先问：${words} 然后出发。`,
      [speech(words,'before_move'),move]);
    await f.service.undo({game_id:after.game_id,expected_revision:after.state_revision,
      request_id:randomUUID()});
    const withoutArrival=await f.service.current();
    expect(withoutArrival.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('market');
    await f.service.undo({game_id:withoutArrival.game_id,expected_revision:withoutArrival.state_revision,
      request_id:randomUUID()});
    const undone=await f.service.current();
    expect(undone.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('square');
    expect((undone.resolution_receipts??[]).filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(0);
    expect(undone.narrative_history?.at(-1)?.location_id).toBe('square');
    expect(undone.narrative_history?.at(-1)?.speech_events?.[0]).toMatchObject({
      speaker_id:'player',utterance:words,provenance:'verbatim_player_input'});
  });

  it('moves first and only then addresses a person at the destination',async()=>{
    const {f,scenes}=await fixture();
    const words='这里有什么资料？';
    const {after}=await submit(f,`我去街角商店，然后问里面的人：${words}`,[move,speech(words,'after_move')]);
    expect(scenes).toMatchObject([{input:words,location:'街角商店'}]);
    expect(scenes[0].people).toContain('npc_qiao');
    expect(scenes[0].people).not.toContain('npc_origin_2');
    expect(after.narrative_history?.at(-1)?.location_id).toBe('market');
    expect(after.narrative_history?.at(-1)?.speech_events?.[0]?.utterance).toBe(words);
  });

  it('does not let an old conversation focus receive speech at the destination',async()=>{
    const {f,scenes}=await fixture();
    const save=await f.service.current();
    save.interaction_context={mode:'conversation',target_entity_id:'npc_lin',started_turn:0,
      last_interaction_turn:0,scene_anchor:'square',status:'active'};
    save.npc_agent_state!.npc_lin.travel_intent={status:'willing',origin_location_id:'square',
      source_request_id:randomUUID(),recorded_revision:save.state_revision};
    await f.store.write(save);
    const words='你这里有什么资料？';
    const {after}=await submit(f,`我去街角商店，再问店里的人：${words}`,
      [move,speech(words,'after_move')]);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({location:'街角商店',partner:'npc_qiao',input:words});
    expect(after.entities.find(entity=>entity.id==='npc_lin')?.components.location?.location_id).toBe('market');
  });

  it('binds speech during travel to an actual route stop and actual companions',async()=>{
    const {f,scenes}=await fixture();
    const save=await f.service.current();
    save.definition.map!.routes=save.definition.map!.routes.filter(route=>
      !(route.from==='square'&&route.to==='market'));
    save.definition.map!.routes.push({...save.definition.map!.routes[0],from:'station',to:'market',travel_minutes:4});
    save.npc_agent_state!.npc_lin.travel_intent={status:'willing',origin_location_id:'square',
      source_request_id:randomUUID(),recorded_revision:save.state_revision};
    await f.store.write(save);
    const words='你觉得前面会是什么地方？';
    const {after}=await submit(f,`我沿路去街角商店，边走边问林舟：${words}`,
      [move,speech(words,'during_move')]);
    expect(scenes).toMatchObject([{input:words,location:'河岸车站'}]);
    expect(scenes[0].people).not.toContain('npc_qiao');
    expect(after.narrative_history?.map(entry=>entry.location_id)).toEqual(['station','station','market']);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(2);
    expect(after.narrative_history?.at(-2)?.speech_events?.[0]?.utterance).toBe(words);
  });

  it('does not move when a direct edge cannot anchor speech during travel',async()=>{
    const {f,scenes}=await fixture();
    const words='你觉得前面会是什么地方？';
    const {before,after,result}=await submit(f,`我去街角商店，边走边问林舟：${words}`,
      [move,speech(words,'during_move')]);
    expect(result.intent).toBe('CLARIFICATION');
    expect(scenes).toHaveLength(0);
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });

  it('respects an explicit solo departure despite an older willing intent',async()=>{
    const {f}=await fixture();
    const save=await f.service.current();
    save.npc_agent_state!.npc_lin.travel_intent={status:'willing',origin_location_id:'square',
      source_request_id:randomUUID(),recorded_revision:save.state_revision};
    await f.store.write(save);
    const words='我先向大家告别。';
    const {after}=await submit(f,`${words}然后独自去街角商店。`,[speech(words,'before_move'),move],'solo');
    expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('market');
    expect(after.entities.find(entity=>entity.id==='npc_lin')?.components.location?.location_id).toBe('square');
    expect(after.narrative_history?.find(entry=>entry.speech_events?.[0]?.utterance===words)?.location_id).toBe('square');
  });

  it('does not move when the pre-departure scene fails validation',async()=>{
    const {f,scenes}=await fixture(true);
    const words='你们愿意一起去吗？';
    const {before,after,result}=await submit(f,`我先问大家：${words}然后去街角商店。`,
      [speech(words,'before_move'),move]);
    expect(scenes).toHaveLength(2);
    expect(result.outcome.type).toBe('engine_failure');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });

  it('retains committed speech when a later MOVE cannot settle',async()=>{
    const {f}=await fixture();
    const save=await f.service.current();
    save.definition.map!.routes=save.definition.map!.routes.filter(route=>route.to!=='market');
    await f.store.write(save);
    const words='大家愿意一起走吗？';
    const {after,result}=await submit(f,`我先问：${words}然后去街角商店。`,
      [speech(words,'before_move'),move]);
    expect(result.outcome).not.toMatchObject({type:'game',kind:'completed'});
    expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('square');
    expect(after.narrative_history?.at(-1)?.speech_events?.[0]?.utterance).toBe(words);
    expect((after.resolution_receipts??[]).filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(0);
  });
});

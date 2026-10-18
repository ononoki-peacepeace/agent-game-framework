import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {agentPresentation} from '../src/client/agent-presentation.js';
import {interpretSemanticEntry} from '../src/agent/semantic-entry.js';
import type {SemanticDecision} from '../src/agent/semantic-entry.js';

const nearbyGoal=(input:string):SemanticDecision=>({
  domain:'world',kind:'world_action',original_user_request:input,operation_plane:'play',
  goal_spec:{objective:input,play_action:'move',targets:[],desired_state:[],desired_outputs:[],
    constraints:[],persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],
    world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null},
  confidence:0.94,answer:null,answer_basis:null,evidence_ids:[],clarification:null,
  speech_target_id:null,interaction_lane:'world_transaction',player_speech_mode:'none',temporal_wait:null,
  open_goal_context:null,
});

describe('bounded low-stakes route discretion and partial story',()=>{
  it('uses the existing route runner for a bound multi-leg travel GoalSpec despite an atomic lane label',async()=>{
    let planCalls=0;
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(request.role==='narrator')return {data:{narrative:'你沿着走廊抵达阅览室，房间里很安静。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;
      planCalls++;
      throw Error('bound travel should not enter the legacy plan compiler');
    });
    const before=await f.service.current();
    before.definition.map!.locations.push({id:'corridor',name:'走廊',description:'通往阅览室。',tags:[],known_by_default:true},
      {id:'reading_room',name:'阅览室',description:'安静的阅览室。',tags:[],known_by_default:true});
    before.definition.map!.routes.push({from:'square',to:'corridor',travel_minutes:2,conditions:[]},
      {from:'corridor',to:'reading_room',travel_minutes:2,conditions:[]});
    before.map_state.known_location_ids.push('corridor','reading_room');
    await f.store.write(before);
    const input='沿走廊到阅览室看看。';
    const semantic={...nearbyGoal(input),interaction_lane:'world_transaction' as const,
      goal_spec:{...nearbyGoal(input).goal_spec!,targets:[
        {kind:'location' as const,reference:'走廊',entity_id:'corridor'},
        {kind:'location' as const,reference:'阅览室',entity_id:'reading_room'}],
      desired_state:[{path:'entity:player.location.location_id',value:'reading_room',target_ref:'player'}]}};
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,semantic);
    const after=await f.service.current();
    expect(planCalls).toBe(0);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.resolution_receipts?.at(-1)?.movement_route?.location_ids).toEqual(['square','corridor','reading_room']);
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(4);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(result.message).toContain('阅览室');
  });
  it('does not repeat a completed travel request as a new NPC scene after arrival',async()=>{
    const unexpectedCalls:string[]=[];
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.decision)return {data:{decision:'transaction',transaction:{kind:'move',
        destination:'街角商店',minutes:null,reason:'公开路线',intermediate:false},
        reason:null,question:null}} as never;
      if(request.role==='narrator')return {data:{narrative:'你走到街角商店，门前的路在这里收束。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;
      unexpectedCalls.push(`${request.role}:${Object.keys(properties).join(',')}`);
      throw Error('travel request must not become a new scene utterance');
    });
    const before=await f.service.current(),input='出发走到附近的街角商店看看。';
    before.entities.find(entity=>entity.id==='npc_lin')!.components.location={location_id:'market'};
    await f.store.write(before);
    const semantic={...nearbyGoal(input),interaction_lane:'open_goal' as const,
      goal_spec:{...nearbyGoal(input).goal_spec!,targets:[{kind:'location' as const,reference:'街角商店',entity_id:'market'}]},
      // This is a travel-only request; the semantic contract must not claim a verbatim utterance.
      player_speech_mode:'none' as const,
      open_goal_context:{destination:'街角商店',continuation:'natural_interaction_if_available' as const,
        search_query:null,travel_after_discovery:true,route_choice:false}};
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,'npc_lin',false,semantic);
    const after=await f.service.current();
    expect(unexpectedCalls).toEqual([]);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id).toBe('market');
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(result.message).toContain('街角商店');
  });
  it('keeps a corridor as a transit step and reaches the authorized next room',async()=>{
    let decisions=0,narrations=0;
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.decision){decisions++;return {data:{decision:'transaction',transaction:{kind:'move',
        destination:decisions===1?'街角商店':'阅览室',minutes:null,reason:'公开相邻路线',
        intermediate:decisions===1},reason:null,question:null}} as never;}
      if(request.role==='narrator'){narrations++;return {data:{narrative:narrations===1?
        '你走到街角商店，继续沿已知通道前进。':'你穿过街角商店，抵达阅览室。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;}
      throw Error('unexpected AI call');
    });
    const before=await f.service.current();
    before.definition.map!.locations.push({id:'reading_room',name:'阅览室',description:'一间可进入的房间。',tags:[],known_by_default:true});
    before.definition.map!.routes.push({from:'market',to:'reading_room',travel_minutes:2,conditions:[]});
    before.map_state.known_location_ids.push('reading_room');
    await f.store.write(before);
    const input='沿合法路线继续探索，直到抵达下一处实际可进入的房间。';
    const semantic={...nearbyGoal(input),interaction_lane:'open_goal' as const,
      open_goal_context:{destination:null,continuation:'none' as const,search_query:null,route_choice:true}};
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,semantic);
    const after=await f.service.current();
    expect(decisions).toBe(2);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(2);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id).toBe('reading_room');
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(8);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(result.message).toContain('阅览室');
  });
  it('lets an explicit NPC conversation context yield to a newly authorized movement goal',async()=>{
    let semanticCalls=0;
    const input='我们现在出发，沿一条可走的路去邻近地点。';
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.domain){semanticCalls++;return {data:nearbyGoal(input)} as never;}
      throw Error('unexpected AI call');
    });
    const save=await f.service.current();
    const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    npc.components.location={location_id:'square'};
    await f.store.write(save);
    const decision=await interpretSemanticEntry(f.service,f.service.project(save),input,'WORLD',null,null,undefined,
      {source:'npc_interaction',target_id:'npc_lin',mode:'conversation'});
    expect(decision?.kind).toBe('world_action');
    expect(decision?.interaction_lane).toBe('world_transaction');
    expect(semanticCalls).toBe(1);
  });
  it('chooses one public direct route from a move goal, commits it once and preserves the chosen destination',async()=>{
    let decisions=0,narrators=0;
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.decision){decisions++;return {data:{decision:'transaction',transaction:{kind:'move',
        destination:'街角商店',minutes:null,reason:'从广场走向公开可达的邻近地点'},reason:null,question:null}} as never;}
      if(request.role==='narrator'){narrators++;return {data:{narrative:'你沿广场边的路走到街角商店，门口挂着营业中的牌子。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;}
      throw Error('unexpected AI call');
    });
    const before=await f.service.current(),beforeView=f.service.project(before);
    const input='沿着附近可走的路去下一处地方看看。',request_id=randomUUID();
    const body={request_id,game_id:before.game_id,expected_revision:before.state_revision,input};
    const result=await handleAgentInput(f.service,body,undefined,null,false,nearbyGoal(input));
    const after=await f.service.current();
    const moves=after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')??[];
    expect(moves).toHaveLength(1);
    expect(moves[0].target_id).toBe('market');
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id).toBe('market');
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+6);
    expect(decisions).toBe(1);
    expect(narrators).toBe(1);
    expect(result.message).toContain('街角商店');
    expect(agentPresentation(beforeView,result).agentReply).toBeNull();
    const replay=await handleAgentInput(f.service,body,undefined,null,false,nearbyGoal(input));
    expect(replay.view?.revision).toBe(after.state_revision);
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
  });

  it('uses the same public-route step when semantic open goal marks a route choice instead of a place search',async()=>{
    let decisions=0;
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.decision){decisions++;return {data:{decision:'transaction',transaction:{kind:'move',
        destination:'街角商店',minutes:null,reason:'相邻公开路线'},reason:null,question:null}} as never;}
      if(request.role==='narrator')return {data:{narrative:'你走到街角商店，门前的营业牌子映入眼帘。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;
      throw Error('unexpected AI call');
    });
    const before=await f.service.current(),input='去附近下一处地方看看。';
    const semantic={...nearbyGoal(input),interaction_lane:'open_goal' as const,
      open_goal_context:{destination:null,continuation:'none' as const,
        search_query:'下一处地点',travel_after_discovery:true,route_choice:true}};
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,semantic);
    expect(decisions).toBe(1);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
  });

  it('keeps committed route prose when a later open-goal planning attempt fails',async()=>{
    let decisions=0,narrators=0;
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.decision){
        decisions++;
        if(decisions>2)throw Error('provider unavailable');
        return {data:{decision:'transaction',transaction:{kind:'move',
          destination:decisions===1?'街角商店':'中央广场',minutes:null,reason:'公开路线'},
          reason:null,question:null}} as never;
      }
      if(request.role==='narrator'){narrators++;return {data:{narrative:narrators===1?
        '你走到街角商店，门前的招牌仍挂着。':'你沿原路回到中央广场，脚下又是熟悉的石砖。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;}
      throw Error('unexpected AI call');
    });
    const before=await f.service.current(),beforeView=f.service.project(before),input='沿可通行路线继续查看周边。';
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none'}} as never);
    const after=await f.service.current();
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(2);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id).toBe('square');
    expect(result.outcome).toMatchObject({type:'engine_failure',receipt_ids:expect.arrayContaining([
      after.resolution_receipts![0].request_id,after.resolution_receipts![1].request_id])});
    expect(result.story).toContain('街角商店');
    expect(result.story).toContain('中央广场');
    const shown=agentPresentation(beforeView,result);
    expect(shown.storyOverride?.text).toBe(result.story);
    expect(shown.agentReply?.appearance).toBe('failure');
  });
});

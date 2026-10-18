import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {demo,MemoryStore} from './helpers.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {addDynamicLocation,currentMap,routePath} from '../src/core/map.js';
import {applyLocationSearch,commitProposedLocation,locationSearchContext,setLocationStatus} from '../src/core/location-lifecycle.js';
import {executeAction} from '../src/core/runtime.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {handleAgentInput} from '../src/agent/executor.js';

const proposal={name:'旧唱片铺',category:'record_store',description:'广场边的一间二手唱片小店。',
  parent_id:'square',anchor_id:'square',travel_minutes:4,visibility:'public' as const,
  creation_reason:'港湾镇的日常商业需求支持一间经营旧唱片的小店。',source_ref:'square'};
const found=(choice:'known'|'discover'|'propose'|'none',id:string|null=null,p=choice==='propose'?proposal:null)=>({
  decision:choice,location_id:id,proposal:p,method:choice==='none'?'none' as const:'public_map' as const,reason:'沿广场地图找到线索。',
});
const review={supported:true,reason:'与现有城镇商业相容。'};

describe('dynamic location lifecycle',()=>{
  it('materializes one reachable, persistent and discoverable place; repeat demand cannot duplicate it',()=>{
    const save=newSave(demo),before=save.map_state.dynamic_locations.length;
    const result=applyLocationSearch(save,found('propose'),'找一家二手唱片店',review);
    expect(result.location?.lifecycle).toMatchObject({origin:'existing_detail',status:'active',visibility:'public'});
    expect(save.map_state.dynamic_locations).toHaveLength(before+1);
    const id=result.location!.id;
    expect(id).toMatch(/^loc_[a-f0-9]{24}$/);
    expect(routePath(currentMap(save).routes,'square',id)).toHaveLength(1);
    expect(routePath(currentMap(save).routes,id,'square')).toHaveLength(1);
    expect(publicView(save).locations.map(loc=>loc.id)).toContain(id);
    const reloaded=validateSave(JSON.parse(JSON.stringify(save)));
    expect(reloaded.map_state.dynamic_locations[0].id).toBe(id);
    expect(reloaded.map_state.dynamic_locations[0].lifecycle?.status).toBe('active');
    expect(()=>applyLocationSearch(reloaded,found('propose'),'再找一家二手唱片店',review)).toThrow();
    expect(applyLocationSearch(reloaded,found('known',id),'找二手唱片店',review).location?.id).toBe(id);
  });

  it('discovers an existing unknown hotel rather than adding a second place',()=>{
    const save=newSave(demo);
    addDynamicLocation(save,{id:'budget_inn',name:'平价旅馆',description:'车站附近的小旅馆。',tags:['inn'],
      kind:'inn',parent_id:'station',known_by_default:false},[
      {from:'station',to:'budget_inn',travel_minutes:3,conditions:[]},
      {from:'budget_inn',to:'station',travel_minutes:3,conditions:[]}],false);
    expect(publicView(save).locations.some(loc=>loc.id==='budget_inn')).toBe(false);
    const before=save.map_state.dynamic_locations.length;
    const choice={...found('discover','budget_inn'),method:'local_exploration' as const};
    const lead=applyLocationSearch(save,choice,'找便宜旅馆',review);
    expect(lead.kind).toBe('approach');expect(lead.location?.id).toBe('station');
    expect(publicView(save).locations.some(loc=>loc.id==='budget_inn')).toBe(false);
    const arrived=executeAction(save,{type:'MOVE',target_id:'station'},randomUUID(),'player',()=>0.5).save;
    const result=applyLocationSearch(arrived,choice,'找便宜旅馆',review);
    expect(result.kind).toBe('discover');
    expect(arrived.map_state.dynamic_locations).toHaveLength(before);
    expect(publicView(arrived).locations.some(loc=>loc.id==='budget_inn')).toBe(true);
  });

  it('does not create an incompatible place or reveal a truly hidden place through a generic search',()=>{
    const save=newSave(demo);
    expect(applyLocationSearch(save,{...found('none'),reason:'这个现实城镇没有这样的地点。'},'找吸血鬼城堡').location).toBeNull();
    expect(()=>applyLocationSearch(save,found('propose'),'找吸血鬼城堡',{supported:false,reason:'与世界冲突'})).toThrow();
    const secret=commitProposedLocation(save,{...proposal,name:'私人仓库',category:'private_warehouse',visibility:'hidden'},
      'world_event','incident:stage','private_warehouse');
    expect(publicView(save).locations.some(loc=>loc.id===secret.id)).toBe(false);
    expect(()=>applyLocationSearch(save,{...found('discover',secret.id),method:'local_exploration'},'找仓库',review)).toThrow();
    expect(locationSearchContext(save).locations.find(loc=>loc.id===secret.id)?.known).toBe(false);
  });

  it('keeps closed sites in canonical geography while denying entry and preserving old saves',()=>{
    const save=newSave(demo),site=commitProposedLocation(save,proposal,'world_event','opening:stage');
    setLocationStatus(save,site.id,'closed','closure:stage');
    expect(currentMap(save).locations.find(loc=>loc.id===site.id)?.lifecycle?.status).toBe('closed');
    expect(()=>executeAction(save,{type:'MOVE',target_id:site.id},randomUUID(),'player',()=>0.5)).toThrow();
    expect(validateSave(save).map_state.dynamic_locations[0].lifecycle?.status).toBe('closed');
    expect(validateSave(newSave(demo)).definition.map!.locations[0].lifecycle).toBeUndefined();
  });

  it('commits exploration through the existing transaction and Undo restores the previous map',async()=>{
    const store=new MemoryStore(),service=new GameService(store,new AIRuntime({name:'unused',generate:async()=>{throw Error('no model');}}),demo);
    await service.newGame();const before=await service.current();
    await service.agentTransaction({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},
      {explore:'record_store'},next=>{applyLocationSearch(next,found('propose'),'找唱片店',review);});
    const after=await service.current();expect(after.map_state.dynamic_locations).toHaveLength(1);
    expect(after.state_revision).toBe(before.state_revision+1);
    await service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    expect((await service.current()).map_state.dynamic_locations).toHaveLength(0);
  });

  it('background event can open an unknown place independently of the player, persist, and follow turn Undo',async()=>{
    const world=structuredClone(demo);world.events=[];
    world.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:0,replenishment:false};
    const at={...world.runtime.time};
    world.background_incidents=[{id:'new_shop',title:'独立店铺开业',summary:'街区商业扩张',source:'WORLD_PACKAGE',
      created_at:at,earliest_activation:at,latest_activation:null,activation_flags:[],activation_chance:1,
      participants:[],locations:['square'],causal_basis:{underlying_pressure:'居民购物需求',actor_motivation:'经营小店',
        resource_constraint:'空铺有限',historical_cause:'旧街区改造',social_relationship:'邻里客流',trigger:'租约签订',
        unintended_consequence:'周边人流变化'},stages:[{id:'opening',earliest_after_minutes:0,latest_after_minutes:null,
        required_flags:[],actor_id:null,effects:[{kind:'create_location',location_id:'new_cafe',
          name:'新咖啡店',category:'cafe',description:'广场边新开的咖啡店。',parent_id:'square',anchor_id:'square',
          travel_minutes:2,visibility:'locally_known',creation_reason:'旧街区空铺出租后，新商户正式开业。',source_ref:'square'}],
        exposures:[],terminal:'resolved'}]}];
    const save=newSave(world);
    const result=executeAction(save,{type:'WAIT',parameters:{minutes:1}},randomUUID(),'player',()=>0.2).save;
    expect(result.map_state.dynamic_locations.find(loc=>loc.id==='new_cafe')?.lifecycle?.origin).toBe('world_event');
    expect(publicView(result).locations.map(loc=>loc.id)).not.toContain('new_cafe');
    const reloaded=validateSave(JSON.parse(JSON.stringify(result)));
    expect(routePath(currentMap(reloaded).routes,'square','new_cafe')).toHaveLength(1);
    const store=new MemoryStore(),ai=new AIRuntime({name:'scripted',generate:async request=>{
      if(request.role==='narrator')return {data:{narrative:'广场上的时间过去了一分钟。',speaker:null,
        dialogue:null,choices:[],patches:[]}};
      throw Error('unexpected model call');
    }});
    await store.write(newSave(world));const service=new GameService(store,ai,world),before=await service.current();
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),
      action:{type:'WAIT',parameters:{minutes:1}}});
    const after=await service.current();expect(after.map_state.dynamic_locations.map(loc=>loc.id)).toContain('new_cafe');
    await service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    expect((await service.current()).map_state.dynamic_locations.map(loc=>loc.id)).not.toContain('new_cafe');
  });

  it('open search accepts a place category without requiring a pre-known name',async()=>{
    let searches=0;
    const ai=new AIRuntime({name:'scripted',generate:async request=>{
      const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(props.location_id&&props.proposal){searches++;return {data:{...found('propose'),proposal:{...proposal,
        name:'露天音乐角',category:'live_music',description:'广场一隅定期举行现场演出。',
        creation_reason:'港湾镇广场的社区活动需求支持一处小型现场演出空间。'}}};}
      if(props.supported)return {data:review};
      throw Error('unexpected model call');
    }});
    const store=new MemoryStore(),service=new GameService(store,ai,demo);await service.newGame();
    const before=await service.current();
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'打听哪里能听现场音乐'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none',
        search_query:'能听现场音乐的地方',travel_after_discovery:false}} as never);
    const after=await service.current();
    expect(searches).toBe(1);expect(after.map_state.dynamic_locations).toHaveLength(1);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(result.message).toContain('露天音乐角');
  });

  it('re-reads the world after discovery, moves once, and hides planner jargon from the final reply',async()=>{
    let steps=0;
    const ai=new AIRuntime({name:'scripted',generate:async request=>{
      const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(props.location_id&&props.proposal)return {data:found('propose')};
      if(props.supported)return {data:review};
      if(props.decision){steps++;return {data:steps===1?
        {decision:'transaction',transaction:{kind:'move',destination:'旧唱片铺',minutes:null,reason:'前往'},reason:null,question:null}:
        {decision:'done',transaction:null,reason:'scene.location=loc_internal; MOVE committed',question:null}};}
      if(request.role==='narrator')return {data:{narrative:'你到了旧唱片铺。',speaker:null,dialogue:null,
        choices:[],patches:[]}};
      throw Error('unexpected model call');
    }});
    const store=new MemoryStore(),service=new GameService(store,ai,demo);await service.newGame();
    const before=await service.current();
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'找一家二手唱片店并过去'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none',
        search_query:'二手唱片店',travel_after_discovery:true}} as never);
    const after=await service.current();
    expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE']);
    expect(after.entities.find(e=>e.id===after.player_state.entity_id)?.components.location?.location_id)
      .toBe(after.map_state.dynamic_locations[0].id);
    expect(steps).toBe(0);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(result.message).toContain('到达 旧唱片铺');
    expect(result.message).not.toMatch(/scene\.location|MOVE|move:|loc_internal/);
  });

  it.each(['none','incompatible','invalid_proposal'] as const)('keeps a %s location lookup as local search progress with narrator-only prose',async kind=>{
    const ai=new AIRuntime({name:'scripted',generate:async request=>{
      const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(props.location_id&&props.proposal)return {data:kind==='none'?
        {...found('none'),reason:'location_id missing; world proposal schema failed'}:
        kind==='invalid_proposal'?found('propose',null,{...proposal,anchor_id:'station'}):found('propose')};
      if(props.supported)return {data:{supported:kind==='invalid_proposal',reason:'世界审核结果。'}};
      if(props.decision)return {data:{decision:'done',transaction:null,reason:'当前搜索范围暂未发现目标。',question:null}};
      if(props.grounded)return {data:{grounded:true,reports_result:true,reason:'只描述了当前区域的搜索过程',unsupported_claims:[]}};
      throw Error('unexpected model call');
    }});
    vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'你沿着附近街区找了一阵，没有发现符合条件的地点。',minutes:8,target_id:null,
      facts:['进行了 8 分钟的搜索。'],relationship:null,item_move:null,storage_move:null,completion_quote:null,
      required_conditions:[],blocker:null,resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',stakes:'寻找目标',visibility:'public',stages:[],evidence_ids:[]}} as never);
    vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你沿着街区找了一阵，仍没有发现符合条件的地点。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
    const store=new MemoryStore(),service=new GameService(store,ai,demo);await service.newGame();
    const before=await service.current();
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'找吸血鬼城堡'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',player_speech_mode:'none',open_goal_context:{destination:null,
        continuation:kind==='none'?'natural_interaction_if_available':'none',
        search_query:'吸血鬼城堡',travel_after_discovery:true}} as never);
    const after=await service.current();
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(after.map_state.dynamic_locations).toHaveLength(0);
    expect(after.resolution_receipts?.some(receipt=>receipt.commit_status==='committed'&&receipt.effects.includes('time'))).toBe(true);
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',stage:'open_goal_continuation',goal_status:'unresolved'});
    expect(result.presentation).toBe('story');
    expect(result.message).not.toMatch(/location_id|proposal|schema|transaction|capability/);
    expect(result.message).toContain('找了一阵');
    expect(result.message).not.toContain('搜索 吸血鬼城堡');
  });

  it('continues from a local miss to a reachable area within the step budget',async()=>{
    let plans=0;
    const ai=new AIRuntime({name:'scripted',generate:async request=>{
      const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(props.location_id&&props.proposal)return {data:found('none')};
      if(props.decision){plans++;return {data:{decision:'transaction',
        transaction:{kind:'move',destination:'河岸车站',minutes:null,reason:'去另一个公开区域寻找'},reason:null,question:null}};}
      throw Error('unexpected model call');
    }});
    vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'搜索了当前区域。',minutes:5,target_id:null,
      facts:['没有发现新的地点线索。'],relationship:null,item_move:null,storage_move:null,completion_quote:null,
      required_conditions:[],blocker:null,resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',stakes:'寻找地点',
        visibility:'public',stages:[],evidence_ids:[]}} as never);
    vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你走过这一带，仍未发现目标。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
    const service=new GameService(new MemoryStore(),ai,demo);await service.newGame();
    const before=await service.current();
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'去找一家能听现场音乐的地方'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none',
        search_query:'能听现场音乐的地方',travel_after_discovery:true}} as never);
    const after=await service.current();
    expect(plans).toBe(1);
    expect(after.resolution_receipts).toHaveLength(3);
    expect(after.resolution_receipts?.[0]?.effects).toContain('time');
    expect(after.resolution_receipts?.[1]?.semantic_action).toBe('MOVE');
    expect(after.resolution_receipts?.[2]?.effects).toContain('time');
    expect(new Set(after.resolution_receipts?.map(receipt=>receipt.request_id)).size).toBe(3);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id).toBe('station');
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',goal_status:'unresolved'});
    expect(result.outcome).toMatchObject({completed_steps:expect.arrayContaining([
      '在中央广场寻找能听现场音乐的地方','到达 河岸车站','在河岸车站寻找能听现场音乐的地方'])});
    expect(result.message).not.toMatch(/在中央广场寻找|在河岸车站寻找|FREEFORM_ACTION/);
    expect(after.map_state.dynamic_locations).toHaveLength(0);
  });

  it('uses a planned inquiry with a present person without treating it as completion of the location search',async()=>{
    let planned=0,scenes=0;
    const ai=new AIRuntime({name:'scripted',generate:async request=>{
      const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(props.location_id&&props.proposal)return {data:found('none')};
      if(props.decision){planned++;return {data:{decision:'scene',transaction:null,reason:'询问在场居民有无线索',question:null}};}
      if(props.understanding){scenes++;return {data:{understanding:'询问当地地点',narrative:'你向广场上的居民询问线索。',
        dialogue:'我还没听说过。',speech_events:[
          {speaker_id:'player',utterance:'请问附近有能听现场音乐的地方吗？',provenance:'generated_from_player_intent'},
          {speaker_id:'npc_lin',utterance:'我还没听说过。',provenance:'npc_response'}],effects:[]}};}
      if(props.verdict)return {data:{verdict:'aligned',explanation:'只询问原目标的地点线索。'}};
      throw Error('unexpected model call');
    }});
    vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'你找了一阵。',minutes:5,target_id:null,
      facts:['没有发现新的地点线索。'],relationship:null,item_move:null,storage_move:null,completion_quote:null,
      required_conditions:[],blocker:null,resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',stakes:'寻找地点',
        visibility:'public',stages:[],evidence_ids:[]}} as never);
    vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你找了一阵，暂时没有线索。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
    const service=new GameService(new MemoryStore(),ai,demo);await service.newGame();
    const before=await service.current();
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'我去找一家能听现场音乐的酒吧'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',player_speech_mode:'none',open_goal_context:{destination:null,
        continuation:'natural_interaction_if_available',search_query:'能听现场音乐的酒吧',travel_after_discovery:true}} as never);
    const after=await service.current();
    expect(planned).toBe(1);expect(scenes).toBe(1);
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(after.interaction_context?.target_entity_id).toBe('npc_lin');
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',stage:'open_goal_search_inquiry',goal_status:'unresolved'});
    expect(result.message).toContain('你向广场上的居民询问线索。');
    expect(result.message).not.toContain('在中央广场寻找能听现场音乐的酒吧');
  });

  it('reports an unavailable location provider as engine failure before searching',async()=>{
    const ai=new AIRuntime({name:'scripted',generate:async()=>{throw Error('provider unavailable');}});
    const service=new GameService(new MemoryStore(),ai,demo);await service.newGame();
    const before=await service.current();
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'去寻找一家旅馆'},undefined,null,false,
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none',
        search_query:'旅馆',travel_after_discovery:true}} as never);
    const after=await service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(result.outcome).toMatchObject({type:'engine_failure',stage:'location_exploration'});
    expect(after.resolution_receipts??[]).toHaveLength(0);
  });
});

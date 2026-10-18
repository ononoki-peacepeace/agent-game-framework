import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {validateSave,publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {readFile} from 'node:fs/promises';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {compileWorld} from '../src/ai/authoring.js';
import {readProfile} from '../src/ai/profiles.js';
import {newSave} from '../src/core/state.js';
import {commitRegionExpansion,regionFrontier} from '../src/core/region-expansion.js';
import {handleAgentInput} from '../src/agent/executor.js';

const expansionProposal={name:'东部街区',width:9,height:9,
  entry:{name:'东部街口',description:'与旧区相接的普通街口。',x:0,y:4},
  places:[{key:'library',name:'东区图书馆',description:'街区内一间公开的图书馆。',x:2,y:4}],
  routes:[{from:'entry',to:'library',travel_minutes:4},
    {from:'library',to:'entry',travel_minutes:4}],
  gateway_minutes:3,return_gateway:true,
  geographic_basis:'世界设定明确允许城区向东自然延伸，街口与普通图书馆均是与既有街区一致的公共地点。'};

async function expandable(){
  const f=await sparseSetup(),save=await f.service.current();
  save.definition.map!.regions=[{id:'center',name:'中心区',scope_location_id:null,width:5,height:5,expansion:'allowed'}];
  save.definition.map!.locations.find(location=>location.id==='square')!.spatial={region_id:'center',x:4,y:2};
  await f.store.write(save);
  return {f,save};
}

async function regions(){
  const f=await sparseSetup(),save=await f.service.current();
  const origin=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
  save.definition.map!.regions=[
    {id:'center',name:'中心区',scope_location_id:null,width:5,height:5,expansion:'closed'},
    {id:'east',name:'东区',scope_location_id:null,width:9,height:9,expansion:'closed'},
  ];
  save.definition.map!.locations.find(location=>location.id===origin)!.spatial={region_id:'center',x:2,y:2};
  save.definition.map!.locations.push(
    {id:'center_exit',name:'中心区东口',description:'区域出口',tags:[],spatial:{region_id:'center',x:4,y:2}},
    {id:'east_entry',name:'东区西口',description:'区域入口',tags:[],spatial:{region_id:'east',x:0,y:4}},
    {id:'east_library',name:'东区图书馆',description:'已登记的图书馆',tags:[],spatial:{region_id:'east',x:2,y:4}},
  );
  save.map_state.known_location_ids.push('center_exit','east_entry','east_library');
  save.definition.map!.routes.push(
    {from:origin,to:'center_exit',travel_minutes:2,conditions:[]},
    {from:'center_exit',to:'east_entry',travel_minutes:3,conditions:[],gateway:{from_region_id:'center',to_region_id:'east',exit_direction:'east',entry_direction:'west'}},
    {from:'east_entry',to:'center_exit',travel_minutes:3,conditions:[],gateway:{from_region_id:'east',to_region_id:'center',exit_direction:'west',entry_direction:'east'}},
    {from:'east_entry',to:'east_library',travel_minutes:4,conditions:[]},
    {from:'east_library',to:'east_entry',travel_minutes:4,conditions:[]},
  );
  return {save,origin};
}
describe('registered map regions share the authoritative directed MOVE graph',()=>{
  it('persists one reviewed frontier expansion with stable return gateway and no coordinate-only travel',async()=>{
    const {save}=await expandable();
    expect(regionFrontier(save,'square','east')).not.toBeNull();
    const created=commitRegionExpansion(save,'square','east',expansionProposal,
      {supported:true,reason:'既有公开地理支持相邻普通街区'});
    const reloaded=validateSave(JSON.parse(JSON.stringify(save)));
    expect(reloaded.map_state.dynamic_regions).toHaveLength(1);
    expect(reloaded.map_state.dynamic_locations).toHaveLength(2);
    expect(reloaded.definition.map?.regions).toHaveLength(1);
    expect(publicView(reloaded).regions?.some(region=>region.id===created.region_id)).toBe(true);
    const out=executeAction(reloaded,{type:'MOVE',target_id:created.entry_id,parameters:{}},randomUUID(),'player');
    expect(out.save.resolution_receipts!.at(-1)?.movement_route?.location_ids)
      .toEqual(['square',created.entry_id]);
    expect(out.save.resolution_receipts!.at(-1)?.time_cost).toBe(3);
    const back=executeAction(out.save,{type:'MOVE',target_id:'square',parameters:{}},randomUUID(),'player');
    expect(back.save.resolution_receipts!.at(-1)?.movement_route?.location_ids)
      .toEqual([created.entry_id,'square']);
    expect(()=>commitRegionExpansion(reloaded,'square','east',expansionProposal,
      {supported:true,reason:'重复生成'})).toThrow();
  });
  it('blocks generation without an allowed, occupied and geographically valid frontier',async()=>{
    const {save}=await expandable();
    expect(regionFrontier(save,'square','west')).toBeNull();
    expect(()=>commitRegionExpansion(save,'square','west',expansionProposal,
      {supported:true,reason:'不应通过'})).toThrow();
    save.definition.map!.regions![0].expansion='closed';
    expect(regionFrontier(save,'square','east')).toBeNull();
    expect(()=>commitRegionExpansion(save,'square','east',expansionProposal,
      {supported:true,reason:'不应通过'})).toThrow();
    expect(save.map_state.dynamic_regions).toHaveLength(0);
  });
  it('uses a bounded open-goal expansion then an ordinary MOVE, retaining both across save reload',async()=>{
    let decisionCalls=0,proposalCalls=0,reviewCalls=0;
    const f=await sparseSetup(async request=>{
      const fields=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(fields.decision){decisionCalls++;return {data:{decision:'transaction',transaction:{kind:'expand',
        destination:null,direction:'east',minutes:null,reason:'获准延伸的东部边界'},reason:null,question:null}} as never;}
      if(fields.entry&&fields.places){proposalCalls++;return {data:expansionProposal} as never;}
      if(fields.supported){reviewCalls++;return {data:{supported:true,reason:'世界普通城区设定支持'}} as never;}
      if(request.role==='narrator')return {data:{narrative:'你穿过东边街口，来到相邻街区。',
        speaker:null,dialogue:null,choices:[],patches:[]}} as never;
      throw Error('unexpected provider call');
    });
    const before=await f.service.current();
    before.definition.map!.regions=[{id:'center',name:'中心区',scope_location_id:null,width:5,height:5,expansion:'allowed'}];
    before.definition.map!.locations.find(location=>location.id==='square')!.spatial={region_id:'center',x:4,y:2};
    await f.store.write(before);
    const input='沿已获准延伸的东边街口继续探索。';
    const body={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input};
    const semantic={kind:'world_action',interaction_lane:'open_goal',goal_spec:{objective:input,play_action:'move',
        targets:[],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',
        temporal:{at:null,recurrence:null},dependencies:['到达边界外后观察当地公开环境'],world_mutation:true,external_artifact:false,
        multi_step:true,ambiguity:null},open_goal_context:{destination:null,continuation:'none',
        route_choice:true,search_query:null},player_speech_mode:'none'} as never;
    const result=await handleAgentInput(f.service,body,undefined,null,false,semantic);
    const after=validateSave(JSON.parse(JSON.stringify(await f.service.current())));
    expect([decisionCalls,proposalCalls,reviewCalls]).toEqual([1,1,1]);
    expect(after.map_state.dynamic_regions).toHaveLength(1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id)
      .toBe(after.map_state.dynamic_locations.find(location=>location.name==='东部街口')?.id);
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(3);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    const replay=await handleAgentInput(f.service,body,undefined,null,false,semantic);
    expect(replay.view?.revision).toBe(after.state_revision);
    expect((await f.service.current()).map_state.dynamic_regions).toHaveLength(1);
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
  });
  it('compiles spatial regions from an initializer candidate and reloads the old-compatible save',async()=>{
    const candidate=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
    candidate.regions=[{id:'square_area',name:'广场区',scope_location_id:null,width:5,height:5,expansion:'closed'},
      {id:'market_area',name:'商店区',scope_location_id:null,width:9,height:9,expansion:'closed'}];
    candidate.locations.find((place:{id:string})=>place.id==='square').spatial={region_id:'square_area',x:4,y:2};
    candidate.locations.find((place:{id:string})=>place.id==='market').spatial={region_id:'market_area',x:0,y:4};
    for(const route of candidate.routes)if(route.from==='square'&&route.to==='market')
      route.gateway={from_region_id:'square_area',to_region_id:'market_area',exit_direction:'east',entry_direction:'west'};
    else if(route.from==='market'&&route.to==='square')
      route.gateway={from_region_id:'market_area',to_region_id:'square_area',exit_direction:'west',entry_direction:'east'};
    const save=newSave(compileWorld(worldInitializationSchema.parse(candidate),
      await readProfile('content/profiles/default.json')));
    const reloaded=validateSave(JSON.parse(JSON.stringify(save)));
    expect(reloaded.definition.map?.regions).toHaveLength(2);
    expect(publicView(reloaded).regions?.map(region=>region.name)).toEqual(['广场区','商店区']);
  });
  it('traverses different-sized regions through stable gateway anchors with one receipt',async()=>{
    const {save,origin}=await regions();
    const view=publicView(validateSave(save));
    expect(view.regions?.map(region=>region.id)).toEqual(['center','east']);
    expect(view.routes.find(route=>route.from==='center_exit'&&route.to==='east_entry')?.gateway)
      .toMatchObject({exit_direction:'east',entry_direction:'west'});
    const moved=executeAction(save,{type:'MOVE',target_id:'east_library',parameters:{}},randomUUID(),'player');
    const receipt=moved.save.resolution_receipts!.at(-1)!;
    expect(receipt.movement_route?.location_ids).toEqual([origin,'center_exit','east_entry','east_library']);
    expect(receipt.time_cost).toBe(9);
    expect(moved.save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id)
      .toBe('east_library');
    const returning=executeAction(moved.save,{type:'MOVE',target_id:'center_exit',parameters:{}},randomUUID(),'player');
    expect(returning.save.resolution_receipts!.at(-1)?.movement_route?.location_ids)
      .toEqual(['east_library','east_entry','center_exit']);
  });
  it('rejects a missing or geometrically false gateway instead of inventing a map crossing',async()=>{
    const {save}=await regions();
    const route=save.definition.map!.routes.find(route=>route.from==='center_exit'&&route.to==='east_entry')!;
    delete route.gateway;
    expect(()=>validateSave(save)).toThrow('跨地图区域路线');
    route.gateway={from_region_id:'center',to_region_id:'east',exit_direction:'west',entry_direction:'west'};
    expect(()=>validateSave(save)).toThrow('边界坐标');
  });
  it('never infers passage from adjacent coordinates without a registered route',async()=>{
    const {save}=await regions();
    save.definition.map!.routes=save.definition.map!.routes.filter(route=>route.from!=='center_exit'||route.to!=='east_entry');
    expect(()=>executeAction(save,{type:'MOVE',target_id:'east_entry',parameters:{}},randomUUID(),'player')).toThrow();
  });
});

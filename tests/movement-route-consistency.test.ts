import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {executeAction} from '../src/core/runtime.js';
import {validateMovementNarrative,canonicalMovementNarrative} from '../src/core/narrative-firewall.js';
import {publicView} from '../src/core/state.js';
import {routePath} from '../src/core/map.js';
import type {SavePackage} from '../src/core/schema.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';

const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
async function fixture(){
  const f=await sparseSetup();const save=await f.service.current();
  const origin=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
  const places=[['way_a','回廊'],['way_b','露台'],['way_c','塔楼'],['way_hidden','隐秘小径']] as const;
  save.definition.map!.locations.push(...places.map(([id,name])=>({id,name,description:`${name}的空间。`,tags:[],known_by_default:id!=='way_hidden'})));
  save.map_state.known_location_ids.push('way_a','way_b','way_c');
  save.definition.map!.routes.push(
    {from:origin,to:'way_a',travel_minutes:3,conditions:[]},
    {from:'way_a',to:'way_c',travel_minutes:4,conditions:[]},
    {from:origin,to:'way_b',travel_minutes:9,conditions:[]},
    {from:'way_b',to:'way_c',travel_minutes:2,conditions:[]},
    {from:origin,to:'way_c',travel_minutes:1,conditions:[{flag:'bridge_open',equals:true}]},
    {from:origin,to:'way_hidden',travel_minutes:1,conditions:[]},
    {from:'way_hidden',to:'way_c',travel_minutes:1,conditions:[]},
  );
  save.gm_state.flags.bridge_open=false;
  await f.store.write(save);
  return {...f,save,origin};
}
function moved(save:SavePackage,target_id:string){
  return executeAction(save,{type:'MOVE',target_id,parameters:{}},randomUUID(),'player',()=>0.5);
}
describe('authoritative movement route',()=>{
  it('records the selected directed path, costs, conditions and actual clock',async()=>{
    const {save,origin}=await fixture();const result=moved(save,'way_c');
    const receipt=result.save.resolution_receipts!.at(-1)!;
    expect(receipt.movement_route).toMatchObject({origin_id:origin,destination_id:'way_c',
      location_ids:[origin,'way_a','way_c'],total_minutes:7,
      edges:[{travel_minutes:3,kind:'registered',conditions:[]},{travel_minutes:4,kind:'registered',conditions:[]}]});
    expect(receipt.time_cost).toBe(7);
    expect(result.save.runtime.time.minute-save.runtime.time.minute).toBe(7);
    expect(result.save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id).toBe('way_c');
    expect(publicView(save).routes.some(edge=>edge.to==='way_hidden')).toBe(false);
    expect(publicView(save).routes.some(edge=>edge.from===origin&&edge.to==='way_c')).toBe(false);
    expect(routePath(publicView(save).routes,origin,'way_c')?.map(edge=>edge.to)).toEqual(['way_a','way_c']);
  });
  it('moves only consenting present NPCs on the same authoritative route and clock',async()=>{
    const {save,origin}=await fixture();
    const consenting=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    consenting.components.location={location_id:origin};
    const refusing=structuredClone(consenting);refusing.id='npc_refusing';
    const conditional=structuredClone(consenting);conditional.id='npc_conditional';
    save.entities.push(refusing,conditional);
    save.npc_agent_state??={};
    save.npc_agent_state[consenting.id]={...emptyNpcAgentState(),travel_intent:{status:'willing',
      origin_location_id:origin,source_request_id:randomUUID(),recorded_revision:save.state_revision}};
    save.npc_agent_state[refusing.id]={...emptyNpcAgentState(),travel_intent:{status:'declined',
      origin_location_id:origin,source_request_id:randomUUID(),recorded_revision:save.state_revision}};
    save.npc_agent_state[conditional.id]={...emptyNpcAgentState(),travel_intent:{status:'conditional',
      origin_location_id:origin,source_request_id:randomUUID(),recorded_revision:save.state_revision}};
    const result=moved(save,'way_c');
    expect(result.save.runtime.time.minute-save.runtime.time.minute).toBe(7);
    expect(result.save.resolution_receipts!.at(-1)?.movement_route?.location_ids).toEqual([origin,'way_a','way_c']);
    expect(result.save.entities.find(entity=>entity.id===consenting.id)?.components.location?.location_id).toBe('way_c');
    expect(result.save.entities.find(entity=>entity.id===refusing.id)?.components.location?.location_id).toBe(origin);
    expect(result.save.entities.find(entity=>entity.id===conditional.id)?.components.location?.location_id).toBe(origin);
    expect(result.save.npc_agent_state?.[consenting.id].travel_intent?.origin_location_id).toBe('way_c');
  });
  it('does not teleport a willing NPC who is no longer at the departure point',async()=>{
    const {save,origin}=await fixture();
    const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    npc.components.location={location_id:'way_a'};
    save.npc_agent_state??={};
    save.npc_agent_state[npc.id]={...emptyNpcAgentState(),travel_intent:{status:'willing',
      origin_location_id:origin,source_request_id:randomUUID(),recorded_revision:save.state_revision}};
    expect(moved(save,'way_c').save.entities.find(entity=>entity.id===npc.id)?.components.location?.location_id).toBe('way_a');
  });
  it('respects direction and does not cross unavailable or undiscovered edges',async()=>{
    const {save}=await fixture();
    const atTower=moved(save,'way_c').save;
    expect(()=>moved(atTower,'way_a')).toThrow();
    expect(()=>moved(save,'way_hidden')).toThrow();
    save.gm_state.flags.bridge_open=true;
    expect(moved(save,'way_c').save.resolution_receipts!.at(-1)?.movement_route?.edges).toMatchObject([
      {from:String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id),to:'way_c',travel_minutes:1,
        conditions:[{flag:'bridge_open',equals:true}]}]);
  });
  it('rejects invented waypoint, shortcut, duration and door mutation while permitting literary travel',async()=>{
    const {save}=await fixture();const result=moved(save,'way_c');const receipt=result.save.resolution_receipts!.at(-1)!;
    expect(()=>validateMovementNarrative(receipt,narration('你经过露台，来到塔楼。'),result.save)).toThrow();
    expect(()=>validateMovementNarrative(receipt,narration('你直接来到塔楼。'),result.save)).toThrow();
    expect(()=>validateMovementNarrative(receipt,narration('你走了六分钟，来到塔楼。'),result.save)).toThrow();
    expect(()=>validateMovementNarrative(receipt,narration('你推开铁门，来到塔楼。'),result.save)).toThrow();
    expect(()=>validateMovementNarrative(receipt,narration('你推开通往塔楼的那道铁门，来到塔楼。'),result.save)).toThrow();
    expect(()=>validateMovementNarrative(receipt,narration('你来到塔楼，合计约六分钟。'),result.save)).toThrow();
    expect(()=>validateMovementNarrative(receipt,narration('回廊的光影随脚步变换，你来到塔楼。'),result.save)).not.toThrow();
    expect(canonicalMovementNarrative(receipt,result.save)).toContain('途经回廊');
  });
  it('regenerates an invalid narrative without executing movement twice',async()=>{
    const f=await fixture();const before=f.save;
    const narrate=vi.spyOn(f.ai,'narrate')
      .mockResolvedValueOnce(narration('你经过露台，来到塔楼。') as never)
      .mockResolvedValueOnce(narration('你穿过回廊，来到塔楼。') as never);
    const requestId=randomUUID();
    await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:requestId,
      action:{type:'MOVE',target_id:'way_c',parameters:{}}});
    const after=await f.service.current();
    expect(narrate).toHaveBeenCalledTimes(2);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(7);
    expect(after.resolution_receipts?.filter(receipt=>receipt.request_id===requestId)).toHaveLength(1);
    expect(after.last_turn?.narrative).toContain('回廊');
  });
  it('falls back to receipt-backed prose after bounded narrator rejection',async()=>{
    const f=await fixture();const before=f.save;
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration('你经过露台，来到塔楼。') as never);
    const requestId=randomUUID();
    await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:requestId,
      action:{type:'MOVE',target_id:'way_c',parameters:{}}});
    const after=await f.service.current();
    expect(after.last_turn?.narrative).toContain('途经回廊');
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(7);
    expect(after.resolution_receipts?.filter(receipt=>receipt.request_id===requestId)).toHaveLength(1);
  });
});

import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {visibleRouteEdges} from '../src/client/panels.js';
import {narrativeResultSchema} from '../src/ai/contracts.js';
import {addDynamicLocation,routePath} from '../src/core/map.js';
import {playerFacingError} from '../src/server/app.js';

const prose=(extra:Record<string,unknown>={})=>({narrative:'你等了一分钟。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,...extra});

describe('Batch 2.2 parent-level map and narrator contract',()=>{
  it('projects a sibling route through the parent while the player remains at that parent',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const parent=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id??'');
    addDynamicLocation(save,{id:'old_child_a',name:'子区甲',description:'',tags:[],parent_id:parent,known_by_default:true},[
      {from:'old_child_a',to:parent,travel_minutes:3,conditions:[]},{from:parent,to:'old_child_a',travel_minutes:3,conditions:[]}]);
    addDynamicLocation(save,{id:'old_child_b',name:'子区乙',description:'',tags:[],parent_id:parent,known_by_default:true},[
      {from:parent,to:'old_child_b',travel_minutes:5,conditions:[]},{from:'old_child_b',to:parent,travel_minutes:5,conditions:[]}]);
    const view=f.service.project(save),children=view.locations.filter(location=>location.parent_id===parent);
    expect(view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id).toBe(parent);
    expect(view.routes.some(route=>route.from==='old_child_a'&&route.to==='old_child_b')).toBe(false);
    expect(routePath(view.routes,'old_child_a','old_child_b')?.map(route=>route.to)).toEqual([parent,'old_child_b']);
    expect(visibleRouteEdges(view,children).get('old_child_a::old_child_b')).toEqual({from:'old_child_a',to:'old_child_b',travel_minutes:8,indirect:true});
  });

  it.each([
    ['null',{item_claims:null,stable_locations:null}],
    ['omitted',{}],
    ['empty arrays',{item_claims:[],stable_locations:[]}],
  ])('normalizes %s optional narrative claims to arrays',(_label,claims)=>{
    const parsed=narrativeResultSchema.parse(prose(claims));
    expect(parsed.item_claims).toEqual([]);expect(parsed.stable_locations).toEqual([]);
  });

  it('commits null claims once, but a malformed result leaves time/revision/state untouched and can retry',async()=>{
    let malformed=true;
    const f=await sparseSetup(async request=>{
      if(request.role!=='narrator')throw Error('unexpected provider call');
      return {data:malformed?prose({item_claims:'invalid',stable_locations:null}):prose({item_claims:null,stable_locations:null})};
    });
    const before=await f.service.current();
    const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'WAIT',parameters:{minutes:1}}};
    let failure:unknown;
    try{await f.service.turn(request);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(Error);
    expect(playerFacingError(failure)).not.toMatch(/item_claims|stable_locations|Zod|Invalid input|expected array/);
    expect(f.ai.last?.reason).toBe('schema');
    expect(await f.service.current()).toEqual(before);
    malformed=false;
    const after=await f.service.turn(request);
    expect(after.revision).toBe(before.state_revision+1);
    expect(after.time.minute).toBe(before.runtime.time.minute+1);
    expect((await f.service.current()).runtime.receipts.filter(receipt=>receipt.id===request.request_id)).toHaveLength(1);
  });
});

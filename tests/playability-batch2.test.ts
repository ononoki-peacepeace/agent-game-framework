import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {sparseSetup} from './sparse-fixture.js';
import {distinctChoices} from '../src/ai/choice-diversity.js';
import {applyNarrativeClaims} from '../src/core/narrative-claims.js';
import {routePath} from '../src/core/map.js';
import {executeAction} from '../src/core/runtime.js';
import {publicView} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {sceneAffordances} from '../src/agent/scene-affordances.js';
import {panelRegistry} from '../src/client/panels.js';
import {ProviderError} from '../src/ai/failures.js';
import {DeepSeekAdapter} from '../src/ai/deepseek.js';
import type {AIRequest} from '../src/ai/contracts.js';
import type {PublicView} from '../src/shared/contracts.js';
import type {Inventory} from '../src/modules/inventory.js';
import {ensureOrdinaryItem} from '../src/modules/inventory.js';

const prose=(narrative:string,extra:Record<string,unknown>={})=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,...extra});
const tx=async(service:Awaited<ReturnType<typeof sparseSetup>>['service'],request_id=randomUUID())=>{const save=await service.current();return {request_id,game_id:save.game_id,expected_revision:save.state_revision,action:{type:'WAIT',parameters:{minutes:1}}};};
const claim=(name:string,placement:'held'|'inside_container'|'scene'|'incidental',container_name:string|null=null)=>({name,placement,container_name,position_label:null,weight:0.2,container:false});

describe('Batch 2 canonical scene claims and safety',()=>{
  it('folds choices with identical intent, immediate consequence and target',()=>{
    const choices=['去长椅旁坐下','到长椅那里坐着','先检查门口'];
    expect(distinctChoices(choices,[
      {index:0,intent_key:'sit',consequence_key:'rest at bench',target_id:'bench'},
      {index:1,intent_key:'sit',consequence_key:'rest at bench',target_id:'bench'},
      {index:2,intent_key:'inspect',consequence_key:'observe door',target_id:'door'},
    ])).toEqual([choices[0],choices[2]]);
  });
  it('keeps different scene characters contextual instead of reducing both to generic action families',async()=>{
    const f=await sparseSetup(async request=>{
      if(request.role!=='gm_reasoning')throw Error('unexpected provider call');
      const context=JSON.parse(request.prompt.match(/\{\"instruction\"[\s\S]*$/)?.[0]??'{}') as any;
      expect(context.scene).toBeTruthy();expect(context.capabilities).toBeTruthy();expect(context.actions).toBeTruthy();
      return {data:context.candidates.map((candidate:any)=>({target_id:candidate.id,label:candidate.role==='访客'?'讨论旅途':'询问街坊近况',intent:`我向${candidate.name}${candidate.role==='访客'?'讨论旅途':'询问街坊近况'}`,family:'communicate'}))};
    });
    const save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const people=save.entities.filter(e=>e.id!==player.id&&e.components.character);
    expect(people.length).toBeGreaterThan(0);
    people[0].components.character.role='住民';
    const second=structuredClone(people[0]);second.id='npc_context_second';second.components.identity.name='另一位人物';second.components.character.role='访客';
    second.components.location={location_id:player.components.location?.location_id};save.entities.push(second);
    people[0].components.location={location_id:player.components.location?.location_id};await f.store.write(save);
    const suggestions=await sceneAffordances(f.service);
    expect(new Set(suggestions.map(item=>item.target_id))).toEqual(new Set([people[0].id,second.id]));
    expect(new Set(suggestions.map(item=>item.label)).size).toBe(2);
  });
  it('materializes held and nested ordinary objects without inventing a second inventory',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    applyNarrativeClaims(save,prose('你拿着布袋，袋中有一枚铜纽扣。',{item_claims:[{...claim('布袋','held'),container:true},claim('铜纽扣','inside_container','布袋')]}));
    const player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const bag=save.entities.find(e=>e.components.identity?.name==='布袋')!,button=save.entities.find(e=>e.components.identity?.name==='铜纽扣')!;
    const inventory=player.components.inventory as Inventory;
    expect(inventory.items[bag.id]).toBe(1);
    expect(inventory.items[button.id]).toBe(1);
    expect(inventory.placements?.[button.id]).toBe(bag.id);
    expect(button.components.location).toBeUndefined();
    const inventoryHtml=renderToStaticMarkup(createElement(panelRegistry.inventory,{view:publicView(save),busy:false} as any));
    expect(inventoryHtml).toContain('<details');expect(inventoryHtml).toContain('铜纽扣');
    const moved=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:button.id,to:'scene',container_id:null,position_label:'桌面'}},randomUUID()).save;
    expect(moved.entities.find(e=>e.id===button.id)?.components.location?.location_id).toBe(player.components.location?.location_id);
    expect(moved.entities.find(e=>e.id===button.id)?.components.scene_position?.label).toBe('桌面');
    expect((moved.entities.find(e=>e.id===moved.player_state.entity_id)?.components.inventory as Inventory).items[button.id]).toBeUndefined();
  });
  it('can upgrade an existing ordinary item into a container in the same validated turn',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const bag=ensureOrdinaryItem(save,'布袋',0.3,false);
    bag.components.location={location_id:String(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id??'')};
    applyNarrativeClaims(save,prose('你带上布袋，里面放着一枚木扣。',{item_claims:[{...claim('布袋','held'),container:true},claim('木扣','inside_container','布袋')]}));
    expect(bag.components.item.container).toBe(true);
    expect((save.entities.find(e=>e.id===save.player_state.entity_id)?.components.inventory as Inventory).placements?.[save.entities.find(e=>e.components.identity?.name==='木扣')!.id]).toBe(bag.id);
  });
  it('tracks incidental objects at the scene without silently granting ownership',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    applyNarrativeClaims(save,prose('窗台有一块碎木片。',{item_claims:[claim('碎木片','incidental')]}));
    const item=save.entities.find(e=>e.components.identity?.name==='碎木片')!;
    expect(item.components.item.tracking).toBe('incidental');
    expect(item.components.location?.location_id).toBe(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id);
    expect((save.entities.find(e=>e.id===save.player_state.entity_id)?.components.inventory as Inventory).items[item.id]).toBeUndefined();
    const moved=executeFreeform(save,'我捡起碎木片',{narrative:'你捡起碎木片。',minutes:1,target_id:item.id,facts:['拾起碎木片'],relationship:null,item_move:{item_id:item.id,to:'held',position_label:null},
      resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'拾起已在场景中的物品',stages:[],evidence_ids:[]}},randomUUID()).save;
    expect(moved.entities.find(e=>e.id===item.id)?.components.item.tracking).toBe('tracked');
    expect((moved.entities.find(e=>e.id===moved.player_state.entity_id)?.components.inventory as Inventory).items[item.id]).toBe(1);
  });
  it('promotes only recurring interactive sublocations into the existing map hierarchy',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const here=save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id!;
    save.last_turn={narrative:'前方是可进入的候车室。',speaker:null,dialogue:null,choices:[],context_actions:[]};
    applyNarrativeClaims(save,prose('候车室的门仍开着。',{stable_locations:[{name:'候车室',parent_id:here,travel_minutes:2,reenterable:true,interactive:true},{name:'墙角',parent_id:here,travel_minutes:1,reenterable:false,interactive:false}]}));
    const child=save.map_state.dynamic_locations.find(e=>e.name==='候车室')!;
    expect(child.parent_id).toBe(here);
    expect(routePath(save.map_state.dynamic_routes,String(here),child.id)?.reduce((n,edge)=>n+edge.travel_minutes,0)).toBe(2);
    expect(save.map_state.dynamic_locations.some(e=>e.name==='墙角')).toBe(false);
  });
  it.each(['max_output_tokens','timeout'] as const)('keeps time and revision atomic when narration fails with %s, then safely retries',async reason=>{
    let fail=true;const f=await sparseSetup(async request=>{
      if(request.role==='narrator'){
        if(fail)throw new ProviderError(reason,'controlled failure','controlled failure');
        return {data:prose('你等了一分钟。')};
      }
      throw Error('unexpected provider call');
    });
    const before=await f.service.current(),request=await tx(f.service);
    await expect(f.service.turn(request)).rejects.toThrow('尚未结算');
    expect(await f.service.current()).toEqual(before);
    fail=false;await f.service.turn(request);
    const after=await f.service.current();expect(after.state_revision).toBe(before.state_revision+1);
    await f.service.turn(request);expect(await f.service.current()).toEqual(after);
  });
  it('rejects an actually incomplete DeepSeek response before parsing or returning game output',async()=>{
    let sentCap=0;
    const adapter=new DeepSeekAdapter({apiKey:'fixture',maxOutputTokens:1024,fetchImpl:async(_url,init)=>{
      sentCap=Number(JSON.parse(String(init?.body)).max_output_tokens);
      return new Response(JSON.stringify({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),{status:200});
    }});
    await expect(adapter.generate({role:'narrator',prompt:'fixture',schema:{type:'object',properties:{narrative:{type:'string'}},required:['narrative']},maxOutputTokens:6000})).rejects.toMatchObject({reason:'max_output_tokens'});
    expect(sentCap).toBe(1024);
  });
  it('rejects contradictory item claims before committing any turn state',async()=>{
    const f=await sparseSetup(async request=>request.role==='narrator'?{data:prose('你只是站着。',{item_claims:[claim('不存在于正文的物件','held')]})}:undefined);
    const before=await f.service.current();await expect(f.service.turn(await tx(f.service))).rejects.toThrow('尚未结算');
    expect(await f.service.current()).toEqual(before);
  });
  it('respects the provider output cap when framing narration budget',async()=>{
    const f=await sparseSetup();const requests:AIRequest[]=[];
    const adapter=(f.ai as any).adapter;
    adapter.providerInfo=()=>({provider:'fixture',maxOutputTokens:1024});
    const original=adapter.generate;
    adapter.generate=async(request:AIRequest)=>{requests.push(request);return request.role==='narrator'?{data:prose('你等了一分钟。')}:original(request);};
    await f.service.turn(await tx(f.service));
    expect(requests.find(request=>request.role==='narrator')?.maxOutputTokens).toBeLessThanOrEqual(1024);
    expect(requests.find(request=>request.role==='narrator')?.prompt).toContain('max_narrative_characters');
  });
  it('renders route travel time as an explicit visible map connection',async()=>{
    const f=await sparseSetup(),view=await f.service.view() as PublicView;
    const html=renderToStaticMarkup(createElement(panelRegistry.map,{view,busy:false} as any));
    expect(html).toContain('当前可达路线');expect(html).toContain('分钟');
  });
  it('shows an indirect path and its summed travel time without fabricating a direct edge',async()=>{
    const f=await sparseSetup(),view=await f.service.view() as PublicView;
    const here=String(view.entities.find(e=>e.id===view.player_id)?.components.location?.location_id??'');
    const middle=view.locations.find(location=>location.id!==here)!;
    const destination={...middle,id:'fixture_destination',name:'远处广场',parent_id:null};
    view.locations.push(destination);
    view.routes=[{from:here,to:middle.id,travel_minutes:3},{from:middle.id,to:destination.id,travel_minutes:7}];
    const html=renderToStaticMarkup(createElement(panelRegistry.map,{view,busy:false} as any));
    expect(routePath(view.routes,here,destination.id)?.map(edge=>edge.to)).toEqual([middle.id,destination.id]);
    expect(html).toContain('10 分钟');expect(html).toContain('途经');expect(html).toContain('map-route-indirect');
  });
});

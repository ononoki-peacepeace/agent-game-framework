import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {interpretSemanticEntry} from '../src/agent/semantic-entry.js';
import {actionBindingContext,authoritativeItemContext} from '../src/ai/action-context.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {applyLocationSearch,commitProposedLocation} from '../src/core/location-lifecycle.js';
import {executeFreeform,localDestination} from '../src/core/freeform.js';
import {publicView,validateSave} from '../src/core/state.js';
import {currentMap} from '../src/core/map.js';

const proposal={narrative:'检查当前地点',minutes:5,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'perception',band:'normal' as const,
    visibility:'public' as const,stakes:'普通巡视',stages:[],evidence_ids:[]}};
const prose={narrative:'你留意当前区域的情况，这次没有确认新的地点或线索。',speaker:null,
  dialogue:null,choices:[],context_actions:[],patches:[]};
const goal=(input:string)=>({kind:'world_action' as const,domain:'world' as const,operation_plane:'play' as const,
  original_user_request:input,
  confidence:.95,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
  player_speech_mode:'verbatim' as const,interaction_lane:'open_goal' as const,
  goal_spec:{objective:input,play_action:'move' as const,targets:[],constraints:[],desired_state:[],desired_outputs:[],
    persistence:'none' as const,temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,
    external_artifact:false,multi_step:true,ambiguity:null},
  open_goal_context:{destination:null,search_query:'附近尚未确认的区域',continuation:'none' as const,
    travel_after_discovery:true,event_sequence:[{kind:'speech' as const,timing:'before_move' as const,text:'一起探索吧。'},
      {kind:'move' as const,timing:null,text:null}],
    spatial_scope:{kind:'local_area' as const,reference:'附近区域',source_quote:input,anchor_id:null,excluded_destination_ids:[]}}});

describe('QA15–21 continuation and exploration reliability',()=>{
  it('continues the authorized local exploration after speech despite an unrelated NPC suggestion gap',async()=>{
    const f=await sparseSetup(async request=>{
      const keys=Object.keys((request.schema as any).properties??{});
      if(keys.includes('location_id'))return {data:{decision:'none',location_id:null,proposal:null,
        method:'none',reason:'本次没有可靠地点。'}};
      if(keys.includes('understanding'))return {data:{understanding:'出发前交流',narrative:'对方听完点了点头。',
        dialogue:'好。',speech_events:[{speaker_id:'player',utterance:'一起探索吧。',provenance:'verbatim_player_input'},
          {speaker_id:'npc_lin',utterance:'好。',provenance:'npc_response'}],
        effects:[{kind:'unsupported',reason:'人物建议了另一项无关活动。'}],travel_intents:[]}};
      throw Error('unexpected provider stage');
    });
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
    vi.spyOn(f.ai,'narrate').mockResolvedValue(prose as never);
    const save=await f.service.current(),input='我说：“一起探索吧。”然后探索附近未确认的区域，遇新区域就停下。';
    const body={game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),input};
    const result=await handleAgentInput(f.service,body,undefined,'npc_lin',false,goal(input));
    const after=await f.service.current();
    expect(result.outcome).toMatchObject({kind:'completed_no_result'});
    expect(after.state_revision).toBe(save.state_revision+2);
    expect(after.narrative_history?.at(-2)?.speech_events?.some(e=>e.utterance==='好。')).toBe(true);
    expect(after.resolution_receipts?.filter(r=>r.semantic_action.includes('巡视'))).toHaveLength(1);
    expect(after.runtime.time.minute-save.runtime.time.minute).toBe(5);
    expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('square');
    await handleAgentInput(f.service,body,undefined,'npc_lin',false,goal(input));
    expect((await f.service.current()).state_revision).toBe(after.state_revision);
    expect((await f.service.current()).runtime.time).toEqual(after.runtime.time);
  });
  it('feeds the concrete scene validation failure into one bounded repair without repeating actions',async()=>{
    const prompts:string[]=[];
    const f=await sparseSetup(async req=>{
      prompts.push(req.prompt);
      return {data:{understanding:'普通交流',narrative:'对方抬起头。',dialogue:'好。',
        speech_events:[{speaker_id:'player',utterance:'一起探索吧。',provenance:'verbatim_player_input'},
          {speaker_id:'npc_lin',utterance:'好。',provenance:'npc_response'}],effects:[],travel_intents:[],
        soft_contacts:prompts.length===1?[{npc_id:'npc_lin',action:'attempt',result:'active',
          description:'无依据接触',source_quote:'没有授权的接触'}]:[]}};
    });
    const save=await f.service.current(),input='一起探索吧。';
    const result=await handleAgentInput(f.service,{game_id:save.game_id,expected_revision:save.state_revision,
      request_id:randomUUID(),input},undefined,'npc_lin',false,
      {...goal(input),interaction_lane:'natural_scene',open_goal_context:null,goal_spec:null});
    expect(result.outcome).toMatchObject({kind:'completed'});
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('身体互动与玩家授权或已发生的接触状态不一致');
    expect((await f.service.current()).state_revision).toBe(save.state_revision+1);
  });
  it('never stores a stopping clause as scene position during a bounded no-discovery investigation',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const input='沿当前区域巡视，走到第一个能够到达的墙角时停下。';
    const turn=executeFreeform(before,input,proposal,randomUUID(),()=>0.5,true);
    expect(turn.save.entities.find(e=>e.id==='player')?.components.scene_position).toBeUndefined();
    expect(turn.save.resolution_receipts?.at(-1)?.effects).not.toContain('position');
    expect(localDestination('走到窗台旁时停下')).toBe('窗台旁');
    expect(turn.action.time_cost).toBe(5);
  });
  it('supports a sibling outdoor region through a nested courtyard anchor, then a child, reload and Undo',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.definition.map!.locations.push({id:'building',name:'建筑',description:'区域内的一栋建筑。',tags:[],parent_id:'square',kind:'building'},
      {id:'courtyard',name:'门外空地',description:'建筑外的连接点。',tags:[],parent_id:'building',kind:'area'});
    save.definition.map!.routes.push({from:'square',to:'building',travel_minutes:1,conditions:[]},
      {from:'building',to:'courtyard',travel_minutes:1,conditions:[]});
    save.map_state.known_location_ids.push('building','courtyard');
    save.entities.find(e=>e.id==='player')!.components.location={location_id:'courtyard'};
    await f.store.write(save);
    const p={name:'自然岸区',category:'shore',description:'连接门外空地的既有自然岸区。',parent_id:'square',anchor_id:'courtyard',
      travel_minutes:3,visibility:'public' as const,source_ref:'square',creation_reason:'原有区域的自然岸线与建筑外空地相接，此前尚未细化。'};
    await f.service.agentTransaction({game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID()},
      {exploration:'shore'},next=>{
        const region=commitProposedLocation(next,p,'existing_detail','test:shore');
        const child=commitProposedLocation(next,{...p,name:'岸区通道',category:'path',parent_id:region.id,anchor_id:region.id,
          source_ref:region.id},'existing_detail','test:path');
        expect(child.map_level).toBe((region.map_level??0)+1);
      });
    const after=await f.service.current(),loaded=validateSave(JSON.parse(JSON.stringify(after)));
    const region=loaded.map_state.dynamic_locations.find(l=>l.name==='自然岸区')!;
    expect(region.parent_id).toBe('square');
    expect(currentMap(loaded).routes).toEqual(expect.arrayContaining([expect.objectContaining({from:'courtyard',to:region.id,travel_minutes:3})]));
    // Existing but undiscovered sibling uses the real local edge, not a forced trip to its parent.
    loaded.map_state.known_location_ids=loaded.map_state.known_location_ids.filter(id=>id!==region.id);
    region.lifecycle!.visibility='locally_known';
    const found=applyLocationSearch(loaded,{decision:'discover',location_id:region.id,proposal:null,
      method:'local_exploration',reason:'沿当地真实连接发现。'},'探索区域',{supported:true,reason:'真实连接。'});
    expect(found.kind).toBe('discover');
    await f.service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    expect((await f.service.current()).map_state.dynamic_locations).toHaveLength(0);
  });
  it('normalizes unique public location names and gives precise quote diagnostics on the one repair',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),input='探索广场附近的区域。';let calls=0;
    vi.spyOn(f.ai,'systemAgent').mockImplementation(async(schema,_profile,data)=>{
      if('preserved' in (schema as any).shape){
        expect((data as any).instruction).toContain('仅授权到达首次确认');
        return {preserved:true,reason:'一致'} as never;
      }
      calls++;
      if(calls===2)expect((data as any).semantic_recovery.reason).toContain('spatial_scope.source_quote');
      const d=goal(input);d.player_speech_mode='none' as never;d.open_goal_context.event_sequence=[];
      d.open_goal_context.spatial_scope.anchor_id='中央广场' as never;
      d.open_goal_context.spatial_scope.source_quote=calls===1?'模型改写的原句':input;
      return d as never;
    });
    const decision=await interpretSemanticEntry(f.service,f.service.project(save),input,'WORLD');
    expect(calls).toBe(2);
    expect(decision?.open_goal_context?.spatial_scope?.anchor_id).toBe('square');
    expect((await f.service.current()).state_revision).toBe(save.state_revision);
  });
  it('trims binding UI/history payload while preserving original input, relevant targets and topology',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),view=f.service.project(save);
    view.last_turn={narrative:'重复历史'.repeat(6000),speaker:null,dialogue:null,choices:[],context_actions:[]};
    const compact=actionBindingContext(view,'去河岸车站，再调查附近。');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(view).length*.5);
    expect(compact.entities.some(e=>e.id==='player')).toBe(true);
    expect(compact.routes).toEqual(view.routes);
    expect(compact.locations.find(l=>l.id==='station')?.description).toBeTruthy();
    const requests:string[]=[];const ai=new AIRuntime({name:'fixture',generate:async req=>{
      requests.push(req.prompt);throw new ProviderError('max_output_tokens','controlled truncation','输出未完成');
    }});
    await expect(ai.interpret(save,'返回岔口，再探索右侧未确认区域。')).rejects.toMatchObject({reason:'max_output_tokens'});
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(requests.every(prompt=>prompt.includes('返回岔口，再探索右侧未确认区域。'))).toBe(true);
    expect((await f.service.current()).state_revision).toBe(save.state_revision);
  });
  it('exposes only authoritative held and visible item state to model binding',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const item=save.entities.find(entity=>entity.id==='notebook')!;
    item.components.location=structuredClone(player.components.location);
    const inventory=(player.components.inventory??={items:{}}) as {items:Record<string,number>;placements?:Record<string,string|null>};
    inventory.items[item.id]=1;inventory.placements??={};inventory.placements[item.id]=null;
    const view=publicView(save),items=authoritativeItemContext(view),context=actionBindingContext(view,'使用笔记本');
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({item_id:'notebook',name:'笔记本',quantity:1,placement:'held'})]));
    expect(context.authoritative_inventory).toEqual(expect.arrayContaining([expect.objectContaining({item_id:'notebook',placement:'held'})]));
    expect(context.visible_scene_items).not.toEqual(expect.arrayContaining([expect.objectContaining({item_id:'notebook',placement:'held'})]));
  });
});

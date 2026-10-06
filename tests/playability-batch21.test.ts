import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {groupAffordances} from '../src/client/affordances.js';
import {visibleRouteEdges} from '../src/client/panels.js';
import {narrativeBudget,narrativeCharacterLimit} from '../src/ai/runtime.js';
import {addDynamicLocation,routePath} from '../src/core/map.js';
import {localDestination,knownDestination} from '../src/core/freeform.js';
import {executableChoices} from '../src/core/choice-availability.js';
import {executeAction} from '../src/core/runtime.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {executePlan} from '../src/agent/executor.js';
import {sceneAffordances} from '../src/agent/scene-affordances.js';
import type {PublicView,ContextActionSuggestion} from '../src/shared/contracts.js';

const goals=(room:string)=>[
  {goal_id:'enter',type:'WORLD_ACTION',normalized_goal:`进入${room}`,depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
  {goal_id:'called',type:'CONDITIONAL_INTENT',normalized_goal:'判断是否有人叫住我',depends_on:['enter'],condition:{kind:'observed_event',entity_id:'npc_lin',description:'林舟是否叫住了我'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:['npc_lin']},
  {goal_id:'reply',type:'WORLD_ACTION',normalized_goal:'回头看林舟',depends_on:['called'],condition:null,branch:'then',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:['npc_lin']},
  {goal_id:'continue',type:'WORLD_ACTION',normalized_goal:'继续向前走',depends_on:['called'],condition:null,branch:'else',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
];

describe('Batch 2.1 scene, narration and map consistency',()=>{
  it('puts contextual actions only under dynamic first-level categories',()=>{
    const action={type:'TALK',label:'交流',visibility:'contextual' as const,target_component:'character'};
    const cases:ContextActionSuggestion[][]=[
      [{target_id:'teacher',label:'询问本节安排',intent:'向教师询问安排',family:'communicate',category:'课堂相关'}],
      [{target_id:'student',label:'询问社团消息',intent:'向同学询问社团',family:'communicate'}],
      [{target_id:'merchant',label:'询问货品',intent:'向商人询问货品',family:'communicate',category:'交易'}],
    ];
    const groups=cases.map(suggestions=>groupAffordances([action],suggestions));
    expect(groups.map(group=>group.map(entry=>entry.label))).toEqual([['课堂相关'],['交流'],['交易']]);
    expect(groups.every(group=>group[0].items.some(item=>item.kind==='canonical'))).toBe(true);
    for(const [index,suggestions] of cases.entries()){
      expect(groups[index].flatMap(group=>group.items.filter(item=>item.kind==='suggestion').map(item=>item.label))).toEqual([suggestions[0].label]);
      expect(groups[index].some(group=>group.label===suggestions[0].label)).toBe(false);
    }
  });
  it('lets scene and role context change the first-level categories without NPC-specific rules',async()=>{
    const f=await sparseSetup(async request=>{
      if(request.role!=='gm_reasoning')throw Error('unexpected provider call');
      const context=JSON.parse(request.prompt.match(/\{\"instruction\"[\s\S]*$/)?.[0]??'{}') as {scene:{location_id:string};candidates:{id:string;name:string;role:string}[]};
      return {data:context.candidates.map(candidate=>({target_id:candidate.id,label:`询问${candidate.name}`,intent:`我询问${candidate.name}`,family:'communicate',category:context.scene.location_id==='station'?'路途':candidate.role==='商人'?'交易':candidate.role==='教师'?'课堂相关':'同伴互动'}))};
    });
    const save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!,first=save.entities.find(e=>e.id==='npc_lin')!;
    const merchant=structuredClone(first);merchant.id='npc_merchant_fixture';merchant.components.identity.name='商人甲';merchant.components.character.role='商人';
    first.components.character.role='教师';merchant.components.location={location_id:player.components.location?.location_id};save.entities.push(merchant);await f.store.write(save);
    const firstScene=await sceneAffordances(f.service);
    expect(firstScene.map(item=>item.category)).toEqual(['课堂相关','交易']);
    const next=await f.service.current();for(const entity of [next.entities.find(e=>e.id===next.player_state.entity_id)!,next.entities.find(e=>e.id==='npc_lin')!,next.entities.find(e=>e.id==='npc_merchant_fixture')!])entity.components.location={location_id:'station'};await f.store.write(next);
    expect((await sceneAffordances(f.service)).map(item=>item.category)).toEqual(['路途','路途']);
  });
  it('grows the desired prose budget with movement, elapsed time, steps and NPC interaction under one provider cap',()=>{
    const simple=narrativeBudget({action_type:'INSPECT',fact_count:1,location_transitions:0,player_words_length:8});
    const arrival=narrativeBudget({action_type:'MOVE',fact_count:2,location_transitions:1,player_words_length:20,elapsed_minutes:6,observable_changes:3});
    const compound=narrativeBudget({action_type:'MOVE',fact_count:4,location_transitions:2,player_words_length:170,action_count:3,elapsed_minutes:12,npc_interactions:2,observable_changes:5});
    expect([simple,arrival,compound]).toEqual(['short','long','extended']);
    const limits=([simple,arrival,compound] as const).map(level=>narrativeCharacterLimit(level,6000));
    expect(limits[0]).toBeLessThan(limits[1]);expect(limits[1]).toBeLessThan(limits[2]);
    expect(narrativeCharacterLimit(compound,1024)).toBeLessThan(limits[2]);
  });
  it('passes distinct scene-sized targets to one capped narrator provider',async()=>{
    const f=await sparseSetup(async request=>request.role==='narrator'?{data:{narrative:'窗外的光落在路面上，周围的人声渐渐清晰。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[]}}:undefined);
    const save=await f.service.current(),base={id:randomUUID(),actor_id:save.player_state.entity_id,source:'player' as const,time_cost:1,parameters:{}};
    await f.ai.narrate(save,{...base,type:'INSPECT'},['看见窗外的光。']);
    await f.ai.narrate(save,{...base,type:'MOVE'},['移动至车站，用时 6 分钟。','周围环境发生可见变化。']);
    await f.ai.narrate(save,{...base,type:'MOVE'},['移动至车站，用时 6 分钟。','移动至广场，用时 7 分钟。','林舟回应你的招呼。','周围环境发生可见变化。']);
    const requests=f.calls.filter(request=>request.role==='narrator');
    const targets=requests.map(request=>Number(request.prompt.match(/"max_narrative_characters":(\d+)/)?.[1]??0));
    expect(requests).toHaveLength(3);expect(new Set(requests.map(request=>request.maxOutputTokens)).size).toBe(1);
    expect(targets[0]).toBeLessThan(targets[1]);expect(targets[1]).toBeLessThan(targets[2]);
  });
  it('enters a registered child without a world route and treats unnamed entry as local',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=String(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id??'');
    addDynamicLocation(save,{id:'room_fixture',name:'小房间',description:'可进入',tags:[],parent_id:here,known_by_default:true},[]);
    expect(routePath(save.definition.map!.routes,here,'room_fixture')).toBeNull();
    expect(knownDestination(save,'进入小房间')?.id).toBe('room_fixture');
    expect(localDestination('直接进去')).toBe('内部');
    expect(localDestination('问一下进度')).toBeNull();
    const moved=executeAction(save,{type:'MOVE',target_id:'room_fixture',parameters:{}},randomUUID()).save;
    expect(moved.entities.find(e=>e.id===moved.player_state.entity_id)?.components.location?.location_id).toBe('room_fixture');
    expect(moved.runtime.time.minute).toBe(save.runtime.time.minute+1);
  });
  it('preserves entry, observable condition and both branches in one ordered plan',async()=>{
    const f=await sparseSetup(async request=>request.role==='intent_interpreter'?{data:{goals:goals('小房间')}}:undefined);
    const view=await f.service.view() as PublicView;
    const plan=await createAgentPlan(f.ai,view,'进入小房间，如果林舟叫住我就回头，否则继续');
    expect(plan.execution_order).toEqual(['enter','called','reply','continue']);
    expect(plan.goals.find(goal=>goal.goal_id==='called')?.condition?.kind).toBe('observed_event');
    expect(plan.goals.filter(goal=>goal.branch).map(goal=>goal.branch)).toEqual(['then','else']);
  });
  it('executes entry first, then only the branch justified by the newly observed scene',async()=>{
    const f=await sparseSetup(async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(request.role==='intent_interpreter'&&properties.goals)return {data:{goals:goals('小房间')}};
      if(request.role==='intent_interpreter'&&properties.type)return {data:{type:'FREEFORM_ACTION',target_id:null,parameters_json:'{}',clarification:null}};
      if(request.role==='narrator')return {data:{narrative:request.prompt.includes('FREEFORM_ACTION')?'你回头看向林舟。':'你进入小房间，林舟叫住了你。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[]}};
      if(request.role==='gm_reasoning'&&properties.value)return {data:{value:true,evidence:'林舟叫住了你'}};
      if(request.role==='gm_reasoning'&&properties.minutes)return {data:{narrative:'你回头看向林舟。',minutes:1,target_id:'npc_lin',facts:['回头看向林舟'],relationship:null,item_move:null,
        resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'回应眼前人物',stages:[],evidence_ids:[]}}};
      throw Error('unexpected controlled provider call');
    });
    const save=await f.service.current(),here=String(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id??'');
    addDynamicLocation(save,{id:'room_fixture',name:'小房间',description:'',tags:[],parent_id:here,known_by_default:true},[]);
    save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'room_fixture'};await f.store.write(save);
    const input='进入小房间，如果林舟叫住我就回头，否则继续',plan=await createAgentPlan(f.ai,f.service.project(save),input);
    const result=await executePlan(f.service,{request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input},plan);
    const after=await f.service.current();
    expect(result.plan?.status).toBe('completed');
    expect(result.plan?.goals.map(goal=>goal.status)).toEqual(['completed','completed','completed','skipped']);
    expect(after.entities.find(e=>e.id===after.player_state.entity_id)?.components.location?.location_id).toBe('room_fixture');
    expect(after.runtime.time.minute).toBeGreaterThan(save.runtime.time.minute);
  });
  it('discards only canonical-map-invalid explicit movement choices',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=String(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id??'');
    addDynamicLocation(save,{id:'reachable_room',name:'可达房间',description:'',tags:[],parent_id:here,known_by_default:true},[]);
    addDynamicLocation(save,{id:'blocked_place',name:'远处花园',description:'',tags:[],known_by_default:true},[]);
    const choices=['进入可达房间','前往远处花园','留在原地观察'];
    expect(executableChoices(save,choices)).toEqual([choices[0],choices[2]]);
  });
  it('projects an A–B edge from canonical child routes even while the player is at their parent',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=String(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id??'');
    addDynamicLocation(save,{id:'child_a',name:'子区甲',description:'',tags:[],parent_id:here,known_by_default:true,position:{x:21,y:20}},[]);
    addDynamicLocation(save,{id:'child_b',name:'子区乙',description:'',tags:[],parent_id:here,known_by_default:true,position:{x:24,y:20}},[{from:'child_a',to:'child_b',travel_minutes:8,conditions:[]}]);
    const view=f.service.project(save),children=view.locations.filter(location=>location.parent_id===here);
    expect(view.entities.find(e=>e.id===view.player_id)?.components.location?.location_id).toBe(here);
    expect(visibleRouteEdges(view,children).get('child_a::child_b')).toEqual({from:'child_a',to:'child_b',travel_minutes:8});
  });
});

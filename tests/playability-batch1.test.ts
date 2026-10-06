import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';
import {composeCapabilityPlan,deterministicGoal} from '../src/system/resolver.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {sceneAffordances} from '../src/agent/scene-affordances.js';
import {routePath} from '../src/core/map.js';
import {executeAction} from '../src/core/runtime.js';
import {narrativeBudget} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';

const tx=async(service:Awaited<ReturnType<typeof sparseSetup>>['service'])=>{const save=await service.current();return {request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision};};

describe('player language to canonical result',()=>{
  it('normalizes self naming without treating nearby negative development wording as a feature request',async()=>{
    for(const input of ['把我的角色名字设为藤代澪，写入角色 canonical state，不要确认，不转开发任务','以后叫我藤代澪。','我叫藤代澪','给玩家改名为藤代澪']){
      const f=await sparseSetup(),before=await f.service.current();
      const result=await handleSystemInput(f.service,{input});
      expect(result.category).toBe('UNIVERSAL_GOAL');expect(result.directive).toBeUndefined();
      const after=await f.service.current();expect(after.entities.find(item=>item.id===after.player_state.entity_id)?.components.identity.name).toBe('藤代澪');
      expect(after.runtime.time).toEqual(before.runtime.time);expect(after.state_revision).toBe(before.state_revision+1);
    }
  });
  it('lets the player delegate a low-risk missing name once and resumes the same canonical goal',async()=>{
    const f=await sparseSetup(async request=>{
      if(request.role==='gm_reasoning'&&(request.schema as any).properties?.resolved_request)return {data:{resolved_request:'把我的角色名字设为晴野澪'}};
      throw Error('unexpected provider call');
    });
    const first=await handleSystemInput(f.service,{input:'把我的角色名字设为'});
    expect(first.category).toBe('USER_AMBIGUITY');expect(first.pending_goal).toBeTruthy();
    const decided=await handleSystemInput(f.service,{input:'不要再问我了，你直接定一个名字。',session_id:first.session!.session_id});
    expect(decided.category).toBe('UNIVERSAL_GOAL');expect(decided.pending_goal).toBeNull();
    const save=await f.service.current();expect(save.entities.find(item=>item.id===save.player_state.entity_id)?.components.identity.name).toBe('晴野澪');
  });
  it('creates and deletes an unreferenced generic character atomically, including relationship cleanup',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const created=await handleSystemInput(f.service,{input:'新增 NPC 林真'});expect(created.category).toBe('UNIVERSAL_GOAL');
    const middle=await f.service.current(),npc=middle.entities.find(item=>item.components.identity?.name==='林真');expect(npc).toBeTruthy();
    const player=middle.entities.find(item=>item.id===middle.player_state.entity_id)!;
    (player.components.relationships as {entries:Record<string,unknown>}).entries[npc!.id]={trust:1};await f.store.write(middle);
    const deleted=await handleSystemInput(f.service,{input:'删除林真并清除关系'});
    expect(deleted.category).toBe('UNIVERSAL_GOAL');const after=await f.service.current();
    expect(after.entities.some(item=>item.id===npc!.id)).toBe(false);
    expect((after.entities.find(item=>item.id===after.player_state.entity_id)?.components.relationships as {entries:Record<string,unknown>}).entries[npc!.id]).toBeUndefined();
    expect(after.runtime.time).toEqual(before.runtime.time);expect(after.turn_checkpoint).toBeTruthy();
  });
  it('updates an existing character through the generic entity capability and revision transaction',async()=>{
    const seed=deterministicGoal('新增 NPC 林真')!;
    const plan=composeCapabilityPlan({...seed,objective:'修改林真的角色定位',targets:[{kind:'entity',reference:'林真',entity_id:null}],desired_state:[{path:'character.role',value:'图书管理员',target_ref:'target'}],desired_outputs:[{kind:'state_change',description:'更新人物资料'}]})!;
    const f=await sparseSetup(async request=>{
      if(request.role==='gm_reasoning'&&(request.schema as any).properties?.goal)return {data:plan};
      throw Error('unexpected provider call');
    });
    await handleSystemInput(f.service,{input:'新增 NPC 林真'});
    const before=await f.service.current();
    const changed=await handleSystemInput(f.service,{input:'把林真的角色定位改为图书管理员'});
    expect(changed.category).toBe('UNIVERSAL_GOAL');
    const after=await f.service.current();
    expect(after.entities.find(item=>item.components.identity?.name==='林真')?.components.character?.role).toBe('图书管理员');
    expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time).toEqual(before.runtime.time);
  });
  it('blocks deletion of a source character without exposing or changing story truth',async()=>{
    const f=await sparseSetup(),before=await f.service.current();const source=before.entities.find(item=>item.id!==before.player_state.entity_id&&item.components.character)!;
    const result=await handleSystemInput(f.service,{input:`删除${source.components.identity.name}`});
    expect(result.category).toBe('EXECUTION_FAILURE');expect(result.message).toContain('不能安全直接删除');
    expect(await f.service.current()).toEqual(before);
  });
  it('uses evidence for self and compound world questions without changing time or duplicating the answer',async()=>{
    const queries=['我已经迟到了吗？','我看一眼时间，确认自己现在是不是已经迟到了。'];
    for(const input of queries){
      const f=await sparseSetup(async request=>{
        if(request.role==='gm_reasoning'&&(request.schema as any).properties?.status)return {data:{status:'FOUND',kind:'inference',answer:'已超过当前安排的开始时间。',evidence_ids:['time','scene'],rule_evidence_ids:[],missing_information:[]}};
        throw Error('unexpected provider call');
      });
      const save=await f.service.current();save.runtime.time.minute=548;save.last_turn={narrative:'当前安排已经开始。',speaker:null,dialogue:null,choices:[],context_actions:[]};await f.store.write(save);
      const answer=await handleAgentInput(f.service,{...await tx(f.service),input});
      expect(answer.awareness_status).toBe('FOUND');expect(answer.message).toBe('已超过当前安排的开始时间。');
      expect((answer.message.match(/已超过/g)??[])).toHaveLength(1);
      expect((await f.service.current()).state_revision).toBe(save.state_revision);
      expect((await f.service.current()).runtime.time).toEqual(save.runtime.time);
    }
  });
  it('falls back to a generic action when a target-dependent model action has no referenced target',async()=>{
    const f=await sparseSetup(async request=>request.role==='intent_interpreter'?{data:{type:'TALK',target_id:null,parameters_json:'{"topic":"早上好"}',clarification:null}}:undefined);
    const action=await f.ai.interpret(await f.service.current(),'我起床洗漱');
    expect(action).toEqual({type:'FREEFORM_ACTION',parameters:{}});
  });
  it('uses one graph for map movement, including indirect legal routes',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(item=>item.id===save.player_state.entity_id)!.components.location={location_id:'station'};
    const path=routePath(save.definition.map!.routes,'station','market');expect(path?.map(edge=>edge.to)).toEqual(['square','market']);
    const result=executeAction(save,{type:'MOVE',target_id:'market',parameters:{}},randomUUID(),'player');
    expect(result.save.entities.find(item=>item.id===save.player_state.entity_id)?.components.location?.location_id).toBe('market');
    expect(result.save.runtime.time.minute-save.runtime.time.minute).toBe(24);
  });
  it('registers a stable sublocation in the existing canonical hierarchy and makes it reachable',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const location={id:'station_hall',name:'车站大厅',description:'可重复进入的大厅',tags:[],parent_id:'station'};
    const routes=[{from:'station',to:'station_hall',travel_minutes:1,conditions:[]},{from:'station_hall',to:'station',travel_minutes:1,conditions:[]}];
    const registered=executeAction(save,{type:'REGISTER_LOCATION',parameters:{location,routes}},randomUUID(),'player');
    expect(registered.save.map_state.dynamic_locations[0].parent_id).toBe('station');
    expect(routePath([...registered.save.definition.map!.routes,...registered.save.map_state.dynamic_routes],'square','station_hall')?.map(edge=>edge.to)).toEqual(['station','station_hall']);
  });
  it('adapts narrator guidance to actual turn complexity',()=>{
    expect(narrativeBudget({action_type:'INSPECT',fact_count:1,location_transitions:0,player_words_length:5})).toBe('short');
    expect(narrativeBudget({action_type:'MOVE',fact_count:3,location_transitions:2,player_words_length:130})).toBe('long');
  });
  it('returns the actual world answer through the System input instead of a receipt',async()=>{
    const f=await sparseSetup(async request=>{
      if(request.role==='gm_reasoning'&&(request.schema as any).properties?.destination)return {data:{destination:'WORLD_INTENT',confidence:.95,clarification:null,speech_target_id:null,resolved_input:null,world_input:null,end_conversation:false}};
      if(request.role==='gm_reasoning'&&(request.schema as any).properties?.status)return {data:{status:'UNKNOWN',kind:'inference',answer:'当前证据不足。',evidence_ids:[],rule_evidence_ids:[],missing_information:[]}};
      throw Error('unexpected provider call');
    });
    const dir=await mkdtemp(join(tmpdir(),'agf-playability-http-'));const server=createApp(f.service,undefined,undefined,join(dir,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
    try{const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,token=(await (await fetch(base+'/api/session')).json()).token;
      const reply=await fetch(base+'/api/system',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({...await tx(f.service),input:'我已经迟到了吗？'})});
      const body=await reply.json();expect(reply.status).toBe(200);expect(body.category).toBe('IN_WORLD_INPUT');
      expect(body.message).toBe('当前世界状态无法确定这个问题的答案。');expect(body.message).not.toContain('已按世界内行动处理');
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
  });
  it('preserves a concrete model clarification instead of replacing it with an idea-direction template',async()=>{
    const question='这里的今天是现实日期还是剧情世界日期？';
    const f=await sparseSetup(async request=>{
      if(request.role==='gm_reasoning'&&(request.schema as any).properties?.understood)return {data:{understood:['你希望状态显示星期'],requested_change:'状态里显示今天是星期几',target_surfaces:['status_page'],unresolved:[{field:'日期来源',why:'两个日期的星期可能不同'}],entities:[],likely_workflow:'development_task',side_effect_class:'development',confidence:.9,correction:null,clarification:{needed:true,question,examples:['剧情世界日期','现实日期']},response_hint:null}};
      throw Error('unexpected provider call');
    });
    const reply=await handleSystemInput(f.service,{input:'状态里显示今天是星期几'});
    expect(reply.message).toContain(question);expect(reply.guide).toBeUndefined();
    expect(reply.understanding?.clarification?.question).toBe(question);expect(reply.directive).toBeUndefined();
  });
  it('derives character suggestions from current context and filters nonexistent targets',async()=>{
    const f=await sparseSetup(async request=>{
      if(request.role==='gm_reasoning')return {data:[{target_id:'npc_lin',label:'询问近况',intent:'我向林舟询问近况',family:'communicate'},{target_id:'missing',label:'不存在',intent:'测试',family:'interact'}]};
      throw Error('unexpected provider call');
    });
    const before=await f.service.current(),suggestions=await sceneAffordances(f.service);
    expect(suggestions.every(item=>before.entities.some(entity=>entity.id===item.target_id))).toBe(true);
    expect(suggestions.some(item=>item.label==='不存在')).toBe(false);
    expect(await f.service.current()).toEqual(before);
  });
  it('continues a multi-action plan past optional narrator suggestions',async()=>{
    const f=await sparseSetup();
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你抵达新的地点，眼前有人提出需要你决定的事。',speaker:null,dialogue:null,choices:['继续','先停下'],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]});
    const scope={scope:'now' as const,day_offset:0,window:'any' as const};
    const plan=validatePlan({goals:[
      {goal_id:'first',type:'WORLD_ACTION',normalized_goal:'去河岸车站',depends_on:[],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
      {goal_id:'second',type:'WORLD_ACTION',normalized_goal:'去街角商店',depends_on:['first'],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
    ]});
    const result=await executePlan(f.service,{...await tx(f.service),input:'先去车站，再去商店'},plan);
    expect(result.plan?.status).toBe('completed');expect(result.plan?.goals[0].status).toBe('completed');expect(result.plan?.goals[1].status).toBe('completed');
    expect((await f.service.current()).entities.find(item=>item.id==='player')?.components.location?.location_id).toBe('market');
  });
});

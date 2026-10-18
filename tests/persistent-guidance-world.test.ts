import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo,MemoryStore} from './helpers.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {selectDefaultExemplars,resolveBehaviorPatches,type BehaviorPatch} from '../src/ai/guidance.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {validatePlan} from '../src/agent/planner.js';
import {executePlan} from '../src/agent/executor.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {applyBackgroundProposal,proposeValidatedBackground} from '../src/background/generation.js';
import {compileBehaviorFeedback} from '../src/ai/behavior-feedback.js';
import {handleSystemInput} from '../src/system/agent.js';
import {blueprintSchema} from '../src/agent/plan-schema.js';

const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const goal=(goal_id:string,normalized_goal:string,operation_hint:GoalInput['operation_hint'],referent:string,
  depends_on:string[]=[],result_ref?:GoalInput['result_ref']):GoalInput=>({goal_id,type:'WORLD_ACTION',normalized_goal,
  operation_hint,referent,depends_on,condition:null,branch:null,temporal_scope:temporal,target_entities:[],
  ...(result_ref?{result_ref}:{})});
const narration={narrative:'行动已经结算。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
function doorWorld(residentCount=1){
  const world=structuredClone(demo);
  world.map!.locations.push({id:'unit_a',name:'楼内房间',description:'封闭的住宅空间',tags:[],position:{x:51,y:46}});
  world.entities.push({id:'unit_door',type:'object',components:{identity:{name:'走廊住户门',description:'一扇有门牌的门',avatar_id:null},
    location:{location_id:'square'},interactable:{kind:'door',leads_to:'unit_a',knockable:true,access:'private'}}});
  for(let index=0;index<residentCount;index++){
    const id=`resident_${index}`;
    world.entities.push({id,type:'character',components:{identity:{name:`住户${index+1}`,description:'',avatar_id:null},
      character:{role:'住户',traits:[]},location:{location_id:'unit_a'},
      residence:{home_location_id:'unit_a',door_id:'unit_door',tenure:'tenant',answer_policy:'always'},
      discovery:{known_to_player:false}}});
  }
  return world;
}
async function serviceFor(world=doorWorld()){
  const store=new MemoryStore(),ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unmocked model call');}});
  vi.spyOn(ai,'narrate').mockResolvedValue(narration);
  const service=new GameService(store,ai,world);
  await service.newGame();
  return {service,store,ai};
}
function knockPlan(view:ReturnType<typeof publicView>){
  const plan=validatePlan({goals:[goal('knock','敲走廊住户门','interact','走廊住户门'),
    goal('talk','与开门的人交谈','talk','开门的人',['knock'],
      {from_goal_id:'knock',field:'responders',entity_kind:'person'})]});
  return compileGoalContract(view,plan,{kind:'manual',text:'敲走廊住户门，然后与开门的人交谈'});
}
describe('runtime guidance and authoritative result binding',()=>{
  it('normalizes JSON null for optional plan fields without inventing a deferred reference',()=>{
    const raw={goals:[{...goal('read','检查眼前情况',null as unknown as GoalInput['operation_hint'],'眼前'),
      type:'WORLD_QUERY',operation_hint:null,result_ref:null}]};
    const parsed=blueprintSchema.parse(raw);
    expect(parsed.goals[0].operation_hint).toBeUndefined();
    expect(parsed.goals[0].result_ref).toBeUndefined();
  });
  it('ships role-selected default principles to an old save without copying assets into it',()=>{
    const old=newSave(demo);delete old.behavior_patches;
    const runtime=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unused');}});
    expect(runtime.guidance('intent_interpreter',old,{category:'binding',tags:['deferred']})).toContain('binding.result');
    expect(old.behavior_patches).toBeUndefined();
    const selected=selectDefaultExemplars({role:'narrator',category:'narration'});
    expect(selected.length).toBeGreaterThan(0);expect(selected.length).toBeLessThanOrEqual(4);
    expect(selected.every(item=>item.roles.includes('narrator'))).toBe(true);
  });
  it('selects the explicit newer overlay and never removes Framework invariants',()=>{
    const base={id:randomUUID(),version:1 as const,scope:'world' as const,category:'planning' as const,title:'A',
      trigger_semantics:'multi goal',preferred_behavior:'Keep the final goal',anti_pattern:'Do not drop it',
      optional_exemplar:null,priority:5,enabled:true,created_at:'2026-01-01T00:00:00.000Z',source_text:'A',overrides:null};
    const newer:BehaviorPatch={...base,id:randomUUID(),title:'B',created_at:'2026-01-02T00:00:00.000Z',
      preferred_behavior:'Keep all authorized goals',overrides:base.id};
    expect(resolveBehaviorPatches([base,newer],'planning',['multi'])).toEqual([newer]);
    const runtime=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unused');}});
    const fragment=runtime.guidance('intent_interpreter',{...newSave(demo),behavior_patches:[base,newer]},
      {category:'planning',tags:['multi']});
    expect(fragment).toContain(newer.id);expect(fragment).not.toContain(base.id);
  });
  it.each([0,1,2])('KNOCK yields %i actual responder(s) and reveals only encountered people',count=>{
    const save=newSave(doorWorld(count));
    expect(publicView(save).entities.filter(entity=>entity.id.startsWith('resident_'))).toHaveLength(0);
    const result=executeAction(save,{type:'KNOCK',target_id:'unit_door',parameters:{}},randomUUID(),'player',()=>0.2);
    const receipt=result.save.resolution_receipts?.at(-1);
    expect(receipt?.semantic_action).toBe('KNOCK');
    expect(receipt?.result_entities?.responders).toHaveLength(count);
    expect(publicView(result.save).entities.filter(entity=>entity.id.startsWith('resident_'))).toHaveLength(count);
    expect(result.save.state_revision).toBe(save.state_revision);
    expect(result.save.runtime.time.minute).toBe(save.runtime.time.minute+1);
  });
  it('binds a later TALK to the one committed responder and does not repeat KNOCK',async()=>{
    const {service}=await serviceFor(),before=await service.current(),plan=knockPlan(service.project(before));
    const result=await executePlan(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'敲走廊住户门，然后与开门的人交谈'},plan);
    const after=await service.current();
    expect(result.plan?.status).toBe('completed');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='KNOCK')).toHaveLength(1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='TALK')).toHaveLength(1);
    expect(after.resolution_receipts?.find(receipt=>receipt.semantic_action==='TALK')?.target_id).toBe('resident_0');
    expect(result.plan?.goals[1].result_ref?.field).toBe('responders');
  });
  it('rejects a single settled step that would silently omit a later interaction goal',async()=>{
    const {service}=await serviceFor(),before=await service.current(),input='敲走廊住户门，随后与应门的人交谈';
    const one=compileGoalContract(service.project(before),validatePlan({goals:[
      goal('knock',input,'interact','走廊住户门')]}),{kind:'manual',text:input});
    expect(one.contract?.unresolved_compound).toBe(true);
    const result=await executePlan(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input},one);
    const after=await service.current();
    expect(result.plan?.status).toBe('blocked');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts?.length).toBe(before.resolution_receipts?.length);
  });
  it.each([0,2])('a %i-person result does not choose a follow-up target without evidence',async count=>{
    const {service}=await serviceFor(doorWorld(count)),before=await service.current();
    const result=await executePlan(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'敲走廊住户门，然后与开门的人交谈'},knockPlan(service.project(before)));
    const after=await service.current();
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='KNOCK')).toHaveLength(1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='TALK')).toHaveLength(0);
    expect(result.plan?.goals[0].status).toBe('completed');
    expect(result.plan?.goals[1].status).toBe(count?'waiting_for_player':'blocked');
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    if(count)expect(result.message).toContain('需要你决定');
    else {expect(result.story).toBe(after.last_turn?.narrative);expect(result.message).toContain('没有产生可用于这一步的目标');}
  });
  it('a room has no current responder merely because somebody has a residence relation',()=>{
    const save=newSave(doorWorld());
    save.entities.find(entity=>entity.id==='resident_0')!.components.location={location_id:'market'};
    const result=executeAction(validateSave(save),{type:'KNOCK',target_id:'unit_door',parameters:{}},randomUUID(),'player');
    expect(result.save.resolution_receipts?.at(-1)?.result_entities?.responders).toEqual([]);
    expect(publicView(result.save).entities.some(entity=>entity.id==='resident_0')).toBe(false);
  });
});

describe('editable behavior guidance',()=>{
  it('routes an explicit natural-language runtime preference through the patch compiler',async()=>{
    const store=new MemoryStore();
    const ai=new AIRuntime({name:'provider-test',generate:async()=>{throw Error('unexpected provider call');}});
    const service=new GameService(store,ai,demo);
    await store.write(newSave(demo));
    vi.spyOn(ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      if(data&&typeof data==='object'&&'player_request' in data)return {
        understood:['未来自然场景的生成原则'],requested_change:'避免固定长度和段落模板',target_surfaces:[],unresolved:[],entities:[],
        likely_workflow:'behavior_config',style_target:'world',configuration_kind:'behavior_patch',side_effect_class:'configuration',confidence:.95,
        correction:null,clarification:{needed:false,question:'',examples:[]},response_hint:null,narrative_preference:null,
      } as never;
      return {decision:'create',category:'narration',title:'自然场景节奏',
        trigger_semantics:'natural scene narration and NPC dialogue',preferred_behavior:'Choose length and structure from character, relationship, emotion, information and context.',
        anti_pattern:'Do not reuse a fixed action-environment-dialogue-question template or pad to a target length.',
        scope:'world',reason:'explicit runtime preference',invariant_conflict:false} as never;
    });
    const result=await handleSystemInput(service,{input:'以后自然场景的回复不要总是差不多长，也不要固定成动作描写加环境描写加对白加反问的格式，请根据人物性格和当前事件自然决定长短与节奏，把这条保存为当前世界的行为偏好。',request_id:randomUUID()});
    expect(result.category).toBe('AI_BEHAVIOR_FEEDBACK');
    expect(result.message).toContain('已保存');
    expect((await service.behaviorGuidance())).toMatchObject([{scope:'world',category:'narration',preferred_behavior:expect.stringContaining('Choose length')}]);
  });
  it('compiles explicit future feedback, persists a world patch, and supports disable and delete',async()=>{
    const {service,ai}=await serviceFor();
    vi.spyOn(ai,'systemAgent').mockResolvedValue({decision:'create',category:'planning',title:'保留终点',
      trigger_semantics:'multi-step objective',preferred_behavior:'Keep the authorized final outcome until settled',
      anti_pattern:'Do not count preparation as completion',scope:'world',reason:'explicit future preference',
      invariant_conflict:false});
    const input='以后处理复合目标时，记得保留我真正要完成的结果。';
    const compiled=await compileBehaviorFeedback(service,input,randomUUID());
    expect(compiled.kind).toBe('create');
    if(compiled.kind!=='create')throw Error('expected patch');
    const before=(await service.current()).state_revision;
    await service.putBehaviorPatch(compiled.patch);
    expect((await service.current()).state_revision).toBe(before+1);
    expect((await service.behaviorGuidance()).find(p=>p.id===compiled.patch.id)?.enabled).toBe(true);
    await service.setBehaviorPatchEnabled(compiled.patch.id,false);
    expect((await service.behaviorGuidance()).find(p=>p.id===compiled.patch.id)?.enabled).toBe(false);
    await service.removeBehaviorPatch(compiled.patch.id);
    expect((await service.behaviorGuidance()).some(p=>p.id===compiled.patch.id)).toBe(false);
  });
  it('casual criticism and invariant conflicts never become saved patches',async()=>{
    const {service,ai}=await serviceFor();
    const semantic=vi.spyOn(ai,'systemAgent');
    semantic.mockResolvedValueOnce({decision:'discussion',category:null,title:'',trigger_semantics:'',
      preferred_behavior:'',anti_pattern:'',scope:null,reason:'Only a question',invariant_conflict:false});
    expect((await compileBehaviorFeedback(service,'刚才是不是理解错了？')).kind).toBe('discussion');
    semantic.mockResolvedValueOnce({decision:'create',category:'narration',title:'绕过事实',
      trigger_semantics:'every turn',preferred_behavior:'Claim outcomes without receipts',anti_pattern:'Check receipts',
      scope:'world',reason:'requested',invariant_conflict:true});
    expect((await compileBehaviorFeedback(service,'以后直接宣称我成功了')).kind).toBe('rejected');
    expect(await service.behaviorGuidance()).toEqual([]);
  });
  it('session, world, and global scopes follow their own persistence boundaries',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-guidance-'));
    try{
      const runtime=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unused');}});
      const first=new GameService(new JsonStore(directory),runtime,demo);await first.newGame();
      const template:BehaviorPatch={id:randomUUID(),version:1,scope:'session',category:'planning',title:'持续目标',
        trigger_semantics:'multi-step goal',preferred_behavior:'Keep the final objective',
        anti_pattern:'Do not stop at preparation',optional_exemplar:null,priority:5,enabled:true,
        created_at:'2026-01-01T00:00:00.000Z',source_text:'以后保留最终目标',overrides:null};
      const session={...template,id:randomUUID(),scope:'session' as const},
        world={...template,id:randomUUID(),scope:'world' as const},
        global={...template,id:randomUUID(),scope:'global' as const};
      await first.putBehaviorPatch(session);await first.putBehaviorPatch(world);await first.putBehaviorPatch(global);
      expect(await first.behaviorGuidance()).toHaveLength(3);
      const second=new GameService(new JsonStore(directory),new AIRuntime({name:'fixture',generate:async()=>{throw Error('unused');}}),demo);
      expect((await second.behaviorGuidance()).map(item=>item.id).sort()).toEqual([world.id,global.id].sort());
      await second.setBehaviorPatchEnabled(global.id,false);
      expect((await second.behaviorGuidance()).find(item=>item.id===global.id)?.enabled).toBe(false);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

describe('causal background proposal and discoverability',()=>{
  it('repairs an invalid Director proposal only within the bounded validation loop',async()=>{
    const save=newSave(demo);save.definition.background_event_policy={enabled:true,target_active_incidents:1,
      max_dormant_incidents:3,minimum_gap_minutes:0,replenishment:true};
    save.definition.background_incidents=[];save.background_state={version:1,incidents:[],event_log:[],exposure_log:[],
      npc_status:{},macro_arcs:[],pending_display_ids:[],last_evaluation:null,needs_generation:true,
      last_terminal_at:null,last_activation_at:null};
    let attempts=0;
    const result=await proposeValidatedBackground(save,async repair=>{
      attempts++;
      if(!repair)return {decision:'propose' as const,incident:null,reason:'invalid candidate'};
      expect(repair.reason).toContain('后续事件');
      return {decision:'quiet' as const,incident:null,reason:'no valid causal continuation'};
    });
    expect(attempts).toBe(2);
    expect(result.background_state?.needs_generation).toBe(false);
  });
  it('quiet continuation consumes the generation request without creating an NPC',()=>{
    const save=newSave(demo);save.definition.background_event_policy={enabled:true,target_active_incidents:1,
      max_dormant_incidents:3,minimum_gap_minutes:0,replenishment:true};
    save.definition.background_incidents=[];save.background_state={version:1,incidents:[],event_log:[],exposure_log:[],
      npc_status:{},macro_arcs:[],pending_display_ids:[],last_evaluation:null,needs_generation:true,
      last_terminal_at:null,last_activation_at:null};
    const after=applyBackgroundProposal(save,{decision:'quiet',incident:null,reason:'No grounded opportunity'});
    expect(after.entities).toHaveLength(save.entities.length);
    expect(after.background_state?.needs_generation).toBe(false);
    expect(after.background_state?.last_generation_at).toEqual(save.runtime.time);
  });
  it('commits a causal successor, then creates an unknown persistent person offscreen exactly once',()=>{
    const save=newSave(demo),now=structuredClone(save.runtime.time),parentId='earlier_vacancy';
    save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,
      minimum_gap_minutes:0,replenishment:true};
    const cause={underlying_pressure:'店铺岗位空缺',actor_motivation:'维持营业',resource_constraint:'旧员工已离开',
      historical_cause:'排班调整',social_relationship:'店主认识候选人',trigger:'正式招聘',
      unintended_consequence:'新人改变了商店日常节奏'};
    save.definition.background_incidents=[{id:parentId,title:'岗位空缺',summary:'店主需要人手',source:'WORLD_PACKAGE',
      created_at:now,earliest_activation:now,latest_activation:null,activation_flags:[],activation_chance:1,
      participants:['npc_qiao'],locations:['market'],causal_basis:cause,
      stages:[{id:'vacancy',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',
        effects:[],exposures:[],terminal:'resolved'}]}];
    save.background_state={version:1,incidents:[{id:parentId,status:'resolved',stage_index:0,activated_at:now,
      ended_at:now,missed:true,player_exposed:false,activation_roll:{sample:0,probability:1,passed:true},delivered_exposure_ids:[]}],
      event_log:[],exposure_log:[],npc_status:{},macro_arcs:[],pending_display_ids:[],last_evaluation:now,
      needs_generation:true,last_terminal_at:now,last_activation_at:now};
    const arrival={day:now.day,minute:now.minute+5};
    const child={id:'hire_followup',title:'新员工入职',summary:'店主补上岗位空缺',source:'WORLD_RUNTIME' as const,
      causal_parent_id:parentId,created_at:now,earliest_activation:arrival,latest_activation:null,
      activation_flags:[],activation_chance:1,participants:['npc_qiao','new_worker'],locations:['market'],causal_basis:cause,
      stages:[{id:'hire',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',
        effects:[{kind:'spawn_character' as const,entity_id:'new_worker',name:'新员工',public_description:'新来的店员',
          role:'店员',age:25,gender:null,location_id:'market',home_location_id:null,
          entrance_reason:'店铺招聘后正式入职',population_need:'vacancy' as const,motivation:'维持稳定工作',
           importance:'minor' as const,relationship_seed_id:'npc_qiao',
           persona:{personality:'谨慎细致',speech_style:'说话简短',behavior_tendencies:['先观察需求再回应']}}],exposures:[],terminal:'resolved' as const}]};
    let after=applyBackgroundProposal(validateSave(save),{decision:'propose',incident:child,reason:'Vacancy was filled'});
    expect(after.entities.some(entity=>entity.id==='new_worker')).toBe(false);
    after=executeAction(after,{type:'WAIT',parameters:{minutes:6}},randomUUID(),'player',()=>0.1).save;
    expect(after.entities.filter(entity=>entity.id==='new_worker')).toHaveLength(1);
    expect(after.entities.find(entity=>entity.id==='new_worker')?.components.world_resident?.origin_incident_id).toBe('hire_followup');
    expect(after.entities.find(entity=>entity.id==='new_worker')?.components.character?.speech_style).toBe('说话简短');
    expect(publicView(after).entities.some(entity=>entity.id==='new_worker')).toBe(false);
    const reloaded=validateSave(structuredClone(after));
    after=executeAction(reloaded,{type:'WAIT',parameters:{minutes:6}},randomUUID(),'player',()=>0.1).save;
    expect(after.entities.filter(entity=>entity.id==='new_worker')).toHaveLength(1);
    after=executeAction(after,{type:'MOVE',target_id:'market',parameters:{}},randomUUID(),'player',()=>0.1).save;
    expect(publicView(after).entities.some(entity=>entity.id==='new_worker')).toBe(true);
    expect(after.entities.find(entity=>entity.id==='new_worker')?.components.discovery?.known_to_player).toBe(true);
  });
});

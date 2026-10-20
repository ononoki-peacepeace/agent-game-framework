import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {canExecuteContractPlan,runContractPlan} from '../src/agent/affordances.js';
import {createAgentPlan,validatePlan} from '../src/agent/planner.js';
import {executeFreeform} from '../src/core/freeform.js';
import {evaluateWorldPrerequisites} from '../src/core/prerequisites.js';
import {recentSettledActions} from '../src/ai/action-context.js';
import {validateSave} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {runSceneInteraction,sceneResultSchema} from '../src/agent/scene-interaction.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
import {ProviderError} from '../src/ai/failures.js';

const prose={narrative:'你在图书室阅读了一会儿，暂时没有追查别的事情。',speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[]};
const proposal={narrative:'进行已授权的普通活动',minutes:1,target_id:null,facts:[],relationship:null,item_move:null,
  storage_move:null,completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,
    domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}};

describe('QA22–25 everyday actions and independent world',()=>{
  it('keeps a three-person notice committed when later reading fails, then resumes only reading',async()=>{
    let scenes=0;
    const f=await sparseSetup(async req=>{
      if((req.schema as any).properties?.understanding){scenes++;return {data:{understanding:'告知三位同伴',
        narrative:'三位同伴听到了你的话。',dialogue:'好。',speech_events:[
          {speaker_id:'player',utterance:'你们可以自己安排。',provenance:'generated_from_player_intent'},
          ...['npc_lin','npc_qiao','npc_third'].map(speaker_id=>({speaker_id,utterance:'好。',provenance:'npc_response'}))],
        effects:[],travel_intents:[]}};}
      if((req.schema as any).properties?.verdict)return {data:{verdict:'aligned',explanation:'保留通知与阅读顺序。'}};
      throw Error('unexpected model stage');
    });
    const save=await f.service.current(),third=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);
    third.id='npc_third';third.components.identity.name='第三位同伴';save.entities.push(third);
    const ids=['npc_lin','npc_qiao','npc_third'];
    for(const npc of save.entities.filter(e=>ids.includes(e.id)))npc.components.location={location_id:'square'};
    save.definition.map!.locations.find(l=>l.id==='square')!.description='书架上有可正常取阅的书籍。';
    await f.store.write(save);
    const names=ids.map(id=>String(save.entities.find(e=>e.id===id)!.components.identity.name));
    const input=`告诉${names.join('、')}可以自己安排，然后在这里阅读十五分钟。`;
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
      {goal_id:'say',type:'WORLD_SPEECH',normalized_goal:`告诉${names.join('、')}可以自己安排`,operation_hint:'talk',
        referent:names.join('、'),depends_on:[],target_entities:[],condition:null,branch:null,
        temporal_scope:{scope:'now',day_offset:0,window:'any'}},
      {goal_id:'read',type:'WORLD_ACTION',normalized_goal:'在这里阅读十五分钟',operation_hint:'activity',referent:'书籍',
        depends_on:['say'],target_entities:[],condition:null,branch:null,
        temporal_scope:{scope:'now',day_offset:0,window:'any'}}]});
    const freeform=vi.spyOn(f.ai,'freeform').mockRejectedValueOnce(new ProviderError('timeout','isolated','isolated'))
      .mockResolvedValue({...proposal,minutes:15} as never);
    vi.spyOn(f.ai,'narrate').mockResolvedValue(prose as never);
    const plan=compileGoalContract(f.service.project(save),await createAgentPlan(f.ai,f.service.project(save),input),
      {kind:'manual',text:input});
    const body={game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),input};
    const interrupted=await executePlan(f.service,body,plan),partial=await f.service.current();
    expect(interrupted.plan?.status).not.toBe('completed');
    expect(scenes).toBe(1);
    expect(partial.runtime.time.minute).toBe(save.runtime.time.minute);
    expect(partial.active_goal?.plan.goals[0].status).toBe('completed');
    const resumed=await handleAgentInput(f.service,{game_id:partial.game_id,expected_revision:partial.state_revision,
      request_id:randomUUID(),input:'继续目标'});
    const after=await f.service.current();
    expect(resumed.plan?.status).toBe('completed');
    expect(scenes).toBe(1);
    expect(freeform).toHaveBeenCalledTimes(2);
    expect(after.runtime.time.minute-save.runtime.time.minute).toBe(15);
    expect(after.resolution_receipts?.filter(r=>r.activity?.description.includes('阅读'))).toHaveLength(1);
  });
  it.each(['referent','real_colon','real_conjunction','scene_composite','scene_presence_recovery'] as const)('binds %s audience as one scene, then reads for fifteen minutes and resumes without repeating speech',async shape=>{
    let scenes=0;
    const f=await sparseSetup(async req=>{
      if((req.schema as any).properties?.understanding){scenes++;return {data:{understanding:'告知同行者',
        // Recorded tr_6d3572ac0fc3 shape: four speech events, three present
        // listeners, wait effect, valid schema, rejected departure narration.
        // Exact original prose was not persisted; this sentence is a synthetic equivalent.
        narrative:shape==='scene_presence_recovery'&&scenes===1?'林舟离开了房间。':'三人听到了你的话。',
        dialogue:'好。',speech_events:[{speaker_id:'player',utterance:'你们可以自己安排。',provenance:'generated_from_player_intent'},
          ...['npc_lin','npc_qiao','npc_third'].map(speaker_id=>({speaker_id,utterance:'好。',provenance:'npc_response'}))],
        effects:shape.startsWith('scene_')?[{kind:'wait',minutes:15}]:[],travel_intents:[]}};}
      if((req.schema as any).properties?.verdict)return {data:{verdict:'aligned',explanation:'仅转述已授权意图。'}};
      throw Error('unexpected model stage');
    });
    const save=await f.service.current();
    const ids=['npc_lin','npc_qiao','npc_third'];
    const third=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);third.id='npc_third';third.components.identity.name='第三位同伴';save.entities.push(third);
    for(const npc of save.entities.filter(e=>ids.includes(e.id)))npc.components.location={location_id:'square'};
    save.definition.map!.locations.find(l=>l.id==='square')!.description='开放阅览区，书架上有可正常取阅的书籍。';
    await f.store.write(save);
    const names=ids.map(id=>String(save.entities.find(e=>e.id===id)!.components.identity.name));
    const input=`对${names.join('、')}说可以自由活动，然后留在这里正常阅读十五分钟，不调查上锁柜子。`;
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
      // Anonymized persisted plans from tr_ee1b8f26b2fa / tr_0dd36ec66b43:
      // WORLD_SPEECH + talk, null referent, [] targets, names only in normalized_goal.
      {goal_id:'say',type:'WORLD_SPEECH',normalized_goal:shape==='real_colon'?
        `对${names.join('、')}说：今天辛苦他们陪着跑了这么多地方；接下来自己想在这里安静看一会儿书，他们不用一直陪着，可以按自己的想法活动，不必等自己。`:
        shape==='real_conjunction'?`向${names.slice(0,2).join('、')}和${names[2]}说今天辛苦了；说明自己接下来想安静看书，三人可以按自己的想法活动。`:
        `告诉${names.join('、')}可以自己安排`,operation_hint:'talk',referent:shape==='referent'?names.join('、'):null,
        depends_on:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}},
      {goal_id:'read',type:'WORLD_ACTION',normalized_goal:'在这里正常阅读十五分钟，不调查上锁柜子',operation_hint:'activity',referent:'书籍',
        depends_on:['say'],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}},
    ]});
    vi.spyOn(f.ai,'freeform').mockResolvedValue({...proposal,required_conditions:[{
      kind:'entity_exists',subject_id:'书籍',scene_reference:{location_id:'square',quote:'书架上有可正常取阅的书籍'}}]});
    vi.spyOn(f.ai,'narrate').mockResolvedValue(prose as never);
    const view=f.service.project(save),plan=compileGoalContract(view,await createAgentPlan(f.ai,view,input),{kind:'manual',text:input});
    expect(plan.goals[0].contract?.completion).toMatchObject({audience_ids:ids});
    expect(canExecuteContractPlan(plan)).toBe(true);
    const body={game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),input};
    // Include the production admission gate which rejected both recorded requests.
    const semantic={kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent',
      goal_spec:{objective:input,play_action:'speak',targets:[],desired_state:[],desired_outputs:[],constraints:[],
        persistence:'none',temporal:{at:null,recurrence:null},dependencies:shape==='scene_composite'?['告知后阅读']:[],
        world_mutation:true,external_artifact:false,multi_step:shape==='scene_composite',ambiguity:null}};
    const response=shape.startsWith('scene_')?await handleAgentInput(f.service,body,undefined,null,false,semantic as never):
      await executePlan(f.service,body,plan);
    const after=await f.service.current(),expectedScenes=shape==='scene_presence_recovery'?2:1;
    expect(response.plan?.status).toBe('completed');expect(response.presentation).toBe('story');expect(scenes).toBe(expectedScenes);
    if(shape.startsWith('scene_'))expect(f.ai.planGoals).toHaveBeenCalledTimes(2); // fixture precompile + actual entry
    const reading=after.resolution_receipts?.find(r=>r.activity?.description.includes('正常阅读'));
    expect(reading?.time_cost).toBe(15);expect(reading?.activity?.occurred).toBe(true);
    expect(after.runtime.time.minute-save.runtime.time.minute).toBe(15);
    expect(ids.every(id=>after.entities.find(e=>e.id===id)?.components.location?.location_id==='square')).toBe(true);
    const loaded=validateSave(JSON.parse(JSON.stringify(after)));await f.store.write(loaded);
    const resumed=await handleAgentInput(f.service,body);
    expect(resumed.plan?.status).toBe('completed');expect(scenes).toBe(expectedScenes);
    expect((await f.service.current()).runtime.time).toEqual(after.runtime.time);
    let undone=await f.service.current();
    for(let attempts=0;attempts<6&&undone.runtime.time.minute>save.runtime.time.minute;attempts++){
      await f.service.undo({game_id:undone.game_id,expected_revision:undone.state_revision,request_id:randomUUID()});
      undone=await f.service.current();
    }
    expect(undone.runtime.time.minute).toBe(save.runtime.time.minute);
    expect(undone.npc_agent_state?.npc_lin?.memories.some(memory=>memory.kind==='heard')).toBe(true);
    expect(scenes).toBe(expectedScenes);
  });
  it('does not commit a scoped scene with false structured presence claims after bounded recovery',async()=>{
    let scenes=0;
    const f=await sparseSetup(async req=>{
      if((req.schema as any).properties?.understanding){scenes++;return {data:{understanding:'告知同行者',
        narrative:'林舟离开了房间。',presence_claims:[{entity_id:'npc_lin',location_id:'market'}],dialogue:'好。',speech_events:[
          {speaker_id:'player',utterance:'你们可以自己安排。',provenance:'generated_from_player_intent'},
          ...['npc_lin','npc_qiao','npc_third'].map(speaker_id=>({speaker_id,utterance:'好。',provenance:'npc_response'}))],
        effects:[{kind:'wait',minutes:15}],travel_intents:[]}};}
      throw Error('unexpected model stage');
    });
    const before=await f.service.current(),third=structuredClone(before.entities.find(e=>e.id==='npc_lin')!);
    third.id='npc_third';third.components.identity.name='第三位同伴';before.entities.push(third);
    for(const npc of before.entities.filter(e=>e.components.character))npc.components.location={location_id:'square'};
    await f.store.write(before);
    const result=await handleAgentInput(f.service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'告知三位同伴可以自由安排'},undefined,'npc_lin',false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'} as never,true);
    const after=await f.service.current();
    expect(scenes).toBe(2);expect(result.outcome).toMatchObject({type:'engine_failure',code:'schema_failure',stage:'natural_scene'});
    expect(after.state_revision).toBe(before.state_revision);expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.entities).toEqual(before.entities);expect(after.resolution_receipts??[]).toEqual(before.resolution_receipts??[]);
    expect(after.narrative_history).toEqual(before.narrative_history);
  });
  it.each([true,false])('respects reading dependency=%s if a named listener is no longer present',async dependent=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
    save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'market'};
    await f.store.write(save);
    const input='向林舟和乔宁说可以自由安排，随后自己正常阅读十五分钟';
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
      {goal_id:'say',type:'WORLD_SPEECH',normalized_goal:'向林舟和乔宁说可以自由安排',operation_hint:'talk',referent:null,
        depends_on:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}},
      {goal_id:'read',type:'WORLD_ACTION',normalized_goal:'在这里正常阅读十五分钟',operation_hint:'activity',referent:null,
        depends_on:dependent?['say']:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}},
    ]});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
    vi.spyOn(f.ai,'narrate').mockResolvedValue(prose as never);
    const view=f.service.project(save),plan=compileGoalContract(view,await createAgentPlan(f.ai,view,input),{kind:'manual',text:input});
    expect(plan.goals[0].contract?.completion).toMatchObject({audience_ids:['npc_lin','npc_qiao']});
    const response=await executePlan(f.service,{game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),input},plan);
    const after=await f.service.current();
    expect(response.plan?.goals[0].status).toBe('blocked');
    expect(response.plan?.goals[1].status).toBe(dependent?'pending':'completed');
    expect(after.runtime.time.minute-save.runtime.time.minute).toBe(dependent?0:15);
    expect(after.npc_agent_state?.npc_lin?.memories.some(memory=>memory.kind==='heard')??false).toBe(false);
  });
  it('does not turn a named addressee and a person being discussed into an automatic group',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'ask',type:'WORLD_SPEECH',
      normalized_goal:'向林舟询问乔宁的近况',operation_hint:'talk',referent:'林舟',depends_on:[],
      target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]});
    const view=f.service.project(save),plan=compileGoalContract(view,await createAgentPlan(f.ai,view,'询问近况'),{kind:'manual',text:'询问近况'});
    expect(plan.goals[0].contract?.completion).not.toHaveProperty('audience_ids');
  });
  it('binds the explicit source addressee without turning a named topic into a group',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),text='向林舟询问乔宁的近况';
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{goal_id:'say',type:'WORLD_SPEECH',normalized_goal:text,
      operation_hint:'talk',referent:null,depends_on:[],target_entities:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}),{kind:'manual',text});
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
    expect(plan.goals[0].contract?.bindings.filter(b=>b.role==='person').map(b=>b.entity_id)).toEqual(['npc_lin']);
    expect(canExecuteContractPlan(plan)).toBe(true);
  });
  it.each(['向林舟或乔宁说今天辛苦了','告诉林舟、乔宁或另一人今天辛苦了',
    '向林舟、乔宁和未登记的人说今天辛苦了'])('does not invent a group for %s',async text=>{
    const f=await sparseSetup(),save=await f.service.current();
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'say',type:'WORLD_SPEECH',normalized_goal:text,
      operation_hint:'talk',referent:null,depends_on:[],target_entities:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'}}]});
    const view=f.service.project(save),plan=compileGoalContract(view,await createAgentPlan(f.ai,view,text),{kind:'manual',text});
    expect(plan.goals[0].contract?.completion).not.toHaveProperty('audience_ids');
    expect(canExecuteContractPlan(plan)).toBe(false);
  });
  it('observes described scenery without an Item entity, but grants no transfer or invented object',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.definition.map!.locations.find(l=>l.id==='square')!.description='地面有旧石槽，石槽外缘布满青苔。';
    const required={kind:'entity_exists' as const,subject_id:'旧石槽',scene_reference:{location_id:'square',quote:'地面有旧石槽'}};
    const observed=executeFreeform(save,'仔细查看旧石槽', {...proposal,required_conditions:[required]},randomUUID(),()=>.5,true);
    expect(observed.save.entities.length).toBe(save.entities.length);
    expect(observed.save.resolution_receipts?.at(-1)?.prerequisites).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'scene_description',subject_id:'旧石槽'})]));
    expect(evaluateWorldPrerequisites(save,{requirements:[required]}).status).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,'查看并不存在的装置', {...proposal,required_conditions:[{...required,
      subject_id:'装置',scene_reference:{location_id:'square',quote:'有一个装置'}}]},randomUUID(),()=>.5,true)).toThrow();
    expect(evaluateWorldPrerequisites(save,{requirements:[{kind:'item_held',subject_id:'旧石槽'}],scene_description_access:true}).status).toBe('NOT_EXECUTABLE');
  });
  it('keeps successive similar inspection targets in committed order and does not assert a return journey',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const first=executeFreeform(save,'观察入口一侧的地面',proposal,randomUUID(),()=>.5,true);
    first.save.resolution_receipts!.at(-1)!.commit_status='committed';
    const second=executeFreeform(first.save,'观察入口另一侧的地面',proposal,randomUUID(),()=>.5,true);
    second.save.resolution_receipts!.at(-1)!.commit_status='committed';
    const actions=recentSettledActions(second.save);
    expect(actions.at(-2)?.attempted_action).toContain('入口一侧');
    expect(actions.at(-1)?.attempted_action).toContain('入口另一侧');
    expect(actions.at(-1)?.movement_route).toBeNull();
    expect(actions.at(-1)?.effects).not.toContain('position');
    let context:any;
    vi.spyOn(f.ai,'sceneAgent').mockImplementation(async(_schema,_profile,data)=>{
      context=data;return sceneResultSchema.parse({understanding:'当前交流',narrative:'同伴抬起头。',dialogue:'好。',
        speech_events:[{speaker_id:'npc_lin',utterance:'好。',provenance:'npc_response'}],effects:[],travel_intents:[]}) as never;
    });
    await runSceneInteraction(f.service,second.save,f.service.project(second.save),'观察结束了。',{id:'npc_lin'},'none');
    expect(context.authoritative_recent_player_actions.at(-1).attempted_action).toContain('入口另一侧');
    expect(context.action_history_policy).toContain('不能用旧叙事覆盖最近权威动作');
  });
  it.each([true,false])('reading drives due NPC actions and only eligible remote events (event=%s)',async eventEnabled=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.runtime.time={day:1,minute:540};save.npc_autonomy_last_at={day:1,minute:180};
    save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
    save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'market'};
    save.definition.map!.routes.push({from:'station',to:'market',travel_minutes:4,conditions:[]});
    save.definition.map!.locations.find(l=>l.id==='square')!.description='图书室有可取阅的普通书籍。';
    save.npc_agent_state={npc_lin:emptyNpcAgentState(),npc_qiao:emptyNpcAgentState()};
    save.npc_agent_state.npc_qiao.goals=[{id:'work',description:'留在本地值守岗位',horizon:'short',priority:5,status:'active',origin:'已登记的日常岗位'}];
    save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:60,replenishment:false};
    save.definition.background_incidents=[{id:'ordinary_shift',title:'普通交接',summary:'独立于玩家的日常安排',source:'WORLD_PACKAGE',
      created_at:save.runtime.time,earliest_activation:{day:1,minute:545},latest_activation:null,
      activation_flags:eventEnabled?[]:['not_satisfied'],activation_chance:1,participants:['npc_qiao'],locations:['market'],
      stages:[{id:'record',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',
        effects:[{kind:'set_flag',flag:'shift_recorded'}],exposures:[{id:'record_seen',channel:'same_location',location_id:'market',npc_id:null,
          text:'值班表上更新了一条交接记录。',interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
    delete save.background_state;await f.store.write(save);
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
    vi.spyOn(f.ai,'narrate').mockImplementation(async(_next,action)=>({...prose,
      narrative:action.type==='MOVE'?'你来到街角商店。':prose.narrative}) as never);
    const decisions=vi.spyOn(f.ai,'npcDecision').mockImplementation(async(_profile,context:any)=>({kind:'proposed_action',speech:null,
      vote_target:null,intent:'按自身既有安排行动',proposed_action:context.npc_id==='npc_lin'?
        {type:'MOVE',target_id:'market',reason:'按既有公开路线前往工作地点'}:
        {type:'HOLD',target_id:null,reason:'在已有岗位值守',duration_minutes:10},
      evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'完成本次有界日常活动',social_response:null}));
    const body={game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),input:'留在图书室阅读十五分钟'};
    await f.service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
    const after=await f.service.current();
    expect(after.runtime.time.minute).toBe(555);
    expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('square');
    expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('market');
    expect(after.resolution_receipts?.some(r=>r.actor_id==='npc_qiao'&&r.semantic_action==='HOLD'&&r.commit_status==='committed')).toBe(true);
    expect(decisions).toHaveBeenCalledTimes(2);
    expect(Boolean(after.gm_state.flags.shift_recorded)).toBe(eventEnabled);
    expect(after.background_state?.exposure_log).toHaveLength(0);
    expect(after.last_turn?.narrative).not.toContain('交接记录');
    await f.service.turn(body);expect((await f.service.current()).runtime.time).toEqual(after.runtime.time);
    await f.store.write(validateSave(JSON.parse(JSON.stringify(after))));
    await f.service.turn({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID(),
      action:{type:'MOVE',target_id:'market',parameters:{companions:'none'}}});
    const arrived=await f.service.current();
    expect(arrived.last_turn?.narrative.includes('交接记录')).toBe(eventEnabled);
    await f.service.undo({game_id:arrived.game_id,expected_revision:arrived.state_revision,request_id:randomUUID()});
    const beforeArrival=await f.service.current();
    await f.service.undo({game_id:beforeArrival.game_id,expected_revision:beforeArrival.state_revision,request_id:randomUUID()});
    const undone=await f.service.current();
    expect(undone.runtime.time.minute).toBe(540);
    expect(undone.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('station');
    expect(undone.gm_state.flags.shift_recorded).toBeUndefined();
  });
});

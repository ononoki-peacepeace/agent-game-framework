import {ProviderError} from '../src/ai/failures.js';
import {afterEach,describe,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';

// Structural recordings: tr_ee1b8f26b2fa (null referent),
// tr_6d3572ac0fc3 (natural_scene + four speech events + wait),
// tr_9db03c095344 (two ordered goals, bound audience, dialogue mismatch,
// then presence rejection). Original scene prose / full Semantic were NOT
// persisted: the public words and semantic detail below are synthetic fixtures.
const cases=['recorded_contract','null_referent','scene_wait','unsafe_prose','refuses_departure',
  'reading_only','absent_listener','invalid_speaker','reading_blocked','remote_event','calm_world',
  'qualified_recipients','qualified_old_plan','structured_recipients','unknown_recipient',
  'unknown_first_recipient','alternative_recipients','discussed_people','semantic_audience','semantic_unknown','semantic_id_mismatch','independent_reading','scene_schema_repair','scene_network_failure','scene_program_failure','stale_clarification'] as const;
type Mode=typeof cases[number];
const resources:{directory:string;servers:Server[]}[]=[];
afterEach(async()=>{
  for(const resource of resources.splice(0)){
    for(const server of resource.servers)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(resource.directory,{recursive:true,force:true});
  }
});

async function setup(mode:Mode){
  const directory=await mkdtemp(join(tmpdir(),'agf-qa25-http-'));
  const resource={directory,servers:[] as Server[]};resources.push(resource);
  const ids=['npc_lin','npc_qiao','npc_third'],names=['林舟','乔宁','第三位同伴'];
  const speech=`对${names.join('、')}说可以自行安排，不必陪同，也不要求离开`;
  // Exact persisted goal structure from tr_ab2359d00203, with public names
  // anonymized. No speech_recipients / referent was present in that recording.
  const qualified=`对同场的${names[0]}、${names[1]}和${names[2]}说：「今天辛苦你们陪我到处调查了。我接下来想在这里安静地看一会儿书，你们不用一直陪着我，可以按自己的想法去做事情，不必等我。」只说明三人可自行行动，不替三人决定去留。`;
  const goalSpeech=mode.startsWith('qualified_')?qualified:mode==='structured_recipients'?'说明接下来的安排，不替听众决定去留':
    mode==='unknown_first_recipient'?`向未登记人物和${names[0]}、${names[1]}说可以自行安排`:
    mode==='alternative_recipients'?`向同场的${names[0]}、${names[1]}或${names[2]}说可以自行安排`:
    mode==='discussed_people'?`向${names[0]}询问${names[1]}和${names[2]}的近况`:speech;
  const reading='留在这里正常阅读十五分钟，不调查上锁文件柜';
  const input=mode==='reading_only'||mode==='remote_event'||mode==='calm_world'?reading:
    mode==='null_referent'?`我对林先生、乔女士和第三位说可以自行安排，随后${reading}`:
    mode==='qualified_old_plan'?`取消当前目标\n补充说明：${speech}，然后${reading}`:`${speech}，然后${reading}`;
  let scenes=0,decisions=0,alignmentHasRecipients=false;
  const stages:string[]=[];
  const ai=new AIRuntime({name:'recorded-shape-fixture',generate:async request=>{
    const p=(request.schema as any).properties??{};
    if(p.interaction_lane){stages.push('semantic');return {data:{domain:'world',kind:'world_action',operation_plane:'play',
      confidence:.99,clarification_resolution:mode==='stale_clarification'?'new_request':null,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
      interaction_lane:input===reading||mode.startsWith('qualified_')?'world_transaction':'natural_scene',player_speech_mode:input===reading?'none':'intent',
      goal_spec:{objective:input,play_action:input===reading||mode.startsWith('qualified_')?'other':'speak',
        targets:mode.startsWith('semantic_')?names.map((reference,index)=>({kind:'entity',role:'audience',reference:mode==='semantic_unknown'&&index===2?'未登记人物':reference,entity_id:mode==='semantic_unknown'&&index===2?null:mode==='semantic_id_mismatch'&&index===2?ids[0]:ids[index]})):mode.startsWith('qualified_')?names.map((reference,index)=>({kind:'entity',reference,entity_id:ids[index]})):[],desired_state:[],desired_outputs:[],
        constraints:[],persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,
        external_artifact:false,multi_step:input!==reading&&mode!=='scene_wait',ambiguity:null}}};}
    if(p.preserved)return {data:{preserved:true,reason:'保留原请求'}};
    if(p.aligned)return {data:{aligned:true,reason:'游戏行动'}};
    if(p.verdict){stages.push('alignment');if(request.prompt.includes('"proposed_steps"'))
      alignmentHasRecipients=request.prompt.includes(`"speech_recipients":${JSON.stringify(names)}`);
      return {data:{verdict:'aligned',explanation:'保留原始授权'}};}
    if(p.goals){stages.push('planner');return {data:{goals:[...(input===reading?[]:[{
      goal_id:'g1',type:'WORLD_SPEECH',normalized_goal:mode.startsWith('semantic_')?'向已经确认的听众说明可以自由活动，不替他们决定去留':goalSpeech,operation_hint:'talk',
      ...(mode==='structured_recipients'?{speech_recipients:names}:['unknown_recipient','independent_reading'].includes(mode)?{speech_recipients:[...names,'未登记人物']}:{}),
      referent:mode==='recorded_contract'?names.join('、'):null,target_entities:[],depends_on:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'}}]),{
      goal_id:'g2',type:'WORLD_ACTION',normalized_goal:reading,operation_hint:'activity',referent:'普通书籍',target_entities:[],
      depends_on:input===reading||mode==='independent_reading'?[]:['g1'],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}};}
    if(p.understanding){stages.push('scene');scenes++;
      if(mode==='scene_network_failure')throw new ProviderError('timeout','isolated transport timeout','timeout');
      if(mode==='scene_program_failure')throw new TypeError('isolated program failure');
      if(mode==='scene_schema_repair'&&scenes===1)return {data:{understanding:'场景',narrative:'合成错误候选',speech_events:null}};
      if(mode==='scene_schema_repair'){expect(request.prompt).toContain('schema_feedback');expect(request.prompt).toContain('speech_events');expect(request.prompt).toContain('previous_output');}
      if(mode==='semantic_audience')expect(request.prompt).toContain(`"confirmed_audience_ids":${JSON.stringify(ids)}`);

      const events=[{speaker_id:'player',utterance:'你们可以自行安排。',provenance:'generated_from_player_intent'},
        ...ids.map((speaker_id,index)=>({speaker_id:mode==='invalid_speaker'&&index===2?'absent_ghost':speaker_id,
          utterance:mode==='refuses_departure'&&index===2?'我想留在这里。':'好。',provenance:'npc_response'}))];
      const unsafe=mode==='unsafe_prose'||mode==='scene_wait'&&scenes===1;
      return {data:{understanding:'群体告知',narrative:unsafe?'林舟离开了房间。':'三人听到了你的话。',
        // Actual failure category: redundant summary was not an event utterance.
        dialogue:'三人分别回应了这次告知。',speech_events:events,
        beats:[{kind:'narration',text:unsafe?'林舟离开了房间。':'三人听到了你的话。'},
          ...events.map((_,speech_index)=>({kind:'speech',speech_index}))],
        effects:mode==='scene_wait'?[{kind:'wait',minutes:15}]:[],travel_intents:[]}};
    }
    if(p.resolution){stages.push('activity_proposal');return {data:{narrative:'进行已授权的普通阅读',minutes:1,
      target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,
      required_conditions:mode==='reading_blocked'?[{kind:'item_held',subject_id:'required_book'}]:[],
      resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'普通阅读',stages:[],evidence_ids:[]}}};}
    if(request.role==='npc_decision'){stages.push('npc');decisions++;
      const moving=/"context"\s*:\s*\{\s*"npc_id"\s*:\s*"npc_worker_move"/.test(request.prompt);
      return {data:{kind:'proposed_action',speech:null,vote_target:null,intent:'履行既有岗位安排',
        proposed_action:moving?{type:'MOVE',target_id:'market',reason:'前往既有工作地点'}:
          {type:'HOLD',target_id:null,reason:'岗位值守',duration_minutes:10},
        evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],
        decision_summary:'有界日常行动',social_response:null}};
    }
    if(request.role==='narrator'){stages.push('narrator');return {data:{narrative:'你在这里安静读了十五分钟，没有追查其他事情。',
      speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],item_claims:[],stable_locations:[],mechanical_claims:[]}};}
    throw Error(`unexpected provider stage: ${request.role} / ${Object.keys(p).join(',')}`);
  }});
  const store=new JsonStore(directory),world=sparseWorld();
  const service=new GameService(store,ai,world);await service.newGame();
  const save=await service.current();save.runtime.time={day:1,minute:540};
  const third=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);third.id=ids[2];third.components.identity.name=names[2];save.entities.push(third);
  for(const entity of save.entities.filter(e=>ids.includes(e.id)))entity.components.location={location_id:'square'};
  if(mode==='absent_listener')save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'market'};
  save.definition.map!.locations.find(l=>l.id==='square')!.description='图书室有允许取阅的普通书籍。';
  if(mode==='reading_blocked'){
    const book=structuredClone(save.entities.find(e=>e.id==='notebook')!);book.id='required_book';
    book.components.identity.name='普通书籍';book.components.location={location_id:'market'};save.entities.push(book);
    save.definition.map!.locations.find(l=>l.id==='square')!.description='这里目前没有可正常取阅的书籍。';
  }
  let oldPlanId:string|undefined;
  if(mode==='qualified_old_plan'){
    const old=compileGoalContract(service.project(save),validatePlan({goals:[{
      goal_id:'old_speech',type:'WORLD_SPEECH',normalized_goal:speech,operation_hint:'talk',referent:names.join('、'),
      target_entities:[],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}),
      {kind:'manual',text:speech});
    oldPlanId=old.plan_id;old.status='blocked';old.goals[0].status='blocked';
    save.active_goal={plan:old,waiting_question:'旧场景未通过校验',options:[]};
    save.paused_goals=Array.from({length:3},()=>({plan:{...structuredClone(old),plan_id:randomUUID()},waiting_question:null,options:[]}));
  }
  if(mode==='remote_event'||mode==='calm_world'){
    save.npc_autonomy_last_at={day:1,minute:180};
    // Existing companions just had their decision opportunity; overdue workers
    // should receive this bounded scheduler slice (no player interaction needed).
    for(const id of ids){save.npc_agent_state??={};save.npc_agent_state[id]=emptyNpcAgentState();
      save.npc_agent_state[id].last_autonomous_at={day:1,minute:540};}
    for(const [index,id] of ['npc_worker_move','npc_worker_hold'].entries()){
      const npc=structuredClone(third);npc.id=id;npc.components.identity.name=`值班者${index}`;
      npc.components.location={location_id:index===0?'station':'market'};save.entities.push(npc);
      save.npc_agent_state={...save.npc_agent_state,[id]:emptyNpcAgentState()};
      save.npc_agent_state[id].goals=[{id:'work',description:'按既有安排值守岗位',horizon:'short',priority:5,status:'active',origin:'已登记岗位'}];
    }
    save.definition.map!.routes.push({from:'station',to:'market',travel_minutes:4,conditions:[]});
    save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:60,replenishment:false};
    save.definition.background_incidents=[{id:'ordinary_shift',title:'日常交接',summary:'既有岗位交接',source:'WORLD_PACKAGE',
      created_at:save.runtime.time,earliest_activation:{day:1,minute:545},latest_activation:null,
      activation_flags:mode==='calm_world'?['not_satisfied']:[],activation_chance:1,participants:['npc_worker_hold'],locations:['market'],
      stages:[{id:'record',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_worker_hold',
        effects:[{kind:'set_flag',flag:'shift_recorded'}],exposures:[{id:'record_seen',channel:'same_location',location_id:'market',npc_id:null,
          text:'值班表更新了一条交接记录。',interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
    delete save.background_state;
  }
  if(mode==='stale_clarification')save.pending_world_clarification={input:'取消当前目标',question:'旧的澄清问题',at:Date.now(),created_revision:save.state_revision};
  await store.write(save);
  const open=async(svc:GameService)=>{
    const server=createApp(svc,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
    resource.servers.push(server);await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const {token}=await (await fetch(base+'/api/session')).json() as {token:string};
    return {base,post:async(path:string,body:unknown)=>{
      const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
      return {status:r.status,data:await r.json() as any};}};
  };
  return {service,store,ai,before:save,input,ids,stages,open,oldPlanId,alignmentHasRecipients:()=>alignmentHasRecipients,
    scenes:()=>scenes,decisions:()=>decisions,...await open(service)};
}

describe('QA25 real-shape HTTP -> semantic -> contract -> scene -> Core -> durable commit',()=>{
  it.each(cases)('%s',async mode=>{
    const f=await setup(mode),body={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input:f.input};
    const result=await f.post('/api/input',body),after=await f.service.current();
    expect(result.status,JSON.stringify(result.data)).toBe(200);
    expect(f.stages).toContain('semantic');if(!['reading_only','remote_event','calm_world'].includes(mode))expect(f.stages).toContain('planner');
    expect(result.data.view.revision).toBe(after.state_revision);expect(result.data.outcome.revision).toBe(after.state_revision);
    const bindingBlocked=['unknown_recipient','unknown_first_recipient','alternative_recipients','discussed_people','semantic_unknown','semantic_id_mismatch'].includes(mode);
    const blocked=bindingBlocked||['absent_listener','invalid_speaker','reading_blocked','scene_network_failure','scene_program_failure'].includes(mode);
    if(blocked){
      expect(after.runtime.time.minute).toBe(540);expect(after.resolution_receipts?.filter(r=>r.activity?.occurred)??[]).toHaveLength(0);
      expect(result.data.plan?.status).not.toBe('completed');
      if(['invalid_speaker','scene_network_failure','scene_program_failure'].includes(mode)){
        expect(result.data.presentation).toBe('failure');expect(result.data.message).toContain('交流');
        if(mode!=='invalid_speaker')expect(f.scenes()).toBe(1);
        expect(after.narrative_history?.filter(h=>h.speech_events?.some(e=>e.speaker_id==='absent_ghost'))??[]).toHaveLength(0);
      }else if(bindingBlocked){
        expect(result.data.outcome).toMatchObject({type:'engine_failure',code:'schema_failure',stage:'plan_admission'});
        expect(f.stages.filter(stage=>stage==='planner')).toHaveLength(2);
      }else expect(result.data.message).toContain(mode==='absent_listener'?'不在当前地点':'没有持有');
      if(bindingBlocked){expect(f.scenes()).toBe(0);if(mode!=='semantic_id_mismatch')expect(result.data.plan.goals[0].contract.completion).not.toHaveProperty('audience_ids');}
    }else{
      expect(result.data.outcome.type,JSON.stringify(result.data)).toBe('game');expect(result.data.plan.status).toBe(mode==='independent_reading'?'waiting_for_player':'completed');
      expect(after.runtime.time.minute).toBe(555);expect(f.stages).toContain('activity_proposal');expect(f.stages).toContain('narrator');
      expect(after.resolution_receipts?.filter(r=>r.activity?.occurred&&r.actor_id==='player')).toHaveLength(1);
      expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('square');
      for(const id of f.ids)expect(after.entities.find(e=>e.id===id)?.components.location?.location_id).toBe('square');
      if(mode==='scene_schema_repair')expect(f.scenes()).toBe(2);
      if(mode==='stale_clarification')expect(result.data.plan.contract.original_intent).toBe(f.input);
      if(mode==='structured_recipients')expect(f.alignmentHasRecipients()).toBe(true);
      if(mode==='independent_reading'){expect(f.scenes()).toBe(0);expect(result.data.plan.goals[0].status).toBe('waiting_for_player');}
      if(mode==='qualified_old_plan'){
        expect(after.active_goal?.plan.plan_id).toBe(body.request_id);expect(after.paused_goals).toHaveLength(4);
        expect(after.paused_goals?.some(p=>p.plan.plan_id===f.oldPlanId)).toBe(true);expect(f.scenes()).toBe(1);
      }
      if(!['reading_only','remote_event','calm_world','independent_reading'].includes(mode)){
        const events=after.narrative_history?.flatMap(h=>h.speech_events??[])??[];
        expect(events.map(e=>e.speaker_id)).toEqual(['player',...f.ids]);
        expect(events.some(e=>e.utterance==='三人分别回应了这次告知。')).toBe(false);
        expect(after.narrative_history?.some(h=>h.narrative.includes('离开了房间'))).toBe(false);
      }
      if(mode==='remote_event'||mode==='calm_world'){
        expect(f.decisions()).toBeGreaterThan(0);
        expect(after.entities.find(e=>e.id==='npc_worker_move')?.components.location?.location_id).toBe('market');
        expect(after.resolution_receipts?.some(r=>r.actor_id==='npc_worker_hold'&&r.semantic_action==='HOLD'&&r.commit_status==='committed')).toBe(true);
        expect(Boolean(after.gm_state.flags.shift_recorded)).toBe(mode==='remote_event');
        expect(after.background_state?.exposure_log).toHaveLength(0);
        expect(JSON.stringify(result.data.view.last_turn)).not.toContain('值班表更新');
        expect(after.resolution_receipts?.some(r=>r.actor_id?.startsWith('npc_worker')&&r.commit_status==='committed')).toBe(true);
      }
    }
    const duplicate=await f.post('/api/input',body);expect(duplicate.data).toEqual(result.data);
    expect((await f.service.current()).runtime.time).toEqual(after.runtime.time);
    // New service/app from disk: no in-memory request map or executor cache.
    const reloaded=new GameService(new JsonStore(f.store.directory),f.ai,sparseWorld());
    const reopened=await f.open(reloaded),calls=f.ai.metrics.requests;
    const retry=await reopened.post('/api/input',body);expect(retry.data).toEqual(result.data);expect(f.ai.metrics.requests).toBe(calls);
    if(!blocked){
      const undo=await reopened.post('/api/undo',{game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
      expect(undo.status).toBe(200);expect((await reloaded.current()).runtime.time.minute).toBe(540);
    }
  });
  it('handles exact cancellation of a real persisted goal identically for non-mock providers',async()=>{
    const f=await setup('qualified_old_plan'),before=await f.service.current(),calls=f.ai.metrics.requests;
    const result=await f.post('/api/input',{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'取消当前目标'});
    const after=await f.service.current();
    expect(result.status).toBe(200);expect(result.data.message).toContain('已终止剩余目标');
    expect(after.active_goal?.plan.status).toBe('failed');expect(after.paused_goals).toHaveLength(3);
    expect(after.runtime.time).toEqual(before.runtime.time);expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(f.ai.metrics.requests).toBe(calls);
    const next=await f.post('/api/input',{game_id:after.game_id,expected_revision:after.state_revision,
      request_id:randomUUID(),input:f.input});
    expect(next.data.plan.status,JSON.stringify(next.data)).toBe('completed');
    expect((await f.service.current()).runtime.time.minute).toBe(555);
  });
  it('queries, cancels a named paused goal, and resumes a named plan without semantic reinterpretation',async()=>{
    const f=await setup('qualified_old_plan'),before=await f.service.current(),calls=f.ai.metrics.requests;
    const command=async(input:string)=>{const now=await f.service.current();return f.post('/api/input',{
      game_id:now.game_id,expected_revision:now.state_revision,request_id:randomUUID(),input});};
    const query=await command('查询目标状态');
    expect(query.data.message).toContain(before.active_goal!.plan.plan_id);
    for(const paused of before.paused_goals!)expect(query.data.message).toContain(paused.plan.plan_id);
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
    const id=before.paused_goals![1].plan.plan_id;
    await command(`取消目标 ${id}`);
    expect((await f.service.current()).paused_goals?.some(p=>p.plan.plan_id===id)).toBe(false);
    expect(f.ai.metrics.requests).toBe(calls);
    const cancelled=await f.service.current();await f.post('/api/undo',{game_id:cancelled.game_id,expected_revision:cancelled.state_revision,request_id:randomUUID()});
    expect((await f.service.current()).paused_goals).toEqual(before.paused_goals);
    const chosen=before.paused_goals![0].plan.plan_id;
    // Explicit resume selects this stored plan, never silently pops a different one.
    await command(`恢复目标 ${chosen}`);
    const after=await f.service.current();expect(after.active_goal?.plan.plan_id).toBe(chosen);
    expect(after.active_goal?.plan.status).toBe('completed');expect(f.scenes()).toBe(1);
    expect(after.paused_goals?.some(p=>p.plan.plan_id===before.active_goal!.plan.plan_id)).toBe(true);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });

  it('continues a pending clarification only when the semantic owner explicitly authorizes that continuation',async()=>{
    const f=await setup('recorded_contract'),before=await f.service.current();
    const pending=f.input.replace('十五分钟','一段时间');
    before.pending_world_clarification={input:pending,question:'阅读多长时间？',at:Date.now(),created_revision:before.state_revision};
    await f.store.write(before);
    const original=f.ai.adapter.generate.bind(f.ai.adapter);
    f.ai.adapter.generate=async request=>{const result=await original(request);
      if((request.schema as any).properties?.interaction_lane)return {...result,data:{...(result.data as object),clarification_resolution:'continue_prior'}};
      return result;};
    const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'十五分钟'};
    const response=await f.post('/api/input',body);expect(response.data.plan.status).toBe('completed');
    expect(response.data.plan.contract.original_intent).toBe(`${pending}\n补充说明：十五分钟`);
    const after=await f.service.current();expect(after.runtime.time.minute).toBe(555);expect(f.scenes()).toBe(1);
    const calls=f.ai.metrics.requests;await f.post('/api/input',body);expect(f.ai.metrics.requests).toBe(calls);
    expect((await f.service.current()).runtime.time).toEqual(after.runtime.time);
  });

});

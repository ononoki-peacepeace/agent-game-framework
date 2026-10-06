import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {sparseSetup,sparseWorld} from './sparse-fixture.js';
import {localDurationIntent,executeFreeform} from '../src/core/freeform.js';
import {executeAction} from '../src/core/runtime.js';
import {prepareCheck,resolveCheck,resolutionProfile} from '../src/core/resolution.js';
import {fastPlan} from '../src/agent/planner.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {publicView} from '../src/core/state.js';
import {executableChoices} from '../src/core/choice-availability.js';
import {addDynamicLocation} from '../src/core/map.js';
import {distinctChoices} from '../src/ai/choice-diversity.js';

const proposal=(extra:Record<string,unknown>={})=>({narrative:'你尝试行动。',minutes:1,target_id:null,facts:['模型声称成功'],relationship:null,item_move:null,
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'仅完成行动尝试',stages:[],evidence_ids:[]},...extra});
const semantics=(type:'SIMPLE_CHECK'|'OPPOSED_CHECK'|'GRADED_CHECK'|'EXTENDED_CHECK'='SIMPLE_CHECK',extra:Record<string,unknown>={})=>({type,domain:'general',band:'normal',visibility:'public',stakes:'仅判定这次尝试',stages:[],evidence_ids:[],...extra});
const prose={narrative:'你完成这次尝试。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null};

describe('Batch 3 free action resolution',()=>{
  it.each([
    ['原地不动一整天',1440],['保持沉默30分钟',30],['坐在这里等到晚上',1080],
    ['躺着休息两个小时',120],['站着不动五分钟',5],['原地保持全裸一整天',1440],
  ])('routes local duration %s to HOLD rather than MOVE',async(input,minutes)=>{
    const f=await sparseSetup(),save=await f.service.current();
    expect(localDurationIntent(input,save.runtime.time)).toMatchObject({minutes});
    expect(fastPlan(publicView(save),input)?.goals[0].type).toBe('WORLD_ACTION');
    expect(await f.ai.interpret(save,input)).toEqual({type:'HOLD',parameters:{minutes,activity:input}});
    expect(f.calls).toHaveLength(0);
  });
  it('advances a hold in bounded world-event steps and stops at a real interruption',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.definition.events.push({id:'interrupt_fixture',hook:'on_time_advance',location_id:null,probability:1,once:true,public_text:'发生了需要处理的事。',set_flag:null,interrupt_automation:true});
    const turn=executeAction(save,{type:'HOLD',parameters:{minutes:1440,activity:'原地等待'}},randomUUID(),'ai',()=>0);
    expect(turn.action.type).toBe('HOLD');expect(turn.action.time_cost).toBeLessThan(1440);
    expect(turn.action.time_cost).toBeGreaterThan(0);expect(turn.save.foreground?.blocker).toBe('interrupt');
    expect(turn.save.event_roll_history?.[0]).toMatchObject({event_id:'interrupt_fixture',fired:true});
  });
  it('executes a full local day through the normal player request chain without a route lookup',async()=>{
    const f=await sparseSetup(async request=>{
      expect(request.role).toBe('narrator');return {data:prose};
    });
    const before=await f.service.current(),input='原地不动一整天';
    const result=await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input});
    expect(result.time).toEqual({day:before.runtime.time.day+1,minute:before.runtime.time.minute});
    expect(result.entities.find(entity=>entity.id===result.player_id)?.components.location?.location_id).toBe(before.entities.find(entity=>entity.id===before.player_state.entity_id)?.components.location?.location_id);
    expect(f.calls.map(call=>call.role)).toEqual(['narrator']);
  });
  it('performs a deterministic held-item pickup without a formal check roll',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const item=save.entities.find(entity=>entity.components.item)!;
    item.components.location=structuredClone(player.components.location);
    const moved=executeFreeform(save,`我拿起${item.components.identity.name}`,proposal({target_id:item.id,item_move:{item_id:item.id,to:'held',position_label:null},facts:[`拾起${item.components.identity.name}`]}),randomUUID(),()=>{throw Error('pickup must not roll');});
    expect((moved.save.entities.find(entity=>entity.id===player.id)?.components.inventory?.items as Record<string,number>)[item.id]).toBe(1);
    expect(moved.save.resolution_history?.[0].rolls).toEqual([]);
    expect(moved.save.resolution_receipts?.[0]).toMatchObject({kind:'DETERMINISTIC',outcome:'success',commit_status:'pending',effects:['time','inventory']});
  });
  it('uses a stable saved profile and legacy fallback without rewriting the old world',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    expect(resolutionProfile(save)).toBe('bell_2d6');
    save.definition.ruleset.resolution_profile={version:1,kind:'percentile_d100'};
    const dir=await mkdtemp(join(tmpdir(),'agf-resolution-profile-'));
    try{const store=new JsonStore(dir);await store.write(save);expect(resolutionProfile((await store.read())!)).toBe('percentile_d100');}
    finally{await rm(dir,{recursive:true,force:true});}
  });
  it('locks the specification before program dice and ignores provider facts as mechanical results',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),id=randomUUID();
    const spec=prepareCheck(save,id,{type:'SIMPLE_CHECK',domain:'general',band:'hard'});
    let calls=0;const result=resolveCheck(save,spec,()=>{expect(Object.isFrozen(spec)).toBe(true);expect(spec.difficulty_band).toBe('hard');calls++;return 0;});
    expect(calls).toBe(2);expect(result.rolls[0].expression).toBe('2d6');expect(result.outcome).toBe('critical_failure');
    const turn=executeFreeform(await f.service.current(),'我尝试攀爬墙面',proposal({facts:['模型声称掷出99并成功'],resolution:semantics()}),randomUUID(),()=>0);
    expect(turn.facts.join(' ')).not.toContain('99');expect(turn.save.resolution_history?.at(-1)?.rolls[0].rolls).toEqual([1,1]);
  });
  it('uses canonical actor and opponent capabilities for an opposed check',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const opponent=save.entities.find(e=>e.id!==actor.id&&e.components.character)!;
    opponent.components.location=structuredClone(actor.components.location);
    actor.components.attributes={values:{stealth:4},labels:{}};opponent.components.attributes={values:{perception:2},labels:{}};
    const spec=prepareCheck(save,randomUUID(),{type:'OPPOSED_CHECK',domain:'stealth',opposition_domain:'perception',band:'normal',target_id:opponent.id});
    expect(spec.actor_modifier).toBe(4);expect(spec.opponent_modifier).toBe(2);
    const values=[.7,.7,.1,.1];const result=resolveCheck(save,spec,()=>values.shift()!);
    expect(result.rolls).toHaveLength(2);expect(result.outcome).toBe('success');
  });
  it('preserves existing hidden evidence on failure, reveals only existing evidence on success',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),actor=save.player_state.entity_id;
    save.gm_state.hidden_truth={version:1,commitments:[{id:'truth_fixture',commitment:'HARD_TRUTH',statement:'已固定的测试事实',seed_constraint:null,source:'GM_DECLARED',created_event_ref:null,known_by:[],evidence:[{id:'evidence_fixture',status:'EXISTS',description:'已存在的测试痕迹',event_ref:null,discovered_by:[],placement:{location_id:String(save.entities.find(e=>e.id===actor)?.components.location?.location_id),anchor_entity_id:null,scene_scope:null,discoverability:{domain:'search',difficulty:'trivial'}}}]}]};
    const before=JSON.stringify(save.gm_state.hidden_truth.commitments[0].evidence);
    const failed=prepareCheck(save,randomUUID(),{type:'GRADED_CHECK',domain:'search',band:'extreme',evidence_ids:['evidence_fixture']});
    expect(resolveCheck(save,failed,()=>0).outcome).toMatch(/failure/);
    expect(save.gm_state.hidden_truth.commitments[0].evidence[0].discovered_by).toEqual([]);
    const successful=prepareCheck(save,randomUUID(),{type:'GRADED_CHECK',domain:'search',band:'trivial',evidence_ids:['evidence_fixture']});
    expect(resolveCheck(save,successful,()=>.99).outcome).toMatch(/success/);
    expect(save.gm_state.hidden_truth.commitments[0].evidence[0].discovered_by).toEqual([actor]);
    expect(JSON.parse(before)[0].description).toBe(save.gm_state.hidden_truth.commitments[0].evidence[0].description);
    expect(()=>prepareCheck(save,randomUUID(),{type:'GRADED_CHECK',domain:'search',band:'normal',evidence_ids:['invented_clue']})).toThrow();
  });
  it('rejects inaccessible opposition before rolling and stops an extended check after stage one fails',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const opponent=save.entities.find(e=>e.id!==actor.id&&e.components.character)!;opponent.components.location={location_id:'remote'};
    expect(()=>prepareCheck(save,randomUUID(),{type:'OPPOSED_CHECK',domain:'stealth',band:'hard',target_id:opponent.id})).toThrow('不在当前场景');
    let count=0;const spec=prepareCheck(save,randomUUID(),{type:'EXTENDED_CHECK',domain:'general',band:'hard',stages:[{id:'approach',band:'extreme'},{id:'act',band:'normal'}]});
    const result=resolveCheck(save,spec,()=>{count++;return 0;});expect(count).toBe(2);expect(result.rolls).toHaveLength(1);expect(result.outcome).toMatch(/failure/);
    const successful=prepareCheck(save,randomUUID(),{type:'EXTENDED_CHECK',domain:'general',band:'normal',stages:[{id:'approach',band:'easy'},{id:'act',band:'normal'}]});
    const completed=resolveCheck(save,successful,()=>0.999);expect(completed.rolls).toHaveLength(2);expect(completed.outcome).toBe('success');
    expect(save.entities.find(e=>e.id===opponent.id)).toEqual(opponent);
  });
  it('reuses the persisted mechanical candidate across a narrator failure and process restart',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'agf-resolution-retry-'));let fail=true;
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      if(request.role!=='narrator')throw Error('unexpected provider role');
      if(fail)throw Error('controlled narrator timeout');return {data:prose};
    }});
    try{
      const store=new JsonStore(dir),service=new GameService(store,ai,sparseWorld());await service.newGame();
      const before=await service.current(),request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'CHECK',parameters:{}}};
      await expect(service.turn(request)).rejects.toThrow('尚未结算');
      const staged=await store.readPending(request.request_id);
      expect(staged?.candidate.resolution_history).toHaveLength(1);expect(await service.current()).toEqual(before);
      fail=false;const resumed=new GameService(store,ai,sparseWorld());const result=await resumed.turn(request);
      expect(result.revision).toBe(before.state_revision+1);
      const committed=await resumed.current();expect(committed.resolution_history).toEqual(staged?.candidate.resolution_history);
      expect(committed.runtime.receipts.filter(receipt=>receipt.id===request.request_id)).toHaveLength(1);
      await resumed.turn(request);expect((await resumed.current()).state_revision).toBe(committed.state_revision);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('keeps generic conditional plans in enter → observed event → branch order',async()=>{
    const cases=[
      '我进房间，如果她问我就回答，否则坐下。',
      '我继续往前走，如果有人拦我就停下。',
    ];
    for(const input of cases){
      const f=await sparseSetup(async request=>{
        expect(request.role).toBe('intent_interpreter');
        return {data:{goals:[
          {goal_id:'enter',type:'WORLD_ACTION',normalized_goal:input.split('，')[0],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
          {goal_id:'observe',type:'CONDITIONAL_INTENT',normalized_goal:'判断声明的事件是否发生',depends_on:['enter'],condition:{kind:'observed_event',entity_id:'npc_lin',description:'是否有人叫住或拦住玩家'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:['npc_lin']},
          {goal_id:'then',type:'WORLD_ACTION',normalized_goal:'按条件回应',depends_on:['observe'],condition:null,branch:'then',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
          {goal_id:'else',type:'WORLD_ACTION',normalized_goal:'按条件继续',depends_on:['observe'],condition:null,branch:'else',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
        ]}};
      });
      const plan=await createAgentPlan(f.ai,await f.service.view() as NonNullable<Awaited<ReturnType<typeof f.service.view>>>,input);
      expect(plan.execution_order).toEqual(['enter','observe','then','else']);
      expect(plan.goals[1].condition?.kind).toBe('observed_event');
    }
  });
  it('uses a separate read-only public-fact condition for a door state without inventing an observed event',async()=>{
    const input='如果门锁着就敲门，否则直接进去。';
    const f=await sparseSetup(async request=>({data:{goals:[
      {goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断门是否锁着',depends_on:[],condition:{kind:'public_fact',entity_id:'player',description:'门当前是否锁着'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
      {goal_id:'knock',type:'WORLD_ACTION',normalized_goal:'敲门',depends_on:['condition'],condition:null,branch:'then',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
      {goal_id:'enter',type:'WORLD_ACTION',normalized_goal:'直接进去',depends_on:['condition'],condition:null,branch:'else',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
    ]}}));
    const plan=await createAgentPlan(f.ai,await f.service.view() as NonNullable<Awaited<ReturnType<typeof f.service.view>>>,input);
    expect(plan.goals.map(goal=>goal.type)).toEqual(['CONDITIONAL_INTENT','WORLD_ACTION','WORLD_ACTION']);
    expect(plan.goals[0].condition?.kind).toBe('public_fact');
  });
  it('filters an unreachable structured target and preserves original semantic indexes during deduplication',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id??'');
    addDynamicLocation(save,{id:'unreachable_fixture',name:'远处塔楼',description:'',tags:[],known_by_default:true},[]);
    const choices=['留在这里','前往远处塔楼','观察附近','观察附近'];
    const meanings=[
      {index:0,intent_key:'stay',consequence_key:'stay',target_id:null},
      {index:1,intent_key:'move',consequence_key:'tower',target_id:'unreachable_fixture'},
      {index:2,intent_key:'observe',consequence_key:'nearby',target_id:null},
      {index:3,intent_key:'observe',consequence_key:'nearby',target_id:null},
    ];
    expect(here).toBeTruthy();
    expect(executableChoices(save,choices,meanings)).toEqual(['留在这里','观察附近','观察附近']);
    expect(distinctChoices(choices,meanings,new Set([0,2,3]))).toEqual(['留在这里','观察附近']);
  });
});

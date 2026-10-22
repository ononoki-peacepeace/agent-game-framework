import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {createAgentPlan,localCompoundSteps,validatePlan} from '../src/agent/planner.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
import {canExecuteContractPlan} from '../src/agent/affordances.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import type {SavePackage} from '../src/core/schema.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import type {Inventory} from '../src/modules/inventory.js';

const scope={scope:'now' as const,day_offset:0,window:'any' as const};
const goal=(index:number,text:string):GoalInput=>({goal_id:`step_${index}`,type:'WORLD_ACTION',normalized_goal:text,
  depends_on:index>0?[`step_${index-1}`]:[],condition:null,branch:null,temporal_scope:scope,target_entities:[]});
const proposal=(minutes=2)=>({narrative:'程序候选',minutes,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通局部行动',stages:[],evidence_ids:[]}});
const narration={narrative:'你依次进行了这些局部活动。',speaker:null,dialogue:null,choices:[],
  context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
async function setup(steps:string[],failAt=-1){
  const f=await sparseSetup();await seedRoomAnchors(f);
  const before=await f.service.current(),writes=vi.spyOn(f.store,'write');
  vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
  const freeform=vi.spyOn(f.ai,'freeform').mockImplementation(async (_save,input)=>{
    const index=steps.indexOf(input);
    return index===failAt?{...proposal(),resolution:null,blocker:{type:'PREREQUISITE_FAILURE' as const,
      reason:'后续步骤的实际前置条件不成立'}}:proposal();
  });
  const narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
  const plan=validatePlan({goals:steps.map((text,index)=>goal(index,text))});plan.local_compound={steps};
  const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
    input:steps.join('，再')};
  return {...f,before,writes,freeform,narrate,plan,request};
}
async function run(f:Awaited<ReturnType<typeof setup>>){return executePlan(f.service,f.request,f.plan);}
function player(save:SavePackage){return save.entities.find(entity=>entity.id===save.player_state.entity_id)!;}
async function seedRoomAnchors(f:Awaited<ReturnType<typeof sparseSetup>>){
  const save=await f.service.current(),here=String(player(save).components.location!.location_id);
  const place=save.definition.map!.locations.find(location=>location.id===here)!;
  place.description='这个测试场景是一间有开放厨房、门口和书桌的起居室。';
  save.environment_state={resolutions:['厨房','门口','书桌前'].map((name,index)=>({
    id:`env_compound_anchor_${index}`,location_id:here,name,aliases:[],status:'present' as const,
    classification:'environment_detail' as const,entity_id:null,description:`房间内的${name}`,
    take_allowed:false,source_request_id:randomUUID(),at:structuredClone(save.runtime.time),
    known_by:[String(save.player_state.entity_id)],
  }))};
  await f.store.write(save);
}

describe('Phase 3 local compound candidate',()=>{
  it('keeps a tagged local compound in one Core candidate instead of separate commits',async()=>{
    const f=await setup(['走到厨房','坐下']);
    const tagged=validatePlan({goals:[{...goal(0,'走到厨房'),operation_hint:'move',referent:'厨房'},
      {...goal(1,'坐下'),operation_hint:'activity'}]});
    tagged.local_compound={steps:['走到厨房','坐下']};
    const compiled=compileGoalContract(f.service.project(f.before),tagged,{kind:'manual',text:f.request.input});
    expect(compiled.goals[0].operation_hint).toBe('activity');
    expect(canExecuteContractPlan(compiled)).toBe(false);
    const result=await executePlan(f.service,f.request,compiled),after=await f.service.current();
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(f.before.state_revision+1);
    expect(player(after).components.scene_position?.label).toBe('厨房');
  });
  it('commits two generic activities once with one revision and both receipts',async()=>{
    const steps=['伸个懒腰','简单整理桌面'],f=await setup(steps);
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status,result.message).toBe('completed');
    expect(result.results?.every(item=>item.status==='completed')).toBe(true);
    expect(f.freeform).toHaveBeenCalledTimes(2);
    expect(f.narrate).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(after.state_revision).toBe(f.before.state_revision+1);
    expect(after.runtime.time.minute).toBe(f.before.runtime.time.minute+4);
    expect(after.resolution_receipts?.slice(-3).map(receipt=>receipt.commit_status)).toEqual(['committed','committed','committed']);
    expect(f.narrate.mock.calls[0][3]?.canonical_facts.filter(fact=>fact.startsWith('进行了活动：'))).toHaveLength(2);
  });
  it('executes local movement then activity in one candidate and keeps final local position',async()=>{
    const steps=['走到厨房','休息一会儿'],f=await setup(steps);
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status,result.message).toBe('completed');
    expect(player(after).components.scene_position?.label).toBe('厨房');
    expect(after.resolution_receipts?.at(-1)?.effects).toEqual(expect.arrayContaining(['position','activity','time']));
    expect(f.writes).toHaveBeenCalledTimes(1);
  });
  it('repairs a first local movement candidate lacking Core position evidence before committing a three-part observation',async()=>{
    const steps=['我从座椅上起身','走到配给柜前','查看里面有哪些商品、各自的价格，以及有没有人在值班。'];
    const f=await setup(steps),before=await f.service.current();
    const here=String(player(before).components.location!.location_id);
    const shop=before.entities.find(entity=>entity.components.shop)!;
    shop.components.identity!.name='配给柜';
    shop.components.location={location_id:here};
    before.definition.map!.locations.find(location=>location.id===here)!.description+=' 配给柜在房间一侧。';
    await f.store.write(before);f.writes.mockClear();
    f.request.input='我从座椅上起身，走到配给柜前，查看里面有哪些商品、各自的价格，以及有没有人在值班。';
    const first={...proposal(),environment_query:{name:'配给柜',source_quote:steps[1],intent:'observe'}};
    let movementCalls=0;
    f.freeform.mockImplementation(async (_save,input,repair)=>{
      if(input===steps[1]&&++movementCalls===1)return first;
      if(input===steps[1]){
        expect(repair).toMatchObject({failure_code:'proposal_contract_invalid',
          diagnostics:[{code:'position_receipt_mismatch'}]});
        expect(JSON.stringify(repair)).toContain('environment_query');
      }
      return proposal();
    });
    vi.spyOn(f.ai,'assessEnvironment').mockResolvedValue({
      authorized_intent:'observe',scope_complete:true,classification:'environment_detail',
      existence:'present',ownership:'shared',world_compatible:true,scene_compatible:true,
      contradicts_known:false,resource_advantage:false,weight:0,description:'房间一侧的配给柜。',
      basis:[{source:'scene',quote:'配给柜在房间一侧。'}],same_as:null,
    });
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status,result.message).toBe('completed');
    expect(movementCalls).toBe(2);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(player(after).components.scene_position?.label).toBe('配给柜前');
    expect(after.resolution_receipts?.slice(-4).map(receipt=>receipt.commit_status))
      .toEqual(['committed','committed','committed','committed']);
    expect(after.resolution_receipts?.at(-1)?.effects).toEqual(expect.arrayContaining(['position','activity']));
    const exposed=f.service.project(after).entities.find(entity=>entity.id===shop.id)?.components.shop;
    expect(exposed).toEqual(shop.components.shop);
  });
  it('accumulates three local steps and their time before a single formal commit',async()=>{
    const steps=['走到厨房','等一会儿','回到门口'],f=await setup(steps);
    const result=await run(f);const after=await f.service.current();
    expect(result.plan?.status,result.message).toBe('completed');
    expect(after.state_revision).toBe(f.before.state_revision+1);
    expect(after.runtime.time.minute).toBe(f.before.runtime.time.minute+6);
    expect(player(after).components.scene_position?.label).toBe('门口');
    expect(after.resolution_receipts?.at(-1)?.time_cost).toBe(6);
    expect(f.writes).toHaveBeenCalledTimes(1);
  });
  it('keeps background event settlement in the same single formal write',async()=>{
    const steps=['伸个懒腰','坐下'],f=await setup(steps),save=await f.service.current();
    save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:1,
      minimum_gap_minutes:0,replenishment:false};
    save.definition.background_incidents=[{id:'qa_background',title:'背景变化',summary:'独立发生的测试事件',
      source:'WORLD_PACKAGE',created_at:{day:1,minute:0},earliest_activation:{day:1,minute:1},
      latest_activation:null,activation_flags:[],activation_chance:1,participants:[],locations:[],
      stages:[{id:'start',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:null,
        effects:[{kind:'set_flag',flag:'qa_background_started'}],exposures:[],terminal:'resolved'}]}];
    await f.store.write(save);f.writes.mockClear();
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status,result.message).toBe('completed');
    expect(after.background_state?.event_log.filter(event=>event.incident_id==='qa_background'&&event.kind==='activated')).toHaveLength(1);
    expect(after.gm_state.flags.qa_background_started).toBe(true);
    expect(f.writes).toHaveBeenCalledTimes(1);
  });
  it.each([1,2])('rolls back all candidate steps when step %i fails',async failAt=>{
    const steps=['走到厨房','坐下','伸个懒腰'],f=await setup(steps,failAt);
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status).toBe('blocked');
    expect(after).toEqual(f.before);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.narrate).not.toHaveBeenCalled();
  });
  it('rolls back an earlier inventory placement when a later required step fails',async()=>{
    const steps=['把木片收进小袋','站起来'],f=await setup(steps,1),save=await f.service.current();
    const here=player(save).components.location!.location_id;
    save.entities.push({id:'qa_wood',type:'item',components:{identity:{name:'木片',description:'普通物品',avatar_id:null},
      location:{location_id:here},item:{weight:0.2,stackable:false,tracking:'tracked'}}});
    save.entities.push({id:'qa_pouch',type:'item',components:{identity:{name:'小袋',description:'普通容器',avatar_id:null},
      location:{location_id:here},item:{weight:0.2,stackable:false,container:true,tracking:'tracked'}}});
    await f.store.write(save);f.writes.mockClear();
    f.freeform.mockImplementation(async (_candidate,input)=>input===steps[0]?{
      ...proposal(),storage_move:{item_name:'木片',item_id:'qa_wood',container_name:'小袋',container_id:'qa_pouch'}}:
      {...proposal(),resolution:null,blocker:{type:'PREREQUISITE_FAILURE',reason:'后续步骤不可执行'}});
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status).toBe('blocked');
    expect(after).toEqual(save);
    expect((player(after).components.inventory as Inventory).placements?.qa_wood).toBeUndefined();
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('does not claim arrival or commit earlier steps when World Gap rejects a local destination',async()=>{
    const steps=['站起来','走到不存在的陈列架前'],f=await setup(steps);
    vi.spyOn(f.ai,'assessEnvironment').mockResolvedValue({
      authorized_intent:'observe',scope_complete:true,classification:'environment_detail',
      existence:'absent',ownership:'unknown',world_compatible:true,scene_compatible:false,
      contradicts_known:false,resource_advantage:false,weight:0,description:'当前场景没有确认该陈列架。',
      basis:[{source:'scene',quote:'这个测试场景是一间有开放厨房、门口和书桌的起居室。'}],same_as:null,
    });
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status).toBe('blocked');
    expect(after).toEqual(f.before);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.narrate).not.toHaveBeenCalled();
  });
  it('does not persist candidate steps or narrate them after a failure',async()=>{
    const steps=['伸个懒腰','坐下'],f=await setup(steps,1);
    await run(f);const after=await f.service.current();
    expect(after.last_turn).toEqual(f.before.last_turn);
    expect(after.narrative_history).toEqual(f.before.narrative_history);
    expect(after.background_state).toEqual(f.before.background_state);
    expect(after.action_facts).toEqual(f.before.action_facts);
    expect(f.narrate).not.toHaveBeenCalled();
  });
  it('lets Narrator cite activity facts from each settled step and degrades fabricated progress to canonical facts',async()=>{
    const steps=['伸个懒腰','简单整理桌面'],f=await setup(steps);
    f.narrate.mockImplementation(async (_save,_action,_facts,receipt,_repair,stepReceipts)=>{
      expect(stepReceipts).toHaveLength(2);
      const indices=receipt!.canonical_facts.flatMap((fact,index)=>fact.startsWith('进行了活动：')?[index]:[]);
      return {...narration,mechanical_claims:indices.map(fact_index=>({kind:'activity' as const,fact_index}))};
    });
    const result=await run(f);
    expect(result.plan?.status,result.message).toBe('completed');
    expect(f.writes).toHaveBeenCalledTimes(1);
    const degraded=await setup(steps);
    degraded.narrate.mockImplementation(async (_save,_action,_facts,receipt)=>({
      ...narration,mechanical_claims:[{kind:'progress' as const,
        fact_index:receipt!.canonical_facts.findIndex(fact=>fact.startsWith('进行了活动：'))}]}));
    const failure=await run(degraded);
    expect(failure.plan?.status,failure.message).toBe('completed');
    const after=await degraded.service.current();
    expect(after.state_revision).toBe(degraded.before.state_revision+1);
    expect(after.last_turn?.presentation).toMatchObject({status:'degraded'});
    expect(after.last_turn?.narrative).toContain('伸个懒腰');
    expect(after.last_turn?.narrative).toContain('整理桌面');
    expect(after.last_turn?.narrative).not.toContain('progress');
  });
  it('can combine a registered time action with a generic activity without a separate commit',async()=>{
    const steps=['等待两分钟','伸个懒腰'],f=await setup(steps);
    vi.spyOn(f.ai,'interpret').mockImplementation(async (_save,input)=>input===steps[0]
      ?{type:'WAIT',parameters:{minutes:2}}:{type:'FREEFORM_ACTION',parameters:{}});
    const result=await run(f),after=await f.service.current();
    expect(result.plan?.status,result.message).toBe('completed');
    expect(after.runtime.time.minute).toBe(f.before.runtime.time.minute+4);
    expect(f.writes).toHaveBeenCalledTimes(1);
  });
  it('does not merge cross-location or conditional plans',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),view=publicView(save);
    const remote=view.locations.find(location=>location.id!==player(save).components.location?.location_id)!;
    const travel=`去${remote.name}买午饭，再休息一会儿`;
    const plan=validatePlan({goals:[goal(0,`去${remote.name}买午饭`),goal(1,'休息一会儿')]});
    expect(localCompoundSteps(view,travel,plan)).toBeNull();
    expect(localCompoundSteps(view,'去便利店，如果碰见同学就问他下午去哪',plan)).toBeNull();
    expect(localCompoundSteps(view,'伸个懒腰，整理桌面',validatePlan({goals:[goal(0,'伸个懒腰'),
      goal(1,'去寻找未知人物')]}))).toBeNull();
  });
  it('degrades a compound whose narrator keeps failing, committing settled steps without re-executing them',async()=>{
    const steps=['伸个懒腰','整理桌面'],f=await setup(steps);
    const unsupported={...narration,mechanical_claims:[{kind:'progress' as const,fact_index:0}]};
    f.narrate.mockReset().mockResolvedValue(unsupported);
    const request={...f.request};
    await f.service.turn(request,undefined,undefined,undefined,false,undefined,steps);
    expect(f.freeform).toHaveBeenCalledTimes(2);
    const after=await f.service.current();
    expect(after.state_revision).toBe(f.before.state_revision+1);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(after.last_turn?.presentation).toMatchObject({status:'degraded'});
    expect(after.last_turn!.narrative).toContain('伸个懒腰');
    expect(after.last_turn!.narrative).toContain('整理桌面');
    expect(after.last_turn!.narrative.indexOf('伸个懒腰')).toBeLessThan(after.last_turn!.narrative.indexOf('整理桌面'));
    expect(after.last_turn!.narrative).not.toMatch(/(?:^|\n)\d+、/);
  });
  it('preserves all local steps in planner output and expands movement plus activity',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const input='起身去厨房待一会儿，再回到书桌前坐下。';
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal(0,'起身去厨房待一会儿'),
      goal(1,'回到书桌前坐下')]});
    const plan=await createAgentPlan(f.ai,publicView(save),input);
    expect(plan.goals).toHaveLength(2);
    expect(plan.local_compound?.steps).toEqual(['起身去厨房','待一会儿','回到书桌前','坐下']);
  });
  it('executes the human QA local round trip through planning with one revision',async()=>{
    const f=await sparseSetup();await seedRoomAnchors(f);
    const before=await f.service.current();
    const input='起身去厨房待一会儿，再回到书桌前坐下。';
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[goal(0,'起身去厨房待一会儿'),goal(1,'回到书桌前坐下')]});
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
    const writes=vi.spyOn(f.store,'write');
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input});
    const after=await f.service.current();
    expect(result.plan?.local_compound?.steps).toHaveLength(4);
    expect(result.plan?.status,result.message).toBe('completed');
    expect(player(after).components.scene_position?.label).toBe('书桌前');
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+8);
    expect(writes).toHaveBeenCalledTimes(1);
  });
  it('keeps both Phase 2 single-step activities outside compound handling',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    for(const input of ['写半小时作业。','起身伸个懒腰，把桌面简单整理一下。']){
      const plan=validatePlan({goals:[goal(0,input)]});
      expect(localCompoundSteps(publicView(save),input,plan)).toBeNull();
    }
  });
});

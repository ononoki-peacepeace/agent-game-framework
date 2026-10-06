import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {createAgentPlan,localCompoundSteps,validatePlan} from '../src/agent/planner.js';
import {executePlan,handleAgentInput} from '../src/agent/executor.js';
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
  const f=await sparseSetup(),before=await f.service.current(),writes=vi.spyOn(f.store,'write');
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

describe('Phase 3 local compound candidate',()=>{
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
  it('does not persist candidate steps or narrate them after a failure',async()=>{
    const steps=['伸个懒腰','坐下'],f=await setup(steps,1);
    await run(f);const after=await f.service.current();
    expect(after.last_turn).toEqual(f.before.last_turn);
    expect(after.narrative_history).toEqual(f.before.narrative_history);
    expect(after.background_state).toEqual(f.before.background_state);
    expect(after.action_facts).toEqual(f.before.action_facts);
    expect(f.narrate).not.toHaveBeenCalled();
  });
  it('lets Narrator cite activity facts from each settled step but rejects unsupported progress',async()=>{
    const steps=['伸个懒腰','简单整理桌面'],f=await setup(steps);
    f.narrate.mockImplementation(async (_save,_action,_facts,receipt,_repair,stepReceipts)=>{
      expect(stepReceipts).toHaveLength(2);
      const indices=receipt!.canonical_facts.flatMap((fact,index)=>fact.startsWith('进行了活动：')?[index]:[]);
      return {...narration,mechanical_claims:indices.map(fact_index=>({kind:'activity' as const,fact_index}))};
    });
    const result=await run(f);
    expect(result.plan?.status,result.message).toBe('completed');
    expect(f.writes).toHaveBeenCalledTimes(1);
    const blocked=await setup(steps);
    blocked.narrate.mockImplementation(async (_save,_action,_facts,receipt)=>({
      ...narration,mechanical_claims:[{kind:'progress' as const,
        fact_index:receipt!.canonical_facts.findIndex(fact=>fact.startsWith('进行了活动：'))}]}));
    const failure=await run(blocked);
    expect(failure.plan?.status).toBe('blocked');
    expect(await blocked.service.current()).toEqual(blocked.before);
    expect(blocked.writes).not.toHaveBeenCalled();
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
  it('retries a pending compound after Narrator rejection without re-executing its steps',async()=>{
    const steps=['伸个懒腰','整理桌面'],f=await setup(steps);
    const unsupported={...narration,mechanical_claims:[{kind:'progress' as const,fact_index:0}]};
    f.narrate.mockReset().mockResolvedValueOnce(unsupported).mockResolvedValueOnce(unsupported)
      .mockResolvedValueOnce(unsupported).mockResolvedValue(narration);
    const request={...f.request};
    await expect(f.service.turn(request,undefined,undefined,undefined,false,undefined,steps)).rejects.toThrow('未结算');
    expect(await f.service.current()).toEqual(f.before);
    expect(f.freeform).toHaveBeenCalledTimes(2);
    await f.service.turn(request,undefined,undefined,undefined,false,undefined,steps);
    const after=await f.service.current();
    expect(f.freeform).toHaveBeenCalledTimes(2);
    expect(after.state_revision).toBe(f.before.state_revision+1);
    expect(f.writes).toHaveBeenCalledTimes(1);
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
    const f=await sparseSetup(),before=await f.service.current();
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

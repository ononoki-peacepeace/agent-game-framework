import {describe,it,expect,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {goalSpecSchema} from '../src/system/goals.js';

const goal=()=>goalSpecSchema.parse({objective:'尝试当前行动',play_action:'other',targets:[],
  persistence:'none',world_mutation:true,external_artifact:false,multi_step:false});
describe('single semantic-owned attempts',()=>{
  it('does not turn an immediate opportunity phrase into an invented future waiting condition',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),input='趁当前还来得及时，我立即尝试推开挡板';
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:input,
      depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]});
    const plan=await createAgentPlan(f.ai,publicView(save),input,{semantic_goal:goal()},true,save);
    expect(plan.goals).toHaveLength(1);expect(plan.goals[0]).toMatchObject({type:'WORLD_ACTION',normalized_goal:input,condition:null,branch:null});
    expect(await f.service.current()).toEqual(save);
  });
  it('does not delete a semantic conditional dependency merely because its wording misses the legacy syntax detector',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),spec=goal(),input='得到许可才动手';spec.multi_step=true;
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
      {goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'确认许可',depends_on:[],condition:{kind:'public_fact',entity_id:'player',description:'已得到许可'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
      {goal_id:'attempt',type:'WORLD_ACTION',normalized_goal:'尝试动手',depends_on:['condition'],condition:null,branch:'then',temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]},
    ]});
    const plan=await createAgentPlan(f.ai,publicView(save),input,{semantic_goal:spec},true,save);
    expect(plan.goals.map(item=>item.type)).toEqual(['CONDITIONAL_INTENT','WORLD_ACTION']);
    expect(plan.goals[1].depends_on).toEqual(['condition']);expect(plan.goals[1].branch).toBe('then');
  });
  it.each(['继续敲门。','再练习一小段时间。','尝试把挡住视线的布拉开。'])('keeps the complete authorized attempt without a second planner: %s',async input=>{
    const f=await sparseSetup(),save=await f.service.current(),view=publicView(save);
    const planner=vi.spyOn(f.ai,'planGoals').mockRejectedValue(Error('must not re-interpret'));
    const plan=compileGoalContract(view,await createAgentPlan(f.ai,view,input,{semantic_goal:goal()},true,save),{kind:'manual',text:input});
    expect(planner).not.toHaveBeenCalled();expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0]).toMatchObject({type:'WORLD_ACTION',normalized_goal:input,status:'pending',condition:null});
    // A plan is not an action receipt or a completion certificate.
    expect(plan.goals[0].contract?.completion.kind).toBe('unsupported');
    expect(plan.contract?.execution_availability).toBe('runtime_gap');
    expect(await f.service.current()).toEqual(save);
  });
  it.each(['recovery','compound','scheduled','ambiguous'])('retains full planning for %s',async kind=>{
    const f=await sparseSetup(),save=await f.service.current(),spec=goal(),input='尝试完成眼前的动作';
    if(kind==='compound')spec.multi_step=true;
    if(kind==='scheduled')spec.temporal.at='明天';
    if(kind==='ambiguous')spec.ambiguity={question:'具体哪一项？'};
    const planner=vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:input,
      depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]});
    await createAgentPlan(f.ai,publicView(save),input,{semantic_goal:spec,...(kind==='recovery'?{recovery:{failure_code:'incomplete'}}:{})},true,save);
    expect(planner).toHaveBeenCalledOnce();expect(await f.service.current()).toEqual(save);
  });
});

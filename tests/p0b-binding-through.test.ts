import {describe,it,expect} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';

const goal=(targets:string[])=>({goals:[{goal_id:'g1',type:'WORLD_ACTION' as const,
  normalized_goal:'强吻她',referent:null,target_entities:targets,depends_on:[],condition:null,branch:null,
  temporal_scope:{scope:'now' as const,day_offset:0,window:'any' as const}}]});

describe('P0-B upstream entity binding through the contract',()=>{
  it('preserves a semantic entity id that the planner omitted from target_entities',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),view=publicView(save);
    const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    const plan=compileGoalContract(view,validatePlan(goal([])),{kind:'manual',text:'强吻她',
      semanticGoal:{objective:'强吻她',play_action:'interact',targets:[
        {kind:'entity',reference:'她',entity_id:npc.id,role:'subject'}],
        desired_state:[],desired_outputs:[],constraints:[],persistence:'none',
        temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,
        external_artifact:false,multi_step:false,ambiguity:null}});
    expect(plan.goals[0].target_entities).toEqual([npc.id]);
    expect(plan.goals[0].contract?.bindings).toEqual([
      expect.objectContaining({role:'person',entity_id:npc.id,status:'bound'})]);
  });

  it('binds an already-populated person target even without an operation hint',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),view=publicView(save);
    const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    const plan=compileGoalContract(view,validatePlan(goal([npc.id])),{kind:'manual',text:'强吻她'});
    expect(plan.goals[0].contract?.bindings).toEqual([
      expect.objectContaining({role:'person',entity_id:npc.id,status:'bound'})]);
  });

  it('keeps non-person semantic targets when the planner omits the hint',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const item=save.entities.find(entity=>entity.components.item)!;
    const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id;
    if(typeof here!=='string')throw new Error('fixture player location missing');
    item.components.location={location_id:here};
    const view=publicView(save);
    const plan=compileGoalContract(view,validatePlan({...goal([]),goals:[{...goal([]).goals[0],normalized_goal:'检查笔记本'}]}),{kind:'manual',text:'检查笔记本',
      semanticGoal:{objective:'检查笔记本',play_action:'interact',targets:[
        {kind:'entity',reference:'笔记本',entity_id:item.id,role:'object'}],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',
        temporal:{at:null,recurrence:null},dependencies:[],world_mutation:false,external_artifact:false,multi_step:false,ambiguity:null}});
    expect(plan.goals[0].target_entities).toEqual([item.id]);
    expect(plan.goals[0].contract?.bindings).toEqual([
      expect.objectContaining({role:'item',entity_id:item.id,status:'bound'})]);
  });
});

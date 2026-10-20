import {describe,it,expect,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {runContractPlan} from '../src/agent/affordances.js';

const step=(id:string,text:string,depends_on:string[]=[]):GoalInput=>({goal_id:id,type:'WORLD_SPEECH',
  normalized_goal:text,operation_hint:'talk',referent:null,target_entities:[],depends_on,condition:null,branch:null,
  temporal_scope:{scope:'now',day_offset:0,window:'any'}});
describe('stage-owned addressee binding without a planner referent',()=>{
  it('binds each explicit stage to its own publicly named person rather than every person in the source',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),view=f.service.project(save);
    const plan=compileGoalContract(view,validatePlan({goals:[step('a','询问林舟今天的安排'),
      step('b','询问乔宁商店何时关门',['a'])]}),
      {kind:'manual',text:'先询问林舟今天的安排，再询问乔宁商店何时关门。'});
    expect(plan.goals.map(goal=>goal.contract?.completion)).toEqual([
      {kind:'conversation_attempted',person_id:'npc_lin'},
      {kind:'conversation_attempted',person_id:'npc_qiao'}]);
    expect(plan.goals.map(goal=>goal.target_entities)).toEqual([['npc_lin'],['npc_qiao']]);
    expect(plan.goals.every(goal=>goal.contract?.availability==='ready')).toBe(true);
    expect(plan.dependencies).toEqual([{from:'a',to:'b'}]);
    expect(await f.service.current()).toEqual(save);
  });
  it('does not invent a recipient from a rewritten stage when the original request names another person',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[step('a','询问乔宁今天的安排')]}),
      {kind:'manual',text:'询问林舟今天的安排。'});
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
  });
  it('keeps a two-person single-stage question ambiguous when there is no addressee role',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[step('a','询问林舟关于乔宁的安排')]}),
      {kind:'manual',text:'询问林舟关于乔宁的安排。'});
    expect(plan.goals[0].contract?.availability).toBe('needs_binding');
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:null});
  });
  it('settles separate dependent TALK receipts, persists the graph and does not repeat completed speech',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};
    await f.store.write(save);
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你问起眼下的安排。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[step('a','询问林舟今天的安排'),
      step('b','询问乔宁商店何时关门',['a'])]}),
      {kind:'manual',text:'先询问林舟今天的安排，再询问乔宁商店何时关门。'});
    const result=await runContractPlan(f.service,save,plan,{},true);
    expect(result.plan.status).toBe('completed');
    expect(result.save.resolution_receipts?.filter(receipt=>receipt.semantic_action==='TALK')
      .map(receipt=>receipt.target_id)).toEqual(['npc_lin','npc_qiao']);
    expect(result.plan.goals.every(goal=>goal.contract?.evidence_refs.length===1)).toBe(true);
    const replay=await runContractPlan(f.service,result.save,result.plan,{},true);
    expect(replay.save.state_revision).toBe(result.save.state_revision);
    expect(replay.save.resolution_receipts).toEqual(result.save.resolution_receipts);
  });
  it('does not replace an absent second addressee or pretend the complete dependent request succeeded',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你问起眼下的安排。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[step('a','询问林舟今天的安排'),
      step('b','询问乔宁商店何时关门',['a'])]}),
      {kind:'manual',text:'先询问林舟今天的安排，再询问乔宁商店何时关门。'});
    const result=await runContractPlan(f.service,save,plan,{},true);
    expect(result.plan.status).not.toBe('completed');
    expect(result.plan.goals[0].status).toBe('completed');
    expect(result.plan.goals[1].status).not.toBe('completed');
    expect(result.save.resolution_receipts?.filter(receipt=>receipt.semantic_action==='TALK')
      .map(receipt=>receipt.target_id)).toEqual(['npc_lin']);
    expect(result.save.entities.find(entity=>entity.id==='npc_qiao')!.components.location).toEqual(
      save.entities.find(entity=>entity.id==='npc_qiao')!.components.location);
  });
});

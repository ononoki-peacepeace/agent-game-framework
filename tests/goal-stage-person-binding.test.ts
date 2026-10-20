import {describe,it,expect,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {runContractPlan} from '../src/agent/affordances.js';
import {sceneAnchor} from '../src/core/interaction.js';

const step=(id:string,text:string,depends_on:string[]=[]):GoalInput=>({goal_id:id,type:'WORLD_SPEECH',
  normalized_goal:text,operation_hint:'talk',referent:null,target_entities:[],depends_on,condition:null,branch:null,
  temporal_scope:{scope:'now',day_offset:0,window:'any'}});
describe('stage-owned addressee binding without a planner referent',()=>{
  it('keeps the uniquely named original recipient when the planner supplies a different real person as referent',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{...step('a','询问乔宁今天的安排'),referent:'乔宁'}]}),
      {kind:'manual',text:'询问林舟今天的安排。'});
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
    expect(plan.goals[0].target_entities).toEqual(['npc_lin']);
  });
  it('retains the actual conversation focus for a pronoun instead of a model-supplied recipient',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};
    save.interaction_context={mode:'conversation',target_entity_id:'npc_lin',started_turn:save.state_revision,
      last_interaction_turn:save.state_revision,scene_anchor:sceneAnchor(save.entities.find(entity=>entity.id===save.player_state.entity_id)),status:'active'};
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{...step('a','继续询问他的安排'),referent:'乔宁'}]}),
      {kind:'manual',text:'继续问他接下来的安排。'});
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
  });
  it.each(['问他接下来的安排。','向他询问林舟去了哪里。'])('keeps genuine pronoun ambiguity even if a planner guesses a present person: %s',async text=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{...step('a','询问他的安排'),referent:'林舟'}]}),
      {kind:'manual',text});
    expect(plan.goals[0].contract?.availability).toBe('needs_binding');
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:null});
  });
  it('accepts an explicit stage referent that is one of the source-authorized people',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{...step('a','询问林舟关于乔宁的安排'),referent:'林舟'}]}),
      {kind:'manual',text:'询问林舟关于乔宁的安排。'});
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
  });
  it.each([
    ['向他询问林舟去了哪里。','npc_qiao','乔宁'],
    ['向他询问林舟去了哪里。','npc_qiao','林舟'],
    ['询问林舟他接下来的安排。','npc_lin','乔宁'],
  ])('distinguishes the pronoun addressee from a named discussion subject in %s',async(text,personId,referent)=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};
    save.interaction_context={mode:'conversation',target_entity_id:'npc_qiao',started_turn:save.state_revision,
      last_interaction_turn:save.state_revision,scene_anchor:sceneAnchor(save.entities.find(entity=>entity.id===save.player_state.entity_id)),status:'active'};
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{...step('a',text),referent}]}),{kind:'manual',text});
    expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:personId});
  });
  it('settles the source-authorized TALK once when a planner paraphrase names another person',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};await f.store.write(save);
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你问起眼下的安排。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{...step('a','询问乔宁今天的安排'),referent:'乔宁'}]}),
      {kind:'manual',text:'询问林舟今天的安排。'});
    const result=await runContractPlan(f.service,save,plan,{},true);
    expect(result.plan.status).toBe('completed');
    expect(result.save.resolution_receipts?.filter(receipt=>receipt.semantic_action==='TALK').map(receipt=>receipt.target_id)).toEqual(['npc_lin']);
    const replay=await runContractPlan(f.service,result.save,result.plan,{},true);
    expect(replay.save.state_revision).toBe(result.save.state_revision);
  });
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

import {afterEach,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {validatePlan} from '../src/agent/planner.js';
import {runContractPlan} from '../src/agent/affordances.js';

const sources=['向林舟询问乔宁去了哪里。','跟林舟讨论乔宁的安排。','告诉林舟乔宁的近况。'];
const makePlan=()=>validatePlan({goals:[{goal_id:'ask',type:'WORLD_SPEECH',normalized_goal:'询问乔宁的安排',operation_hint:'talk',referent:'乔宁',
 target_entities:['npc_qiao'],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]});
afterEach(()=>vi.restoreAllMocks());
it.each(sources)('keeps the source addressee instead of a named topic/planner recipient: %s',async text=>{
 const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save);
 const plan=compileGoalContract(f.service.project(save),makePlan(),{kind:'manual',text});
 expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
 expect(plan.goals[0].target_entities).toEqual(['npc_lin']);expect(plan.goals[0].contract?.availability).toBe('ready');
 expect(save).toEqual(before);
});
it.each(['typed_person','typed_group','referent_group'] as const)('does not let a %s hint bypass the explicit source listener',async shape=>{
 const f=await sparseSetup(),save=await f.service.current(),input=makePlan();
 if(shape==='typed_person')input.goals[0].speech_recipients=['乔宁'];
 else if(shape==='typed_group')input.goals[0].speech_recipients=['林舟','乔宁'];
 else {input.goals[0].referent='林舟、乔宁';input.goals[0].normalized_goal='向林舟、乔宁询问近况';}
 const plan=compileGoalContract(f.service.project(save),input,{kind:'manual',text:sources[0]});
 expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
 expect(plan.goals[0].target_entities).toEqual(['npc_lin']);
});
it('keeps duplicate source listener names ambiguous even when the planner picks a unique topic',async()=>{
 const f=await sparseSetup(),save=await f.service.current(),other=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);other.id='second_lin';save.entities.push(other);
 const plan=compileGoalContract(f.service.project(save),makePlan(),{kind:'manual',text:sources[0]});
 expect(plan.goals[0].contract?.availability).toBe('needs_binding');expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:null});
 expect(plan.goals[0].contract?.bindings.filter(b=>b.role==='person').map(b=>b.entity_id)).toEqual([null]);
});
it('preserves absent authorized listeners instead of substituting a present topic person',async()=>{
 const f=await sparseSetup(),save=await f.service.current();save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
 save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};await f.store.write(save);
 const plan=compileGoalContract(f.service.project(save),makePlan(),{kind:'manual',text:sources[0]});
 const result=await runContractPlan(f.service,save,plan,{},true);
 expect(result.plan.status).not.toBe('completed');expect(result.save.resolution_receipts?.filter(r=>r.semantic_action==='TALK')??[]).toHaveLength(0);
 expect(result.save.runtime.time).toEqual(save.runtime.time);
});
it.each(['告诉林舟、乔宁或另一人今天辛苦了','向林舟或乔宁说今天辛苦了'])('does not pick the first of alternative listeners: %s',async text=>{
 const f=await sparseSetup(),save=await f.service.current(),input=makePlan();input.goals[0].referent=null;input.goals[0].target_entities=[];input.goals[0].normalized_goal=text;
 const plan=compileGoalContract(f.service.project(save),input,{kind:'manual',text});
 expect(plan.goals[0].contract?.availability).toBe('needs_binding');expect(plan.goals[0].contract?.completion).toEqual({kind:'conversation_attempted',person_id:null});
});
it('settles the actual authorized TALK once, with a present topic person',async()=>{
 const f=await sparseSetup(),save=await f.service.current();save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};await f.store.write(save);
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你问起乔宁的近况。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const plan=compileGoalContract(f.service.project(save),makePlan(),{kind:'manual',text:sources[0]});
 const result=await runContractPlan(f.service,save,plan,{},true);
 expect(result.plan.status).toBe('completed');expect(result.save.resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
 const repeated=await runContractPlan(f.service,result.save,result.plan,{},true);
 expect(repeated.save.resolution_receipts).toEqual(result.save.resolution_receipts);expect(repeated.save.state_revision).toBe(result.save.state_revision);
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {executePlan} from '../src/agent/executor.js';
import {sceneAnchor} from '../src/core/interaction.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
afterEach(()=>vi.restoreAllMocks());
async function fixture(input:string,focus:'npc_lin'|'npc_qiao'|null,hints=false,referent='乔宁',familiar=true){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:familiar?60:0}}};
 delete before.interaction_context;
 if(focus)before.interaction_context={mode:'conversation',target_entity_id:focus,started_turn:before.state_revision,
  last_interaction_turn:before.state_revision,scene_anchor:sceneAnchor(before.entities.find(e=>e.id==='player')),status:'active'};
 await f.store.write(before);
 const condition:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我与林舟是否熟悉',
  condition:{kind:'familiar',entity_id:'npc_lin',description:'我与林舟熟悉'},branch:null,depends_on:[],target_entities:[],temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const speech:GoalInput={...condition,goal_id:'speech',type:'WORLD_SPEECH',condition:null,branch:'then',depends_on:['condition'],
  normalized_goal:`询问${referent}今天的安排`,operation_hint:'talk',referent,...(hints?{speech_recipients:[referent]}:{})};
 const plan=compileGoalContract(f.service.project(before),validatePlan({goals:[condition,speech]}),{kind:'manual',text:input});
 const interpret=vi.spyOn(f.ai,'interpret').mockRejectedValue(Error('must execute verified listener, not reinterpret'));
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你继续询问。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 return {...f,before,plan,body,interpret};
}
it.each([false,true])('keeps actual pronoun focus instead of guard/topic names (typed hint=%s)',async hints=>{
 const f=await fixture('如果我和林舟熟悉，就向他询问乔宁今天的安排','npc_lin',hints);
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
 expect(f.interpret).not.toHaveBeenCalled();
});
it.each([false,true])('keeps genuine conditional pronoun ambiguity despite a topic-based guess (typed hint=%s)',async hints=>{
 const f=await fixture('如果我和林舟熟悉，就向他询问乔宁今天的安排',null,hints);
 await executePlan(f.service,f.body,f.plan);
 expect(await f.store.read()).toEqual(f.before);expect(f.plan.goals[1].contract?.availability).toBe('needs_binding');expect(f.interpret).not.toHaveBeenCalled();
});
it('uses current focus when the same topic name already appeared in the guard',async()=>{
 const f=await fixture('如果我和林舟熟悉，就向他询问林舟今天的安排','npc_qiao',false,'林舟');
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_qiao']);
});
it.each([false,true])('does not mistake a guard or topic pronoun for a named listener (typed hint=%s)',async hints=>{
 const f=await fixture('如果他已经到场，就询问林舟他的安排','npc_qiao',hints);
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
});
it('does not execute an otherwise bound pronoun when its branch is false',async()=>{
 const f=await fixture('如果我和林舟熟悉，就向他询问乔宁今天的安排','npc_lin',true,'乔宁',false);
 const result=await executePlan(f.service,f.body,f.plan);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','skipped']);expect(await f.store.read()).toEqual(f.before);
});
it('does not apply one stage pronoun to a different explicitly named speech stage',async()=>{
 const input='如果我和林舟熟悉，就向他询问乔宁的安排，再询问乔宁商店何时关门';
 const f=await fixture(input,'npc_lin');
 const first={...f.plan.goals[1],referent:'林舟',normalized_goal:'向林舟询问乔宁的安排',speech_recipients:['林舟']};
 const second={...first,goal_id:'second',referent:'乔宁',normalized_goal:'询问乔宁商店何时关门',speech_recipients:['乔宁'],depends_on:['condition','speech']};
 const goals=[f.plan.goals[0],first,second].map(({side_effect_level,requires_confirmation,status,contract,...inputGoal})=>inputGoal);
 const plan=compileGoalContract(f.service.project(f.before),validatePlan({goals}),{kind:'manual',text:input});
 await executePlan(f.service,f.body,plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin','npc_qiao']);
});
it('uses a uniquely present public person without treating a remote topic as a listener',async()=>{
 const input='如果我和林舟熟悉就向他询问乔宁今天的安排',f=await fixture(input,null,true);
 f.before.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'market'};
 await f.store.write(f.before);
 const plan=compileGoalContract(f.service.project(f.before),f.plan,{kind:'manual',text:input});
 await executePlan(f.service,f.body,plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
});

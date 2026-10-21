import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {executePlan} from '../src/agent/executor.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
afterEach(()=>vi.restoreAllMocks());
async function fixture(branch:'then'|'else',input:string,referent='林舟',recipients?:string[],duplicate=false){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:branch==='then'?60:0}}};
 if(duplicate){const npc=structuredClone(before.entities.find(e=>e.id==='npc_lin')!);npc.id='another_lin';before.entities.push(npc);}
 await f.store.write(before);
 const condition:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我与林舟是否熟悉',
  condition:{kind:'familiar',entity_id:'npc_lin',description:'我与林舟比较熟'},branch:null,depends_on:[],target_entities:[],
  temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const speech:GoalInput={...condition,goal_id:'speech',type:'WORLD_SPEECH',condition:null,branch,depends_on:['condition'],
  normalized_goal:`询问${referent}今天的安排`,operation_hint:'talk',referent,...(recipients?{speech_recipients:recipients}:{})};
 const plan=compileGoalContract(f.service.project(before),validatePlan({goals:[condition,speech]}),{kind:'manual',text:input});
 const interpret=vi.spyOn(f.ai,'interpret').mockRejectedValue(Error('typed speech must not reinterpret the planner text'));
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你开口询问。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 return {...f,before,plan,body,interpret};
}
it.each(['then','else'] as const)('does not treat the guard or discussion subject as the %s addressee',async branch=>{
 const f=await fixture(branch,`如果我和林舟${branch==='then'?'熟悉':'不熟'}，就询问乔宁林舟今天的安排`);
 expect(f.plan.goals[1].contract?.completion).toMatchObject({kind:'conversation_attempted',person_id:'npc_qiao'});
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_qiao']);
 expect(f.interpret).not.toHaveBeenCalled();
});
it.each(['then','else'] as const)('does not let explicit model recipient hints override the original %s addressee',async branch=>{
 const f=await fixture(branch,`如果我们${branch==='then'?'熟悉':'不熟'}，就询问林舟今天的安排`,'乔宁',['乔宁']);
 expect(f.plan.goals[1].contract?.completion).toMatchObject({kind:'conversation_attempted',person_id:'npc_lin'});
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
 expect(f.interpret).not.toHaveBeenCalled();
});
it('does not collapse a coordinated conditional audience to its first named person',async()=>{
 const f=await fixture('then','如果我们熟悉，就告诉林舟和乔宁今天的安排','林舟',['林舟','乔宁']);
 expect(f.plan.goals[1].contract?.completion).toMatchObject({kind:'conversation_attempted',audience_ids:['npc_lin','npc_qiao']});
});
it('keeps genuine same-name ambiguity unresolved without a TALK or save',async()=>{
 const f=await fixture('then','如果我们熟悉，就询问林舟今天的安排','乔宁',undefined,true),before=await f.store.read();
 expect(f.plan.goals[1].contract?.availability).toBe('needs_binding');
 await executePlan(f.service,f.body,f.plan);expect(await f.store.read()).toEqual(before);expect(f.interpret).not.toHaveBeenCalled();
});
it('does not count a recipient inside an NPC guard as the player addressee',async()=>{
 const f=await fixture('then','如果林舟向乔宁说过话，就询问林舟今天的安排','乔宁');
 expect(f.plan.goals[1].contract?.completion).toMatchObject({kind:'conversation_attempted',person_id:'npc_lin'});
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
});
it('does not arbitrarily select one of two explicitly alternative conditional listeners',async()=>{
 const f=await fixture('then','如果我们熟悉，就询问林舟或乔宁今天的安排'),before=await f.store.read();
 expect(f.plan.goals[1].contract?.availability).toBe('needs_binding');
 await executePlan(f.service,f.body,f.plan);expect(await f.store.read()).toEqual(before);expect(f.interpret).not.toHaveBeenCalled();
});
it('uses the same verified listener when a speech contract is labeled WORLD_ACTION',async()=>{
 const f=await fixture('then','如果我们熟悉，就询问林舟今天的安排','乔宁');
 f.plan.goals[1].type='WORLD_ACTION';
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
 expect(f.interpret).not.toHaveBeenCalled();
});
it.each(['如果我和林舟熟悉就询问乔宁林舟今天的安排','若我和林舟熟悉则询问乔宁林舟今天的安排',
 '只要我和林舟熟悉那么询问乔宁林舟今天的安排'])('binds the addressed person in an unpunctuated conditional: %s',async input=>{
 const f=await fixture('then',input);
 expect(f.plan.goals[1].contract?.completion).toMatchObject({kind:'conversation_attempted',person_id:'npc_qiao'});
 await executePlan(f.service,f.body,f.plan);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_qiao']);
 expect(f.interpret).not.toHaveBeenCalled();
});

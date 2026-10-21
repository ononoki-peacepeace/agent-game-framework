import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

afterEach(()=>vi.restoreAllMocks());
async function setup(familiar:boolean,branch:'then'|'else',rewritten:boolean,repeatedName=false){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:familiar?60:0}}};
 await f.store.write(before);
 const input=`如果${repeatedName?'我和林舟':'我们'}${branch==='else'?'不熟':'比较熟'}，就询问林舟今天的安排`;
 const condition:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我与林舟是否熟悉',
  target_entities:[],depends_on:[],condition:{kind:'familiar',entity_id:'npc_lin',description:'我与林舟比较熟'},
  branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const speech:GoalInput={...condition,goal_id:'speech',type:'WORLD_SPEECH',
  normalized_goal:rewritten?'询问乔宁今天的安排':'询问林舟今天的安排',operation_hint:'talk',referent:rewritten?'乔宁':'林舟',
  depends_on:['condition'],condition:null,branch};
 const plan=compileGoalContract(f.service.project(before),validatePlan({goals:[condition,speech]}),{kind:'manual',text:input});
 const interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,text)=>({type:'TALK',
  target_id:text.includes('乔宁')?'npc_qiao':'npc_lin',parameters:{topic:'今天的安排'}}));
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你开口问好。',speaker:null,dialogue:null,choices:[],
  context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 return {...f,before,plan,body,interpret};
}
it.each([{familiar:true,branch:'then'},{familiar:false,branch:'else'}] as const)(
 'retains the source-owned speech recipient in a matching $branch branch',async({familiar,branch})=>{
 const f=await setup(familiar,branch,true);
 expect(f.plan.goals[1].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
 const result=await executePlan(f.service,f.body,f.plan),after=await f.service.current();
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','completed']);
 expect(after.resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
 expect(f.plan.goals[1].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
});
it.each([{familiar:true,branch:'then'},{familiar:false,branch:'else'}] as const)(
 'binds the explicit addressee even when its name appeared earlier in the $branch guard',async({familiar,branch})=>{
 const f=await setup(familiar,branch,true,true);
 expect(f.plan.goals[1].contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
 const result=await executePlan(f.service,f.body,f.plan);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','completed']);
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
});
it.each([{familiar:false,branch:'then'},{familiar:true,branch:'else'}] as const)(
 'does not execute speech in a nonmatching $branch branch',async({familiar,branch})=>{
 const f=await setup(familiar,branch,true),result=await executePlan(f.service,f.body,f.plan);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','skipped']);
 expect(await f.store.read()).toEqual(f.before);expect(f.interpret).not.toHaveBeenCalled();
});
it('retains an aligned conditional speech attempt',async()=>{
 const f=await setup(true,'then',false),result=await executePlan(f.service,f.body,f.plan);
 expect(result.plan?.status).toBe('completed');
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.semantic_action==='TALK').map(r=>r.target_id)).toEqual(['npc_lin']);
});

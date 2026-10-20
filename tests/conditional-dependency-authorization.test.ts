import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validatePlan} from '../src/agent/planner.js';
import {executePlan} from '../src/agent/executor.js';
import type {GoalInput,AgentPlan} from '../src/agent/plan-schema.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,type:GoalInput['type'],extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type,
 normalized_goal:type==='CONDITIONAL_INTENT'?'确认林舟是否在场':'明天找林舟',depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],...extra});
const condition=(id:string)=>goal(id,'CONDITIONAL_INTENT',{condition:{kind:'present',entity_id:'npc_lin',description:'林舟现在在这里'}});
const future=(parents:string[],branch:GoalInput['branch'])=>goal('future','FUTURE_INTENT',{
 depends_on:parents,branch,target_entities:['npc_lin'],temporal_scope:{scope:'future',day_offset:1,window:'any'}});

it('rejects an effect whose direct conditional dependency lost its branch authorization',()=>{
 expect(()=>validatePlan({goals:[condition('c'),future(['c'],null)]})).toThrow('条件');
});
it('rejects a branch with two possible condition owners instead of choosing the first',()=>{
 expect(()=>validatePlan({goals:[condition('c1'),condition('c2'),future(['c1','c2'],'then')]})).toThrow('条件');
});
it('rejects a nested condition that drops the outer branch guard',()=>{
 expect(()=>validatePlan({goals:[condition('c1'),{...condition('c2'),depends_on:['c1']},future(['c2'],'then')]})).toThrow('条件');
});
it('does not persist an unauthorized future when a legacy snapshot has an unguarded unknown condition',async()=>{
 const f=await sparseSetup(),before=await f.service.current();
 before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
 before.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};await f.store.write(before);
 // Start with a valid plan, then reproduce a previously accepted persisted snapshot.
 const plan=validatePlan({goals:[condition('c'),future(['c'],'then')]});plan.goals[1].branch=null;
 const writes=vi.spyOn(f.store,'write');
 await expect(executePlan(f.service,{input:'如果林舟在这里，明天找他',game_id:before.game_id,
  expected_revision:before.state_revision,request_id:randomUUID()},plan)).rejects.toThrow('条件');
 expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(before);
});
it('rejects ambiguous legacy condition owners before an earlier independent future write',async()=>{
 const f=await sparseSetup(),before=await f.service.current();
 const plan=validatePlan({goals:[goal('independent','FUTURE_INTENT',{temporal_scope:{scope:'future',day_offset:2,window:'any'}}),
  condition('c1'),condition('c2'),future(['c1'],'then')]});
 plan.goals.at(-1)!.depends_on=['c1','c2'];
 const writes=vi.spyOn(f.store,'write');
 await expect(executePlan(f.service,{input:'明天安排两件事',game_id:before.game_id,
  expected_revision:before.state_revision,request_id:randomUUID()},plan as AgentPlan)).rejects.toThrow('条件');
 expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(before);
});
it.each([false,true])('preserves a valid single condition with then/else branches (familiar=%s)',async familiar=>{
 const f=await sparseSetup(),before=await f.service.current();
 before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 const player=before.entities.find(e=>e.id==='player')!;player.components.location={location_id:'square'};
 player.components.relationships={entries:{npc_lin:{familiarity:familiar?60:0}}};await f.store.write(before);
 const check={...condition('c'),condition:{kind:'familiar' as const,entity_id:'npc_lin',description:'我与林舟比较熟'}};
 const plan=validatePlan({goals:[check,future(['c'],'then'),{...future(['c'],'else'),goal_id:'alternative',normalized_goal:'明天改为独自训练',target_entities:[]}]});
 const result=await executePlan(f.service,{input:'如果与林舟熟悉，明天找他；否则明天独自训练',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},plan);
 expect(result.results?.map(g=>g.status)).toEqual(['completed',familiar?'completed':'skipped',familiar?'skipped':'completed']);
 const after=await f.service.current();expect(after.future_intents).toHaveLength(1);expect(after.future_intents![0].goal).toBe(familiar?'明天找林舟':'明天改为独自训练');
 expect(after.runtime.time).toEqual(before.runtime.time);expect(after.entities).toEqual(before.entities);expect(f.calls).toHaveLength(0);
});
it.each([false,true])('keeps current nested evaluation guarded by its outer branch (outer=%s)',async familiar=>{
 const f=await sparseSetup(),before=await f.service.current();
 before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 const player=before.entities.find(e=>e.id==='player')!;player.components.location={location_id:'square'};
 player.components.relationships={entries:{npc_lin:{familiarity:familiar?60:0}}};await f.store.write(before);
 const outer={...condition('c1'),condition:{kind:'familiar' as const,entity_id:'npc_lin',description:'我与林舟比较熟'}};
 const inner={...condition('c2'),depends_on:['c1'],branch:'then' as const,condition:{kind:'present' as const,entity_id:'player',description:'玩家在这里'}};
 const plan=validatePlan({goals:[outer,inner,future(['c2'],'then')]});
 const result=await executePlan(f.service,{input:'如果林舟在场，再确认玩家在这里，然后登记明天的打算',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},plan);
 expect(result.results?.map(g=>g.status)).toEqual(['completed',familiar?'completed':'skipped',familiar?'completed':'skipped']);
 expect((await f.service.current()).future_intents??[]).toHaveLength(familiar?1:0);expect(f.calls).toHaveLength(0);
});
it('allows an explicitly independent query to read after a condition without authorizing effects',()=>{
 expect(()=>validatePlan({goals:[condition('c'),goal('query','WORLD_QUERY',{normalized_goal:'我有多少钱？',depends_on:['c']})]})).not.toThrow();
});
it.each(['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL','CONTINUE_ROUTINE','FUTURE_INTENT','SCHEDULED_INTENT','CANCEL_FUTURE','EXECUTE_FUTURE'] as const)(
 'requires a branch for a direct conditional %s effect',type=>{
 expect(()=>validatePlan({goals:[condition('c'),goal('effect',type,{depends_on:['c']})]})).toThrow('条件');
});
it('keeps unknown public presence unresolved and never executes either branch',async()=>{
 const f=await sparseSetup(),before=await f.service.current();
 before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
 before.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};await f.store.write(before);
 const plan=validatePlan({goals:[condition('c'),future(['c'],'then'),{...future(['c'],'else'),goal_id:'alternative'}]});
 const result=await executePlan(f.service,{input:'如果林舟在这里，明天找他，否则另作打算',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},plan);
 expect(result.results?.map(g=>g.status)).toEqual(['completed','unresolved','unresolved']);expect(await f.store.read()).toEqual(before);
});

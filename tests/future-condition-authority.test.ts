import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {validatePlan} from '../src/agent/planner.js';
import {executePlan} from '../src/agent/executor.js';
import {validateSave} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {futureConditionGuards} from '../src/agent/future.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,type:GoalInput['type'],extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type,
 normalized_goal:'明天向米拉问好',depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],...extra});
const check=(id:string,entity='npc_lin')=>goal(id,'CONDITIONAL_INTENT',{
 condition:{kind:'familiar',entity_id:entity,description:`玩家与${entity}熟悉`}});
async function fixture(nested=false,presence=false,branch:'then'|'else'='then'){
 const adapter=new MockAIAdapter(),f=await sparseSetup(request=>adapter.generate(request)),before=await f.service.current();
 const lin=before.entities.find(e=>e.id==='npc_lin')!,mira=structuredClone(lin);mira.id='npc_mira';mira.components.identity={...mira.components.identity!,name:'米拉'};
 lin.components.location={location_id:'square'};mira.components.location={location_id:'square'};before.entities.push(mira);
 const player=before.entities.find(e=>e.id==='player')!;player.components.location={location_id:'square'};
 player.components.relationships={entries:{npc_lin:{familiarity:branch==='else'?0:60},npc_mira:{familiarity:nested?60:0}}};await f.store.write(before);
 const outer=presence?{...check('outer'),condition:{kind:'present' as const,entity_id:'npc_lin',description:'林舟在这里'}}:check('outer');
 const inner={...check('inner','npc_mira'),depends_on:['outer'],branch:'then' as const};
 const future=goal('future','FUTURE_INTENT',{depends_on:[nested?'inner':'outer'],branch,
  target_entities:['npc_mira'],temporal_scope:{scope:'future',day_offset:1,window:'any'}});
 const plan=validatePlan({goals:nested?[outer,inner,future]:[outer,future]});
 await executePlan(f.service,{input:'如果与林舟熟悉，明天向米拉问好',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},plan);
 const interpret=vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'TALK',target_id:'npc_mira',parameters:{topic:'问好'}});
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你向米拉问好。',speaker:'npc_mira',dialogue:'你好。',choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const turn=vi.spyOn(f.service,'turn');
 const due=async(a:number,b:number,legacy=false,absent=false)=>{
  const save=await f.service.current();save.runtime.time.day=2;
  save.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:a},npc_mira:{familiarity:b}}};
  if(legacy)delete (save.future_intents![0] as unknown as Record<string,unknown>).condition_guards;
  if(absent)save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
  await f.store.write(validateSave(save));const beforeDue=await f.service.current();
  const execute=validatePlan({goals:[goal('execute','EXECUTE_FUTURE',{normalized_goal:'执行向米拉问好的打算',target_entities:['npc_mira']})]});
  const result=await executePlan(f.service,{input:'执行向米拉问好的打算',game_id:beforeDue.game_id,expected_revision:beforeDue.state_revision,request_id:randomUUID()},execute);
  return {result,beforeDue,after:await f.service.current()};
 };
 return {...f,due,interpret,turn};
}
it.each([false,true])('evaluates the condition entity rather than a different recipient (condition=%s)',async truth=>{
 const f=await fixture(),{after,beforeDue}=await f.due(truth?60:0,truth?0:60);
 expect(f.interpret).toHaveBeenCalledTimes(truth?1:0);expect(f.turn).toHaveBeenCalledTimes(truth?1:0);
 expect(after.future_intents![0].status).toBe(truth?'completed':'due');if(!truth)expect(after).toEqual(beforeDue);
});
it.each([false,true])('preserves old single-condition saves without condition_guards (condition=%s)',async truth=>{
 const f=await fixture(),{after,beforeDue}=await f.due(truth?60:0,truth?0:60,true);
 expect(f.interpret).toHaveBeenCalledTimes(truth?1:0);expect(after.future_intents![0].status).toBe(truth?'completed':'due');
 if(!truth)expect(after).toEqual(beforeDue);
});
it('retains outer guards when registering a nested future intent',async()=>{
 const f=await fixture(true),intent=(await f.service.current()).future_intents![0];
 expect(intent).toMatchObject({condition_guards:[
  {condition:{kind:'familiar',entity_id:'npc_mira'},expected:true},
  {condition:{kind:'familiar',entity_id:'npc_lin'},expected:true},
 ]});
});
it('blocks a nested future when an outer guard becomes false before execution',async()=>{
 const f=await fixture(true),{after,beforeDue}=await f.due(0,60);
 expect(f.interpret).not.toHaveBeenCalled();expect(f.turn).not.toHaveBeenCalled();expect(after).toEqual(beforeDue);
});
it('does not treat the recipient being present as proof that a different condition entity is present',async()=>{
 const f=await fixture(false,true),{after,beforeDue}=await f.due(60,60,false,true);
 expect(f.interpret).not.toHaveBeenCalled();expect(f.turn).not.toHaveBeenCalled();expect(after).toEqual(beforeDue);
});
it.each([false,true])('retains the expected false value of an ELSE guard at due time (now familiar=%s)',async familiar=>{
 const f=await fixture(false,false,'else'),{after,beforeDue}=await f.due(familiar?60:0,familiar?0:60);
 expect(f.interpret).toHaveBeenCalledTimes(familiar?0:1);expect(after.future_intents![0].status).toBe(familiar?'due':'completed');
 if(familiar)expect(after).toEqual(beforeDue);
});
it('retains inherited guards through an intermediate non-conditional dependency',()=>{
 const plan=validatePlan({goals:[check('condition'),goal('query','WORLD_QUERY',{
  normalized_goal:'我有多少钱？',depends_on:['condition'],branch:'else'}),goal('future','FUTURE_INTENT',{
   depends_on:['query'],temporal_scope:{scope:'future',day_offset:1,window:'any'}})]});
 expect(futureConditionGuards(plan,plan.goals[2])).toEqual([{condition:plan.goals[0].condition,expected:false}]);
});
it('retains guards on disk and checks them before any model call after service recreation',async()=>{
 const f=await fixture(true),save=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-future-guards-'));
 try{
  const store=new JsonStore(directory);await store.write(save);const disk=new JsonStore(directory),loaded=(await disk.read())!;
  expect(loaded.future_intents![0]).toEqual(save.future_intents![0]);
  loaded.runtime.time.day=2;loaded.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:0},npc_mira:{familiarity:60}}};
  await disk.write(validateSave(loaded));const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(disk,ai,loaded.definition),before=await service.current();
  const interpret=vi.spyOn(ai,'interpret'),writes=vi.spyOn(disk,'write');
  const plan=validatePlan({goals:[goal('execute','EXECUTE_FUTURE',{target_entities:['npc_mira']})]});
  await executePlan(service,{input:'执行计划',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},plan);
  expect(interpret).not.toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();expect(await disk.read()).toEqual(before);
 }finally{await rm(directory,{recursive:true,force:true});}
});

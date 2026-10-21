import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {executeGoalControl,executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import {ProviderError} from '../src/ai/failures.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import type {Inventory} from '../src/modules/inventory.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,type:GoalInput['type'],text:string,extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type,normalized_goal:text,
 target_entities:[],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},...extra});
const future=(id:string,text:string,extra:Partial<GoalInput>)=>goal(id,'FUTURE_INTENT',text,{
 temporal_scope:{scope:'future',day_offset:1,window:'any'},...extra});
it.each((['true','false','unknown'] as const).flatMap(outer=>[false,true].map(inner=>({outer,inner})) ))(
 'keeps nested mixed action ownership outer=$outer inner=$inner',async({outer,inner})=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 for(const id of ['player','npc_lin','npc_qiao'])before.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:{...(outer==='unknown'?{}:{npc_lin:{familiarity:outer==='true'?60:0}}),npc_qiao:{familiarity:inner?60:0}}};
 await f.store.write(before);
 const goals=[goal('outer','CONDITIONAL_INTENT','核对与林舟是否熟悉',{condition:{kind:'familiar',entity_id:'npc_lin',description:'我与林舟熟悉'}}),
  goal('wait','WORLD_ACTION','等一分钟',{depends_on:['outer'],branch:'then'}),
  goal('inner','CONDITIONAL_INTENT','核对与乔宁是否熟悉',{depends_on:['outer','wait'],branch:'then',condition:{kind:'familiar',entity_id:'npc_qiao',description:'我与乔宁熟悉'}}),
  goal('hold','WORLD_ACTION','整理记录两分钟',{depends_on:['inner'],branch:'then'}),
  future('original','明天复核已有记录',{depends_on:['inner','hold'],branch:'then'}),
  future('inner_else','明天改做独自训练',{depends_on:['inner'],branch:'else'}),
  future('outer_else','明天另作安排',{depends_on:['outer'],branch:'else'})];
 const input='如果我与林舟熟悉，先等一分钟；如果我也与乔宁熟悉，整理记录两分钟并记下明天复核；否则明天独自训练。外层条件不成立则明天另作安排。';
 const plan=validatePlan({goals}),interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,text)=>text==='等一分钟'?
  {type:'WAIT',parameters:{minutes:1}}:{type:'HOLD',parameters:{minutes:2,activity:'整理已有记录'}});
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','使用权威降级'));
 const result=await executePlan(f.service,{input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},plan),after=await f.service.current();
 const expected=outer==='true'?['completed','completed','completed',inner?'completed':'skipped',inner?'completed':'skipped',inner?'skipped':'completed','skipped']:
  outer==='false'?['completed','skipped','skipped','skipped','skipped','skipped','completed']:
  ['completed','unresolved','skipped','skipped','skipped','skipped','unresolved'];
 expect(result.results?.map(r=>r.status)).toEqual(expected);
 expect(after.runtime.time.minute-before.runtime.time.minute).toBe(outer==='true'?1+(inner?2:0):0);
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)??[]).toEqual(outer==='true'?inner?['WAIT','HOLD']:['WAIT']:[]);
 expect(interpret).toHaveBeenCalledTimes(outer==='true'?inner?2:1:0);
 expect(after.future_intents??[]).toHaveLength(outer==='unknown'?0:1);
 if(outer!=='unknown'){
  const intent=after.future_intents![0];expect(intent.goal_id).toBe(outer==='false'?'outer_else':inner?'original':'inner_else');
  expect(intent.condition_guards).toEqual(outer==='false'?[{condition:goals[0].condition,expected:false}]:
   expect.arrayContaining([{condition:goals[0].condition,expected:true},{condition:goals[2].condition,expected:inner}]));
 }
 expect(after.entities.find(e=>e.id==='player')!.components.inventory).toEqual(before.entities.find(e=>e.id==='player')!.components.inventory);
});
it.each([false,true])('changes intent after actual partial trade and cancels only the %s paused target',async paused=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-mixed-intent-'));try{
  const f=await sparseSetup(),seed=await f.service.current();seed.definition.events=[];
  (seed.entities.find(e=>e.id==='player')!.components.wallet as {balances:Record<string,number>}).balances.credit=0;
  const store=new JsonStore(directory);await store.write(seed);const service=new GameService(store,f.ai,seed.definition),before=await service.current();
  vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','使用权威降级'));
  const oldInput='先去街角商店，再买一份面包',oldPlan=compileGoalContract(publicView(before),validatePlan({goals:[
   goal('move','WORLD_ACTION','去街角商店',{operation_hint:'move',referent:'街角商店'}),
   goal('buy','WORLD_ACTION','买一份面包',{depends_on:['move'],operation_hint:'purchase',referent:'面包'})]}),{kind:'manual',text:oldInput});
  const oldId=randomUUID();await executePlan(service,{input:oldInput,game_id:before.game_id,expected_revision:before.state_revision,request_id:oldId},oldPlan);
  const partial=await service.current();expect(partial.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['MOVE']);
  expect(partial.active_goal?.plan.plan_id).toBe(oldId);expect(partial.active_goal?.plan.goals[0].status).toBe('completed');
  const newWait=async()=>{
   const current=await service.current(),text=paused?'改为原地等待一分钟，再整理记录一分钟':'改为原地等待一分钟';
   const steps=[goal('new_wait','WORLD_ACTION','改为原地等待一分钟',{operation_hint:'activity',referent:'原地'}),
    ...(paused?[goal('new_record','WORLD_ACTION','整理记录一分钟',{operation_hint:'activity',referent:'记录',depends_on:['new_wait']})]:[])];
   const plan=compileGoalContract(publicView(current),validatePlan({goals:steps}),{kind:'manual',text});
   vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'候选等待',minutes:1,target_id:null,facts:[],relationship:null,
    resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'等待',stages:[],evidence_ids:[]}});
   await executePlan(service,{input:text,game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID()},plan);
  };
  if(paused)await newWait();
  const prior=await service.current();
  if(paused)expect(prior.paused_goals?.some(p=>p.plan.plan_id===oldId)).toBe(true);
  const cancelled=await executeGoalControl(service,{input:'取消目标 '+oldId,game_id:prior.game_id,expected_revision:prior.state_revision,request_id:randomUUID()},
   {kind:'cancel',target:oldId});expect(cancelled.goal_control?.status).toBe('cancelled');
  if(!paused)await newWait();
  const after=await service.current();
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['MOVE','改为原地等待一分钟',...(paused?['整理记录一分钟']:[])]);
  expect((after.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.bread??0).toBe(0);
  expect(after.entities.find(e=>e.id==='player')!.components.wallet).toEqual(before.entities.find(e=>e.id==='player')!.components.wallet);
  expect(after.runtime.time.minute-partial.runtime.time.minute).toBe(paused?2:1);
  const bytes=await readFile(join(directory,'current.json')),calls=f.ai.metrics.requests;
  const fresh=new GameService(new JsonStore(directory),f.ai,seed.definition);
  const resumed=await executeGoalControl(fresh,{input:'恢复目标 '+oldId,game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()},
   {kind:'resume',target:oldId});expect(resumed.goal_control?.status).toMatch(/already_terminal|not_found/);
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(f.ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

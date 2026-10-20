import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {ProviderError} from '../src/ai/failures.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,text:string,extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type:'WORLD_ACTION',
 normalized_goal:text,depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],...extra});
async function fixture(){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];await f.store.write(before);
 const interpret=vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'WAIT',parameters:{minutes:1}});
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你等了一分钟。',speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 return {...f,before,interpret};
}
it.each(['storage','provider'] as const)('retains committed prefix when between-step handoff inspection fails: %s',async kind=>{
 const f=await fixture(),blocker=vi.spyOn(f.service,'handoffBlocker').mockRejectedValue(kind==='storage'
  ?new Error('temporary handoff read failure'):new ProviderError('timeout','fixture','handoff timeout'));
 const plan=validatePlan({goals:[goal('first','等一分钟'),goal('second','再等一分钟',{depends_on:['first']}),
  goal('third','最后再等一分钟',{depends_on:['second']})]});
 const result=await executePlan(f.service,{input:'等一分钟，再等一分钟，最后再等一分钟',request_id:randomUUID(),
  game_id:f.before.game_id,expected_revision:f.before.state_revision},plan);
 const after=await f.service.current();
 expect(blocker).toHaveBeenCalledTimes(1);expect(f.interpret).toHaveBeenCalledTimes(1);
 expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);
 expect(result.results?.map(g=>g.status)).toEqual(['completed','failed','skipped']);
 expect(result.outcome).toMatchObject({type:'engine_failure',stage:'plan_handoff',state_certain:true,
  committed_steps:['world_action:first'],receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(result.story).toBe('你等了一分钟。');expect(result.presentation).toBe('failure');
 expect(result.message).toContain('前面已经结算');expect(result.recovery?.original_player_input).toBe('等一分钟，再等一分钟，最后再等一分钟');
 expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(1);
});
it('keeps a real player handoff distinct from technical failure',async()=>{
 const f=await fixture();vi.spyOn(f.service,'handoffBlocker').mockResolvedValue({kind:'player_decision',reason:'等待玩家决定'});
 const plan=validatePlan({goals:[goal('first','等一分钟'),goal('second','再等一分钟',{depends_on:['first']})]});
 const result=await executePlan(f.service,{input:'等一分钟，再等一分钟',request_id:randomUUID(),
  game_id:f.before.game_id,expected_revision:f.before.state_revision},plan);
 expect(result.results?.map(g=>g.status)).toEqual(['completed','unresolved']);
 expect(result.outcome?.type).toBe('game');expect(result.message).toContain('暂停');
 expect(f.interpret).toHaveBeenCalledTimes(1);
});
it('does not inspect a handoff for a false world branch before an authorized read-only alternative',async()=>{
 const f=await fixture(),check=goal('check','确认是否熟悉林舟',{type:'CONDITIONAL_INTENT',depends_on:['first'],
  condition:{kind:'familiar',entity_id:'npc_lin',description:'与林舟熟悉'}});
 const save=await f.service.current();save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 save.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:0}}};await f.store.write(save);
 const blocker=vi.spyOn(f.service,'handoffBlocker').mockResolvedValue({kind:'player_decision',reason:'等待玩家决定'});
 const plan=validatePlan({goals:[goal('first','等一分钟'),check,
  goal('then','再等一分钟',{depends_on:['check'],branch:'then'}),
  goal('else','我有多少钱？',{type:'WORLD_QUERY',depends_on:['check'],branch:'else'})]});
 const result=await executePlan(f.service,{input:'等一分钟，如果熟悉林舟就再等一分钟，否则查看余额',request_id:randomUUID(),
  game_id:save.game_id,expected_revision:save.state_revision},plan);
 expect(result.results?.map(g=>g.status)).toEqual(['completed','completed','skipped','completed']);
 expect(blocker).not.toHaveBeenCalled();expect(f.interpret).toHaveBeenCalledTimes(1);
 expect((await f.service.current()).resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);
});
it.each([false,true])('recovers an actual handoff storage read fault with prefix receipt intact (disk=%s)',async disk=>{
 const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'agf-handoff-'));
 try{
  const store=disk?new JsonStore(directory):f.store;await store.write(f.before);
  const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,f.before.definition);
  const interpret=vi.spyOn(ai,'interpret').mockResolvedValue({type:'WAIT',parameters:{minutes:1}});
  vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你等了一分钟。',speaker:null,dialogue:null,
   choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
  const original=service.handoffBlocker.bind(service);
  const blocker=vi.spyOn(service,'handoffBlocker').mockImplementationOnce(async()=>{
   vi.spyOn(store,'read').mockRejectedValueOnce(new Error('transient disk read fault'));
   return original();
  });
  const goals=[goal('first','等一分钟'),goal('second','再等一分钟',{depends_on:['first']})],request_id=randomUUID();
  const body={input:'等一分钟，再等一分钟',request_id,game_id:f.before.game_id,expected_revision:f.before.state_revision};
  const failed=await executePlan(service,body,validatePlan({goals})),saved=await service.current();
  expect(failed.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'plan_handoff',
   receipt_ids:[saved.resolution_receipts![0].request_id]});
  expect(saved.resolution_receipts).toHaveLength(1);expect(interpret).toHaveBeenCalledTimes(1);blocker.mockRestore();
  const prefix=structuredClone(saved.resolution_receipts![0]),reloadedStore=disk?new JsonStore(directory):store;
  const newAI=new AIRuntime(new MockAIAdapter()),rebuilt=new GameService(reloadedStore,newAI,saved.definition);
  const newInterpret=vi.spyOn(newAI,'interpret').mockResolvedValue({type:'WAIT',parameters:{minutes:1}});
  vi.spyOn(newAI,'narrate').mockResolvedValue({narrative:'你又等了一分钟。',speaker:null,dialogue:null,
   choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
  // Explicit retry against the refreshed revision: same child identity recovers the prefix.
  const result=await executePlan(rebuilt,{...body,expected_revision:saved.state_revision},validatePlan({goals}));
  const after=await rebuilt.current();expect(result.plan?.status).toBe('completed');
  expect(newInterpret).toHaveBeenCalledTimes(1);expect(after.resolution_receipts).toHaveLength(2);
  expect(after.resolution_receipts![0]).toEqual(prefix);
  expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(2);
 }finally{await rm(directory,{recursive:true,force:true});}
});


import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,depends_on:string[]=[]):GoalInput=>({goal_id:id,type:'WORLD_ACTION',
 normalized_goal:'等一分钟',depends_on,condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]});
async function fixture(){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];await f.store.write(before);
 const interpret=vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'WAIT',parameters:{minutes:1}});
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你等了一分钟。',speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 return {...f,before,interpret};
}
it('stops with known prefix evidence when handoff and all recovery reads stay unavailable',async()=>{
 const f=await fixture(),read=f.store.read.bind(f.store);let saved=await read();
 vi.spyOn(f.service,'handoffBlocker').mockImplementationOnce(async()=>{
  saved=await read();vi.spyOn(f.store,'read').mockRejectedValue(new Error('storage stays unreadable'));
  throw new Error('handoff storage read failed');
 });
 const plan=validatePlan({goals:[goal('first'),goal('second',['first']),goal('third',['second'])]});
 const result=await executePlan(f.service,{input:'等一分钟，再等一分钟，最后再等一分钟',request_id:randomUUID(),
  game_id:f.before.game_id,expected_revision:f.before.state_revision},plan);
 expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'plan_handoff',state_certain:false,
  receipt_ids:[saved!.resolution_receipts![0].request_id],revision:saved!.state_revision});
 expect(result.results?.map(g=>g.status)).toEqual(['completed','failed','skipped']);
 expect(result.story).toBe('你等了一分钟。');expect(result.presentation).toBe('failure');expect(result.view).toBeUndefined();
 expect(result.message).toContain('前面已经结算');expect(f.interpret).toHaveBeenCalledTimes(1);
 expect(await read()).toEqual(saved);expect(saved!.runtime.time.minute-f.before.runtime.time.minute).toBe(1);
});
it('does not expose a cached view as fresh authority when only final refresh becomes unreadable',async()=>{
 const f=await fixture(),turn=f.service.turn.bind(f.service),current=f.service.current.bind(f.service),read=f.store.read.bind(f.store);
 vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
  const result=await turn(...args),save=await current();
  vi.spyOn(f.service,'current').mockResolvedValueOnce(save).mockRejectedValue(new Error('final refresh unreadable'));
  return result;
 });
 const result=await executePlan(f.service,{input:'等一分钟',request_id:randomUUID(),
  game_id:f.before.game_id,expected_revision:f.before.state_revision},validatePlan({goals:[goal('first')]}));
 const after=(await read())!;
 expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'plan_finalize',state_certain:false,
  receipt_ids:[after.resolution_receipts![0].request_id],revision:after.state_revision});
 expect(result.results?.map(g=>g.status)).toEqual(['completed']);
 expect(result.story).toBe('你等了一分钟。');expect(result.view).toBeUndefined();
 expect(result.presentation).toBe('failure');expect(result.message).toContain('前面已经结算');
 expect(f.interpret).toHaveBeenCalledTimes(1);expect(after.resolution_receipts).toHaveLength(1);
 expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(1);
});
it('keeps receipt evidence obtained by recovery when the following final read fails',async()=>{
 const f=await fixture(),turn=f.service.turn.bind(f.service),current=f.service.current.bind(f.service),read=f.store.read.bind(f.store);
 vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
  await turn(...args);const save=await current();
  vi.spyOn(f.service,'current').mockResolvedValueOnce(save).mockRejectedValue(new Error('final read unavailable'));
  throw new Error('response lost after actual commit');
 });
 const result=await executePlan(f.service,{input:'等一分钟',request_id:randomUUID(),
  game_id:f.before.game_id,expected_revision:f.before.state_revision},validatePlan({goals:[goal('first')]}));
 const after=(await read())!;
 expect(result.outcome).toMatchObject({type:'engine_failure',stage:'plan_step',state_certain:false,
  revision:after.state_revision,receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(result.results?.map(g=>g.status)).toEqual(['failed']);
 expect(result.story).toBe('你等了一分钟。');expect(result.view).toBeUndefined();
 expect(f.interpret).toHaveBeenCalledTimes(1);expect(after.resolution_receipts).toHaveLength(1);
});
it('stops even an independent later world action when a read-only condition fails and state stays unreadable',async()=>{
 const f=await fixture(),read=f.store.read.bind(f.store);let saved=await read();
 vi.spyOn(f.ai,'systemAgent').mockImplementation(async()=>{
  saved=await read();vi.spyOn(f.store,'read').mockRejectedValue(new Error('state unavailable'));
  throw new Error('condition evaluation failed');
 });
 const check={...goal('check',['first']),type:'CONDITIONAL_INTENT' as const,
  condition:{kind:'public_fact' as const,entity_id:'player',description:'是否已经等过一分钟'}};
 const result=await executePlan(f.service,{input:'等一分钟，确认情况，再等一分钟',request_id:randomUUID(),
  game_id:f.before.game_id,expected_revision:f.before.state_revision},validatePlan({goals:[goal('first'),check,goal('independent',['first'])]}));
 expect(result.results?.map(g=>g.status)).toEqual(['completed','failed','skipped']);
 expect(result.results?.[1].summary).toContain('无法读取');expect(result.results?.[1].summary).not.toContain('没有改变');
 expect(result.outcome).toMatchObject({type:'engine_failure',state_certain:false,receipt_ids:[saved!.resolution_receipts![0].request_id]});
 expect(result.view).toBeUndefined();expect(f.interpret).toHaveBeenCalledTimes(1);expect(await read()).toEqual(saved);
});

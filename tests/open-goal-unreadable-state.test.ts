import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';

afterEach(()=>vi.restoreAllMocks());
const lane={kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:null,continuation:'none'}} as never;
const input='先去车站，再等五分钟看看后续情况';
async function fixture(disk:boolean){
 const directory=disk?await mkdtemp(join(tmpdir(),'agf-open-unreadable-')):null;
 let decisions=0;
 let secondPlanner:(()=>void)|undefined;
 const f=await sparseSetup(async request=>{
  if((request.schema as {properties?:Record<string,unknown>}).properties?.decision){
   decisions++;if(decisions===2)secondPlanner?.();return {data:{decision:'transaction',transaction:decisions===1?
    {kind:'move',destination:'河岸车站',minutes:null,reason:'前往'}:
    {kind:'wait',destination:null,minutes:5,reason:'查看后续变化'},reason:null,question:null}};
  }
  throw Error('Unexpected offline stage');
 });
 const save=await f.service.current();for(const e of save.entities)if(e.components.character)e.components.location={location_id:'square'};
 const store=directory?new JsonStore(directory):f.store;await store.write(save);
 const service=directory?new GameService(store,f.ai,save.definition):f.service;
 const narrate=vi.spyOn(f.ai,'narrate').mockImplementation(async(_save,action)=>({narrative:action.type==='MOVE'?'你来到河岸车站。':'你等了五分钟。',
  speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}) as never);
 const before=await service.current();return {directory,store,service,ai:f.ai,before,narrate,decisions:()=>decisions,
  onSecondPlanner:(callback:()=>void)=>{secondPlanner=callback;}};
}
it.each([false,true])('returns a structured unknown-state failure with observed prefix evidence (disk=%s)',async disk=>{
 const f=await fixture(disk),read=f.store.read.bind(f.store),turn=f.service.turn.bind(f.service);try{
  const turns=vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
   if((args[0] as {action?:{type:string}}).action?.type==='WAIT'){
    vi.spyOn(f.store,'read').mockRejectedValue(Error('persistent recovery read fault'));throw Error('second step storage failure');
   }
   return turn(...args);
  });
  const request={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input};
  const result=await handleAgentInput(f.service,request,
   undefined,null,false,lane);
  const after=(await read())!;
  expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'open_goal_refresh',state_certain:false,
   revision:after.state_revision,receipt_ids:[after.resolution_receipts![0].request_id]});
  expect(result.view).toBeUndefined();expect(result.presentation).toBe('failure');expect(result.story).toContain('你来到河岸车站');
  expect(result.message).toContain('前面已经结算');expect(result.message).not.toContain('世界没有改变');
  expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE']);expect(turns).toHaveBeenCalledTimes(2);
  expect(f.decisions()).toBe(2);expect(f.narrate).toHaveBeenCalledTimes(1);
  expect(await handleAgentInput(f.service,request,undefined,null,false,lane)).toEqual(result);
  expect(turns).toHaveBeenCalledTimes(2);expect(f.decisions()).toBe(2);
  if(f.directory)expect(JSON.parse(await readFile(join(f.directory,'current.json'),'utf8'))).toEqual(after);
 }finally{if(f.directory)await rm(f.directory,{recursive:true,force:true});}
});
it('does not claim an unseen second commit as absent or return a stale view',async()=>{
 const f=await fixture(true),read=f.store.read.bind(f.store),turn=f.service.turn.bind(f.service);try{
  const turns=vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
   const result=await turn(...args);
   if((args[0] as {action?:{type:string}}).action?.type==='WAIT'){
    vi.spyOn(f.store,'read').mockRejectedValue(Error('persistent postcommit read fault'));throw Error('second response lost after commit');
   }
   return result;
  });
  const result=await handleAgentInput(f.service,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input},
   undefined,null,false,lane);
  const after=(await read())!;expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE','WAIT']);
  expect(result.outcome).toMatchObject({type:'engine_failure',stage:'open_goal_refresh',state_certain:false,
   revision:after.state_revision-1,receipt_ids:[after.resolution_receipts![0].request_id]});
  expect(result.view).toBeUndefined();expect(result.story).toBe('你来到河岸车站。');expect(result.message).not.toContain('世界没有改变');
  expect(turns).toHaveBeenCalledTimes(2);expect(f.narrate).toHaveBeenCalledTimes(2);expect(f.decisions()).toBe(2);
  const bytes=await readFile(join(f.directory!,'current.json'));
  const restarted=new GameService(new JsonStore(f.directory!),f.ai,f.before.definition);
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(f.directory!,'current.json'))).toEqual(bytes);
  expect(f.narrate).toHaveBeenCalledTimes(2);expect(f.decisions()).toBe(2);
 }finally{if(f.directory)await rm(f.directory,{recursive:true,force:true});}
});
it('retains known progress if the planner fails and its recovery refresh is also unreadable',async()=>{
 const f=await fixture(false),read=f.store.read.bind(f.store);
 f.onSecondPlanner(()=>{vi.spyOn(f.store,'read').mockRejectedValue(Error('planner recovery storage unavailable'));throw Error('planner failed');});
 const turns=vi.spyOn(f.service,'turn');
 const result=await handleAgentInput(f.service,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input},
  undefined,null,false,lane);
 const after=(await read())!;expect(result.outcome).toMatchObject({type:'engine_failure',stage:'open_goal_refresh',state_certain:false,
  revision:after.state_revision,receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(result.story).toBe('你来到河岸车站。');expect(result.view).toBeUndefined();expect(turns).toHaveBeenCalledTimes(1);
 expect(f.decisions()).toBe(2);expect(f.narrate).toHaveBeenCalledTimes(1);
});
it('uses the normal step failure with a current view if the recovery read succeeds',async()=>{
 const f=await fixture(false),turn=f.service.turn.bind(f.service);
 vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
  if((args[0] as {action?:{type:string}}).action?.type==='WAIT')throw Error('step storage failure');
  return turn(...args);
 });
 const result=await handleAgentInput(f.service,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input},
  undefined,null,false,lane);
 const after=await f.service.current();expect(result.outcome).toMatchObject({type:'engine_failure',stage:'open_goal_step',
  receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(result.view).toEqual(f.service.project(after));expect(result.story).toBe('你来到河岸车站。');
 expect(f.decisions()).toBe(2);expect(f.narrate).toHaveBeenCalledTimes(1);
});
it('retains an observed commit when the next between-step refresh fails',async()=>{
 const f=await fixture(false),turn=f.service.turn.bind(f.service),current=f.service.current.bind(f.service),read=f.store.read.bind(f.store);
 vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
  const result=await turn(...args),committed=await current();
  vi.spyOn(f.service,'current').mockResolvedValueOnce(committed).mockRejectedValue(Error('between-step read unavailable'));
  return result;
 });
 const result=await handleAgentInput(f.service,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input},
  undefined,null,false,lane);
 const after=(await read())!;expect(result.outcome).toMatchObject({type:'engine_failure',stage:'open_goal_refresh',state_certain:false,
  revision:after.state_revision,receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(result.view).toBeUndefined();expect(result.story).toBe('你来到河岸车站。');expect(f.decisions()).toBe(1);
 expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE']);
});

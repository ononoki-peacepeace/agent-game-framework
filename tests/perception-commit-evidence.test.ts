import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {ProviderError} from '../src/ai/failures.js';
import {WorldBlockedError} from '../src/agent/outcome.js';

afterEach(()=>vi.restoreAllMocks());
const input='我仔细观察四周',semantic={kind:'world_action',interaction_lane:'natural_scene',
 goal_spec:{objective:input,play_action:'perceive',targets:[],desired_state:[],desired_outputs:[],constraints:[],
  persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,external_artifact:false,
  multi_step:false,ambiguity:null}} as never;
const proposal={narrative:'查看当前区域',minutes:2,target_id:null,facts:[],relationship:null,required_conditions:[],
 resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',stakes:'观察周围',
  stages:[],evidence_ids:[],discover_facts:true}};
type Mode='normal'|'before-write'|'after-write'|'after-newer'|'before-unreadable'|'after-unreadable'|'ack-unreadable'|'missing'|'unrelated'|'provider'|'blocked';
it.each(['normal','before-write','after-write','after-newer','before-unreadable','after-unreadable','ack-unreadable','missing','unrelated','provider','blocked'] as const)(
 'requires own perception evidence and preserves read/write failures (%s)',async(mode:Mode)=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-perception-evidence-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,f.ai,save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
  const freeform=vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal as never);
  if(mode==='provider')freeform.mockRejectedValue(new ProviderError('refusal','offline','offline refusal'));
  if(mode==='blocked')vi.spyOn(service,'turn').mockRejectedValue(new WorldBlockedError('unavailable','当前条件不允许这次观察'));
  vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','使用权威降级描写'));
  const write=store.write.bind(store),read=store.read.bind(store),unreadable=mode.endsWith('unreadable');
  const poison=()=>vi.spyOn(store,'read').mockRejectedValue(Error('perception canonical read unavailable'));
  const writes=vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   if(next.resolution_receipts?.some(r=>r.request_id===request.request_id)&&mode!=='normal'&&mode!=='ack-unreadable'){
    if(mode.startsWith('after-'))await write(next,slot);
    if(mode==='after-newer'){
     const other=new GameService(new JsonStore(directory),f.ai,save.definition),current=await other.current();
     await other.turn({game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID(),
      action:{type:'WAIT',parameters:{minutes:1}}});
    }
    if(unreadable)poison();throw Error('perception commit response lost');
   }
   return write(next,slot);
  });
  if(mode==='ack-unreadable'){
   const turn=service.turn.bind(service);vi.spyOn(service,'turn').mockImplementation(async(...args)=>{const result=await turn(...args);poison();return result;});
  }
  if(mode==='missing'||mode==='unrelated')vi.spyOn(service,'turn').mockImplementation(async()=>{
   if(mode==='unrelated')return service.agentTransaction({game_id:before.game_id,expected_revision:before.state_revision,
    request_id:randomUUID()},{unrelated_observation:true},()=>{});
   return service.project(await service.current());
  });
  const result=await handleAgentInput(service,request,undefined,null,false,semantic),after=(await read())!;
  const actualCommit=mode==='normal'||mode.startsWith('after-')||mode==='ack-unreadable';
  expect(after.state_revision).toBe(before.state_revision+Number(actualCommit||mode==='unrelated')+Number(mode==='after-newer'));
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe((actualCommit?2:0)+Number(mode==='after-newer'));
  expect(after.resolution_receipts?.filter(r=>r.request_id===request.request_id)??[]).toHaveLength(Number(actualCommit));
  if(mode==='normal')expect(result.outcome).toMatchObject({type:'game',kind:'completed',completed_steps:['perception_check'],receipt_ids:[request.request_id]});
  else if(mode==='blocked')expect(result.outcome).toMatchObject({type:'game',kind:'blocked_by_world',completed_steps:[],receipt_ids:[]});
  else{
   expect(result.outcome).toMatchObject({type:'engine_failure',
    code:mode==='missing'||mode==='unrelated'?'invariant_failure':mode==='provider'?'provider_failure':'transaction_failure',
    state_certain:!unreadable&&(mode==='before-write'||mode==='provider'),
    committed_steps:mode==='after-write'||mode==='after-newer'?['perception_check']:[],
    receipt_ids:mode==='after-write'||mode==='after-newer'?[request.request_id]:[]});
   if(mode==='after-write'||mode==='after-newer')expect(result.story).toBe(after.narrative_history?.find(h=>h.request_id===request.request_id)?.narrative);
   else expect(result.story).toBeUndefined();
   if(mode==='after-newer')expect(result.story).not.toBe(after.last_turn?.narrative);
  }
  if(unreadable)expect(result.view).toBeUndefined();else expect(result.view).toEqual(service.project(after));
  const bytes=await readFile(join(directory,'current.json')),calls=f.ai.metrics.requests,count=writes.mock.calls.length,generations=freeform.mock.calls.length;
  expect(await handleAgentInput(service,request,undefined,null,false,semantic)).toEqual(result);
  expect(f.ai.metrics.requests).toBe(calls);expect(writes).toHaveBeenCalledTimes(count);expect(freeform).toHaveBeenCalledTimes(generations);
  expect(await new GameService(new JsonStore(directory),f.ai,before.definition).current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

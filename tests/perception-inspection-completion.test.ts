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

afterEach(()=>vi.restoreAllMocks());
const input='检查鞋底、身体疲劳眩晕、湿滑地面',items=['鞋底','身体疲劳眩晕','湿滑地面'];
const semantic={kind:'world_action',interaction_lane:'natural_scene',goal_spec:{objective:input,play_action:'perceive',
 targets:[],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
 dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null}} as never;
it.each((['complete','partial','world_blocked','not_executed'] as const).flatMap(status=>[false,true].map(lostAck=>({status,lostAck}))))(
 'uses authoritative per-item inspection completion ($status/lostAck=$lostAck)',async({status,lostAck})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-inspection-completion-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,f.ai,save.definition),before=await service.current();
  const results=items.map((item,index)=>({item,result:status==='complete'?'nothing':status==='world_blocked'?'blocked':
   status==='partial'&&index===0?'nothing':'not_checked',detail:'固定离线逐项检查结果'}));
  vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'逐项检查',minutes:2,target_id:null,facts:[],inspection_results:results,
   relationship:null,required_conditions:[],resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',
    stakes:'检查列举项目',stages:[],evidence_ids:[],discover_facts:true}} as never);
  vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','使用权威降级描写'));
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
  if(lostAck){const write=store.write.bind(store);vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   await write(next,slot);if(next.resolution_receipts?.some(r=>r.request_id===request.request_id))throw Error('inspection acknowledgement lost');
  });}
  const response=await handleAgentInput(service,request,undefined,null,false,semantic),after=await service.current(),receipt=after.resolution_receipts!.at(-1)!;
  expect(receipt.inspection_status).toBe(status);expect(receipt.inspection_results).toEqual(results);
  if(lostAck)expect(response.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',state_certain:false,
   committed_steps:status==='complete'?['perception_check']:[],receipt_ids:[request.request_id]});
  else expect(response.outcome).toMatchObject({type:'game',kind:status==='complete'?'completed':status==='partial'?'partial_progress':
   status==='world_blocked'?'blocked_by_world':'unresolved_goal',goal_status:status==='complete'?'completed':status==='partial'?'partial':'unresolved',
   completed_steps:status==='complete'?['perception_check']:[],receipt_ids:[request.request_id]});
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(2);
  expect(after.entities).toEqual(before.entities);expect(response.story).toBe(after.last_turn?.narrative);
  expect(response.view).toEqual(service.project(after));
  const bytes=await readFile(join(directory,'current.json')),calls=f.ai.metrics.requests;
  const writes=vi.spyOn(store,'write');writes.mockClear();
  expect(await handleAgentInput(service,request,undefined,null,false,semantic)).toEqual(response);
  expect(writes).not.toHaveBeenCalled();expect(f.ai.metrics.requests).toBe(calls);
  expect(await new GameService(new JsonStore(directory),f.ai,before.definition).current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

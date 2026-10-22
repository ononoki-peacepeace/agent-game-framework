import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import * as core from '../src/core/runtime.js';
const run=randomUUID(),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
afterEach(()=>vi.restoreAllMocks());
const prose=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(narrativeWorldKinds.flatMap(kind=>(['before','after'] as const).flatMap(fault=>[false,true].map(degraded=>({kind,fault,degraded})))))(
 'keeps one authority through $fault-write loss, restart and later depletion in $kind / degraded=$degraded',async({kind,fault,degraded})=>{
 const {save}=await consumptionWorld(kind),directory=await mkdtemp(join(tmpdir(),'agf-consume-transaction-'));try{
  const store=new JsonStore(directory);await store.write(save);
  let amount=2,invalid=degraded;
  const ai=new AIRuntime({name:'offline-consumption-transaction',generate:async request=>{
   if(request.role==='narrator')return {data:prose(invalid?'你仍然持有三份面包。':`你吃掉了${amount}份面包。`)};
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded)return {data:{grounded:true,reports_result:true,reason:'fixed offline audit',unsupported_claims:[]}};
   throw new ProviderError('refusal','offline-only','No live model');
  }});
  const service=new GameService(store,ai,save.definition),before=await service.current(),beforeBytes=await readFile(join(directory,'current.json'));
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:2}}};
  const originalCore=core.executeAction;let executions=0;
  vi.spyOn(core,'executeAction').mockImplementation((...args)=>{if((args[1] as {type?:string}).type==='CONSUME_ITEM')executions++;return originalCore(...args);});
  const originalWrite=store.write.bind(store);let injected=false;
  vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   const hit=!injected&&next.runtime.receipts.some(receipt=>receipt.id===body.request_id);
   if(hit){injected=true;if(fault==='before')throw Error('fixed consumption before-write failure');}
   await originalWrite(next,slot);if(hit&&fault==='after')throw Error('fixed consumption persisted write acknowledgement lost');
  });
  let initialOutcome:unknown;try{initialOutcome=await service.turn(body);}catch(error){initialOutcome={error:String(error)};}
  expect(injected).toBe(true);const uncertainBytes=await readFile(join(directory,'current.json'));
  const uncertain=await new JsonStore(directory).read();expect(quantity(uncertain!)).toBe(fault==='before'?3:1);
  if(fault==='before')expect(uncertainBytes).toEqual(beforeBytes);
  const fresh=new GameService(new JsonStore(directory),ai,save.definition),response=await fresh.turn(body),after=await fresh.current();
  expect(executions).toBe(1);expect(quantity(after)).toBe(1);expect(quantity(after,'qa_other_bread','npc_lin')).toBe(2);
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute).toBe(before.runtime.time.minute+2);
  const receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
  expect(receipt).toMatchObject({commit_status:'committed',consumption:{consumed_quantity:2,after_quantity:1}});
  expect(after.last_turn!.presentation!.status).toBe(degraded?'degraded':'normal');
  expect(after.last_turn!.narrative).not.toContain('持有三份');
  const committed=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  const reloaded=new GameService(new JsonStore(directory),ai,save.definition);expect(await reloaded.turn(body)).toEqual(response);
  expect(await reloaded.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(committed);expect(ai.metrics.requests).toBe(calls);expect(executions).toBe(1);
  await expect(reloaded.turn({...body,action:{...body.action,parameters:{quantity:1}}})).rejects.toThrow();
  const replayExecutions=executions;
  amount=1;invalid=false;await reloaded.turn({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID(),action:{...body.action,parameters:{quantity:1}}});
  const depleted=await reloaded.current(),depletedBytes=await readFile(join(directory,'current.json'));expect(quantity(depleted)).toBe(0);expect(executions).toBe(2);
  await expect(reloaded.turn({game_id:depleted.game_id,expected_revision:depleted.state_revision,request_id:randomUUID(),action:body.action})).rejects.toThrow();
  expect(await readFile(join(directory,'current.json'))).toEqual(depletedBytes);
  await writeFile(`.agent-runtime/codex/consumption-transaction-${run}-${kind}-${fault}-${degraded}.json`,JSON.stringify({kind,fault,degraded,body,before,before_bytes_sha256:hash(beforeBytes),initialOutcome,uncertain,uncertain_bytes_sha256:hash(uncertainBytes),after,response,receipt,committed_bytes_sha256:hash(committed),depleted,replay_execution_count:replayExecutions,core_attempts_after_later_actions:executions},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},90000);
it.each(narrativeWorldKinds)('resumes a prepared consumption after Narrator interruption without running Core twice in %s',async kind=>{
 const {save}=await consumptionWorld(kind),directory=await mkdtemp(join(tmpdir(),'agf-consume-pending-'));try{
  const store=new JsonStore(directory);await store.write(save);const ai=new AIRuntime({name:'offline-pending-consumption',generate:async()=>{throw Error('No accidental generation');}});
  const narrate=vi.spyOn(ai,'narrate').mockRejectedValueOnce(Error('unclassified interruption after prepared consumption'));
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:2}}};
  await expect(service.turn(body)).rejects.toThrow();expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const pending=await store.readPending(body.request_id);expect(quantity(pending!.candidate)).toBe(1);
  const execute=vi.spyOn(core,'executeAction');narrate.mockResolvedValue(prose('你吃掉了两份面包。'));
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);await fresh.turn(body);
  const after=await fresh.current();expect(quantity(after)).toBe(1);expect(after.state_revision).toBe(before.state_revision+1);expect(execute).not.toHaveBeenCalled();
  const committed=await readFile(join(directory,'current.json'));await fresh.turn(body);expect(await readFile(join(directory,'current.json'))).toEqual(committed);expect(narrate).toHaveBeenCalledTimes(2);
 }finally{await rm(directory,{recursive:true,force:true});}
},60000);

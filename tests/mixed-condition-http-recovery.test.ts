import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {sparseSetup} from './sparse-fixture.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';
import {ProviderError} from '../src/ai/failures.js';
import * as router from '../src/system/context-router.js';
import * as planner from '../src/agent/planner.js';
import * as alignment from '../src/agent/goal-alignment.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import type {SavePackage} from '../src/core/schema.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,type:GoalInput['type'],text:string,extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type,normalized_goal:text,
 target_entities:[],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},...extra});
const future=(id:string,text:string,extra:Partial<GoalInput>)=>goal(id,'FUTURE_INTENT',text,{
 temporal_scope:{scope:'future',day_offset:1,window:'any'},...extra});
const combinations=(['true','false','unknown'] as const).flatMap(outer=>[false,true].flatMap(inner=>
 (['normal','lost_ack'] as const).map(mode=>({outer,inner,mode}))));
const matrix=[...combinations,...[false,true].map(inner=>({outer:'true' as const,inner,mode:'interrupted' as const}))];
it.each(matrix)('replays parent HTTP nested outer=$outer inner=$inner mode=$mode without effects',async({outer,inner,mode})=>{
 const f=await sparseSetup(),seed=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-mixed-http-'));
 seed.definition.events=[];
 for(const id of ['player','npc_lin','npc_qiao'])seed.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 seed.entities.find(e=>e.id==='player')!.components.relationships={entries:{...(outer==='unknown'?{}:{npc_lin:{familiarity:outer==='true'?60:0}}),npc_qiao:{familiarity:inner?60:0}}};
 if(mode==='interrupted'){
  seed.entities.find(e=>e.id==='player')!.components.opportunities={entries:{mixed_meeting:{status:'accepted',title:'已接受的会面'}}};
  seed.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'mixed_meeting',label:'已接受的会面',
   at:seed.runtime.time.day*seed.definition.ruleset.minutes_per_day+seed.runtime.time.minute+2,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 const goals=[goal('outer','CONDITIONAL_INTENT','核对与林舟是否熟悉',{condition:{kind:'familiar',entity_id:'npc_lin',description:'我与林舟熟悉'}}),
  goal('wait','WORLD_ACTION','等一分钟',{depends_on:['outer'],branch:'then'}),
  goal('inner','CONDITIONAL_INTENT','核对与乔宁是否熟悉',{depends_on:['outer','wait'],branch:'then',condition:{kind:'familiar',entity_id:'npc_qiao',description:'我与乔宁熟悉'}}),
  goal('hold','WORLD_ACTION','整理记录两分钟',{depends_on:['inner'],branch:'then'}),
  future('original','明天复核已有记录',{depends_on:['inner','hold'],branch:'then'}),
  future('inner_else','明天改做独自训练',{depends_on:['inner'],branch:'else'}),
  future('outer_else','明天另作安排',{depends_on:['outer'],branch:'else'})];
 const proposed=planner.validatePlan({goals});
 const route=vi.spyOn(router,'routeContext').mockResolvedValue({destination:'WORLD_INTENT',semantic:{kind:'world_action'}} as never);
 const plan=vi.spyOn(planner,'createAgentPlan').mockImplementation(async()=>structuredClone(proposed));
 const audit=vi.spyOn(alignment,'verifyGoalAlignment').mockResolvedValue({verdict:'aligned',explanation:'controlled offline fixed corpus'});
 const interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,text)=>text==='等一分钟'?
  {type:'WAIT',parameters:{minutes:1}}:{type:'HOLD',parameters:{minutes:2,activity:'整理已有记录'}});
 const narrate=vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','使用权威降级'));
 const store=new JsonStore(directory);await store.write(seed);
 const service=new GameService(store,f.ai,seed.definition),before=await service.current();
 const input='如果我与林舟熟悉，先等一分钟；如果我也与乔宁熟悉，整理记录两分钟并记下明天复核；否则明天独自训练。外层条件不成立则明天另作安排。';
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 let injected=false;const write=store.write.bind(store);
 vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
  await write(next,slot);
  if(mode==='lost_ack'&&!injected&&next.resolution_receipts?.some(r=>r.actor_id==='player')){
   injected=true;throw Error('mixed corpus first player settlement acknowledgement lost');
  }
 });
 let server=createApp(service).listen(0,'127.0.0.1');
 const close=async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));};
 const post=async(value:unknown=body)=>{
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(value)});
  return {status:response.status,body:await response.json()};
 };
 try{
  await once(server,'listening');const first=await post(),after=(await store.read())!;
  expect(first.status,JSON.stringify(first.body)).toBe(200);
  const lost=mode==='lost_ack'&&outer==='true',interrupted=mode==='interrupted'&&inner;
  expect(injected).toBe(lost);
  const expectedMinutes=outer==='true'?lost?1:1+(inner?(interrupted?1:2):0):0;
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(expectedMinutes);
  const receipts=after.resolution_receipts?.filter(r=>r.actor_id==='player')??[];
  expect(receipts.map(r=>r.semantic_action)).toEqual(outer==='true'?inner&&!lost?['WAIT','HOLD']:['WAIT']:[]);
  expect(receipts.map(r=>r.time_cost)).toEqual(outer==='true'?inner&&!lost?[1,interrupted?1:2]:[1]:[]);
  expect(interpret).toHaveBeenCalledTimes(receipts.length);
  if(lost){
   expect(first.body.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure'});
   expect(first.body.outcome.receipt_ids).toContain(receipts[0].request_id);
  }else{
   const statuses=outer==='true'?['completed','completed','completed',inner?(interrupted?'blocked':'completed'):'skipped',inner?(interrupted?'skipped':'completed'):'skipped',inner?'skipped':'completed','skipped']:
    outer==='false'?['completed','skipped','skipped','skipped','skipped','skipped','completed']:
    ['completed','unresolved','skipped','skipped','skipped','skipped','unresolved'];
   expect(first.body.plan.goals.map((g:{status:string})=>g.status)).toEqual(statuses);
   if(interrupted)expect(first.body.outcome).toMatchObject({type:'game',kind:'partial_progress',goal_status:'partial',completed_steps:['world_action:wait']});
  }
  expect(after.future_intents??[]).toHaveLength(outer==='unknown'||lost||interrupted?0:1);
  if(after.future_intents?.length){
   const intent=after.future_intents[0];expect(intent.goal_id).toBe(outer==='false'?'outer_else':inner?'original':'inner_else');
   expect(intent.condition_guards).toEqual(outer==='false'?[{condition:goals[0].condition,expected:false}]:
    expect.arrayContaining([{condition:goals[0].condition,expected:true},{condition:goals[2].condition,expected:inner}]));
  }
  for(const key of ['wallet','inventory','condition'])expect(after.entities.find(e=>e.id==='player')!.components[key]).toEqual(before.entities.find(e=>e.id==='player')!.components[key]);
  for(let i=0;i<100;i++){if((await store.readInputRecord(body.game_id,body.request_id))?.state==='completed')break;await new Promise(done=>setTimeout(done,5));}
  expect((await store.readInputRecord(body.game_id,body.request_id))?.state).toBe('completed');
  const bytes=await readFile(join(directory,'current.json')),counts=[route.mock.calls.length,plan.mock.calls.length,audit.mock.calls.length,interpret.mock.calls.length,narrate.mock.calls.length];
  await close();const disk=new JsonStore(directory),ai=new AIRuntime({name:'no-replay-generation',generate:async()=>{throw Error('Replay must not generate');}});
  const writes=vi.spyOn(disk,'write'),restarted=new GameService(disk,ai,seed.definition);
  server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
  expect(await post()).toEqual(first);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(writes).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
  expect([route.mock.calls.length,plan.mock.calls.length,audit.mock.calls.length,interpret.mock.calls.length,narrate.mock.calls.length]).toEqual(counts);
  expect((await post({...body,input:'另一条未授权的请求'})).status).toBe(409);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(writes).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await close();await rm(directory,{recursive:true,force:true});}
});

// Functional disk/HTTP/restart/replay scenarios, not a five-second performance
// contract. The paused variant completes multiple new requests and replays all
// of them after three service instances. Keep a bounded per-case deadline.
it.each(['cancel_current','cancel_paused','buy_before','buy_after'] as const)(
 'retains actual trade prefix and parent identities across HTTP restart and %s',async mode=>{
 const f=await sparseSetup(),seed=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-mixed-trade-http-'));
 seed.definition.events=[];
 const player=(save:SavePackage)=>save.entities.find(e=>e.id==='player')!;
 const balance=(save:SavePackage)=>(player(save).components.wallet as {balances:Record<string,number>}).balances.credit;
 const bread=(save:SavePackage)=>(player(save).components.inventory as {items:Record<string,number>}).items.bread??0;
 const stock=(save:SavePackage)=>(save.entities.find(e=>e.id==='corner_shop')!.components.shop as {stock:Record<string,number>}).stock.bread;
 const cancel=mode.startsWith('cancel');
 if(cancel)(player(seed).components.wallet as {balances:Record<string,number>}).balances.credit=0;
 const tradeText='先去街角商店，再买一份面包',replacement=mode==='cancel_paused'?'改为原地等待一分钟，再整理记录一分钟':'改为原地等待一分钟';
 const trade=planner.validatePlan({goals:[goal('move','WORLD_ACTION','去街角商店',{operation_hint:'move',referent:'街角商店'}),
  goal('buy','WORLD_ACTION','买一份面包',{depends_on:['move'],operation_hint:'purchase',referent:'面包'})]});
 const alternate=planner.validatePlan({goals:[goal('new_wait','WORLD_ACTION','改为原地等待一分钟',{operation_hint:'activity',referent:'原地'}),
  ...(mode==='cancel_paused'?[goal('new_record','WORLD_ACTION','整理记录一分钟',{operation_hint:'activity',referent:'记录',depends_on:['new_wait']})]:[])]});
 const route=vi.spyOn(router,'routeContext').mockResolvedValue({destination:'WORLD_INTENT',semantic:{kind:'world_action'}} as never);
 const plans=vi.spyOn(planner,'createAgentPlan').mockImplementation(async(_ai,_view,text)=>structuredClone(text===tradeText?trade:alternate));
 const audit=vi.spyOn(alignment,'verifyGoalAlignment').mockResolvedValue({verdict:'aligned',explanation:'controlled offline fixed corpus'});
 const freeform=vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'候选活动',minutes:1,target_id:null,facts:[],relationship:null,
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'等待',stages:[],evidence_ids:[]}});
 const narrate=vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','权威降级'));
 const store=new JsonStore(directory);await store.write(seed);
 let service=new GameService(store,f.ai,seed.definition),server=createApp(service).listen(0,'127.0.0.1');
 const close=async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));};
 const history:{request:{input:string;game_id:string;expected_revision:number;request_id:string};response:{status:number;body:any}}[]=[];
 const post=async(value:unknown)=>{
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(value)});
  return {status:response.status,body:await response.json()};
 };
 const request=async(input:string)=>{
  const current=await service.current(),body={input,game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID()},response=await post(body);
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  for(let i=0;i<100;i++){if((await service.storage.readInputRecord?.(body.game_id,body.request_id))?.state==='completed')break;await new Promise(done=>setTimeout(done,5));}
  expect((await service.storage.readInputRecord?.(body.game_id,body.request_id))?.state).toBe('completed');
  history.push({request:body,response});return history.at(-1)!;
 };
 const restart=async()=>{
  await close();service=new GameService(new JsonStore(directory),f.ai,seed.definition);
  server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
 };
 let injected=false;const write=store.write.bind(store);
 vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
  const hit=!cancel&&!injected&&next.resolution_receipts?.some(r=>r.semantic_action==='BUY');
  if(hit){injected=true;if(mode==='buy_before')throw Error('BUY save failed before write');}
  await write(next,slot);if(hit)throw Error('BUY acknowledgement lost after write');
 });
 try{
  await once(server,'listening');const before=await service.current(),original=await request(tradeText),partial=await service.current();
  expect(partial.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(mode==='buy_after'?['MOVE','BUY']:['MOVE']);
  expect(injected).toBe(!cancel);expect(bread(partial)-bread(before)).toBe(mode==='buy_after'?1:0);
  expect(balance(before)-balance(partial)).toBe(mode==='buy_after'?8:0);
  // The contract runner recovers a completed BUY from its own persisted goal and receipt after lost acknowledgement.
  expect(original.response.body.outcome.type).toBe(mode==='buy_before'?'engine_failure':'game');
  if(mode==='buy_after')expect(original.response.body.plan.goals.map((g:{status:string})=>g.status)).toEqual(['completed','completed']);
  const prefix=partial.resolution_receipts!.find(r=>r.semantic_action==='MOVE')!;
  await restart();const prefixBytes=await readFile(join(directory,'current.json')),metrics=f.ai.metrics.requests;
  expect(await post(original.request)).toEqual(original.response);expect(await readFile(join(directory,'current.json'))).toEqual(prefixBytes);expect(f.ai.metrics.requests).toBe(metrics);
  if(cancel){
   if(mode==='cancel_paused'){
    await request(replacement);expect((await service.current()).paused_goals?.some(g=>g.plan.plan_id===original.request.request_id)).toBe(true);
   }
   const cancelled=await request('取消目标 '+original.request.request_id);expect(cancelled.response.body.goal_control.status).toBe('cancelled');
   if(mode==='cancel_current')await request(replacement);
   await restart();const bytes=await readFile(join(directory,'current.json'));
   const terminal=await request('恢复目标 '+original.request.request_id);expect(terminal.response.body.goal_control.status).toMatch(/already_terminal|not_found/);
   expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }else{
   const continued=await request('恢复目标 '+original.request.request_id);
   expect(continued.response.body.outcome.type).toBe('game');
  }
  const after=await service.current(),receipts=after.resolution_receipts!.filter(r=>r.actor_id==='player');
  expect(receipts.find(r=>r.request_id===prefix.request_id)).toEqual(prefix);
  expect(receipts.filter(r=>r.semantic_action==='MOVE')).toHaveLength(1);
  expect(receipts.filter(r=>r.semantic_action==='BUY')).toHaveLength(cancel?0:1);
  expect(bread(after)-bread(before)).toBe(cancel?0:1);expect(stock(before)-stock(after)).toBe(cancel?0:1);expect(balance(before)-balance(after)).toBe(cancel?0:8);
  if(cancel){expect(after.runtime.time.minute-partial.runtime.time.minute).toBe(mode==='cancel_paused'?2:1);expect(freeform).toHaveBeenCalledTimes(mode==='cancel_paused'?2:1);}
  const bytes=await readFile(join(directory,'current.json')),counts=[route.mock.calls.length,plans.mock.calls.length,audit.mock.calls.length,freeform.mock.calls.length,narrate.mock.calls.length];
  await close();const disk=new JsonStore(directory),ai=new AIRuntime({name:'no-replay-generation',generate:async()=>{throw Error('Historical parent replay must not generate');}}),writes=vi.spyOn(disk,'write');
  service=new GameService(disk,ai,seed.definition);server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  for(const prior of history)expect(await post(prior.request)).toEqual(prior.response);
  expect(await service.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(writes).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
  expect([route.mock.calls.length,plans.mock.calls.length,audit.mock.calls.length,freeform.mock.calls.length,narrate.mock.calls.length]).toEqual(counts);
 }finally{await close();await rm(directory,{recursive:true,force:true});}
},20_000);

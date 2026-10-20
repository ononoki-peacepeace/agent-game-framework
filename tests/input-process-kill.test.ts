import {expect,it} from 'vitest';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import type {Server} from 'node:http';
import {fresh} from './helpers.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {createApp} from '../src/server/app.js';

function message(child:ChildProcess,kind:string):Promise<{kind:string;port?:number;stage?:string;request_id?:string}>{
 return new Promise((resolveMessage,reject)=>{
  const cleanup=()=>{clearTimeout(timer);child.off('message',received);child.off('exit',exited);child.off('error',failed);};
  const received=(value:unknown)=>{const data=value as {kind:string};if(data?.kind===kind){cleanup();resolveMessage(data);}};
  const exited=(code:number|null,signal:NodeJS.Signals|null)=>{cleanup();reject(Error(`Worker exited before ${kind}: ${code}/${signal}`));};
  const failed=(error:Error)=>{cleanup();reject(error);};
  const timer=setTimeout(()=>{cleanup();reject(Error('Worker boundary timeout: '+kind));},30000);
  child.on('message',received);child.once('exit',exited);child.once('error',failed);
 });
}
const boundaries=['pending_before','pending_after','commit_before','commit_after','terminal_before','terminal_after'] as const;
const scenarios=(['wait','buy','physical'] as const).flatMap(scenario=>boundaries.map(boundary=>({scenario,boundary})));
it.each(scenarios)('independent process kill of $scenario at $boundary preserves authoritative request/commit identity',async({scenario,boundary})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-input-kill-')),store=new JsonStore(directory),initial=fresh(),request_id=randomUUID();
 initial.definition.events=[];
 if(scenario==='buy')initial.entities.find(e=>e.id===initial.player_state.entity_id)!.components.location={location_id:'market'};
 await store.write(initial);
 const normalized=await new GameService(store,new AIRuntime(new MockAIAdapter()),initial.definition).current();
 await store.write(normalized);
 const body={request_id,game_id:normalized.game_id,expected_revision:normalized.state_revision,
  input:scenario==='physical'?'尝试打击林舟':scenario==='buy'?'买一个面包':'等一分钟'};
 let child:ChildProcess|undefined,server:Server|undefined,pendingResponse:Promise<unknown>|undefined,stderr='';
 try{
  child=fork(resolve('tests/fixtures/input-kill-worker.ts'),[directory,boundary,request_id,scenario],{
   execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
   env:{...process.env,AI_ADAPTER:'mock',GAME_DATA_DIR:directory,GAME_LOG_DIR:join(directory,'logs')},
  });
  child.stderr!.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-6000);});
  const ready=await message(child,'ready'),base=`http://127.0.0.1:${ready.port}`;
  const token=(await(await fetch(base+'/api/session',{headers:{connection:'close'}})).json() as {token:string}).token;
  const reached=message(child,'boundary');
  pendingResponse=fetch(base+'/api/input',{method:'POST',headers:{connection:'close','content-type':'application/json','X-Game-Token':token},
   body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()})).catch(()=>null);
  expect(await reached).toMatchObject({stage:boundary,request_id});
  const exit=once(child,'exit');expect(child.kill('SIGKILL')).toBe(true);await exit;await pendingResponse;
  const killed=(await new JsonStore(directory).read())!,committed=['commit_after','terminal_before','terminal_after'].includes(boundary);
  expect(killed.state_revision).toBe(normalized.state_revision+(committed?1:0));
  expect(killed.runtime.time.minute-normalized.runtime.time.minute).toBe(committed?(scenario==='buy'?2:1):0);
  const receipts=killed.resolution_receipts?.filter(r=>r.commit_status==='committed'&&
   (scenario==='physical'?Boolean(r.physical_outcome):r.semantic_action===(scenario==='buy'?'BUY':'WAIT')))??[];
  expect(receipts).toHaveLength(committed?1:0);
  if(committed){
   expect(killed.runtime.receipts.filter(r=>r.id===receipts[0].request_id)).toHaveLength(1);
   if(scenario!=='wait')expect(receipts[0].request_id).not.toBe(request_id);
   else expect(receipts[0].request_id).toBe(request_id);
  }
  if(scenario==='physical'){
   const checks=killed.resolution_history??[];
   expect(checks).toHaveLength(committed?1:0);
   if(committed){
    expect(checks[0].rolls.length).toBeGreaterThan(0);
    expect(receipts[0].rolls).toEqual(checks[0].rolls);
    expect(receipts[0].outcome).toBe(checks[0].outcome);
    expect(checks[0].request_id).toBe(receipts[0].request_id);
   }
  }
  if(scenario==='buy'){
   const player=killed.entities.find(e=>e.id===killed.player_state.entity_id)!,shop=killed.entities.find(e=>e.id==='corner_shop')!;
   expect(player.components.wallet?.balances).toEqual({credit:committed?92:100});
   expect(player.components.inventory?.items).toEqual(committed?{bread:1}:{});
   expect(shop.components.wallet?.balances).toEqual({credit:committed?1008:1000});
   expect(shop.components.shop?.stock).toEqual({water:10,notebook:10,bread:committed?9:10});
  }
  const raw=await readFile(join(directory,'current.json'));
  const disk=new JsonStore(directory),ai=new AIRuntime(new MockAIAdapter()),service=new GameService(disk,ai,killed.definition);
  server=createApp(service,undefined,undefined,join(directory,'restart-assets')).listen(0,'127.0.0.1');await once(server,'listening');
  const restored=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const status=await(await fetch(`${restored}/api/input/status/${request_id}?game_id=${body.game_id}`,{headers:{connection:'close'}})).json();
  expect(status.state).toBe(committed?'completed':'unknown');
  if(committed)expect(status.result.outcome.receipt_ids).toContain(receipts[0].request_id);
  else expect(status.reason).toBe('server_interrupted');
  const newToken=(await(await fetch(restored+'/api/session',{headers:{connection:'close'}})).json() as {token:string}).token;
  const replay=await fetch(restored+'/api/input',{method:'POST',headers:{connection:'close','content-type':'application/json','X-Game-Token':newToken},body:JSON.stringify(body)});
  expect(replay.status).toBe(committed?200:409);
  const result=await replay.json();
  if(committed)expect(result).toEqual(status.result);else expect(result.retry_policy).toBe('do_not_replay');
  expect(ai.metrics.requests).toBe(0);expect(service.logger.entries({event:'rng.roll'})).toHaveLength(0);
  expect(await disk.read()).toEqual(killed);
  expect(await readFile(join(directory,'current.json'))).toEqual(raw);
 }catch(error){throw new Error(`${scenario}/${boundary}: ${inspect(error)}\n${stderr}`,{cause:error});}
 finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
  await pendingResponse;
  if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}
  await rm(directory,{recursive:true,force:true});
 }
},60000);

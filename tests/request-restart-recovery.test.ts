import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {createApp} from '../src/server/app.js';
import {fresh} from './helpers.js';
import {inputRequestStatus} from '../src/client/api.js';
import {awaitInputResult,InputStatusUnknown} from '../src/client/input-recovery.js';
afterEach(()=>vi.unstubAllGlobals());
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'herne-request-restart-')),store=new JsonStore(directory),initial=fresh();await store.write(initial);
 const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,initial.definition);
 const baseline=await service.current();
 let server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
 let base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 return {directory,store,initial:baseline,service,ai,get base(){return base;},
  async restart(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
   server=createApp(new GameService(new JsonStore(directory),ai,initial.definition)).listen(0,'127.0.0.1');await once(server,'listening');
   base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;},
  async close(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});},
  async post(body:unknown){const session=await (await fetch(base+'/api/session')).json() as {token:string};
   return fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},body:JSON.stringify(body)});},
  async status(id:string){return fetch(`${base}/api/input/status/${id}?game_id=${initial.game_id}`);}};
}
it('normalizes only the typed status-record 404, without swallowing proxy or server errors',async()=>{
 const mocked=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({state:'unknown'}),{status:404}))
  .mockResolvedValueOnce(new Response(JSON.stringify({error:'route missing'}),{status:404}))
  .mockResolvedValueOnce(new Response(JSON.stringify({error:'unavailable'}),{status:503}));
 vi.stubGlobal('fetch',mocked);
 expect(await inputRequestStatus('game','request')).toEqual({state:'unknown',reason:'record_missing'});
 await expect(inputRequestStatus('game','request')).rejects.toThrow();
 await expect(inputRequestStatus('game','request')).rejects.toThrow();
});
it('stops once on missing status and cancels timer-based recovery on disposal',async()=>{
 const status=vi.fn(async()=>({state:'unknown' as const}));
 await expect(awaitInputResult(new Promise<never>(()=>{}),status,{requestTimeoutMs:0,pollMs:1})).rejects.toBeInstanceOf(InputStatusUnknown);
 expect(status).toHaveBeenCalledTimes(1);
 const controller=new AbortController(),running=vi.fn(async()=>{controller.abort();return {state:'running' as const};});
 await expect(awaitInputResult(new Promise<never>(()=>{}),running,{requestTimeoutMs:0,pollMs:10000,signal:controller.signal})).rejects.toThrow();
 expect(running).toHaveBeenCalledTimes(1);
});
it('recovers a durable terminal response after restart, rejects changed payload and never executes again',async()=>{
 const f=await fixture();try{
  const body={request_id:randomUUID(),game_id:f.initial.game_id,expected_revision:0,input:'未知的离线请求'};
  const response=await f.post(body),result=await response.json();expect(response.status).toBe(200);
  // HTTP response can precede final journal fsync; wait for the handler's durable finish.
  for(let attempt=0;attempt<100;attempt++){if((await f.store.readInputRecord(body.game_id,body.request_id))?.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,5));}
  const before=await f.store.read(),calls=f.ai.metrics.requests;
  await f.restart();const status=await f.status(body.request_id);expect(status.status).toBe(200);
  expect((await status.json()).result).toEqual(result);
  expect((await f.post({...body,input:'不同内容'})).status).toBe(409);
  expect((await f.post(body)).status).toBe(200);
  expect(f.ai.metrics.requests).toBe(calls);expect(await f.store.read()).toEqual(before);
 }finally{await f.close();}
});
it('recovers committed progress from existing receipts when no HTTP journal survived',async()=>{
 const f=await fixture();try{
  const id=randomUUID();await f.service.turn({request_id:id,game_id:f.initial.game_id,expected_revision:0,action:{type:'WAIT',parameters:{minutes:5}}});
  const before=await f.store.read();await f.restart();
  const status=await f.status(id),body=await status.json();expect(body.state).toBe('completed');
  expect(body.result.outcome.kind).toBe('partial_progress');expect(body.result.view.revision).toBe(before!.state_revision);
  expect(await f.store.read()).toEqual(before);
 }finally{await f.close();}
});
it('distinguishes interrupted, missing and corrupt request records without changing the world',async()=>{
 const f=await fixture();try{
  const body={request_id:randomUUID(),game_id:f.initial.game_id,expected_revision:0,input:'你好'};
  await f.store.writeInputRecord({version:1,request_id:body.request_id,game_id:body.game_id,started_at:Date.now(),state:'running',fingerprint:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
  const interrupted=await (await f.status(body.request_id)).json();expect(interrupted).toMatchObject({state:'unknown',reason:'server_interrupted'});
  expect((await f.post(body)).status).toBe(409);expect(f.ai.metrics.requests).toBe(0);
  const missing=await f.status(randomUUID());expect(missing.status).toBe(404);expect((await missing.json()).state).toBe('unknown');
  const corrupt=randomUUID(),folder=join(f.directory,'input-requests',body.game_id);await mkdir(folder,{recursive:true});await writeFile(join(folder,corrupt+'.json'),'{bad');
  expect((await f.status(corrupt)).status).toBeGreaterThanOrEqual(400);
  expect(await f.store.read()).toEqual(f.initial);
 }finally{await f.close();}
});

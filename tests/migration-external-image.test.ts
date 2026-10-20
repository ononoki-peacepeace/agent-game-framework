import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rename,rm,readdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {sparseSetup} from './sparse-fixture.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {newSave} from '../src/core/state.js';

afterEach(()=>vi.restoreAllMocks());
async function replaceRaw(directory:string,body:string){
 const temporary=join(directory,'external-'+randomUUID()+'.tmp');await writeFile(temporary,body);await rename(temporary,join(directory,'current.json'));
}
it.each((['current','view'] as const).flatMap(method=>(['canonical','same_revision','new_game'] as const).map(replacement=>({method,replacement}))))(
 'preserves an external $replacement image replaced before $method migration compare',async({method,replacement})=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-external-migration-'));
 let release=()=>{};let reading:Promise<unknown>|undefined;
 try{
  const store=new JsonStore(directory);await store.write(legacy);const service=new GameService(store,f.ai,legacy.definition);
  let arrive!:()=>void;const entered=new Promise<void>(r=>{arrive=r;}),gate=new Promise<void>(r=>{release=r;});
  const write=store.writeMigration.bind(store);vi.spyOn(store,'writeMigration').mockImplementationOnce(async(...args)=>{arrive();await gate;return write(...args);});
  reading=service[method]();await entered;
  let next=structuredClone(legacy);
  if(replacement==='canonical'){
   await f.service.agentTransaction({game_id:legacy.game_id,expected_revision:legacy.state_revision,request_id:randomUUID()},
    {external_fixture:true},save=>{save.gm_state.flags.external_retained=true;});next=await f.service.current();
  }else if(replacement==='new_game')next=newSave(legacy.definition);
  else next.gm_state.flags.external_retained=true;
  await replaceRaw(directory,JSON.stringify(next,null,2));release();await reading;
  const after=(await store.read())!;expect(after).toMatchObject(next);expect(after.game_id).toBe(next.game_id);
  if(replacement==='canonical')expect(after).toEqual(next);
  else expect(after.routine_meta).toBeDefined();
  expect(f.ai.metrics.requests).toBe(0);
 }finally{release();await reading?.catch(()=>undefined);await rm(directory,{recursive:true,force:true});}
});
it.each(['state','input'] as const)('classifies externally corrupted saved JSON as server failure on %s without a replay',async route=>{
 const f=await sparseSetup(),initial=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-corrupt-save-http-'));
 let server:Server|undefined;
 try{
  const store=new JsonStore(directory);await store.write(initial);const service=new GameService(store,f.ai,initial.definition);
  server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const token=(await(await fetch(base+'/api/session',{headers:{connection:'close'}})).json() as {token:string}).token;
  const broken='{external replacement incomplete';await replaceRaw(directory,broken);
  const body={game_id:initial.game_id,expected_revision:initial.state_revision,request_id:randomUUID(),input:'等一分钟'};
  const response=route==='state'?await fetch(base+'/api/state',{headers:{connection:'close'}}):await fetch(base+'/api/input',{
   method:'POST',headers:{connection:'close','content-type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
  const result=await response.json();
  expect(await readFile(join(directory,'current.json'),'utf8')).toBe(broken);expect(f.ai.metrics.requests).toBe(0);
  if(route==='state')expect(await readdir(directory)).not.toContain('input-requests');
  else expect(await store.readInputRecord(initial.game_id,body.request_id)).toMatchObject({state:'failed'});
  expect(response.status,JSON.stringify(result)).toBe(503);
  if(route==='input'){
   expect(result.outcome).toMatchObject({type:'engine_failure',state_certain:false});expect(result.retry_policy).toBe('do_not_replay');
   expect(await store.readInputRecord(initial.game_id,body.request_id)).toMatchObject({state:'failed',http_status:503});
   server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));
   const restarted=new GameService(new JsonStore(directory),f.ai,initial.definition);
   server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
   const restored='http://127.0.0.1:'+(server.address() as {port:number}).port;
   const newToken=(await(await fetch(restored+'/api/session',{headers:{connection:'close'}})).json() as {token:string}).token;
   const replay=await fetch(restored+'/api/input',{method:'POST',headers:{connection:'close','content-type':'application/json','X-Game-Token':newToken},body:JSON.stringify(body)});
   expect(replay.status).toBe(503);expect(await replay.json()).toEqual(result);expect(f.ai.metrics.requests).toBe(0);
   expect(await readFile(join(directory,'current.json'),'utf8')).toBe(broken);
  }
  else expect(result.error).not.toMatch(/JSON.*格式|请求.*格式/);
 }finally{
  if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}
  await rm(directory,{recursive:true,force:true});
 }
});
it.each((['current','view'] as const).flatMap(method=>(['corrupt','missing'] as const).map(replacement=>({method,replacement}))))(
 'stops $method migration on a $replacement external replacement and permits explicit file recovery',async({method,replacement})=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-external-migration-invalid-'));
 let release=()=>{};let reading:Promise<unknown>|undefined;
 try{
  const store=new JsonStore(directory);await store.write(legacy);const service=new GameService(store,f.ai,legacy.definition);
  let arrive!:()=>void;const entered=new Promise<void>(r=>{arrive=r;}),gate=new Promise<void>(r=>{release=r;});
  const write=store.writeMigration.bind(store);vi.spyOn(store,'writeMigration').mockImplementationOnce(async(...args)=>{arrive();await gate;return write(...args);});
  reading=service[method]();await entered;
  if(replacement==='corrupt')await replaceRaw(directory,'{corrupt external image');else await unlink(join(directory,'current.json'));
  const rejected=replacement==='corrupt'?expect(reading).rejects.toBeInstanceOf(SyntaxError):expect(reading).rejects.toMatchObject({status:400});
  release();await rejected;
  if(replacement==='corrupt')expect(await readFile(join(directory,'current.json'),'utf8')).toBe('{corrupt external image');
  else await expect(readFile(join(directory,'current.json'))).rejects.toMatchObject({code:'ENOENT'});
  await replaceRaw(directory,JSON.stringify(legacy));await service[method]();
  const recovered=(await store.read())!;expect(recovered).toMatchObject(legacy);expect(recovered.routine_meta).toBeDefined();
  expect(recovered.runtime).toEqual(legacy.runtime);expect(recovered.state_revision).toBe(legacy.state_revision);expect(f.ai.metrics.requests).toBe(0);
 }finally{release();await reading?.catch(()=>undefined);await rm(directory,{recursive:true,force:true});}
});

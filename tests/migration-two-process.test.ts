import {afterEach,expect,it,vi} from 'vitest';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {SavePackage} from '../src/core/schema.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import * as atomic from '../src/storage/atomic-json.js';
import {sparseSetup} from './sparse-fixture.js';

type Notice={kind:string;save?:SavePackage;calls?:number};
function launch(directory:string,mode:string,method='current'){
 const child=fork(resolve('tests/fixtures/migration-write-worker.ts'),[directory,mode,method],{
  execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
  env:{...process.env,AI_ADAPTER:'mock',GAME_DATA_DIR:directory,GAME_LOG_DIR:join(directory,'logs')},
 });
 const notices:Notice[]=[],listeners=new Set<()=>void>();let failure:Error|undefined,stderr='';
 child.stderr!.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-5000);});
 child.on('message',value=>{notices.push(value as Notice);for(const notify of listeners)notify();});
 child.on('error',error=>{failure=error;for(const notify of listeners)notify();});
 child.on('exit',(code,signal)=>{failure=Error(`Worker exited ${code}/${signal}: ${stderr}`);for(const notify of listeners)notify();});
 const wait=(kind:string)=>new Promise<Notice>((done,reject)=>{
  const finish=()=>{const notice=notices.find(n=>n.kind===kind);if(!notice&&!failure)return;
   clearTimeout(timer);listeners.delete(finish);if(notice)done(notice);else reject(failure);};
  const timer=setTimeout(()=>{listeners.delete(finish);reject(Error(`Worker timeout ${kind}: ${stderr}`));},15000);
  listeners.add(finish);finish();
 });
 return {child,wait,notices};
}
async function reap(child:ChildProcess|undefined){
 if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
}
async function killAtBoundary(child:ChildProcess){
 expect(child.exitCode).toBeNull();expect(child.signalCode).toBeNull();
 const exited=once(child,'exit');expect(child.kill('SIGKILL')).toBe(true);await exited;
}
afterEach(()=>vi.restoreAllMocks());
it.each((['current','view'] as const).flatMap(method=>(['canonical','media','same_revision'] as const).map(writer=>({method,writer}))))(
 'keeps independent-service $writer identity across delayed $method migration',async({method,writer})=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-process-before-compare-'));let worker:ReturnType<typeof launch>|undefined;
 let release=()=>{};let pending:Promise<unknown>|undefined;
 try{
  const store=new JsonStore(directory);await store.write(legacy);worker=launch(directory,writer);await worker.wait('ready');
  const service=new GameService(store,f.ai,legacy.definition);
  let arrive!:()=>void;const entered=new Promise<void>(r=>{arrive=r;}),gate=new Promise<void>(r=>{release=r;});
  const write=store.writeMigration.bind(store);vi.spyOn(store,'writeMigration').mockImplementationOnce(async(...args)=>{arrive();await gate;return write(...args);});
  pending=service[method]();await entered;worker.child.send({kind:'go'});
  const done=await worker.wait('done');expect(done.calls).toBe(0);release();await pending;
  const after=(await new JsonStore(directory).read())!;
  if(writer==='same_revision'){expect(after).toMatchObject(done.save!);expect(after.routine_meta).toBeDefined();}
  else expect(after).toEqual(done.save);
  if(writer==='canonical'){
   expect(done.save!.gm_state.flags.other_process_retained).toBe(true);
   expect(done.save!.runtime.receipts).toHaveLength(legacy.runtime.receipts.length+1);
  }else if(writer==='media')expect(done.save!.entities.find(e=>e.id==='player')!.components.visual_assets.images).toMatchObject({fullbody:'process_migration_asset'});
  else expect(done.save!.gm_state.flags.other_process_retained).toBe(true);
  expect(f.ai.metrics.requests).toBe(0);
 }finally{release();await pending?.catch(()=>undefined);await reap(worker?.child);await rm(directory,{recursive:true,force:true});}
},30000);
it.each((['current','view'] as const).flatMap(method=>(['before','after'] as const).map(boundary=>({method,boundary}))))(
 'releases independent-process migration on SIGKILL $boundary replacement for $method',async({method,boundary})=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-process-migration-kill-'));let worker:ReturnType<typeof launch>|undefined;
 try{
  const store=new JsonStore(directory);await store.write(legacy);worker=launch(directory,'kill_'+boundary,method);await worker.wait('ready');
  worker.child.send({kind:'go'});await worker.wait('boundary');await killAtBoundary(worker.child);
  const after=(await new JsonStore(directory).read())!,stripped=structuredClone(after);delete stripped.routine_meta;
  expect(stripped).toEqual(legacy);expect(Boolean(after.routine_meta)).toBe(boundary==='after');
  const service=new GameService(new JsonStore(directory),f.ai,legacy.definition),request={game_id:legacy.game_id,expected_revision:legacy.state_revision,request_id:randomUUID()};
  let calls=0;const mutate=(save:SavePackage)=>{calls++;save.gm_state.flags.after_kill_retained=true;};
  await service.agentTransaction(request,{after_kill:true},mutate);const saved=(await store.read())!;
  await new GameService(new JsonStore(directory),f.ai,legacy.definition).agentTransaction(request,{after_kill:true},mutate);
  expect(calls).toBe(1);expect(saved.gm_state.flags.after_kill_retained).toBe(true);expect(await store.read()).toEqual(saved);
  expect(saved.runtime.receipts.filter(r=>r.id===request.request_id)).toHaveLength(1);expect(f.ai.metrics.requests).toBe(0);
 }finally{await reap(worker?.child);await rm(directory,{recursive:true,force:true});}
},30000);
it.each((['current','view'] as const).flatMap(method=>(['canonical','media','image','same_revision'] as const).map(writer=>({method,writer}))))(
 'serializes independent $writer writer after $method migration comparison',async({method,writer})=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-process-after-compare-'));let worker:ReturnType<typeof launch>|undefined;
 let release=()=>{};let pending:Promise<unknown>|undefined;
 try{
  const store=new JsonStore(directory);await store.write(legacy);worker=launch(directory,writer);await worker.wait('ready');
  const service=new GameService(store,f.ai,legacy.definition),replace=atomic.replaceWithBoundedRetry;
  let arrive!:()=>void;const entered=new Promise<void>(r=>{arrive=r;}),gate=new Promise<void>(r=>{release=r;});
  vi.spyOn(atomic,'replaceWithBoundedRetry').mockImplementationOnce(async(...args)=>{arrive();await gate;return replace(...args);});
  pending=service[method]();await entered;worker.child.send({kind:'go'});
  // Owned canonical/media mutations fold normalization into their final write.
  await worker.wait('write_attempt');
  await new Promise(r=>setTimeout(r,150));const completedWhileOwned=worker.notices.some(n=>n.kind==='done');
  release();await pending;const done=await worker.wait('done');
  expect(await new JsonStore(directory).read()).toEqual(done.save);
  if(writer==='media')expect(done.save!.entities.find(e=>e.id==='player')!.components.visual_assets.images).toMatchObject({fullbody:'process_migration_asset'});
  else expect(done.save!.gm_state.flags.other_process_retained).toBe(true);
  if(writer==='canonical')expect(done.save!.runtime.receipts).toHaveLength(legacy.runtime.receipts.length+1);
  expect(completedWhileOwned).toBe(false);expect(done.calls).toBe(0);expect(f.ai.metrics.requests).toBe(0);
 }finally{release();await pending?.catch(()=>undefined);await reap(worker?.child);await rm(directory,{recursive:true,force:true});}
},30000);
it('times out a competing process write without replacing authority and permits retry after SIGKILL',async()=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-process-write-timeout-'));let worker:ReturnType<typeof launch>|undefined;
 try{
  const store=new JsonStore(directory);await store.write(legacy);worker=launch(directory,'kill_before');await worker.wait('ready');
  worker.child.send({kind:'go'});await worker.wait('boundary');
  const next=structuredClone(legacy);next.gm_state.flags.after_timeout=true;
  await expect(store.write(next)).rejects.toMatchObject({code:'CURRENT_WRITE_BUSY'});expect(await store.read()).toEqual(legacy);
  await killAtBoundary(worker.child);await store.write(next);expect(await new JsonStore(directory).read()).toEqual(next);
 }finally{await reap(worker?.child);await rm(directory,{recursive:true,force:true});}
},30000);

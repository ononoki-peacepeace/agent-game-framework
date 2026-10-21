import {fork,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {expect,it} from 'vitest';
import {fresh} from './helpers.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import type {DevelopmentTask} from '../src/extensions/tasks.js';

function start(directory:string,mode:string,boundary:string,nonce:string,requestId:string){
 const child=fork(resolve('tests/fixtures/development-kill-worker.ts'),[directory,mode,boundary,nonce,requestId],{
  execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
  env:{...process.env,AI_ADAPTER:'mock',GAME_DATA_DIR:join(directory,'save'),GAME_LOG_DIR:join(directory,'logs')},
 });let stderr='';child.stderr!.on('data',data=>{stderr=(stderr+String(data)).slice(-6000);});
 const messages=new Map<string,Record<string,any>>(),waiting=new Map<string,(value:Record<string,any>)=>void>();
 child.on('message',value=>{const data=value as Record<string,any>;messages.set(data.kind,data);waiting.get(data.kind)?.(data);});
 const wait=(kind:string)=>messages.has(kind)?Promise.resolve(messages.get(kind)!):new Promise<Record<string,any>>((resolveMessage,reject)=>{
  const timer=setTimeout(()=>reject(Error('Worker timeout '+kind+' '+stderr)),30000);
  waiting.set(kind,value=>{clearTimeout(timer);resolveMessage(value);});
  child.once('exit',(code,signal)=>{if(!messages.has(kind)){clearTimeout(timer);reject(Error(`Worker exited ${code}/${signal}: ${stderr}`));}});
 });
 const exit=once(child,'exit');return {child,wait,exit};
}
it.each(['package','framework_build'] as const)('actual owned %s process kill preserves failure identity across independent task workers',async boundary=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-development-kill-')),nonce=randomUUID(),requestId=randomUUID(),store=new JsonStore(join(directory,'save'));
 const initial=fresh();await store.write(initial);
 await new GameService(store,new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected fixture Provider');}}),initial.definition).current();
 const before=await readFile(join(directory,'save','current.json'));let worker:ReturnType<typeof start>|undefined;
 try{
  worker=start(directory,'run',boundary,nonce,requestId);const ready=await worker.wait('tool_ready');
  expect(ready).toMatchObject({stage:boundary,nonce});expect(ready.pid).toBeGreaterThan(0);
  if(boundary==='framework_build')expect(ready.inner_pid).toBeGreaterThan(0);
  worker.child.send({kind:'kill',nonce});const terminal=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  const failed=terminal.task as DevelopmentTask;expect(failed.status).toBe('failed');expect(failed.installed_version).toBeNull();
  expect(failed.test_results.at(-1)).toMatchObject({milestone:boundary,passed:false});expect(failed.capability_artifacts).toEqual([]);
  expect(terminal).toMatchObject({registered:false,provider_calls:0,calls:boundary==='package'?1:2});
  expect(terminal.tool_exit.code!==null||terminal.tool_exit.signal!==null).toBe(true);
  if(boundary==='package')expect(terminal.tool_exit.signal).toBe('SIGKILL');
  else{expect(terminal.tool_exit.code).toBe(79);expect(failed.history.at(-1)!.detail).toContain('OWNED_INNER_EXIT');}
  const patch=await readFile(join(failed.workspace,'capability-package.json')),
   journal=await readFile(join(directory,'development','tasks.json'));
  worker=start(directory,'recover',boundary,nonce,requestId);const restored=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  expect(restored).toMatchObject({calls:0,registered:false,provider_calls:0});expect(restored.task).toEqual(failed);
  expect(await readFile(join(failed.workspace,'capability-package.json'))).toEqual(patch);
  expect(await readFile(join(directory,'development','tasks.json'))).toEqual(journal);expect(await readFile(join(directory,'save','current.json'))).toEqual(before);
 }finally{
  if(worker&&worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill('SIGKILL');await worker.exit;}
  await rm(directory,{recursive:true,force:true});
 }
},60000);

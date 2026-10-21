import {fork,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
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
it('actual full-project TypeScript compiler kill preserves the build failure across independent workers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-typescript-process-kill-')),nonce=randomUUID(),requestId=randomUUID(),
  store=new JsonStore(join(directory,'save')),initial=fresh();
 await store.write(initial);await new GameService(store,new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected Provider');}}),initial.definition).current();
 const before=await readFile(join(directory,'save','current.json'));let worker:ReturnType<typeof start>|undefined;
 try{
  worker=start(directory,'run','typescript',nonce,requestId);const ready=await worker.wait('tool_ready');
  expect(ready).toMatchObject({stage:'typescript',nonce,compiler:resolve('node_modules/typescript/lib/tsc.js'),project:resolve('tsconfig.json')});
  expect(ready.pid).toBeGreaterThan(0);worker.child.send({kind:'kill',nonce});
  const terminal=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  const failed=terminal.task as DevelopmentTask;
  expect(failed.status).toBe('failed');expect(failed.installed_version).toBeNull();expect(failed.capability_artifacts).toEqual([]);
  expect(failed.test_results.at(-1)).toMatchObject({milestone:'framework_build',passed:false});
  expect(failed.history.at(-1)!.detail).toContain('Starting compilation in watch mode');
  expect(terminal).toMatchObject({registered:false,provider_calls:0,calls:2,tool_exit:{signal:'SIGKILL'}});
  const patch=await readFile(join(failed.workspace,'capability-package.json')),journal=await readFile(join(directory,'development','tasks.json'));
  worker=start(directory,'recover','typescript',nonce,requestId);const restored=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  expect(restored).toMatchObject({calls:0,registered:false,provider_calls:0});expect(restored.task).toEqual(failed);
  expect(await readFile(join(failed.workspace,'capability-package.json'))).toEqual(patch);
  expect(await readFile(join(directory,'development','tasks.json'))).toEqual(journal);expect(await readFile(join(directory,'save','current.json'))).toEqual(before);
 }finally{
  if(worker&&worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill('SIGKILL');await worker.exit;}
  await rm(directory,{recursive:true,force:true});
 }
},60000);
it.each(['core_install','runtime_build'] as const)('actual owned %s kill leaves a durable stopped installation across independent workers',async boundary=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-install-process-kill-')),repository=join(directory,'repository'),workspace=join(directory,'candidate'),
  nonce=randomUUID(),requestId=randomUUID(),exec=promisify(execFile);
 const git=async(args:string[])=>(await exec('git',args,{cwd:repository,windowsHide:true})).stdout.trim();
 let worker:ReturnType<typeof start>|undefined;
 try{
  await mkdir(join(repository,'src'),{recursive:true});await mkdir(workspace);
  const source=join(repository,'src','runtime.ts');await writeFile(source,'export const fixture = false;\n');
  await git(['init']);await git(['config','core.autocrlf','false']);await git(['add','.']);
  await git(['-c','user.name=fixture','-c','user.email=fixture@local.invalid','commit','-m','base']);const base=await git(['rev-parse','HEAD']);
  await writeFile(source,'export const fixture = true;\n');const patch=await git(['diff','--binary','HEAD']);await writeFile(source,'export const fixture = false;\n');
  const patchPath=join(workspace,'candidate.patch');await writeFile(patchPath,patch+'\n');
  await writeFile(join(directory,'core-report.json'),JSON.stringify({status:'candidate_ready',provider:'offline-fixture',workspace,base_revision:base,changed_files:['src/runtime.ts'],commands:[],
   patch_path:patchPath,tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'fixture'}));
  const store=new JsonStore(join(directory,'save')),initial=fresh();await store.write(initial);
  await new GameService(store,new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected Provider');}}),initial.definition).current();
  const before=await readFile(join(directory,'save','current.json'));
  worker=start(directory,'run',boundary,nonce,requestId);const ready=await worker.wait('tool_ready');expect(ready).toMatchObject({stage:boundary,nonce});
  worker.child.send({kind:'kill',nonce});const terminal=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  const failed=terminal.task as DevelopmentTask;expect(failed.status).toBe('failed');expect(failed.core_execution?.registered).toBe(false);
  expect(failed.core_install?.error).toContain(boundary==='core_install'?'[install_build]':'[runtime_build]');
  expect(failed.core_install?.stage).toBe(boundary==='core_install'?'install_failed':'rolled_back');
  expect(terminal).toMatchObject({registered:false,provider_calls:0,calls:boundary==='core_install'?1:2});
  expect(await readFile(source,'utf8')).toContain(boundary==='core_install'?'true':'false');
  const head=await git(['rev-parse','HEAD']),index=await git(['diff','--cached','--binary']),bytes=await readFile(source),
   journal=await readFile(join(directory,'development','tasks.json')),patchBytes=await readFile(patchPath);
  if(boundary==='core_install')expect(head).toBe(base);else expect(head).not.toBe(base);
  worker=start(directory,'recover',boundary,nonce,requestId);const restored=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  expect(restored).toMatchObject({calls:0,registered:false,provider_calls:0});expect(restored.task).toEqual(failed);
  expect(await git(['rev-parse','HEAD'])).toBe(head);expect(await git(['diff','--cached','--binary'])).toBe(index);
  expect(await readFile(source)).toEqual(bytes);expect(await readFile(patchPath)).toEqual(patchBytes);
  expect(await readFile(join(directory,'development','tasks.json'))).toEqual(journal);expect(await readFile(join(directory,'save','current.json'))).toEqual(before);
 }finally{
  if(worker&&worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill('SIGKILL');await worker.exit;}
  await rm(directory,{recursive:true,force:true});
 }
},60000);

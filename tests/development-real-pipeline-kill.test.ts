import {execFile,fork} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdtemp,mkdir,readFile,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {fresh} from './helpers.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import type {DevelopmentTask} from '../src/extensions/tasks.js';

const exec=promisify(execFile);
const delay=(ms:number)=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
function start(directory:string,mode:string,boundary:string,nonce:string,requestId:string){
 const child=fork(resolve('tests/fixtures/development-kill-worker.ts'),[directory,mode,boundary,nonce,requestId],{
  execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
  env:{...process.env,AI_ADAPTER:'mock',GAME_DATA_DIR:join(directory,'save'),GAME_LOG_DIR:join(directory,'logs')},
 });let stderr='';child.stderr!.on('data',data=>{stderr=(stderr+String(data)).slice(-6000);});
 const messages=new Map<string,Record<string,any>>();child.on('message',value=>{const data=value as Record<string,any>;messages.set(data.kind,data);});
 const exit=once(child,'exit');
 const wait=async(kind:string)=>{
  const deadline=Date.now()+105000;
  while(!messages.has(kind)){
   if(child.exitCode!==null||child.signalCode!==null)throw Error(`Worker ended before ${kind}: ${stderr}`);
   if(Date.now()>deadline)throw Error(`Worker timeout ${kind}: ${stderr}`);
   await delay(30);
  }return messages.get(kind)!;
 };
 return {child,wait,exit};
}
function exists(pid:number){try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}}
async function ownedPids(directory:string,nonce:string){
 const raw=await readFile(join(directory,'owned-node-processes.ndjson'),'utf8').catch(error=>{
  if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;
 });
 const lines=raw.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
 expect(lines.every(line=>line.nonce===nonce&&Number.isInteger(line.pid)&&line.pid>0)).toBe(true);
 return [...new Set<number>(lines.map(line=>line.pid))];
}
async function awaitExited(pids:number[]){
 const deadline=Date.now()+8000;
 while(pids.some(exists)&&Date.now()<deadline)await delay(40);
 expect(pids.filter(exists)).toEqual([]);
}
async function prepareBuild(repository:string,directory:string,nonce:string){
 const {stdout}=await exec('git',['ls-files','--cached','--others','--exclude-standard','--','src','tests','scripts','public',
  'content','index.html','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts'],{cwd:resolve('.'),windowsHide:true});
 const files=[];
 for(const path of [...new Set(stdout.trim().split(/\r?\n/))]){
  if(!path||path.split('/').includes('..'))throw Error('Unsafe build input');
  const destination=join(repository,path);await mkdir(dirname(destination),{recursive:true});await copyFile(resolve(path),destination);
  files.push({path,sha256:createHash('sha256').update(await readFile(destination)).digest('hex')});
 }
 await writeFile(resolve('.agent-runtime/codex',`real-pipeline-inputs-${nonce}.json`),JSON.stringify({nonce,files},null,2));
 await symlink(resolve('node_modules'),join(repository,'node_modules'),'junction');
 await writeFile(join(repository,'.gitignore'),'node_modules/\ndist/\n');
 const configPath=join(repository,'vite.config.ts'),config=await readFile(configPath,'utf8');
 if(!config.includes('plugins: [react()],'))throw Error('Unexpected Vite config: instrument explicitly');
 const instrument=`{name:'agf-owned-kill-boundary',async buildStart(){
 console.log('AGF_VITE_READY '+JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,stage:'vite_build_start'}));
 await new Promise<void>((_resolve,reject)=>{const timer=setInterval(()=>{void agfRead(${JSON.stringify(join(directory,'kill-vite'))},'utf8').then(value=>{
 if(value===${JSON.stringify(nonce)})process.kill(process.pid,'SIGKILL');}).catch(()=>{});},40);
 setTimeout(()=>{clearInterval(timer);reject(Error('Owned Vite boundary expired'));},90000);});}}`;
 const instrumented="import {readFile as agfRead} from 'node:fs/promises';\n"+config.replace('plugins: [react()],',`plugins: [react(),${instrument}],`);
 await writeFile(configPath,instrumented);
 await writeFile(resolve('.agent-runtime/codex',`real-pipeline-vite-${nonce}.ts`),instrumented);
}
it.each(['npm_pipeline','core_pipeline'] as const)('real npm/TypeScript/Vite %s termination preserves durable failure and owned process exit',async boundary=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-real-pipeline-')),core=boundary==='core_pipeline',
  repository=join(directory,core?'repository':'framework'),nonce=randomUUID(),requestId=randomUUID();
 let worker:ReturnType<typeof start>|undefined,ownerPid:number|undefined;
 try{
  await mkdir(repository,{recursive:true});await prepareBuild(repository,directory,nonce);
  const git=async(args:string[])=>(await exec('git',args,{cwd:repository,windowsHide:true})).stdout.trim();
  let base:string|undefined,source:string|undefined;
  if(core){
   source=join(repository,'src','qa_pipeline_marker.ts');await writeFile(source,'export const marker=false;\n');
   await git(['init']);await git(['config','core.autocrlf','false']);await git(['add','.']);
   await git(['-c','user.name=fixture','-c','user.email=fixture@local.invalid','commit','-m','synthetic build base']);base=await git(['rev-parse','HEAD']);
   await writeFile(source,'export const marker=true;\n');const patch=await git(['diff','--binary','HEAD']);await writeFile(source,'export const marker=false;\n');
   const workspace=join(directory,'candidate');await mkdir(workspace);const patchPath=join(workspace,'candidate.patch');await writeFile(patchPath,patch+'\n');
   await writeFile(join(directory,'core-report.json'),JSON.stringify({status:'candidate_ready',provider:'offline-fixture',workspace,base_revision:base,
    changed_files:['src/qa_pipeline_marker.ts'],commands:[],patch_path:patchPath,tests_passed:true,build_passed:true,acceptance_passed:true,
    installed:false,registered:false,restart_required:true,message:'synthetic candidate; real install build is tested below'}));
  }
  const store=new JsonStore(join(directory,'save')),initial=fresh();await store.write(initial);
  await new GameService(store,new AIRuntime({name:'offline',generate:async()=>{throw Error('Unexpected Provider');}}),initial.definition).current();
  const before=await readFile(join(directory,'save','current.json'));
  worker=start(directory,'run',boundary,nonce,requestId);const ready=await worker.wait('tool_ready');ownerPid=ready.owner_pid;
  expect(ready).toMatchObject({stage:boundary,actual_stage:'vite_build_start',nonce});expect(ready.pid).toBeGreaterThan(0);
  expect(ready.command.args.join(' ')).toContain('npm run build');worker.child.send({kind:'kill',nonce});
  const terminal=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  const task=terminal.task as DevelopmentTask;expect(task.status).toBe('failed');expect(terminal).toMatchObject({registered:false,provider_calls:0,calls:core?1:2});
  if(core){
   expect(task.core_install).toMatchObject({stage:'install_failed',installed_revision:null});expect(task.core_install?.error).toContain('[install_build]');
   expect(task.core_install?.error).toContain('AGF_VITE_READY');expect(await git(['rev-parse','HEAD'])).toBe(base);
   expect(await readFile(source!,'utf8')).toContain('true');expect(await git(['diff','--cached','--name-only'])).toBe('src/qa_pipeline_marker.ts');
  }else{
   expect(task.test_results.at(-1)).toMatchObject({milestone:'framework_build',passed:false});
   expect(task.history.at(-1)!.detail).toContain('AGF_VITE_READY');expect(task.installed_version).toBeNull();expect(task.capability_artifacts).toEqual([]);
  }
  const pids=await ownedPids(directory,nonce);expect(pids).toContain(ready.pid);expect(pids.length).toBeGreaterThanOrEqual(3);
  const processes=(await readFile(join(directory,'owned-node-processes.ndjson'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  expect(processes.some(entry=>entry.argv.some((arg:string)=>/typescript[\\/](?:bin|lib)[\\/]tsc/.test(arg))&&entry.argv.includes('--noEmit'))).toBe(true);
  expect(processes.some(entry=>entry.pid===ready.pid&&entry.argv.some((arg:string)=>/[\\/]vite[\\/]bin[\\/]vite/.test(arg)))).toBe(true);
  expect(processes.some(entry=>entry.argv.includes('tsconfig.server.json'))).toBe(false);
  await awaitExited([...pids,ownerPid!]);
  const journal=await readFile(join(directory,'development','tasks.json')),
   artifactPath=core?task.core_install!.patch_path:join(task.workspace,'capability-package.json'),artifact=await readFile(artifactPath),
   index=core?await git(['diff','--cached','--binary']):null;
  worker=start(directory,'recover',boundary,nonce,requestId);const restored=await worker.wait('terminal');expect(await worker.exit).toEqual([0,null]);
  expect(restored).toMatchObject({calls:0,registered:false,provider_calls:0});expect(restored.task).toEqual(task);
  expect(await readFile(artifactPath)).toEqual(artifact);expect(await readFile(join(directory,'development','tasks.json'))).toEqual(journal);
  expect(await readFile(join(directory,'save','current.json'))).toEqual(before);
  if(core){expect(await git(['rev-parse','HEAD'])).toBe(base);expect(await git(['diff','--cached','--binary'])).toBe(index);}
  await writeFile(resolve('.agent-runtime/codex',`real-pipeline-result-${nonce}.json`),JSON.stringify({nonce,boundary,ready,
   task,tool_exit:terminal.tool_exit,calls:terminal.calls,provider_calls:terminal.provider_calls,processes,owned_all_exited:true,
   restarted_calls:restored.calls,restarted_task_identical:true,save_sha256:createHash('sha256').update(before).digest('hex'),
   artifact_sha256:createHash('sha256').update(artifact).digest('hex'),base,index_sha256:index===null?null:createHash('sha256').update(index).digest('hex')},null,2));
 }finally{
  await writeFile(join(directory,'kill-vite'),nonce);
  if(worker&&worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.kill('SIGKILL');await worker.exit;}
  try{await awaitExited([...(await ownedPids(directory,nonce)),...(ownerPid?[ownerPid]:[])]);}catch(error){
   // Preserve all evidence/workspace until bounded descendants end; never delete under a live compiler.
   throw error;
  }
  await unlink(join(repository,'node_modules'));await rm(directory,{recursive:true,force:true});
 }
},150000);

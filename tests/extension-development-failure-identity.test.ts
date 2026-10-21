import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore,fresh} from './helpers.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {ExtensionDevelopment} from '../src/extensions/development.js';

const compiler=vi.hoisted(()=>({error:null as (Error&{code?:number;signal?:string;stdout?:string;stderr?:string})|null,calls:0}));
vi.mock('node:child_process',async original=>{
 const actual=await original<typeof import('node:child_process')>(),{promisify}=await import('node:util');
 const execFile=(...args:unknown[])=>Reflect.apply(actual.execFile,actual,args);
 Reflect.set(execFile,promisify.custom,async(file:string,args:string[],options:import('node:child_process').ExecFileOptions)=>{
  if(args.some(arg=>arg.replaceAll('\\','/').endsWith('/typescript/lib/tsc.js'))){compiler.calls++;if(compiler.error)throw compiler.error;return {stdout:'isolated compiler substitute',stderr:''};}
  return promisify(actual.execFile)(file,args,options);
 });
 return {...actual,execFile};
});
afterEach(()=>{compiler.error=null;compiler.calls=0;vi.restoreAllMocks();});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'agf-development-identity-')),save=fresh(),store=new MemoryStore();await store.write(save);
 const service=new GameService(store,new AIRuntime({name:'offline',generate:async()=>{throw Error('no model calls authorized in fixture');}}),save.definition);
 const before=await service.current(),host=new ExtensionHost(service,directory);await host.ready;
 const workspace=join(directory,'tasks',randomUUID(),'candidate');await mkdir(join(workspace,'..'),{recursive:true});
 const input={request_id:randomUUID(),request:'隔离声明式开发故障身份',template:'declarative',extension_id:'failure_identity',use_codex:false};
 return {directory,service,before,host,workspace,input,dev:new ExtensionDevelopment(host)};
}
it.each(['creating_workspace','writing_files','building'] as const)('retains exact %s failure identity across restart without registration',async stage=>{
 const f=await fixture();try{
  if(stage==='creating_workspace')await writeFile(f.workspace,'occupied by a fixture file');
  else if(stage==='writing_files')await mkdir(join(f.workspace,'extension.json'),{recursive:true});
  else compiler.error=Object.assign(Error('isolated profile compiler failed'),{code:2,signal:'SIGTERM',stdout:'PROFILE_STDOUT_DETAIL',stderr:'PROFILE_STDERR_DETAIL'});
  const job=await f.dev.start(f.input,{workspace:f.workspace,version:'1.0.0'}),failed=await f.dev.wait(job.job_id);
  expect(failed.status).toBe('failed');expect(failed.phase).toBe(stage);
  if(stage==='building'){
   expect(compiler.calls).toBe(1);expect(failed.message).toContain('PROFILE_STDOUT_DETAIL');expect(failed.message).toContain('PROFILE_STDERR_DETAIL');
   expect(failed.message).toContain('exit=2');expect(failed.message).toContain('signal=SIGTERM');
  }else expect(compiler.calls).toBe(0);
  const restored=new ExtensionDevelopment(f.host);await restored.ready;expect(await restored.get()).toEqual(failed);
  expect(await f.service.current()).toEqual(f.before);
  await expect(restored.install(job.job_id,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),confirmed:true})).rejects.toThrow();
  expect(await f.service.current()).toEqual(f.before);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('keeps a passing isolated candidate preview without running a real compiler or installing it',async()=>{
 const f=await fixture();try{
  const job=await f.dev.start(f.input,{workspace:f.workspace,version:'1.0.0'}),ready=await f.dev.wait(job.job_id);
  expect(ready).toMatchObject({status:'ready',phase:'preview'});expect(compiler.calls).toBe(1);
  expect(JSON.parse(await readFile(join(f.workspace,'dist','profile.json'),'utf8')).extension_id).toBe('failure_identity');
  expect(await f.service.current()).toEqual(f.before);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('retains final compiler diagnostics and redacts complete secrets before bounding output tails',async()=>{
 const f=await fixture();try{
  const credential='sk-'+ 'S'.repeat(2400);
  compiler.error=Object.assign(Error('large isolated compiler output'),{code:2,stdout:'UNRELATED_PREFIX'+'X'.repeat(6000)+' '+credential+' FINAL_STDOUT_DIAGNOSTIC',stderr:'Y'.repeat(6000)+' FINAL_STDERR_DIAGNOSTIC'});
  const job=await f.dev.start(f.input,{workspace:f.workspace,version:'1.0.0'}),failed=await f.dev.wait(job.job_id);
  expect(failed.phase).toBe('building');expect(failed.message).toContain('FINAL_STDOUT_DIAGNOSTIC');expect(failed.message).toContain('FINAL_STDERR_DIAGNOSTIC');
  expect(failed.message).not.toContain('S'.repeat(40));expect(failed.message).not.toContain('UNRELATED_PREFIX');expect(failed.message.length).toBeLessThanOrEqual(12000);
  expect(compiler.calls).toBe(1);expect(await f.service.current()).toEqual(f.before);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each(['approval_before','approval_after','world_before','world_after'] as const)('retains %s installation failure identity while reconciling only actual commits',async point=>{
 const f=await fixture();try{
  const job=await f.dev.start(f.input,{workspace:f.workspace,version:'1.0.0'});await f.dev.wait(job.job_id);
  const approve=f.host.approve.bind(f.host),install=f.host.install.bind(f.host);
  const approved=vi.spyOn(f.host,'approve'),installed=vi.spyOn(f.host,'install');
  if(point.startsWith('approval'))approved.mockImplementationOnce(async manifest=>{if(point==='approval_after')await approve(manifest);throw Error(point);});
  else installed.mockImplementationOnce(async(...args)=>{if(point==='world_after')await install(...args);throw Error(point);});
  const tx={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),confirmed:true};
  await expect(f.dev.install(job.job_id,tx)).rejects.toThrow(point);
  const current=await f.service.current(),record=(await f.dev.get())!;
  if(point==='world_after'){
   expect(current.state_revision).toBe(f.before.state_revision+1);expect(current.extensions?.failure_identity.installed).toBe(true);
   expect(record).toMatchObject({status:'installed',phase:'installed'});
  }else expect(current).toEqual(f.before);
  const stage=point.startsWith('approval')?'approving':'installing';
  if(point!=='world_after')expect(record).toMatchObject({status:'failed',phase:stage});
  expect(record.logs.some(line=>line.includes('['+stage+']')&&line.includes(point))).toBe(true);
  const restored=new ExtensionDevelopment(f.host);await restored.ready;
  const durable=(await restored.get())!;expect(durable.status).toBe(record.status);expect(durable.phase).toBe(record.phase);expect(durable.logs).toEqual(record.logs);
  if(point==='world_after')await restored.install(job.job_id,tx);
  else await expect(restored.install(job.job_id,tx)).rejects.toThrow();
  expect(installed).toHaveBeenCalledTimes(point.startsWith('approval')?0:1);expect(approved).toHaveBeenCalledOnce();
  expect(await f.service.current()).toEqual(current);expect(compiler.calls).toBe(1);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

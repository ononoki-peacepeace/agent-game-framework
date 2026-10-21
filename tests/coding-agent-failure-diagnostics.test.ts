import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexCodingAgentExecutor,type CoreDevelopmentRequest} from '../src/development/coding-agent.js';

// Both SDK backend and all commands are local JavaScript substitutes. The only
// filesystem effects are synthetic files/junction inside this test's temp root.
async function fixture(point:string){
 const root=await mkdtemp(join(tmpdir(),'agf-coding-diagnostics-')),repository=join(root,'source'),workspace=join(root,'workspace');
 await mkdir(join(repository,'node_modules'),{recursive:true});
 if(point==='workspace_create')await writeFile(workspace,'occupied fixture file');
 if(point==='patch_write')await mkdir(join(workspace,'candidate.patch'),{recursive:true});
 const backend={startThread:vi.fn((options:{workingDirectory:string})=>({run:vi.fn(async()=>{
  await writeFile(join(options.workingDirectory,'src','capability.ts'),'export const fixtureCapability = true;\n');return {items:[]};
 })}))};
 const run=vi.fn(async(file:string,args:string[])=>{
  if(file==='where.exe'||file==='which')return {stdout:'controlled-backend',stderr:''};
  if(file==='git'){
   if(args[0]==='status'||args[0]==='ls-files'||args[0]==='add')return {stdout:'',stderr:''};
   if(args[0]==='rev-parse')return {stdout:'base',stderr:''};
   if(args[0]==='clone'){
    if(point==='workspace_clone')throw Object.assign(Error('controlled clone failure'),{code:31,stdout:'FINAL_CLONE_STDOUT',stderr:'FINAL_CLONE_STDERR'});
    const candidate=args.at(-1)!;await mkdir(join(candidate,'src'),{recursive:true});
    await writeFile(join(candidate,'package.json'),point==='package_read'?'{':JSON.stringify({scripts:{test:'controlled',build:'controlled'}}));
    if(point==='dependencies')await mkdir(join(candidate,'node_modules'));return {stdout:'',stderr:''};
   }
   if(args[0]==='diff')return {stdout:args.includes('--name-only')?'src/capability.ts\n':args.includes('--check')?'':'controlled patch\n',stderr:''};
   throw Error('Unexpected fake Git operation');
  }
  const stage=args.includes('test')?'test':'build';
  if(point===stage)throw Object.assign(Error('controlled '+stage+' failure'),{code:stage==='test'?17:23,signal:'SIGTERM',stdout:'X'.repeat(3000)+' FINAL_'+stage.toUpperCase()+'_STDOUT',stderr:'Y'.repeat(3000)+' FINAL_'+stage.toUpperCase()+'_STDERR'});
  return {stdout:'controlled gate success',stderr:''};
 });
 type Backend=NonNullable<ConstructorParameters<typeof CodexCodingAgentExecutor>[0]>;
 const executor=new CodexCodingAgentExecutor(backend as unknown as Backend,run);
 const request:CoreDevelopmentRequest={task_id:'controlled-task',repository,workspace,requirement:'Controlled diagnostic fixture',proposal:{problem:'fixture',proposed_api:['fixtureCapability'],impact:['core'],migration:'none',tests:['npm test'],rollback:'discard candidate',risk:'low'},targeted_tests:['npm test'],required_acceptance:[]};
 return {root,repository,workspace,backend,run,executor,request};
}
it.each(['test','build'])('preserves failed %s gate identity, output and exit in the uninstalled candidate report',async point=>{
 const f=await fixture(point);try{
  const report=await f.executor.execute(f.request);
  expect(report).toMatchObject({status:'failed',tests_passed:point==='build',build_passed:false,acceptance_passed:false,installed:false,registered:false});
  expect(report.message).toContain('['+point+']');expect(report.message).toContain('exit='+(point==='test'?17:23));
  expect(report.message).toContain('FINAL_'+point.toUpperCase()+'_STDOUT');expect(report.message).toContain('FINAL_'+point.toUpperCase()+'_STDERR');
  expect(report.commands).toContainEqual({command:point==='test'?'npm test':'npm run build',exit_code:point==='test'?17:23});
  expect(await readFile(report.patch_path!,'utf8')).toContain('controlled patch');expect(f.backend.startThread).toHaveBeenCalledOnce();
  await expect(readFile(join(f.repository,'src','capability.ts'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it.each(['workspace_create','workspace_clone','patch_write','dependencies','package_read'])('labels the original %s filesystem/command failure and stops without launching a real backend',async point=>{
 const f=await fixture(point);try{
  await expect(f.executor.execute(f.request)).rejects.toThrow('['+point+']');
  if(point==='workspace_create'||point==='workspace_clone')expect(f.backend.startThread).not.toHaveBeenCalled();
  else expect(f.backend.startThread).toHaveBeenCalledOnce();
 }finally{await rm(f.root,{recursive:true,force:true});}
});

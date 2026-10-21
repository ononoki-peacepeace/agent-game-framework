import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CoreCandidateInstaller,type CoreInstallRecord} from '../src/development/core-installer.js';
import type {CoreDevelopmentReport} from '../src/development/coding-agent.js';

// Every subprocess command goes to this in-memory Run substitute. No Git,
// compiler, npm, coding agent or production repository is executed or modified.
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'agf-core-diagnostics-')),repository=join(root,'repository'),workspace=join(root,'candidate');
 await mkdir(repository);await mkdir(workspace);const patch=join(workspace,'candidate.patch');await writeFile(patch,'controlled fixture patch bytes');
 const state={applied:false,installed:false,failBuild:true,builds:0};
 const run=vi.fn(async(file:string,args:string[])=>{
  if(file==='git'){
   if(args[0]==='status')return {stdout:state.applied?' M src/runtime.ts\n':'',stderr:''};
   if(args[0]==='rev-parse')return {stdout:state.installed?'installed':'base',stderr:''};
   if(args[0]==='apply'){if(!args.includes('--check'))state.applied=true;return {stdout:'',stderr:''};}
   if(args.includes('commit')){state.installed=true;state.applied=false;return {stdout:'',stderr:''};}
   if(args[0]==='reset'){state.applied=false;return {stdout:'',stderr:''};}
   throw Error('Unexpected fake Git operation '+args.join(' '));
  }
  expect(file==='npm'||args.includes('npm run build')).toBe(true);state.builds++;
  if(state.failBuild)throw Object.assign(Error('controlled candidate build failure'),{code:2,signal:'SIGTERM',
   stdout:'X'.repeat(2000)+' FINAL_CORE_STDOUT',stderr:'sk-privatecredential '+ 'Y'.repeat(2000)+' FINAL_CORE_STDERR'});
  return {stdout:'controlled build success',stderr:''};
 });
 const report:CoreDevelopmentReport={status:'candidate_ready',provider:'controlled-offline',workspace,base_revision:'base',changed_files:['src/runtime.ts'],commands:[],
  patch_path:patch,tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'fixture candidate'};
 return {root,repository,patch,state,run,report};
}
it('retains install build stage, exit and output tails while retaining the existing base restoration',async()=>{
 const f=await fixture();try{
  const installer=new CoreCandidateInstaller(f.repository,f.run,'first-boot');
  const failure=await installer.install('fixture-task',f.report).then(()=>{throw Error('expected controlled build failure');},error=>error as Error&{install_record:CoreInstallRecord});
  expect(failure).toBeInstanceOf(Error);const record=failure.install_record;
  expect(record.stage).toBe('install_failed');expect(f.state).toMatchObject({applied:false,installed:false,builds:1});
  expect(record.error).toContain('[install_build]');expect(record.error).toContain('exit=2');expect(record.error).toContain('signal=SIGTERM');
  expect(record.error).toContain('FINAL_CORE_STDOUT');expect(record.error).toContain('FINAL_CORE_STDERR');expect(record.error).not.toContain('sk-privatecredential');
  expect(record.error!.length).toBeLessThanOrEqual(1500);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('retains runtime-validation diagnostics without claiming registration and clears them only after a valid retry',async()=>{
 const f=await fixture();try{
  f.state.installed=true;
  const record:CoreInstallRecord={stage:'installed_pending_reload',candidate_id:'candidate',task_id:'fixture-task',base_revision:'base',installed_revision:'installed',rollback_revision:null,
   patch_path:f.patch,patch_sha256:'0'.repeat(64),changed_files:['src/runtime.ts'],installed_by_boot_id:'old-boot',installed_at:null,validated_at:null,error:null};
  const installer=new CoreCandidateInstaller(f.repository,f.run,'new-boot');
  await expect(installer.validateReload(record)).rejects.toThrow();
  expect(record.stage).toBe('validating_runtime');expect(record.validated_at).toBeNull();
  expect(record.error).toContain('[runtime_build]');expect(record.error).toContain('exit=2');expect(record.error).toContain('FINAL_CORE_STDERR');
  expect(f.run.mock.calls.filter(([file,args])=>file==='git'&&(args.includes('commit')||args[0]==='apply'||args[0]==='reset'))).toEqual([]);
  f.state.failBuild=false;expect(await installer.validateReload(record)).toEqual({ready:true,reason:null});
  expect(record.stage).toBe('registered');expect(record.error).toBeNull();expect(record.validated_at).toBeTruthy();expect(f.state.builds).toBe(2);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

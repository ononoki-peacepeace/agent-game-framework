import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';
import {CoreCandidateInstaller,type CoreInstallRecord} from '../src/development/core-installer.js';
import type {CoreDevelopmentReport} from '../src/development/coding-agent.js';

const exec=promisify(execFile);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'agf-install-protection-')),repository=join(root,'repository'),workspace=join(root,'candidate');
 await mkdir(join(repository,'src'),{recursive:true});await mkdir(workspace);
 const original='export const capability = false;\n',candidate='export const capability = true;\n';
 await writeFile(join(repository,'src','runtime.ts'),original);
 await writeFile(join(repository,'src','other.ts'),'export const other = false;\n');
 const git=async(args:string[])=>(await exec('git',args,{cwd:repository,windowsHide:true})).stdout;
 await git(['init']);await git(['config','core.autocrlf','false']);await git(['add','.']);await git(['-c','user.name=fixture','-c','user.email=fixture@local.invalid','commit','-m','base']);
 const base=(await git(['rev-parse','HEAD'])).trim();
 await writeFile(join(repository,'src','runtime.ts'),candidate);
 const patch=await git(['diff','--binary','HEAD']);await writeFile(join(repository,'src','runtime.ts'),original);
 const patchPath=join(workspace,'candidate.patch');await writeFile(patchPath,patch);
 const report:CoreDevelopmentReport={status:'candidate_ready',provider:'offline-fixture',workspace,base_revision:base,changed_files:['src/runtime.ts'],
  commands:[],patch_path:patchPath,tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'fixture'};
 return {root,repository,git,base,report,candidate};
}
it.each(['unstaged','staged'] as const)('preserves existing tracked %s bytes and index when refusing installation',async mode=>{
 const f=await fixture();try{
  await writeFile(join(f.repository,'src','runtime.ts'),'// existing human change\n');
  if(mode==='staged')await f.git(['add','src/runtime.ts']);
  const before={bytes:await readFile(join(f.repository,'src','runtime.ts')),status:await f.git(['status','--porcelain']),index:await f.git(['diff','--cached','--binary'])};
  await expect(new CoreCandidateInstaller(f.repository).install('task',f.report)).rejects.toThrow('UNOWNED_DIRTY_WORKTREE');
  expect(await readFile(join(f.repository,'src','runtime.ts'))).toEqual(before.bytes);
  expect(await f.git(['status','--porcelain'])).toBe(before.status);expect(await f.git(['diff','--cached','--binary'])).toBe(before.index);
  expect((await f.git(['rev-parse','HEAD'])).trim()).toBe(f.base);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it.each(['candidate_path','other_path','index','none'] as const)('preserves external %s writes made after candidate apply and before a failed build',async point=>{
 const f=await fixture();let captured:{runtime:Buffer;other:Buffer;status:string;index:string}|undefined;
 try{
  const run=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>{
   if(file==='git')return exec(file,args,{cwd,signal,windowsHide:true});
   const path=point==='other_path'?'other.ts':'runtime.ts';
   if(point!=='none')await writeFile(join(f.repository,'src',path),'// external write after candidate apply\n');
   if(point==='index')await f.git(['add','src/runtime.ts']);
   captured={runtime:await readFile(join(f.repository,'src','runtime.ts')),other:await readFile(join(f.repository,'src','other.ts')),
    status:await f.git(['status','--porcelain']),index:await f.git(['diff','--cached','--binary'])};
   throw Object.assign(Error('controlled build failure'),{code:2,stderr:'FINAL_PROTECTION_BUILD_ERROR'});
  };
  const failure=await new CoreCandidateInstaller(f.repository,run).install('task',f.report).then(()=>{throw Error('expected failure');},error=>error as Error&{install_record:CoreInstallRecord});
  expect(failure.install_record.stage).toBe('install_failed');expect(failure.message).toContain('FINAL_PROTECTION_BUILD_ERROR');expect(captured).toBeDefined();
  expect(await readFile(join(f.repository,'src','runtime.ts'))).toEqual(captured!.runtime);expect(await readFile(join(f.repository,'src','other.ts'))).toEqual(captured!.other);
  expect(await f.git(['status','--porcelain'])).toBe(captured!.status);expect(await f.git(['diff','--cached','--binary'])).toBe(captured!.index);
  expect((await f.git(['rev-parse','HEAD'])).trim()).toBe(f.base);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('preserves an actual install commit when its command response is lost',async()=>{
 const f=await fixture();let installed='';try{
  const run=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>{
   if(file!=='git')return {stdout:'controlled build success',stderr:''};
   const result=await exec(file,args,{cwd,signal,windowsHide:true});
   if(args[0]==='update-ref'){installed=(await f.git(['rev-parse','HEAD'])).trim();throw Error('commit response lost');}
   return result;
  };
  await expect(new CoreCandidateInstaller(f.repository,run).install('task',f.report)).rejects.toThrow('[install_head]');
  expect(installed).not.toBe(f.base);expect((await f.git(['rev-parse','HEAD'])).trim()).toBe(installed);
  expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toBe(f.candidate);expect((await f.git(['status','--porcelain'])).trim()).toBe('');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it.each(['worktree','index','head'] as const)('stops before commit if a passing build changes the external %s',async point=>{
 const f=await fixture();let headAfterBuild=f.base,indexAfterBuild='',sourceAfterBuild='';try{
  const run=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>{
   if(file==='git')return exec(file,args,{cwd,signal,windowsHide:true});
   await writeFile(join(f.repository,'src','runtime.ts'),'// external successful build change\n');
   if(point!=='worktree')await f.git(['add','src/runtime.ts']);
   if(point==='head')await f.git(['-c','user.name=external','-c','user.email=external@local.invalid','commit','-m','external writer']);
   headAfterBuild=(await f.git(['rev-parse','HEAD'])).trim();indexAfterBuild=await f.git(['diff','--cached','--binary']);sourceAfterBuild=await readFile(join(f.repository,'src','runtime.ts'),'utf8');
   return {stdout:'controlled successful build',stderr:''};
  };
  await expect(new CoreCandidateInstaller(f.repository,run).install('task',f.report)).rejects.toThrow(/CANDIDATE_OWNERSHIP_CHANGED/);
  expect((await f.git(['rev-parse','HEAD'])).trim()).toBe(headAfterBuild);
  expect(await f.git(['diff','--cached','--binary'])).toBe(indexAfterBuild);expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toBe(sourceAfterBuild);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it.each(['index','head'] as const)('cannot absorb or overwrite an external %s update after the final ownership check',async point=>{
 const f=await fixture();let externalHead=f.base,externalIndex='',externalSource='';try{
  const run=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>{
   if(file!=='git')return {stdout:'controlled build success',stderr:''};
   if(args.includes('commit-tree')){
    await writeFile(join(f.repository,'src','runtime.ts'),'// late external staged source\n');await f.git(['add','src/runtime.ts']);
    if(point==='head')await f.git(['-c','user.name=external','-c','user.email=external@local.invalid','commit','-m','external head']);
    externalHead=(await f.git(['rev-parse','HEAD'])).trim();externalIndex=await f.git(['diff','--cached','--binary']);externalSource=await readFile(join(f.repository,'src','runtime.ts'),'utf8');
   }
   return exec(file,args,{cwd,signal,windowsHide:true});
  };
  const installer=new CoreCandidateInstaller(f.repository,run,'before');
  if(point==='head'){
   await expect(installer.install('task',f.report)).rejects.toThrow('[install_head]');
   expect((await f.git(['rev-parse','HEAD'])).trim()).toBe(externalHead);expect(await f.git(['diff','--cached','--binary'])).toBe(externalIndex);
  }else{
   const record=await installer.install('task',f.report);
   expect(await f.git(['show',`${record.installed_revision}:src/runtime.ts`])).toBe(f.candidate);
   expect(await f.git(['show',':src/runtime.ts'])).toBe(externalSource);
   expect((await new CoreCandidateInstaller(f.repository,run,'after').validateReload(record)).ready).toBe(false);
   expect(record.stage).not.toBe('registered');
  }
  expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toBe(externalSource);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('refuses an unowned index replacement before the candidate tree is captured',async()=>{
 const f=await fixture();let source='',index='';try{
  let injected=false;
  const run=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>{
   if(file!=='git')return {stdout:'controlled build',stderr:''};
   if(args[0]==='write-tree'&&!injected){injected=true;await writeFile(join(f.repository,'src','runtime.ts'),'// unowned early staged replacement\n');
    await f.git(['add','src/runtime.ts']);source=await readFile(join(f.repository,'src','runtime.ts'),'utf8');index=await f.git(['diff','--cached','--binary']);}
   return exec(file,args,{cwd,signal,windowsHide:true});
  };
  await expect(new CoreCandidateInstaller(f.repository,run).install('task',f.report)).rejects.toThrow('CANDIDATE_TREE_MISMATCH');
  expect((await f.git(['rev-parse','HEAD'])).trim()).toBe(f.base);expect(await f.git(['diff','--cached','--binary'])).toBe(index);
  expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toBe(source);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

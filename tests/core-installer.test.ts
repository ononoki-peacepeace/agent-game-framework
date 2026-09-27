import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CoreCandidateInstaller } from '../src/development/core-installer.js';
import type { CoreDevelopmentReport } from '../src/development/coding-agent.js';

const exec=promisify(execFile);
async function git(cwd:string,args:string[]){return (await exec('git',args,{cwd,windowsHide:true})).stdout.trim();}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'agf-core-install-')),repository=join(root,'repository'),workspace=join(root,'candidate');
 await mkdir(join(repository,'src'),{recursive:true});await mkdir(workspace,{recursive:true});
 await writeFile(join(repository,'package.json'),JSON.stringify({name:'core-install-fixture',private:true,scripts:{build:'node -e "process.exit(0)"'}},null,2));
 await writeFile(join(repository,'src','runtime.ts'),'export const runtimeValue = "before";\n');
 await git(repository,['init']);await git(repository,['add','.']);await git(repository,['-c','user.name=fixture','-c','user.email=fixture@local.invalid','commit','-m','base']);
 const base=await git(repository,['rev-parse','HEAD']);
 await writeFile(join(repository,'src','runtime.ts'),'export const runtimeValue = "after";\n');
 const patch=await git(repository,['diff','--binary','HEAD']);const patchPath=join(workspace,'candidate.patch');await writeFile(patchPath,patch+'\n');
 await git(repository,['restore','src/runtime.ts']);
 const report:CoreDevelopmentReport={status:'candidate_ready',provider:'fixture',workspace,base_revision:base,changed_files:['src/runtime.ts'],commands:[],patch_path:patchPath,tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'candidate ready'};
 return {root,repository,workspace,base,report};
}
describe('Core candidate install transaction',()=>{
 it('installs a validated candidate as a clean managed commit and validates only after a new boot',async()=>{
  const f=await fixture();try{
   const first=new CoreCandidateInstaller(f.repository,undefined,'boot-a'),record=await first.install('task-fixture',f.report);
   expect(record.stage).toBe('installed_pending_reload');expect(record.installed_revision).not.toBe(f.base);
   expect(await git(f.repository,['status','--porcelain'])).toBe('');
   expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toContain('"after"');
   expect(await first.validateReload(record)).toEqual({ready:false,reason:'Runtime restart is still required.'});
   const second=new CoreCandidateInstaller(f.repository,undefined,'boot-b');
   expect(await second.validateReload(record)).toEqual({ready:true,reason:null});
   expect(record.stage).toBe('registered');
  }finally{await rm(f.root,{recursive:true,force:true});}
 },20_000);
 it('rejects an unowned dirty worktree without modifying source or creating a commit',async()=>{
  const f=await fixture();try{
   await writeFile(join(f.repository,'unowned.txt'),'local change');
   const head=await git(f.repository,['rev-parse','HEAD']);
   await expect(new CoreCandidateInstaller(f.repository,undefined,'boot-a').install('task-fixture',f.report)).rejects.toThrow('UNOWNED_DIRTY_WORKTREE');
   expect(await git(f.repository,['rev-parse','HEAD'])).toBe(head);
   expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toContain('"before"');
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
 it('rolls an installed candidate back as another auditable clean commit',async()=>{
  const f=await fixture();try{
   const installer=new CoreCandidateInstaller(f.repository,undefined,'boot-a'),record=await installer.install('task-fixture',f.report);
   const installed=record.installed_revision;await new CoreCandidateInstaller(f.repository,undefined,'boot-b').rollback(record);
   expect(record.stage).toBe('rolled_back');expect(record.rollback_revision).not.toBe(installed);
   expect(await readFile(join(f.repository,'src','runtime.ts'),'utf8')).toContain('"before"');
   expect(await git(f.repository,['status','--porcelain'])).toBe('');
  }finally{await rm(f.root,{recursive:true,force:true});}
 },20_000);
});

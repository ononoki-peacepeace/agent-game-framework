import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { ExtensionHost } from '../src/extensions/host.js';
import { ExtensionDevelopment } from '../src/extensions/development.js';
import { DevelopmentTasks } from '../src/extensions/tasks.js';
import { CoreCandidateInstaller } from '../src/development/core-installer.js';
import type { CodingAgentExecutor, CoreDevelopmentReport } from '../src/development/coding-agent.js';

const exec=promisify(execFile);
async function git(cwd:string,args:string[]){return (await exec('git',args,{cwd,windowsHide:true})).stdout.trim();}
async function candidateFixture(){
 const root=await mkdtemp(join(tmpdir(),'agf-core-lifecycle-')),repository=join(root,'repository'),workspace=join(root,'candidate');
 await mkdir(join(repository,'src'),{recursive:true});await mkdir(workspace,{recursive:true});
 await writeFile(join(repository,'package.json'),JSON.stringify({name:'core-lifecycle-fixture',private:true,scripts:{build:'node -e "process.exit(0)"'}},null,2));
 await writeFile(join(repository,'src','runtime.ts'),'export const registered = false;\n');
 await git(repository,['init']);await git(repository,['add','.']);await git(repository,['-c','user.name=fixture','-c','user.email=fixture@local.invalid','commit','-m','base']);
 const base=await git(repository,['rev-parse','HEAD']);await writeFile(join(repository,'src','runtime.ts'),'export const registered = true;\n');
 const patch=(await git(repository,['diff','--binary','HEAD']))+'\n',patchPath=join(workspace,'candidate.patch');await writeFile(patchPath,patch);await git(repository,['restore','src/runtime.ts']);
 const report:CoreDevelopmentReport={status:'candidate_ready',provider:'fixture',workspace,base_revision:base,changed_files:['src/runtime.ts'],commands:[],patch_path:patchPath,tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'candidate ready'};
 return {root,repository,report};
}
it('DevelopmentTask survives the core install restart boundary, registers, and invokes the existing resume callback',async()=>{
 const f=await sparseSetup(),developmentDirectory=await mkdtemp(join(tmpdir(),'agf-core-task-')),candidate=await candidateFixture();
 try{
  const host=new ExtensionHost(f.service,developmentDirectory),builder=new ExtensionDevelopment(host);
  const plan={normalized_requirements:['提供一个 fixture runtime capability'],complexity:'HIGH',clarification:null,milestones:[{id:'runtime',title:'实现运行时能力',kind:'integration',acceptance:['能力可注册']},{id:'resume',title:'恢复原目标',kind:'integration',acceptance:['目标继续执行']}],capability_gaps:[{required_capability:'fixture.runtime',why_needed:'测试运行时需要该能力',affected_modules:['core'],current_limitation:'当前运行时未注册',proposed_generic_capability:'可注册的 fixture runtime capability',risk:'启动失败'}],affected_milestone_ids:[]};
  const adapter={name:'core-task-fixture',generate:async()=>({data:plan})};
  const executor:CodingAgentExecutor={availability:async()=>({available:true,provider:'fixture',reason:null}),execute:async()=>structuredClone(candidate.report)};
  const firstInstaller=new CoreCandidateInstaller(candidate.repository,undefined,'boot-a');
  const tasks=new DevelopmentTasks(builder,()=>adapter as any,executor,undefined,firstInstaller);
  const started=await tasks.start({request:'增加一个需要核心注册的通用 fixture 能力',request_id:randomUUID()});
  expect((await tasks.wait(started.id)).status).toBe('waiting_for_core_approval');
  await tasks.approveCore(started.id,true);expect((await tasks.wait(started.id)).core_execution?.status).toBe('candidate_ready');
  const pending=await tasks.installCore(started.id,true);expect(pending.core_install?.stage).toBe('installed_pending_reload');expect(pending.status).toBe('paused');
  const resumed=vi.fn(async()=>undefined);
  const restarted=new DevelopmentTasks(builder,()=>adapter as any,executor,resumed,new CoreCandidateInstaller(candidate.repository,undefined,'boot-b'));
  await restarted.ready;const completed=await restarted.get(started.id);
  expect(completed).toMatchObject({status:'installed',core_install:{stage:'completed'},core_execution:{installed:true,registered:true,restart_required:false}});
  expect(resumed).toHaveBeenCalledOnce();
 }finally{await rm(developmentDirectory,{recursive:true,force:true});await rm(candidate.root,{recursive:true,force:true});}
},30_000);

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { GameService } from '../src/server/service.js';
import { JsonStore } from '../src/storage/json-store.js';
import { sparseWorld } from './sparse-fixture.js';
import { CapabilityRegistry, capabilityRegistry } from '../src/system/capabilities.js';
import { CoreCandidateInstaller } from '../src/development/core-installer.js';
import type { CodingAgentExecutor, CoreDevelopmentReport } from '../src/development/coding-agent.js';

const exec=promisify(execFile);
async function git(cwd:string,args:string[]){return (await exec('git',args,{cwd,windowsHide:true})).stdout.trim();}
async function candidateFixture(){
 const root=await mkdtemp(join(tmpdir(),'agf-core-product-')),repository=join(root,'repository'),workspace=join(root,'candidate');
 await mkdir(join(repository,'src'),{recursive:true});await mkdir(workspace,{recursive:true});
 await writeFile(join(repository,'package.json'),JSON.stringify({name:'core-product-fixture',private:true,scripts:{build:'node -e "process.exit(0)"'}},null,2));
 await writeFile(join(repository,'src','capability.ts'),'export const walletCapabilityRegistered = false;\n');
 await git(repository,['init']);await git(repository,['add','.']);await git(repository,['-c','user.name=fixture','-c','user.email=fixture@local.invalid','commit','-m','base']);
 const base=await git(repository,['rev-parse','HEAD']);await writeFile(join(repository,'src','capability.ts'),'export const walletCapabilityRegistered = true;\n');
 const patch=(await git(repository,['diff','--binary','HEAD']))+'\n',patchPath=join(workspace,'candidate.patch');await writeFile(patchPath,patch);await git(repository,['restore','src/capability.ts']);
 const report:CoreDevelopmentReport={status:'candidate_ready',provider:'fixture',workspace,base_revision:base,changed_files:['src/capability.ts'],commands:[],patch_path:patchPath,tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'candidate ready'};
 return {root,repository,report};
}
const waitFor=async<T>(read:()=>Promise<T>,done:(value:T)=>boolean,timeout=30_000)=>{const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(done(value))return value;await new Promise(r=>setTimeout(r,100));}throw new Error('timed out');};
async function close(server:any){await new Promise<void>((resolve,reject)=>server.close((error?:Error)=>error?reject(error):resolve()));}

it('normal System goal closes Core candidate install, reload, registration and original-goal resume',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agf-core-product-e2e-')),saveDirectory=join(root,'save'),candidate=await candidateFixture();
 const plan={normalized_requirements:['注册可复用的本地 wallet set capability'],complexity:'HIGH',clarification:null,milestones:[{id:'capability',title:'实现能力注册',kind:'integration',acceptance:['新运行时可发现能力']},{id:'resume',title:'恢复原目标',kind:'integration',acceptance:['原事务成功']}],capability_gaps:[{required_capability:'entity.wallet.balance.set',why_needed:'当前运行时未注册该本地能力',affected_modules:['system capability registry'],current_limitation:'目标被挂起',proposed_generic_capability:'注册已有安全事务 executor',risk:'错误注册会导致恢复失败'}],affected_milestone_ids:[]};
 const adapter={name:'mock',generate:async()=>({data:plan})},ai=new AIRuntime(adapter as any);
 const disabled=new CapabilityRegistry(capabilityRegistry.all().map(item=>item.id==='entity.wallet.balance.set'?{...item,implemented:false}:item));
 const service1=new GameService(new JsonStore(saveDirectory),ai,sparseWorld(),[],undefined,disabled);await service1.newGame();
 const before=await service1.current(),player=before.entities.find(entity=>entity.id===before.player_state.entity_id)!,currency=Object.keys((player.components.wallet as any).balances)[0];(player.components.wallet as any).balances[currency]=30;await service1.storage.write(before);
 const executor:CodingAgentExecutor={availability:async()=>({available:true,provider:'fixture',reason:null}),execute:async()=>structuredClone(candidate.report)};
 let server1:any,server2:any;
 try{
  server1=createApp(service1,undefined,undefined,join(saveDirectory,'assets'),{}, {coreExecutor:executor,coreInstaller:new CoreCandidateInstaller(candidate.repository,undefined,'boot-a')}).listen(0,'127.0.0.1');await once(server1,'listening');
  let base='http://127.0.0.1:'+(server1.address() as any).port,token=(await(await fetch(base+'/api/session')).json()).token;
  const headers={'Content-Type':'application/json','X-Game-Token':token},requestId=randomUUID();
  const response=await fetch(base+'/api/system',{method:'POST',headers,body:JSON.stringify({input:'把我身上的钱从30改成3000',request_id:requestId,game_id:before.game_id,expected_revision:before.state_revision})}),first=await response.json();
  expect(first).toMatchObject({category:'CAPABILITY_GAP',suspended_goal:{status:'developing',external_blocked:false}});
  const goals=await(await fetch(base+'/api/system/suspended-goals?game_id='+before.game_id)).json(),goal=goals[0],taskId=goal.development_task_id;
  await waitFor(async()=>await(await fetch(base+'/api/development/tasks/'+taskId)).json(),(task:any)=>task.status==='waiting_for_core_approval');
  await fetch(base+'/api/development/tasks/'+taskId+'/approve-core',{method:'POST',headers,body:JSON.stringify({confirmed:true})});
  await waitFor(async()=>await(await fetch(base+'/api/development/tasks/'+taskId)).json(),(task:any)=>task.core_execution?.status==='candidate_ready');
  const installed=await(await fetch(base+'/api/development/tasks/'+taskId+'/install-core',{method:'POST',headers,body:JSON.stringify({confirmed:true})})).json();
  expect(installed).toMatchObject({status:'paused',core_install:{stage:'installed_pending_reload'}});
  await close(server1);server1=null;

  const service2=new GameService(new JsonStore(saveDirectory),ai,sparseWorld());
  server2=createApp(service2,undefined,undefined,join(saveDirectory,'assets'),{}, {coreExecutor:executor,coreInstaller:new CoreCandidateInstaller(candidate.repository,undefined,'boot-b')}).listen(0,'127.0.0.1');await once(server2,'listening');
  base='http://127.0.0.1:'+(server2.address() as any).port;token=(await(await fetch(base+'/api/session')).json()).token;
  const completed=await waitFor(async()=>await(await fetch(base+'/api/development/tasks/'+taskId)).json(),(task:any)=>task.status==='installed');
  expect(completed).toMatchObject({core_install:{stage:'completed'},core_execution:{installed:true,registered:true,restart_required:false}});
  const resumedGoals=await(await fetch(base+'/api/system/suspended-goals?game_id='+before.game_id)).json();
  expect(resumedGoals[0]).toMatchObject({status:'completed',resume:{attempts:1}});
  const after=await service2.current(),afterPlayer=after.entities.find(entity=>entity.id===after.player_state.entity_id)!;
  expect((afterPlayer.components.wallet as any).balances[currency]).toBe(3000);
 }finally{if(server1)await close(server1);if(server2)await close(server2);await rm(root,{recursive:true,force:true});await rm(candidate.root,{recursive:true,force:true});}
},60_000);

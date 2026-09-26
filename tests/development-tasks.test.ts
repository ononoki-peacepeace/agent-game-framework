import {it,expect,vi} from 'vitest';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {ExtensionDevelopment} from '../src/extensions/development.js';
import {DevelopmentTasks} from '../src/extensions/tasks.js';
import {manifestFrom,type ExtensionSpec} from '../src/extensions/schema.js';
import {taskGroups} from '../src/client/task-visibility.js';
import type {AIRequest} from '../src/ai/contracts.js';
import {developmentProjection} from '../src/system/development-status.js';
import type {CodingAgentExecutor} from '../src/development/coding-agent.js';
const plan={normalized_requirements:['提供一个自有开关并展示当前值'],complexity:'LOW',clarification:null,milestones:[{id:'switch',title:'开关功能与界面',kind:'ui',acceptance:['点击切换且状态保留']}],capability_gaps:[]};
const gap={required_capability:'input.subscription',why_needed:'用户目标需要连续输入',affected_modules:['extension host'],current_limitation:'仅支持离散动作',proposed_generic_capability:'可取消且限频的输入订阅',risk:'事件泄漏和并发事务'};
function spec(id:string):ExtensionSpec{return {extension_id:id,name:'状态开关',description:'切换本功能自身状态',template:'declarative',allow_betting:false,max_stake:0,healing_item_id:null,fields:[{key:'enabled',type:'flag',initial:false}],declarative_actions:[{id:'toggle',label:'切换',op:'toggle',field:'enabled'}],surfaces:[{id:'switch_panel',kind:'panel',title:'状态开关',visibility:'always'}]};}
async function setup(override?:(r:AIRequest)=>unknown|Promise<unknown>,coreExecutor?:CodingAgentExecutor,onInstalled?:(task:any)=>Promise<void>){
 const f=await sparseSetup(),dir=await mkdtemp(join(tmpdir(),'agf-devtasks-')),host=new ExtensionHost(f.service,dir),builder=new ExtensionDevelopment(host);
 const calls:AIRequest[]=[];
 const adapter={name:'task-fixture',async generate(r:AIRequest){calls.push(r);if(override){const data=await override(r);if(data!==undefined)return {data};}
 if((r.schema as any).properties.normalized_requirements)return {data:plan};
 const context=JSON.parse(r.prompt.slice(r.prompt.indexOf('{"extension_id"')));return {data:{spec:spec(context.extension_id),capability_gaps:[]}};}};
 const tasks=new DevelopmentTasks(builder,()=>adapter,coreExecutor,onInstalled);return {...f,dir,host,builder,tasks,calls,adapter};
}
const start=async(f:Awaited<ReturnType<typeof setup>>,request='增加一个我可以切换的状态开关')=>f.tasks.start({request,request_id:randomUUID()});
const tx=async(f:Awaited<ReturnType<typeof setup>>)=>{const s=await f.service.current();return {game_id:s.game_id,expected_revision:s.state_revision,request_id:randomUUID()};};
it('goal creates a durable task, verified checkpoint and product preview without installing',async()=>{
 const f=await setup(),before=await f.service.current(),task=await start(f),ready=await f.tasks.wait(task.id);
 expect(ready.status).toBe('ready_for_preview');expect(ready.artifacts).toHaveLength(1);expect(ready.preview).toMatchObject({name:'状态开关',canonical_writes:[]});expect(ready.preview!.rules).toContain('切换：切换');
 expect(JSON.parse(await readFile(join(f.dir,'tasks.json'),'utf8')).tasks[0].id).toBe(task.id);expect(await f.service.current()).toEqual(before);
},20000);
it('failed generation retries locally with diagnostics then preserves task/workspace',async()=>{
 let n=0;const f=await setup(r=>{if((r.schema as any).properties.spec&&++n===1)return {spec:{bad:true},capability_gaps:[]};}),t=await start(f),ready=await f.tasks.wait(t.id);
 expect(ready.status).toBe('ready_for_preview');expect(ready.workspace).toBe(t.workspace);expect(ready.test_results.some(r=>!r.passed)).toBe(true);expect(f.calls.at(-1)!.prompt).toContain('diagnostics');
},20000);
it('exhausted budget pauses and restart retains diagnostics/workspace before resume',async()=>{
 let fail=true;const f=await setup(r=>(r.schema as any).properties.spec&&fail?{spec:null,capability_gaps:[]}:undefined),t=await start(f),paused=await f.tasks.wait(t.id);
 expect(paused.status).toBe('paused');expect(paused.attempts).toBe(paused.budget.max_attempts);
 const restarted=new DevelopmentTasks(f.builder,()=>f.adapter);expect((await restarted.get(t.id)).workspace).toBe(t.workspace);
 fail=false;await restarted.resume(t.id);expect((await restarted.wait(t.id)).status).toBe('ready_for_preview');
},20000);
it('capability gap stops retries and approval never edits Core or grants execution',async()=>{
 const f=await setup(r=>(r.schema as any).properties.normalized_requirements?{...plan,complexity:'HIGH',milestones:[...plan.milestones,{id:'integration',title:'验证世界接入',kind:'integration',acceptance:['只提交合法事务']}],capability_gaps:[gap]}:undefined);
 const t=await start(f,'希望通过键盘连续控制地图上的角色位置'),out=await f.tasks.wait(t.id);
 expect(out.status).toBe('waiting_for_core_approval');expect(out.milestones).toHaveLength(2);expect(f.calls).toHaveLength(1);expect(out.core_proposal).toHaveProperty('rollback');
 await expect(f.tasks.approveCore(t.id,false)).rejects.toThrow();expect((await f.tasks.approveCore(t.id,true)).core_proposal!.status).toBe('approved');
 await expect(f.tasks.resume(t.id)).rejects.toThrow('核心能力');expect(out.artifacts).toEqual([]);
});
it('approved core work uses the configured executor but cannot become installed without install and registration gates',async()=>{
 const execute=vi.fn(async(request:any)=>({status:'candidate_ready' as const,provider:'fixture',workspace:request.workspace,base_revision:'base',changed_files:['src/example.ts'],commands:[],patch_path:join(request.workspace,'candidate.patch'),tests_passed:true,build_passed:true,acceptance_passed:true,installed:false,registered:false,restart_required:true,message:'candidate ready'}));
 const executor:CodingAgentExecutor={availability:async()=>({available:true,provider:'fixture',reason:null}),execute};
 const f=await setup(r=>(r.schema as any).properties.normalized_requirements?{...plan,complexity:'HIGH',milestones:[...plan.milestones,{id:'integration',title:'验证世界接入',kind:'integration',acceptance:['只提交合法事务']}],capability_gaps:[gap]}:undefined,executor);
 const t=await start(f,'增加一个 SDK 无法表达的通用输入能力');await f.tasks.wait(t.id);
 const approved=await f.tasks.approveCore(t.id,true);expect(approved.status).toBe('developing');
 const finished=await f.tasks.wait(t.id);expect(execute).toHaveBeenCalledOnce();
 expect(finished).toMatchObject({status:'paused',core_execution:{status:'candidate_ready',tests_passed:true,build_passed:true,installed:false,registered:false}});
 expect(finished.message).toContain('尚未安装、注册');
});
it('underspecified request asks rules instead of generating a reference game',async()=>{
 const f=await setup(r=>(r.schema as any).properties.normalized_requirements?{...plan,clarification:'请说明一局的规则和结束条件。'}:undefined);
 const t=await start(f,'加入赌博小游戏'),out=await f.tasks.wait(t.id);expect(out.status).toBe('waiting_for_user');expect(out.candidate_job_id).toBeNull();expect(f.calls).toHaveLength(1);
});
it('capability gap found during implementation is distinct from code failure',async()=>{
 const f=await setup(r=>(r.schema as any).properties.spec?{spec:null,capability_gaps:[gap]}:undefined),t=await start(f),out=await f.tasks.wait(t.id);
 expect(out.status).toBe('waiting_for_core_approval');expect(out.test_results).toHaveLength(0);expect(out.attempts).toBe(2);
});
it('candidate feedback retains identity and history, increments version and reuses workspace',async()=>{
 const f=await setup(),t=await start(f);await f.tasks.wait(t.id);await f.tasks.revise(t.id,'第一版太简单，继续修改界面标题');
 const revised=await f.tasks.wait(t.id);expect(revised.status).toBe('ready_for_preview');expect(revised.extension_id).toBe(t.extension_id);expect(revised.workspace).toBe(t.workspace);expect(revised.current_version).not.toBe(t.current_version);expect(revised.requirement_history).toHaveLength(2);expect(revised.artifacts).toHaveLength(2);
},30000);
it('installed update and rollback retain stable state; stale preview cannot install',async()=>{
 const f=await setup(),t=await start(f),first=await f.tasks.wait(t.id);
 await f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:first.current_version});
 await f.host.act(t.extension_id,{...await tx(f),action:{type:'toggle'}});const stable=(await f.service.current()).extensions![t.extension_id];
 await f.tasks.revise(t.id,'修改界面标题');const updated=await f.tasks.wait(t.id);
 await expect(f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:first.current_version})).rejects.toThrow('候选已更新');
 expect((await f.service.current()).extensions![t.extension_id]).toEqual(stable);
 await f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:updated.current_version});
 await f.host.manage(t.extension_id,await tx(f),'rollback');expect((await f.service.current()).extensions![t.extension_id].state).toEqual(stable.state);expect((await f.service.current()).extensions![t.extension_id].version).toBe(stable.version);
},30000);
it('a committed installation emits its durable task to the goal-resume callback exactly once',async()=>{
 const onInstalled=vi.fn(async(_task:any)=>undefined),f=await setup(undefined,undefined,onInstalled),t=await start(f),ready=await f.tasks.wait(t.id);
 await f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:ready.current_version});
 expect(onInstalled).toHaveBeenCalledOnce();expect(onInstalled.mock.calls[0][0]).toMatchObject({id:t.id,status:'installed',installed_version:ready.current_version});
});
it('schema migration requires confirmation and rollback restores the exact old schema/state',async()=>{
 const f=await setup(),v1=manifestFrom(spec('switch'),'0.1.0','fixture');await f.host.approve(v1);await f.host.install(await tx(f),v1);await f.host.act('switch',{...await tx(f),action:{type:'toggle'}});
 const before=(await f.service.current()).extensions!.switch;
 const v2=manifestFrom({...spec('switch'),fields:[...spec('switch').fields,{key:'new_value',type:'number',initial:7}]},'0.2.0','fixture');await f.host.approve(v2);
 await expect(f.host.install(await tx(f),v2)).rejects.toThrow('迁移');expect((await f.service.current()).extensions!.switch).toEqual(before);
 await f.host.install(await tx(f),v2,true);expect((await f.service.current()).extensions!.switch.state).toMatchObject({values:{enabled:true,new_value:7}});
 await f.host.manage('switch',await tx(f),'rollback');expect((await f.service.current()).extensions!.switch.state).toEqual(before.state);
});
it('bad startup state is rejected before replacing installed version',async()=>{
 const f=await setup(),v1=manifestFrom(spec('switch'),'0.1.0','fixture');await f.host.approve(v1);await f.host.install(await tx(f),v1);const before=await f.service.current();
 const v2=manifestFrom({...spec('switch'),fields:[{key:'enabled',type:'number',initial:false}]},'0.2.0','fixture');await f.host.approve(v2);
 await expect(f.host.install(await tx(f),v2,true)).rejects.toThrow('类型');expect(await f.service.current()).toEqual(before);
});
it('artifact tampering prevents installation',async()=>{
 const f=await setup(),t=await start(f),out=await f.tasks.wait(t.id);await writeFile(join(t.workspace,'candidate','dist','profile.json'),'{}');
 await expect(f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:out.current_version})).rejects.toThrow('产物已改变');
 expect((await f.service.current()).extensions?.[t.extension_id]).toBeUndefined();
},20000);
it('restart pauses active work and reconciles an already committed installation',async()=>{
 const f=await setup(),t=await start(f);await f.tasks.wait(t.id);const path=join(f.dir,'tasks.json'),data=JSON.parse(await readFile(path,'utf8'));data.tasks[0].status='developing';await writeFile(path,JSON.stringify(data));
 const restarted=new DevelopmentTasks(f.builder,()=>f.adapter);expect((await restarted.get(t.id)).status).toBe('paused');
 const ready=await f.tasks.get(t.id);await f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:ready.current_version});const committed=JSON.parse(await readFile(path,'utf8'));committed.tasks[0].status='ready_for_preview';committed.tasks[0].installed_version=null;await writeFile(path,JSON.stringify(committed));
 const recovered=new DevelopmentTasks(f.builder,()=>f.adapter);expect((await recovered.get(t.id)).status).toBe('installed');expect((await recovered.get(t.id)).installed_version).toBe(ready.current_version);
},20000);
it('projects only canonical DevelopmentTask status and never calls pending work completed',()=>{
 const paused=developmentProjection({id:'task',status:'paused'}),approval=developmentProjection({id:'task',status:'waiting_for_core_approval'}),waiting=developmentProjection({id:'task',status:'waiting_for_user'}),installed=developmentProjection({id:'task',status:'installed'});
 expect(paused).toMatchObject({lifecycle:'paused',terminal:false,completed:false,label:'已暂停'});
 expect(approval).toMatchObject({lifecycle:'waiting_for_core_approval',terminal:false,completed:false,label:'等待审阅'});
 expect(waiting).toMatchObject({lifecycle:'waiting_for_clarification',terminal:false,completed:false});
 expect(installed).toMatchObject({lifecycle:'installed',terminal:true,completed:true,label:'已完成'});
});
it('cancelled task remains durable with candidate artifacts',async()=>{
 const f=await setup(),t=await start(f);await f.tasks.wait(t.id);const cancelled=await f.tasks.cancel(t.id);expect(cancelled.status).toBe('cancelled');expect(cancelled.artifacts).toHaveLength(1);
},20000);
it('task hiding and restoring are projection-only and preserve canonical history',()=>{
 const entries={one:{status:'completed'},two:{status:'cancelled'},three:{status:'failed'},four:{status:'active'}},before=structuredClone(entries);
 expect(taskGroups(entries,['one','two']).hidden).toHaveLength(2);expect(taskGroups(entries,[]).ended).toHaveLength(3);expect(taskGroups(entries,['one']).active).toHaveLength(1);expect(entries).toEqual(before);
});
it('generic UI has no sample-world NPC literals or default reference picker',async()=>{
 for(const path of ['src/client/App.tsx','src/client/SystemPanel.tsx','src/client/DevelopmentPanel.tsx'])expect(await readFile(path,'utf8')).not.toMatch(/伊芙琳|莉娅|梅芙|维斯特|赫恩/);
 const source=await readFile('src/extensions/tasks.ts','utf8');expect(source).not.toMatch(/WASD|赌博|blackjack/);
});


it('a failed installed update preserves the active manifest and state',async()=>{
 let broken=false;const f=await setup(r=>(r.schema as any).properties.spec&&broken?{spec:null,capability_gaps:[]}:undefined);
 const t=await start(f),ready=await f.tasks.wait(t.id);await f.tasks.install(t.id,{...await tx(f),confirmed:true,candidate_version:ready.current_version});
 const stable=(await f.service.current()).extensions![t.extension_id];broken=true;await f.tasks.revise(t.id,'修改标题');const failed=await f.tasks.wait(t.id);
 expect(failed.status).toBe('paused');expect((await f.service.current()).extensions![t.extension_id]).toEqual(stable);
},20000);
it('UI-only revision retains unrelated passed milestone checkpoints',async()=>{
 const two={...plan,affected_milestone_ids:['switch'],milestones:[{...plan.milestones[0],id:'logic',kind:'behavior',title:'状态行为'},plan.milestones[0]]};
 const f=await setup(r=>(r.schema as any).properties.normalized_requirements?two:undefined),t=await start(f),first=await f.tasks.wait(t.id);
 expect(first.status).toBe('ready_for_preview');await f.tasks.revise(t.id,'只修改界面标题');const revised=await f.tasks.wait(t.id);
 expect(revised.milestones[0].checkpoint).toBe(first.milestones[0].checkpoint);expect(revised.artifacts).toHaveLength(3);
},30000);
it('requirements changed while generation is running replace only the pending attempt',async()=>{
 let reached!:()=>void,release!:()=>void,hold=true;const entered=new Promise<void>(r=>reached=r),block=new Promise<void>(r=>release=r);
 const f=await setup(async r=>{if((r.schema as any).properties.spec&&hold){hold=false;reached();await block;}});
 const t=await start(f);await entered;const revision=f.tasks.revise(t.id,'补充新的界面要求');release();await revision;
 const out=await f.tasks.wait(t.id);expect(out.status).toBe('ready_for_preview');expect(out.requirement_history).toHaveLength(2);expect(out.artifacts).toHaveLength(1);expect(out.workspace).toBe(t.workspace);
},20000);
it('repeated start id is idempotent and rejects a different request',async()=>{
 const f=await setup(r=>(r.schema as any).properties.normalized_requirements?{...plan,clarification:'请补充规则'}:undefined),raw={request:'描述目标',request_id:randomUUID()};
 const t=await f.tasks.start(raw);await f.tasks.wait(t.id);expect((await f.tasks.start(raw)).id).toBe(t.id);expect(await f.tasks.list()).toHaveLength(1);
 await expect(f.tasks.start({...raw,request:'不同目标'})).rejects.toThrow('不同需求');
});
it('concurrent task starts cannot share the builder workspace',async()=>{
 const f=await setup(r=>(r.schema as any).properties.normalized_requirements?{...plan,clarification:'请补充规则'}:undefined);
 const results=await Promise.allSettled([start(f),start(f)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);for(const t of await f.tasks.list())await f.tasks.wait(t.id);
});
it('a paused task remains intact while a different task becomes active',async()=>{
 let fail=true;const f=await setup(r=>(r.schema as any).properties.spec&&fail?{spec:null,capability_gaps:[]}:undefined);
 const first=await start(f,'开发潜力系统'),paused=await f.tasks.wait(first.id);expect(paused.status).toBe('paused');
 fail=false;const second=await start(f,'开发角色改名能力');expect(second.id).not.toBe(first.id);expect(second.workspace).not.toBe(first.workspace);
 const active=await f.tasks.wait(second.id),tasks=await f.tasks.list();expect(active.status).toBe('ready_for_preview');expect(tasks).toHaveLength(2);
 expect(tasks.find(task=>task.id===first.id)).toMatchObject({status:'paused',workspace:first.workspace,requirement_history:['开发潜力系统']});
 expect(tasks.find(task=>task.id===second.id)).toMatchObject({status:'ready_for_preview',workspace:second.workspace,requirement_history:['开发角色改名能力']});
},30000);

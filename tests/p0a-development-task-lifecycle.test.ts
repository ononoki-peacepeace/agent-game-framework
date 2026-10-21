import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {ExtensionDevelopment} from '../src/extensions/development.js';
import {DevelopmentTasks} from '../src/extensions/tasks.js';
import type {AIAdapter} from '../src/ai/contracts.js';
import * as atomic from '../src/storage/atomic-json.js';
import {withInputRecovery,prepareRequestCommit,type InputRecovery} from '../src/recovery/request-context.js';
import {withRequestBudget} from '../src/ai/request-budget.js';
import {currentTrace} from '../src/observability/trace.js';
import type {CodingAgentExecutor} from '../src/development/coding-agent.js';
import {generateWithinRequestBudget} from '../src/ai/request-budget.js';

afterEach(()=>vi.restoreAllMocks());
const plan={normalized_requirements:['需要选择展示方式'],complexity:'LOW',clarification:'你希望使用哪种展示方式？',
  clarification_options:['面板','弹窗'],milestones:[{id:'display',title:'展示方式',kind:'ui',acceptance:['展示已选择的内容']}],capability_gaps:[]};
async function fixture(adapter:AIAdapter={name:'offline-task',generate:async()=>({data:plan})},executor?:CodingAgentExecutor){
  const f=await sparseSetup(),directory=await mkdtemp(join(tmpdir(),'agf-task-lifecycle-'));
  const host=new ExtensionHost(f.service,directory);await host.ready;
  const builder=new ExtensionDevelopment(host),tasks=new DevelopmentTasks(builder,()=>adapter,executor);await tasks.ready;
  return {...f,directory,builder,tasks,baseline:await f.service.current(),
    input:()=>({request_id:randomUUID(),request:'开发一个展示面板'}),close:()=>rm(directory,{recursive:true,force:true})};
}

it.each(['test','build'])('does not treat schema-error text inside a failed %s gate as a backend request failure',async stage=>{
 let calls=0;
 const gap={required_capability:'input.subscription',why_needed:'需要连续输入',affected_modules:['core'],current_limitation:'仅离散动作',proposed_generic_capability:'可取消输入订阅',risk:'并发事务'};
 const executor:CodingAgentExecutor={availability:async()=>({available:true,provider:'controlled-local',reason:null}),execute:async request=>{
  calls++;return {status:'failed',provider:'controlled-local',workspace:request.workspace,base_revision:'fixture-base',changed_files:['src/fixture.ts'],commands:[{command:stage==='test'?'npm test':'npm run build',exit_code:17}],patch_path:null,
   tests_passed:stage==='build',build_passed:false,acceptance_passed:false,installed:false,registered:false,restart_required:false,
   message:`[${stage}] local gate failed\nstdout: negative fixture mentions invalid_json_schema malformed request`};
 }};
 const f=await fixture({name:'controlled-plan',generate:async()=>({data:{...plan,clarification:null,capability_gaps:[gap]}})},executor);
 try{
  const task=await f.tasks.start(f.input());expect((await f.tasks.wait(task.id)).status).toBe('waiting_for_core_approval');
  await f.tasks.approveCore(task.id,true);const failed=await f.tasks.wait(task.id);
  expect(failed.core_recovery?.classification).toBe('IMPLEMENTATION_FAILURE');expect(failed.status).toBe('failed');
  expect(calls).toBe(failed.core_recovery!.max_replans+1);expect(failed.core_execution?.installed).toBe(false);expect(failed.core_execution?.registered).toBe(false);
  expect(await f.service.current()).toEqual(f.baseline);
 }finally{await f.close();}
});
describe('P0-A development task lifecycle',()=>{
  it.each(['approval','resume','restart'] as const)('isolates approved core work launched by %s',async(mode)=>{
    const gap={required_capability:'input.subscription',why_needed:'需要连续输入',affected_modules:['extension host'],
      current_limitation:'仅离散动作',proposed_generic_capability:'可取消输入订阅',risk:'并发事务'};
    const traces:string[]=[];
    const executor:CodingAgentExecutor={availability:async()=>({available:true,provider:'offline-executor',reason:null}),
      async execute(request){
        traces.push(currentTrace()!.trace_id);
        await generateWithinRequestBudget({name:'offline-probe',generate:async()=>({data:{}})},
          {role:'gm_reasoning',prompt:'budget probe',schema:{},maxOutputTokens:1});
        await prepareRequestCommit(f.baseline.game_id,randomUUID(),'core-probe',f.baseline.state_revision);
        return {status:'blocked',provider:'offline-executor',workspace:request.workspace,base_revision:null,
          changed_files:[],commands:[],patch_path:null,tests_passed:false,build_passed:false,acceptance_passed:false,
          installed:false,registered:false,restart_required:false,message:'dirty worktree'};
      }};
    const f=await fixture({name:'offline-gap',generate:async()=>({data:{...plan,clarification:null,capability_gaps:[gap]}})},executor);
    try{
      const task=await f.tasks.start(f.input());expect((await f.tasks.wait(task.id)).status).toBe('waiting_for_core_approval');
      const recovery:InputRecovery={original_player_input:'foreground',trace_id:'tr_foreground',transactions:[]},persist=vi.fn(async()=>{});
      let tasks=f.tasks;
      if(mode!=='approval'){await tasks.approveCore(task.id,true);await tasks.wait(task.id);}
      if(mode==='restart'){
        const data=JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8'));data.tasks[0].status='developing';
        await atomic.writeAtomicJson(join(f.directory,'tasks.json'),data);
      }
      const previous=traces.length;
      await withInputRecovery({game_id:f.baseline.game_id,recovery,persist},()=>withRequestBudget(async()=>{
        if(mode==='approval')await tasks.approveCore(task.id,true);
        else if(mode==='resume')await tasks.resume(task.id);
        else{tasks=new DevelopmentTasks(f.builder,()=>({name:'unused',generate:async()=>{throw Error('unused');}}),executor);await tasks.ready;}
      },{calls:0,tokens:0,milliseconds:1}));
      const terminal=await tasks.wait(task.id);expect(terminal.status).toBe('paused');expect(terminal.core_execution?.status).toBe('blocked');
      expect(traces).toHaveLength(previous+1);expect(traces.at(-1)).toBe(terminal.trace_id);
      expect(traces.at(-1)).not.toBe(recovery.trace_id);expect(recovery.transactions).toEqual([]);expect(persist).not.toHaveBeenCalled();
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('waits for a durable creation before returning a concurrent duplicate',async()=>{
    const generate=vi.fn(async()=>({data:plan})),f=await fixture({name:'offline-task',generate});try{
      let entered!:()=>void,release!:()=>void;
      const reached=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
      vi.spyOn(atomic,'writeAtomicJson').mockImplementationOnce(async()=>{entered();await hold;throw Error('creation fail');});
      const input=f.input(),first=f.tasks.start(input),firstResult=first.catch(error=>error);await reached;
      const second=f.tasks.start(input);release();expect(await firstResult).toBeInstanceOf(Error);
      const task=await second;expect((await f.tasks.wait(task.id)).status).toBe('waiting_for_user');
      expect(generate).toHaveBeenCalledTimes(1);expect((await f.tasks.start(input)).id).toBe(task.id);
      expect(JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0].id).toBe(task.id);
    }finally{await f.close();}
  });
  it('does not retain a capability request whose initial journal fails',async()=>{
    const f=await fixture();try{
      const input={...f.input(),capability_ids:['feature.develop']};
      const spy=vi.spyOn(atomic,'writeAtomicJson').mockRejectedValueOnce(Error('capability initial fail'));
      await expect(f.tasks.startCapability(input)).rejects.toThrow('capability initial fail');
      expect(await f.tasks.list()).toEqual([]);
      spy.mockRejectedValueOnce(Error('capability retry reached persistence'));
      await expect(f.tasks.startCapability(input)).rejects.toThrow('capability retry reached persistence');
      expect(await f.tasks.list()).toEqual([]);expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('removes a creation whose initial journal failed and accepts the same request later',async()=>{
    const generate=vi.fn(async()=>({data:plan})),f=await fixture({name:'offline-task',generate});try{
      const input=f.input();vi.spyOn(atomic,'writeAtomicJson').mockRejectedValueOnce(Error('initial task disk failure'));
      await expect(f.tasks.start(input)).rejects.toThrow('initial task disk failure');
      expect(await f.tasks.list()).toEqual([]);expect(generate).not.toHaveBeenCalled();
      const task=await f.tasks.start(input);expect((await f.tasks.wait(task.id)).status).toBe('waiting_for_user');
      expect((await f.tasks.start(input)).id).toBe(task.id);expect(generate).toHaveBeenCalledTimes(1);
      const restarted=new DevelopmentTasks(f.builder);expect((await restarted.list()).map(t=>t.id)).toEqual([task.id]);
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('can persist a terminal failure after a phase flush fails and receive another task',async()=>{
    const generate=vi.fn(async()=>({data:plan})),f=await fixture({name:'offline-task',generate});try{
      const write=atomic.writeAtomicJson;let failed=false;
      vi.spyOn(atomic,'writeAtomicJson').mockImplementation(async(path,value)=>{
        const tasks=(value as {tasks?:{attempts:number}[]}).tasks;
        if(!failed&&tasks?.some(t=>t.attempts===1)){failed=true;throw Error('task phase disk failure');}
        await write(path,value);
      });
      const task=await f.tasks.start(f.input()),terminal=await f.tasks.wait(task.id);
      expect(terminal.status).toBe('failed');expect(terminal.history.at(-1)?.detail).toContain('task phase disk failure');
      expect(JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0].status).toBe('failed');
      expect(generate).not.toHaveBeenCalled();const next=await f.tasks.start(f.input());
      expect((await f.tasks.wait(next.id)).status).toBe('waiting_for_user');expect(generate).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });
  it('owns its trace and budget without adding transactions to the foreground journal',async()=>{
    let trace:string|undefined;const persist=vi.fn(async()=>{});
    const f=await fixture({name:'offline-task',async generate(){trace=currentTrace()?.trace_id;
      await prepareRequestCommit(f.baseline.game_id,randomUUID(),'background-probe',f.baseline.state_revision);
      return {data:plan};}});try{
      const recovery:InputRecovery={original_player_input:'foreground',trace_id:'tr_foreground',transactions:[]};
      const task=await withInputRecovery({game_id:f.baseline.game_id,recovery,persist},()=>withRequestBudget(
        ()=>f.tasks.start(f.input()),{calls:0,tokens:0,milliseconds:1}));
      const terminal=await f.tasks.wait(task.id);expect(terminal.status).toBe('waiting_for_user');
      expect(trace).toBe(task.trace_id);expect(trace).not.toBe(recovery.trace_id);
      expect(recovery.transactions).toEqual([]);expect(persist).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0].trace_id).toBe(trace);
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
});

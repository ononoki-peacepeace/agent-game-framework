import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ExtensionDevelopment} from '../src/extensions/development.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {MemoryStore,fresh} from './helpers.js';
import * as atomic from '../src/storage/atomic-json.js';
import {withInputRecovery,prepareRequestCommit,type InputRecovery} from '../src/recovery/request-context.js';
import {withRequestBudget} from '../src/ai/request-budget.js';
import {currentTrace} from '../src/observability/trace.js';
import {manifestFrom} from '../src/extensions/schema.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'agf-extension-lifecycle-')),store=new MemoryStore(),initial=fresh();
  await store.write(initial);const service=new GameService(store,new AIRuntime(new MockAIAdapter()),initial.definition);
  const baseline=await service.current(),host=new ExtensionHost(service,directory);await host.ready;
  return {directory,service,baseline,host,input:()=>({request_id:randomUUID(),request:'隔离候选故障测试',
    template:'declarative',extension_id:'isolated_candidate',use_codex:true}),
    close:()=>rm(directory,{recursive:true,force:true})};
}
describe('P0-A extension background lifecycle',()=>{
  it('validates a durable duplicate against the original request and workspace options',async()=>{
    const f=await fixture();try{
      const generate=vi.fn(async()=>{throw Error('offline stop');});
      const dev=new ExtensionDevelopment(f.host,()=>({name:'offline',generate})),input=f.input();
      const job=await dev.start(input);await dev.wait(job.job_id);
      expect((await dev.start(input)).job_id).toBe(job.job_id);
      await expect(dev.start({...input,request:'different requirement'})).rejects.toThrow('请求标识');
      await expect(dev.start(input,{workspace:join(f.directory,'different'),version:'0.9.0'})).rejects.toThrow('请求标识');
      const restarted=new ExtensionDevelopment(f.host);
      expect((await restarted.start(input)).job_id).toBe(job.job_id);expect(generate).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });
  it('does not return an unpersisted duplicate while the initial journal is failing',async()=>{
    const f=await fixture();try{
      const generate=vi.fn(async()=>{throw Error('offline stop');});
      const dev=new ExtensionDevelopment(f.host,()=>({name:'offline',generate})),input=f.input();
      let entered!:()=>void,release!:()=>void;
      const reached=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
      vi.spyOn(atomic,'writeAtomicJson').mockImplementationOnce(async()=>{entered();await hold;throw Error('initial fail');});
      const first=dev.start(input),firstResult=first.catch(error=>error);await reached;
      const second=dev.start(input);release();expect(await firstResult).toBeInstanceOf(Error);
      const actual=await second;expect((await dev.wait(actual.job_id)).status).toBe('failed');
      expect(generate).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(join(f.directory,'development.json'),'utf8'))[0].job_id).toBe(actual.job_id);
    }finally{await f.close();}
  });
  it('does not expose a failed approval as installable and recovers the approval queue',async()=>{
    const f=await fixture();try{
      const manifest=manifestFrom({extension_id:'isolated_game',name:'隔离训练',description:'离线事务测试',
        template:'turn_based_combat',allow_betting:false,max_stake:0,healing_item_id:null,fields:[],declarative_actions:[],surfaces:[]},'0.1.0','offline-test');
      const raw={game_id:f.baseline.game_id,expected_revision:f.baseline.state_revision,request_id:randomUUID()};
      vi.spyOn(atomic,'writeAtomicJson').mockRejectedValueOnce(Error('approval disk failure'));
      await expect(f.host.approve(manifest)).rejects.toThrow('approval disk failure');
      await expect(f.host.install(raw,manifest)).rejects.toThrow('扩展尚未通过安装验证');
      expect(await f.service.current()).toEqual(f.baseline);
      await f.host.approve(manifest);
      const restarted=new ExtensionHost(f.service,f.directory);await restarted.ready;
      await restarted.install(raw,manifest);
      const after=await f.service.current();expect(after.extensions?.isolated_game.version).toBe('0.1.0');
      expect(after.state_revision).toBe(f.baseline.state_revision+1);
    }finally{await f.close();}
  });
  it('serializes approval conflicts against the durable version and leaves later versions usable',async()=>{
    const f=await fixture();try{
      const spec={extension_id:'isolated_game',name:'隔离训练',description:'离线事务测试',
        template:'turn_based_combat' as const,allow_betting:false,max_stake:0,healing_item_id:null,fields:[],declarative_actions:[],surfaces:[]};
      const first=manifestFrom(spec,'0.1.0','offline-test'),conflict=manifestFrom({...spec,name:'冲突候选'},'0.1.0','offline-test');
      const results=await Promise.allSettled([f.host.approve(first),f.host.approve(conflict)]);
      expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
      const next=manifestFrom(spec,'0.1.1','offline-test');await f.host.approve(next);
      const durable=JSON.parse(await readFile(join(f.directory,'approved.json'),'utf8'));
      expect(durable.isolated_game).toEqual([first,next]);expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('removes an unlaunched job on initial journal failure and accepts a later job',async()=>{
    const f=await fixture();try{
      const generate=vi.fn(async()=>{throw Error('offline candidate failure');});
      const dev=new ExtensionDevelopment(f.host,()=>({name:'offline-failure',generate}));
      vi.spyOn(atomic,'writeAtomicJson').mockRejectedValueOnce(Error('initial journal unavailable'));
      await expect(dev.start(f.input())).rejects.toThrow('initial journal unavailable');
      expect(await dev.get()).toBeNull();expect(generate).not.toHaveBeenCalled();
      const job=await dev.start(f.input());expect((await dev.wait(job.job_id)).status).toBe('failed');
      expect(generate).toHaveBeenCalledTimes(1);expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('persists a safe terminal record after a phase flush failure without poisoning the queue',async()=>{
    const f=await fixture();try{
      const generate=vi.fn(async()=>{throw Error('must not run');});
      const dev=new ExtensionDevelopment(f.host,()=>({name:'offline-failure',generate}));
      const write=atomic.writeAtomicJson;let failed=false;
      vi.spyOn(atomic,'writeAtomicJson').mockImplementation(async(path,value)=>{
        if(!failed&&(value as {status:string}[]).some(job=>job.status==='running')){
          failed=true;throw Error('phase journal failure');
        }await write(path,value);
      });
      const job=await dev.start(f.input());expect((await dev.wait(job.job_id)).status).toBe('failed');
      expect(JSON.parse(await readFile(join(f.directory,'development.json'),'utf8'))[0]).toMatchObject({
        job_id:job.job_id,status:'failed',message:'phase journal failure'});
      expect(generate).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('owns its trace and model budget and cannot mutate the foreground recovery journal',async()=>{
    const f=await fixture();try{
      const recovery:InputRecovery={original_player_input:'foreground',trace_id:'tr_foreground',transactions:[]};
      const persist=vi.fn(async()=>{});let calls=0,trace:string|undefined;
      const dev=new ExtensionDevelopment(f.host,()=>({name:'offline-lifecycle',async generate(){
        calls++;trace=currentTrace()?.trace_id;
        await prepareRequestCommit(f.baseline.game_id,randomUUID(),'not-a-world-commit',f.baseline.state_revision);
        throw Error('injected candidate failure');
      }}));
      const job=await withInputRecovery({game_id:f.baseline.game_id,recovery,persist},()=>withRequestBudget(
        ()=>dev.start(f.input()),{calls:0,tokens:0,milliseconds:1}));
      expect((await dev.wait(job.job_id)).status).toBe('failed');
      expect(calls).toBe(1);expect(trace).toBe(job.trace_id);expect(trace).not.toBe(recovery.trace_id);
      expect(recovery.transactions).toEqual([]);expect(persist).not.toHaveBeenCalled();
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
});

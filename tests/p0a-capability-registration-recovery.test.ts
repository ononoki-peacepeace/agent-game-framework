import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {GameService} from '../src/server/service.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {ExtensionDevelopment} from '../src/extensions/development.js';
import {DevelopmentTasks} from '../src/extensions/tasks.js';
import {capabilityRegistry} from '../src/system/capabilities.js';
import * as atomic from '../src/storage/atomic-json.js';

// These tests isolate the registration/commit boundary. Commands are substitutes;
// passing them does not establish package verification or a real Framework build.
const command=vi.hoisted(()=>({run:vi.fn(async()=>({stdout:'',stderr:''}))}));
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  const {promisify}=await import('node:util');
  return {...actual,execFile:Object.assign(()=>{throw Error('unexpected callback command');},{[promisify.custom]:command.run})};
});
afterEach(()=>{vi.restoreAllMocks();command.run.mockReset();command.run.mockResolvedValue({stdout:'',stderr:''});});
async function fixture(onInstalled?:()=>Promise<void>){
  const f=await sparseSetup(),directory=await mkdtemp(join(tmpdir(),'agf-capability-registration-'));
  const registry=capabilityRegistry.without(['feature.develop']);
  const service=new GameService(f.store,f.ai,f.service.demo,[],f.service.logger,registry);
  const host=new ExtensionHost(service,directory);await host.ready;
  const builder=new ExtensionDevelopment(host),tasks=new DevelopmentTasks(builder,undefined,undefined,onInstalled);await tasks.ready;
  return {service,registry,tasks,builder,directory,baseline:await service.current(),
    input:()=>({request_id:randomUUID(),request:'注册本地开发能力',capability_ids:['feature.develop']}),
    close:()=>rm(directory,{recursive:true,force:true})};
}
describe('P0-A capability registration effects',()=>{
  it('persists the failed build stage and bounded compiler output without publishing the capability',async()=>{
    const f=await fixture();try{
      command.run.mockResolvedValueOnce({stdout:'verified',stderr:''}).mockRejectedValueOnce(Object.assign(
        Error('Command failed: npm run build'),{code:2,stdout:'x'.repeat(8000)+'\nsrc/example.ts(8,2): error TS2322: incompatible candidate',stderr:'compiler diagnostic tail'}));
      const task=await f.tasks.startCapability(f.input()),terminal=await f.tasks.wait(task.id);
      expect(terminal.status).toBe('failed');expect(f.registry.get('feature.develop')).toBeNull();
      expect(terminal.test_results.at(-1)).toMatchObject({milestone:'framework_build',passed:false});
      const detail=terminal.test_results.at(-1)!.detail;
      expect(detail).toContain('TS2322');expect(detail).toContain('compiler diagnostic tail');expect(detail.length).toBeLessThanOrEqual(1800);
      expect(terminal.test_results).toContainEqual(expect.objectContaining({milestone:'package',passed:true}));
      const stored=JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0];
      expect(stored.test_results.at(-1).detail).toBe(detail);expect(command.run).toHaveBeenCalledTimes(2);
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it.each(['hash','path','identity'] as const)('stops recovery when the stored capability artifact has a bad %s',async(kind)=>{
    const f=await fixture();try{
      const task=await f.tasks.startCapability(f.input());await f.tasks.wait(task.id);
      const data=JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')),artifact=data.tasks[0].capability_artifacts[0];
      if(kind==='hash')artifact.hash='0'.repeat(64);
      if(kind==='path')artifact.path=join(f.directory,'untrusted.json');
      if(kind==='identity')artifact.capability_ids=['entity.lookup'];
      await atomic.writeAtomicJson(join(f.directory,'tasks.json'),data);
      const restarted=new DevelopmentTasks(f.builder);await restarted.ready;
      expect((await restarted.get(task.id)).status).toBe('failed');
      await expect(restarted.resume(task.id)).rejects.toThrow();expect(command.run).toHaveBeenCalledTimes(2);
    }finally{await f.close();}
  });
  it('does not repeat an interrupted goal callback when a prepared registration is recovered',async()=>{
    const resume=vi.fn(async()=>{}),f=await fixture(resume);try{
      const task=await f.tasks.startCapability(f.input());await f.tasks.wait(task.id);
      const data=JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8'));
      data.tasks[0].status='testing';data.tasks[0].installed_version=null;
      data.tasks[0].capability_registration={stage:'prepared',goal_resume:'started'};
      await atomic.writeAtomicJson(join(f.directory,'tasks.json'),data);
      (f.registry as unknown as {entries:Map<string,unknown>}).entries.delete('feature.develop');
      const restarted=new DevelopmentTasks(f.builder,undefined,undefined,resume);await restarted.ready;
      expect((await restarted.get(task.id)).status).toBe('paused');expect(resume).toHaveBeenCalledTimes(1);
      await restarted.resume(task.id);expect((await restarted.wait(task.id)).status).toBe('installed');
      expect(resume).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });
  it('does not claim a lost runtime registration is installed after restart or replay the original goal',async()=>{
    const resume=vi.fn(async()=>{}),f=await fixture(resume);try{
      const task=await f.tasks.startCapability(f.input());await f.tasks.wait(task.id);expect(resume).toHaveBeenCalledTimes(1);
      (f.registry as unknown as {entries:Map<string,unknown>}).entries.delete('feature.develop');
      const restarted=new DevelopmentTasks(f.builder,undefined,undefined,resume);await restarted.ready;
      const interrupted=await restarted.get(task.id);expect(interrupted.status).toBe('paused');expect(interrupted.installed_version).toBeNull();
      expect(command.run).toHaveBeenCalledTimes(2);expect(resume).toHaveBeenCalledTimes(1);
      await restarted.resume(task.id);const restored=await restarted.wait(task.id);
      expect(restored.status).toBe('installed');expect(f.registry.get('feature.develop')).not.toBeNull();
      expect(command.run).toHaveBeenCalledTimes(4);expect(resume).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });
  it('persists registration intent before publication and stops if that flush fails',async()=>{
    const f=await fixture();try{
      const write=atomic.writeAtomicJson;let failed=false;
      vi.spyOn(atomic,'writeAtomicJson').mockImplementation(async(path,value)=>{
        if(!failed&&(value as {tasks?:{capability_registration?:{stage:string}}[]}).tasks?.some(t=>t.capability_registration?.stage==='prepared')){
          failed=true;throw Error('registration prepare failure');
        }await write(path,value);
      });
      const task=await f.tasks.startCapability(f.input()),terminal=await f.tasks.wait(task.id);
      expect(failed).toBe(true);expect(terminal.status).toBe('failed');expect(f.registry.get('feature.develop')).toBeNull();
      expect(terminal.history.some(e=>e.detail.includes('registration prepare failure'))).toBe(true);
    }finally{await f.close();}
  });
  it('does not mark an installed capability cancelled when cancellation follows registration',async()=>{
    let entered!:()=>void,release!:()=>void;
    const reached=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
    const f=await fixture(async()=>{entered();await hold;});try{
      const task=await f.tasks.startCapability(f.input());await reached;
      const cancellation=f.tasks.cancel(task.id);release();
      expect((await cancellation).status).toBe('installed');expect(f.registry.get('feature.develop')).not.toBeNull();
      expect(JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0].status).toBe('installed');
    }finally{await f.close();}
  });
  it('keeps a registered capability installed when resuming its original goal fails',async()=>{
    const resume=vi.fn(async()=>{throw Error('goal resume failed');}),f=await fixture(resume);try{
      const task=await f.tasks.startCapability(f.input()),terminal=await f.tasks.wait(task.id);
      expect(f.registry.get('feature.develop')).not.toBeNull();expect(resume).toHaveBeenCalledTimes(1);
      expect(terminal.status).toBe('installed');expect(terminal.installed_version).toBe(task.current_version);
      expect(terminal.history.some(e=>e.event==='goal_resume_failed'&&e.detail.includes('goal resume failed'))).toBe(true);
      expect(JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0].status).toBe('installed');
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('does not report no registration when the installed journal flush fails',async()=>{
    const f=await fixture();try{
      const write=atomic.writeAtomicJson;let failed=false;
      vi.spyOn(atomic,'writeAtomicJson').mockImplementation(async(path,value)=>{
        if(!failed&&(value as {tasks?:{status:string}[]}).tasks?.some(t=>t.status==='installed')){
          failed=true;throw Error('installed journal failed');
        }await write(path,value);
      });
      const task=await f.tasks.startCapability(f.input()),terminal=await f.tasks.wait(task.id);
      expect(failed).toBe(true);expect(f.registry.get('feature.develop')).not.toBeNull();
      expect(terminal.status).toBe('installed');expect(terminal.message).not.toContain('未注册任何能力');
      expect(terminal.history.some(e=>e.detail.includes('installed journal failed'))).toBe(true);
      expect(JSON.parse(await readFile(join(f.directory,'tasks.json'),'utf8')).tasks[0].status).toBe('installed');
      expect(command.run).toHaveBeenCalledTimes(2);
    }finally{await f.close();}
  });
  it('validates all registrations before publishing any capability',async()=>{
    const f=await fixture();try{
      const descriptor=f.registry.get('entity.lookup')!;
      (f.registry as unknown as {entries:Map<string,unknown>}).entries.set('entity.lookup',{...descriptor,description:'conflicting implementation'});
      const task=await f.tasks.startCapability({...f.input(),capability_ids:['feature.develop','entity.lookup']});
      const terminal=await f.tasks.wait(task.id);expect(terminal.status).toBe('failed');
      expect(f.registry.get('feature.develop')).toBeNull();expect(terminal.installed_version).toBeNull();
      expect(await f.service.current()).toEqual(f.baseline);
    }finally{await f.close();}
  });
  it('honors a cancellation that arrives as the build finishes before registration',async()=>{
    const f=await fixture();try{
      let entered!:()=>void,release!:()=>void;
      const reached=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
      command.run.mockImplementationOnce(async()=>({stdout:'',stderr:''})).mockImplementationOnce(async()=>{
        entered();await hold;return {stdout:'',stderr:''};
      });
      const task=await f.tasks.startCapability(f.input());await reached;
      const cancelled=f.tasks.cancel(task.id);await vi.waitFor(()=>expect((f.tasks as any).runs.get(task.id).controller.signal.aborted).toBe(true));
      release();expect((await cancelled).status).toBe('cancelled');
      expect(f.registry.get('feature.develop')).toBeNull();expect((await f.tasks.get(task.id)).installed_version).toBeNull();
    }finally{await f.close();}
  });
});

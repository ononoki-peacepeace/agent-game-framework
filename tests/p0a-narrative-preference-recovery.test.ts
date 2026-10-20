import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
const preferences={scopes:['narration'],tone:'natural',allowed_topics:['politics']};
async function fixture(){
  const f=await sparseSetup(),before=await f.service.current();
  const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
  const recovery:InputRecovery={original_player_input:'调整叙事风格与题材',trace_id:'preference-recovery',transactions:[]};
  const persist=vi.fn(async()=>{});
  const configure=(value:unknown=preferences)=>f.service.setNarrativePreferences(value,request);
  return {...f,before,request,recovery,persist,configure};
}
it.each(['before','after'] as const)('binds a narrative configuration %s-write failure to the original request',async point=>{
  const f=await fixture(),write=f.store.write.bind(f.store);
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(point==='after')await write(save,slot);
    throw Error(`preference ${point} write failure`);
  });
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},()=>f.configure()))
    .rejects.toThrow('write failure');
  expect(f.persist).toHaveBeenCalledOnce();
  const after=(await f.store.read())!;
  expect(committedInputReceipts(after,f.recovery)).toEqual(point==='after'?[f.request.request_id]:[]);
  expect(after.runtime.time).toEqual(f.before.runtime.time);
  if(point==='before')expect(after).toEqual(f.before);
  fault.mockRestore();
  const writes=vi.spyOn(f.store,'write');await f.configure();
  expect(writes).toHaveBeenCalledTimes(point==='after'?0:1);
  expect((await f.service.current()).state_revision).toBe(f.before.state_revision+1);
});
it('stops before storage when the parent journal fails and rejects changed-argument replay',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:async()=>{throw Error('journal down');}},
    ()=>f.configure())).rejects.toThrow('journal down');
  expect(writes).not.toHaveBeenCalled();expect(f.recovery.transactions).toEqual([]);
  await f.configure();const after=await f.service.current();writes.mockClear();
  await f.configure();expect(writes).not.toHaveBeenCalled();
  await expect(f.configure({...preferences,tone:'plain'})).rejects.toThrow('请求 ID');
  expect(await f.service.current()).toEqual(after);
});
it('forwards the System request identity instead of treating a saved preference as an uncommitted failure',async()=>{
  const f=await fixture(),write=f.store.write.bind(f.store),input='请让旁白更成熟，并允许这个世界涉及政治与创伤题材。';
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('System preference response lost');});
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},()=>
    handleSystemInput(f.service,{input,...f.request}))).rejects.toThrow('response lost');
  const after=(await f.store.read())!;
  expect(committedInputReceipts(after,f.recovery)).toEqual([f.request.request_id]);
  expect(after.state_revision).toBe(f.before.state_revision+1);
  fault.mockRestore();const writes=vi.spyOn(f.store,'write');
  await handleSystemInput(f.service,{input,...f.request});
  expect(writes).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(after);
});
it('replays an identified System preference over HTTP after a lost response and disk/service restart without writing again',async()=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'agf-preference-http-'));
  const store=new JsonStore(directory);await store.write(f.before);
  const service=new GameService(store,new AIRuntime(new MockAIAdapter()),f.before.definition);
  const before=await service.current(),body={input:'请让旁白更成熟，并允许这个世界涉及政治与创伤题材。',
    request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
  let server=createApp(service).listen(0,'127.0.0.1');
  const post=async()=>{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const {token}=await(await fetch(base+'/api/session')).json();
    const response=await fetch(base+'/api/system',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  try{
    await once(server,'listening');const write=store.write.bind(store);
    const fault=vi.spyOn(store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('HTTP preference response lost');});
    expect((await post()).status).toBe(503);const after=(await store.read())!;
    expect(after.runtime.receipts.some(item=>item.id===body.request_id)).toBe(true);fault.mockRestore();
    server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    const disk=new JsonStore(directory),restarted=new GameService(disk,new AIRuntime(new MockAIAdapter()),before.definition);
    const writes=vi.spyOn(disk,'write');server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
    const replay=await post();expect(replay.status).toBe(200);expect(replay.body.view.revision).toBe(after.state_revision);
    expect(writes).not.toHaveBeenCalled();expect(await disk.read()).toEqual(after);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}
});

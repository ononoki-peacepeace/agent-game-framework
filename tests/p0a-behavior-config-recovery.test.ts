import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {worldImage,canUndo,historyAvailable} from '../src/core/turn-history.js';

afterEach(()=>vi.restoreAllMocks());
const input='旁白和人物对话每句话结尾加个“喵~”';
async function fixture(move=false){
  const f=await sparseSetup();
  if(move)await handleSystemInput(f.service,{input:'游戏助手每句话结尾加个“喵~”'});
  const before=await f.service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const recovery:InputRecovery={original_player_input:move?'不是游戏助手，是故事的最后一句':input,
    trace_id:'behavior-configuration',transactions:[]};
  const persist=vi.fn(async()=>{});
  const run=()=>withInputRecovery({game_id:before.game_id,recovery,persist},()=>handleSystemInput(f.service,{
    input:recovery.original_player_input,...request}));
  return {...f,before,request,recovery,persist,run};
}
it('commits a multi-scope affix as one revision and replays without another write',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');
  await f.run();const after=await f.service.current();
  expect(after.behavior_config.map(rule=>[rule.scope,rule.op,rule.value])).toEqual([
    ['narration','suffix','喵~'],['dialogue','suffix','喵~']]);
  expect(writes).toHaveBeenCalledOnce();expect(after.state_revision).toBe(f.before.state_revision+1);
  expect({...after.runtime,receipts:f.before.runtime.receipts}).toEqual(f.before.runtime);
  expect(after.entities).toEqual(f.before.entities);expect(after.resolution_receipts).toEqual(f.before.resolution_receipts);
  expect(committedInputReceipts(after,f.recovery)).toEqual([f.request.request_id]);
  writes.mockClear();await f.run();expect(writes).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(after);
});
it.each([false,true])('does not leave a partial multi-scope edit when target storage fails (move=%s)',async move=>{
  const f=await fixture(move),write=f.store.write.bind(f.store);
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(save.behavior_config.some(rule=>rule.scope===(move?'narration':'dialogue')))throw Error('target configuration disk failure');
    await write(save,slot);
  });
  await expect(f.run()).rejects.toThrow('disk failure');
  expect(await f.store.read()).toEqual(f.before);
  expect(committedInputReceipts((await f.store.read())!,f.recovery)).toEqual([]);
});
it.each([false,true])('stops all configuration writes if the parent intent journal fails (move=%s)',async move=>{
  const f=await fixture(move),writes=vi.spyOn(f.store,'write');f.persist.mockRejectedValue(Error('behavior journal down'));
  await expect(f.run()).rejects.toThrow('journal down');
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);expect(f.recovery.transactions).toEqual([]);
});
it.each([false,true])('keeps the original receipt after a lost storage response (move=%s)',async move=>{
  const f=await fixture(move),write=f.store.write.bind(f.store);
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('behavior response lost');});
  await expect(f.run()).rejects.toThrow('response lost');
  const after=(await f.store.read())!;
  expect(committedInputReceipts(after,f.recovery)).toEqual([f.request.request_id]);
  expect(after.state_revision).toBe(f.before.state_revision+1);
  expect(after.behavior_config.map(rule=>rule.scope)).toEqual(move?['narration']:['narration','dialogue']);
  fault.mockRestore();const writes=vi.spyOn(f.store,'write');await f.run();
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(after);
});
it('moves only the corrected operation and preserves an unrelated rule in the old scope',async()=>{
  const f=await sparseSetup();
  await f.service.setBehaviorConfig({scope:'assistant',rule:{op:'prefix',value:'提示：'}});
  await handleSystemInput(f.service,{input:'游戏助手每句话结尾加个“喵~”'});
  const before=await f.service.current(),writes=vi.spyOn(f.store,'write');
  await handleSystemInput(f.service,{input:'不是游戏助手，是故事的最后一句'});
  const after=await f.service.current();
  expect(after.behavior_config.map(rule=>[rule.scope,rule.op,rule.value])).toEqual([
    ['assistant','prefix','提示：'],['narration','suffix','喵~']]);
  expect(after.state_revision).toBe(before.state_revision+1);expect(writes).toHaveBeenCalledOnce();
});
it('retains a prefix operation when the player corrects its output scope',async()=>{
  const f=await sparseSetup();
  await handleSystemInput(f.service,{input:'游戏助手每段前面加上“提示：”，这是固定风格'});
  await handleSystemInput(f.service,{input:'不是游戏助手，是故事的最后一句'});
  expect((await f.service.current()).behavior_config).toMatchObject([
    {scope:'narration',op:'prefix',value:'提示：',application:'final_sentence'}]);
});
it.each([false,true])('recovers the complete edit over HTTP after response loss and restart (move=%s)',async move=>{
  const f=await sparseSetup(),initial=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-behavior-http-'));
  const store=new JsonStore(directory);await store.write(initial);
  const service=new GameService(store,new AIRuntime(new MockAIAdapter()),initial.definition);
  await service.current();
  if(move)await handleSystemInput(service,{input:'游戏助手每句话结尾加个“喵~”'});
  const before=await service.current(),body={input:move?'不是游戏助手，是故事的最后一句':input,
    game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  let server=createApp(service).listen(0,'127.0.0.1');
  const post=async(value=body)=>{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const {token}=await(await fetch(base+'/api/session')).json();
    const response=await fetch(base+'/api/system',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(value)});
    return {status:response.status,body:await response.json()};
  };
  try{
    await once(server,'listening');const write=store.write.bind(store);
    const fault=vi.spyOn(store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('HTTP behavior response lost');});
    expect((await post()).status).toBe(503);const after=(await store.read())!;
    expect(after.runtime.receipts.some(receipt=>receipt.id===body.request_id)).toBe(true);
    expect(after.behavior_config.map(rule=>rule.scope)).toEqual(move?['narration']:['narration','dialogue']);
    expect(after.state_revision).toBe(before.state_revision+1);fault.mockRestore();
    server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    const disk=new JsonStore(directory),restarted=new GameService(disk,new AIRuntime(new MockAIAdapter()),initial.definition);
    const writes=vi.spyOn(disk,'write');server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
    const replay=await post();expect(replay.status).toBe(200);expect(replay.body.view.revision).toBe(after.state_revision);
    expect(writes).not.toHaveBeenCalled();expect(await disk.read()).toEqual(after);
    expect((await post({...body,input:'旁白每句话结尾加个“改了”'})).status).toBeGreaterThanOrEqual(400);
    expect(writes).not.toHaveBeenCalled();
  }finally{
    server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    await rm(directory,{recursive:true,force:true});
  }
});
const edit={set:[{scope:'narration',rule:{op:'suffix',value:'（完）'}},{scope:'dialogue',rule:{op:'tone',value:'natural'}}]};
it('validates every scope, rule and conflicting operation before writing any of them',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');
  for(const invalid of [
    {set:[edit.set[0],{scope:'world',rule:{op:'suffix',value:'bad'}}]},
    {set:[edit.set[0],{scope:'dialogue',rule:{op:'tone',value:''}}]},
    {set:[edit.set[0],{scope:'narration',rule:{op:'suffix',value:'different'}}]},
    {set:[edit.set[0],{scope:'dialogue'}]},
    {set:[edit.set[0]],remove:[{scope:'invalid'}]},
  ])await expect(f.service.updateBehaviorConfig(invalid,f.request)).rejects.toThrow();
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
});
it('retains the raw request identity when semantic routing expands a short clarification',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');
  await handleSystemInput(f.service,{input:'游戏助手每句话结尾加个“喵~”',...f.request},undefined,'助手');
  const after=await f.service.current(),restarted=new GameService(f.store,f.ai,f.before.definition);
  writes.mockClear();const understand=vi.spyOn(f.ai,'systemAgent').mockRejectedValue(Error('must not reinterpret replay'));
  const answer=await handleSystemInput(restarted,{input:'助手',...f.request});
  expect(answer.category).toBe('BEHAVIOR_CONFIGURATION');expect(understand).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(after);
});
it('binds direct service replay to the complete edit and rejects stale or wrong-game requests',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');
  await f.service.updateBehaviorConfig(edit,f.request);const after=await f.service.current();writes.mockClear();
  const restarted=new GameService(f.store,f.ai,f.before.definition);
  await restarted.updateBehaviorConfig(edit,f.request);expect(writes).not.toHaveBeenCalled();
  await expect(restarted.updateBehaviorConfig({remove:[{}]},f.request)).rejects.toThrow('请求 ID');
  await expect(restarted.updateBehaviorConfig(edit,{...f.request,request_id:randomUUID()})).rejects.toThrow('状态已更新');
  await expect(restarted.updateBehaviorConfig(edit,{...f.request,game_id:randomUUID()})).rejects.toThrow('游戏已切换');
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(after);
});
it('allows a write only after the complete edit has been prepared, and rejects a concurrent edit',async()=>{
  const f=await fixture(),write=f.store.write.bind(f.store);
  let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    expect(f.recovery.transactions.map(tx=>tx.request_id)).toEqual([f.request.request_id]);
    expect(save.behavior_config).toHaveLength(2);arrive();await gate;await write(save,slot);
  });
  const first=withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},()=>f.service.updateBehaviorConfig(edit,f.request));
  try{
    await entered;
    await expect(f.service.updateBehaviorConfig({remove:[{}]},{...f.request,request_id:randomUUID()})).rejects.toThrow('正在执行');
    expect(await f.store.read()).toEqual(f.before);
  }finally{release();}
  await first;expect(writes).toHaveBeenCalledOnce();expect((await f.store.read())!.state_revision).toBe(f.before.state_revision+1);
});
it('journals and deduplicates clear operations without recreating cleared rules',async()=>{
  const f=await fixture(true),writes=vi.spyOn(f.store,'write');
  const run=()=>withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},()=>
    f.service.clearBehaviorConfig('assistant',f.request));
  await run();const after=await f.service.current();expect(after.behavior_config).toEqual([]);
  expect(committedInputReceipts(after,f.recovery)).toEqual([f.request.request_id]);
  writes.mockClear();await run();expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(after);
});
it.each(['undo','restore'] as const)('retains the whole style edit across World %s and prevents its replay',async mode=>{
  const mock=new MockAIAdapter(),f=await sparseSetup(request=>mock.generate(request));
  const turn=async()=>{
    const save=await f.service.current();await f.service.turn({request_id:randomUUID(),game_id:save.game_id,
      expected_revision:save.state_revision,action:{type:'WAIT',parameters:{minutes:1}}});
  };
  const initial=await f.service.current();await turn();const first=await f.service.current();
  if(mode==='restore')await turn();
  const before=await f.service.current(),request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
  await f.service.updateBehaviorConfig(edit,request);const configured=await f.service.current();
  expect(mode==='undo'?canUndo(configured):historyAvailable(configured)).toBe(true);
  const tx={request_id:randomUUID(),game_id:before.game_id,expected_revision:configured.state_revision};
  if(mode==='undo')await f.service.undo(tx);else await f.service.restoreTurn({...tx,turn_id:first.active_turn_id!});
  const restored=await f.service.current();expect(worldImage(restored)).toEqual(worldImage(mode==='undo'?initial:first));
  expect(restored.behavior_config).toEqual(configured.behavior_config);
  const writes=vi.spyOn(f.store,'write');await f.service.updateBehaviorConfig(edit,request);
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(restored);
});

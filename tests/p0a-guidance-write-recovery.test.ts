import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MemoryStore} from './helpers.js';
import {GameService} from '../src/server/service.js';
import type {BehaviorPatch} from '../src/ai/guidance.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {JsonStore} from '../src/storage/json-store.js';
import {createApp} from '../src/server/app.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {handleSystemInput} from '../src/system/agent.js';
import {compileBehaviorFeedback} from '../src/ai/behavior-feedback.js';

afterEach(()=>vi.restoreAllMocks());
class GuidanceStore extends MemoryStore{
  global:BehaviorPatch[]=[];
  async readGlobalGuidance(){return structuredClone(this.global);}
  async writeGlobalGuidance(patches:BehaviorPatch[]){this.global=structuredClone(patches);}
}
const patch=(scope:BehaviorPatch['scope']='world',id=randomUUID()):BehaviorPatch=>({id,version:1,scope,
  category:'planning',title:'保留最终目标',trigger_semantics:'composite goal',preferred_behavior:'Retain the authorized final goal',
  anti_pattern:'Do not substitute preparation',optional_exemplar:null,priority:5,enabled:true,
  created_at:'2026-10-20T00:00:00.000Z',source_text:'以后不要遗漏最终目标',overrides:null});
async function fixture(collision=false){
  const f=await sparseSetup(),store=new GuidanceStore(),before=await f.service.current(),rule=patch();
  if(collision){before.behavior_patches=[rule];store.global=[{...rule,scope:'global'}];f.ai.sessionPatches=[{...rule,scope:'session'}];}
  await store.write(before);const service=new GameService(store,f.ai,before.definition);await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const recovery:InputRecovery={original_player_input:rule.source_text,trace_id:'guidance-recovery',transactions:[]};
  const persist=vi.fn(async()=>{});
  const run=()=>withInputRecovery({game_id:before.game_id,recovery,persist},()=>service.putBehaviorPatch(rule,request));
  return {...f,service,store,before,rule,request,recovery,persist,run};
}
it.each(['before','after'] as const)('prepares world guidance and retains its original receipt on a %s-write failure',async point=>{
  const f=await fixture(),write=f.store.write.bind(f.store);
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{if(point==='after')await write(save,slot);throw Error('guidance storage failure');});
  await expect(f.run()).rejects.toThrow('storage failure');const after=(await f.store.read())!;
  expect(f.persist).toHaveBeenCalledOnce();expect(committedInputReceipts(after,f.recovery)).toEqual(point==='after'?[f.request.request_id]:[]);
  if(point==='before')expect(after).toEqual(f.before);
  fault.mockRestore();const writes=vi.spyOn(f.store,'write');await f.run();
  expect(writes).toHaveBeenCalledTimes(point==='after'?0:1);expect((await f.store.read())!.state_revision).toBe(f.before.state_revision+1);
});
it('does not save world guidance when the parent journal fails',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');f.persist.mockRejectedValue(Error('guidance journal down'));
  await expect(f.run()).rejects.toThrow('journal down');expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
});
it('deduplicates world guidance and rejects changed arguments with the same request ID',async()=>{
  const f=await fixture();await f.run();const after=await f.service.current(),writes=vi.spyOn(f.store,'write');
  await f.run();expect(writes).not.toHaveBeenCalled();
  await expect(f.service.putBehaviorPatch({...f.rule,preferred_behavior:'different'},f.request)).rejects.toThrow('请求 ID');
  expect(await f.store.read()).toEqual(after);
});
it.each(['remove','toggle'] as const)('rejects ambiguous legacy IDs before any %s side effects',async operation=>{
  const f=await fixture(true),world=vi.spyOn(f.store,'write'),global=vi.spyOn(f.store,'writeGlobalGuidance');
  const run=()=>operation==='remove'?f.service.removeBehaviorPatch(f.rule.id):f.service.setBehaviorPatchEnabled(f.rule.id,false);
  await expect(run()).rejects.toThrow('范围');expect(world).not.toHaveBeenCalled();expect(global).not.toHaveBeenCalled();
  expect(await f.store.read()).toEqual(f.before);expect(f.ai.sessionPatches).toHaveLength(1);
});
it('removes only the explicitly selected world scope even if legacy scopes share an ID',async()=>{
  const f=await fixture(true),global=vi.spyOn(f.store,'writeGlobalGuidance');
  await f.service.removeBehaviorPatch(f.rule.id,{...f.request,scope:'world'});
  expect((await f.store.read())!.behavior_patches).toEqual([]);expect(global).not.toHaveBeenCalled();
  expect(f.ai.globalPatches).toHaveLength(1);expect(f.ai.sessionPatches).toHaveLength(1);
  const after=await f.store.read(),writes=vi.spyOn(f.store,'write');
  await f.service.removeBehaviorPatch(f.rule.id,{...f.request,scope:'world'});
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(after);
});
it('does not silently move an existing guidance ID to another persistence scope',async()=>{
  const f=await fixture();await f.service.putBehaviorPatch(f.rule);const before=await f.store.read(),writes=vi.spyOn(f.store,'writeGlobalGuidance');
  await expect(f.service.putBehaviorPatch({...f.rule,scope:'global'})).rejects.toThrow('范围');
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(before);
});
it.each(['put','remove'] as const)('reconciles global guidance memory from disk after a saved %s response is lost',async operation=>{
  const f=await fixture(),rule=patch('global');await f.service.putBehaviorPatch(rule);
  const write=f.store.writeGlobalGuidance.bind(f.store);
  vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async rules=>{await write(rules);throw Error('global response lost');});
  await expect(operation==='put'?f.service.putBehaviorPatch({...rule,enabled:false}):f.service.removeBehaviorPatch(rule.id)).rejects.toThrow('response lost');
  expect(await f.service.behaviorGuidance()).toEqual(f.store.global);expect(await f.store.read()).toEqual(f.before);
});
it('does not serve stale global guidance while disk authority cannot be checked',async()=>{
  const f=await fixture(),rule=patch('global');await f.service.putBehaviorPatch(rule);
  const write=f.store.writeGlobalGuidance.bind(f.store);
  vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async rules=>{await write(rules);throw Error('global response lost');});
  const read=vi.spyOn(f.store,'readGlobalGuidance').mockRejectedValue(Error('global read unavailable'));
  await expect(f.service.putBehaviorPatch({...rule,enabled:false})).rejects.toThrow('response lost');
  await expect(f.service.behaviorGuidance()).rejects.toThrow('read unavailable');
  read.mockRestore();expect(await f.service.behaviorGuidance()).toEqual(f.store.global);
});
it('shares one in-flight global initialization across concurrent current readers',async()=>{
  const f=await fixture(),service=new GameService(f.store,f.ai,f.before.definition);
  let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const reads=vi.spyOn(f.store,'readGlobalGuidance').mockImplementation(async()=>{arrive();await gate;return [];});
  const first=service.current();await entered;const second=service.current();release();
  await Promise.all([first,second]);expect(reads).toHaveBeenCalledOnce();
});
it('reuses a retained global feedback request without generating a self-override or enabling it again',async()=>{
  const f=await fixture(),rule={...patch('global'),enabled:false};await f.service.putBehaviorPatch(rule);
  const model=vi.spyOn(f.ai,'systemAgent').mockRejectedValue(Error('must not regenerate a retained request'));
  const compiled=await compileBehaviorFeedback(f.service,rule.source_text,rule.id);
  expect(compiled).toMatchObject({kind:'create',patch:rule});expect(model).not.toHaveBeenCalled();
  const writes=vi.spyOn(f.store,'writeGlobalGuidance');
  if(compiled.kind==='create')await f.service.putBehaviorPatch(compiled.patch);
  expect(writes).not.toHaveBeenCalled();
  await expect(compileBehaviorFeedback(f.service,'different input',rule.id)).rejects.toThrow('请求 ID');
});
it('rejects stale world edits and self-overrides before saving',async()=>{
  const f=await fixture();await f.run();const before=await f.store.read(),writes=vi.spyOn(f.store,'write');
  await expect(f.service.putBehaviorPatch(patch(),{...f.request,request_id:randomUUID()})).rejects.toThrow('状态已更新');
  await expect(f.service.putBehaviorPatch({...f.rule,overrides:f.rule.id})).rejects.toThrow('自身');
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(before);
});
it('rejects a competing guidance edit while its first complete world write is in flight',async()=>{
  const f=await fixture();await f.service.putBehaviorPatch(f.rule);const before=await f.service.current(),write=f.store.write.bind(f.store);
  let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{arrive();await gate;await write(save,slot);});
  const request={...f.request,expected_revision:before.state_revision,scope:'world' as const};
  const first=f.service.setBehaviorPatchEnabled(f.rule.id,false,request);
  try{await entered;await expect(f.service.removeBehaviorPatch(f.rule.id,{...request,request_id:randomUUID()})).rejects.toThrow('正在执行');}
  finally{release();}
  await first;expect(writes).toHaveBeenCalledOnce();expect((await f.store.read())!.behavior_patches?.[0].enabled).toBe(false);
});
it('forwards the original System request to world-guidance recovery and skips model regeneration on replay',async()=>{
  const f=await fixture();(f.ai.adapter as {name:string}).name='controlled-offline';
  const model=vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
    if(data&&typeof data==='object'&&'player_request' in data)return {understood:['未来行为指导'],requested_change:'保留最终目标',target_surfaces:[],unresolved:[],entities:[],
      likely_workflow:'behavior_config',style_target:'world',configuration_kind:'behavior_patch',side_effect_class:'configuration',confidence:.95,
      correction:null,clarification:{needed:false,question:'',examples:[]},response_hint:null,narrative_preference:null} as never;
    return {decision:'create',category:'planning',title:f.rule.title,trigger_semantics:f.rule.trigger_semantics,
      preferred_behavior:f.rule.preferred_behavior,anti_pattern:f.rule.anti_pattern,scope:'world',reason:'explicit future guidance',invariant_conflict:false} as never;
  });
  const input='以后不要遗漏最终目标，把这条保存为当前世界的行为指导。',write=f.store.write.bind(f.store);
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('System guidance response lost');});
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},()=>
    handleSystemInput(f.service,{input,...f.request}))).rejects.toThrow('response lost');
  const after=(await f.store.read())!;expect(committedInputReceipts(after,f.recovery)).toEqual([f.request.request_id]);
  fault.mockRestore();model.mockClear();const writes=vi.spyOn(f.store,'write');
  const restarted=new GameService(f.store,f.ai,f.before.definition),replay=await handleSystemInput(restarted,{input,...f.request});
  expect(replay.category).toBe('AI_BEHAVIOR_FEEDBACK');expect(model).not.toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();
});
it.each(['remove','enabled'] as const)('replays a saved world-guidance %s over HTTP after response loss and restart',async operation=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'agf-guidance-http-')),store=new JsonStore(directory);
  await store.write(f.before);const service=new GameService(store,new AIRuntime(new MockAIAdapter()),f.before.definition);
  await service.putBehaviorPatch(f.rule);const before=await service.current();
  const body={scope:'world',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),...(operation==='enabled'?{enabled:false}:{})};
  let server=createApp(service).listen(0,'127.0.0.1');
  const post=async(value:unknown=body)=>{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
    const response=await fetch(`${base}/api/system/behavior-guidance/${f.rule.id}/${operation}`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(value)});
    return {status:response.status,body:await response.json()};
  };
  try{
    await once(server,'listening');const write=store.write.bind(store);
    const fault=vi.spyOn(store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('HTTP guidance response lost');});
    expect((await post()).status).toBe(503);const after=(await store.read())!;
    expect(after.runtime.receipts.some(receipt=>receipt.id===body.request_id)).toBe(true);fault.mockRestore();
    server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    const disk=new JsonStore(directory),restarted=new GameService(disk,new AIRuntime(new MockAIAdapter()),f.before.definition),writes=vi.spyOn(disk,'write');
    server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
    const replay=await post();expect(replay.status).toBe(200);expect(replay.body.view.revision).toBe(after.state_revision);
    expect(writes).not.toHaveBeenCalled();expect(await disk.read()).toEqual(after);
    expect((await post({...body,scope:'global'})).status).toBeGreaterThanOrEqual(400);expect(writes).not.toHaveBeenCalled();
    if(operation==='enabled')expect((await post({...body,request_id:randomUUID(),enabled:'false'})).status).toBe(400);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import type {BehaviorPatch} from '../src/ai/guidance.js';
import {guidanceRecordId} from '../src/recovery/guidance-request.js';
import {handleSystemInput} from '../src/system/agent.js';
import {once} from 'node:events';
import {createApp} from '../src/server/app.js';
import * as router from '../src/system/context-router.js';
import * as executor from '../src/agent/executor.js';
const directories:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function fixture(scope:'global'|'session'){
 const f=await sparseSetup(),before=await f.service.current(),directory=await mkdtemp(join(tmpdir(),'agf-guidance-identity-'));directories.push(directory);
 const store=new JsonStore(directory);await store.write(before);
 const restart=()=>new GameService(store,new AIRuntime(new MockAIAdapter()),before.definition);
 const service=restart(),rule:BehaviorPatch={id:randomUUID(),version:1,scope,category:'planning',title:'保留目标',
 trigger_semantics:'future plans',preferred_behavior:'Keep the original final goal',anti_pattern:'Do not substitute preparation',
 optional_exemplar:null,priority:5,enabled:true,created_at:'2026-10-20T00:00:00.000Z',source_text:'以后保留最终目标',overrides:null};
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 return {before,store,service,rule,request,restart};
}
it.each(['global','session'] as const)('does not recreate a deleted %s rule when its identified creation is replayed after restart',async scope=>{
 const f=await fixture(scope);await f.service.putBehaviorPatch(f.rule,f.request);
 await f.service.removeBehaviorPatch(f.rule.id,{...f.request,request_id:randomUUID(),scope});
 const service=f.restart(),writes=vi.spyOn(f.store,'writeGlobalGuidance');
 await service.putBehaviorPatch(f.rule,f.request);
 expect(await service.behaviorGuidance()).toEqual([]);expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
});
it.each(['global','session'] as const)('rejects reuse of an identified %s request for changed arguments after deletion',async scope=>{
 const f=await fixture(scope);await f.service.putBehaviorPatch(f.rule,f.request);await f.service.removeBehaviorPatch(f.rule.id,{scope});
 await expect(f.restart().putBehaviorPatch({...f.rule,enabled:false},f.request)).rejects.toThrow('请求 ID');
});
it.each(['global','session'] as const)('recovers original %s source text before model work after deletion and restart',async scope=>{
 const f=await fixture(scope);await f.service.putBehaviorPatch(f.rule,f.request,f.rule.source_text);
 await f.service.removeBehaviorPatch(f.rule.id,{scope});
 const restarted=f.restart();expect(await restarted.recoverSystemConfigurationRequest(f.rule.source_text,f.request)).toMatchObject({kind:'guidance'});
 await expect(restarted.recoverSystemConfigurationRequest('different input',f.request)).rejects.toThrow('请求 ID');
 expect(await restarted.behaviorGuidance()).toEqual([]);
});
it.each([['global','remove'],['global','enabled'],['session','remove'],['session','enabled']] as const)('replays identified %s %s after the rule disappears',async(scope,operation)=>{
 const f=await fixture(scope);await f.service.putBehaviorPatch(f.rule);
 const request={...f.request,scope};
 const run=(service:GameService)=>operation==='remove'?service.removeBehaviorPatch(f.rule.id,request):service.setBehaviorPatchEnabled(f.rule.id,false,request);
 await run(f.service);await f.service.removeBehaviorPatch(f.rule.id,{scope});
 const restarted=f.restart(),writes=vi.spyOn(f.store,'writeGlobalGuidance');
 await expect(run(restarted)).resolves.toBeDefined();expect(writes).not.toHaveBeenCalled();expect(await restarted.behaviorGuidance()).toEqual([]);
});
it.each(['before','after'] as const)('never starts global effects when the intent journal fails %s its save',async point=>{
 const f=await fixture('global'),write=f.store.writeInputRecord.bind(f.store),effects=vi.spyOn(f.store,'writeGlobalGuidance');
 const fault=vi.spyOn(f.store,'writeInputRecord').mockImplementation(async record=>{if(point==='after')await write(record);throw Error('intent flush failed');});
 await expect(f.service.putBehaviorPatch(f.rule,f.request)).rejects.toMatchObject({retry_policy:'do_not_replay'});
 expect(effects).not.toHaveBeenCalled();expect(await f.store.readGlobalGuidance()).toEqual([]);fault.mockRestore();
 if(point==='after')await expect(f.restart().putBehaviorPatch(f.rule,f.request)).rejects.toMatchObject({status:409,retry_policy:'do_not_replay'});
 else await f.restart().putBehaviorPatch(f.rule,f.request);
 expect(effects).toHaveBeenCalledTimes(point==='after'?0:1);
});
it.each(['before','after'] as const)('does not repeat a global effect after its completed record flush fails %s saving',async point=>{
 const f=await fixture('global'),write=f.store.writeInputRecord.bind(f.store);
 const fault=vi.spyOn(f.store,'writeInputRecord').mockImplementation(async record=>{
  if(record.state!=='completed')return write(record);
  if(point==='after')await write(record);throw Error('terminal response lost');
 });
 await expect(f.service.putBehaviorPatch(f.rule,f.request)).rejects.toMatchObject({retry_policy:'do_not_replay'});
 expect(await f.store.readGlobalGuidance()).toEqual([f.rule]);fault.mockRestore();
 await f.service.removeBehaviorPatch(f.rule.id,{scope:'global'});const effects=vi.spyOn(f.store,'writeGlobalGuidance');
 const replay=f.restart().putBehaviorPatch(f.rule,f.request);
 if(point==='before')await expect(replay).rejects.toMatchObject({status:409});else await replay;
 expect(effects).not.toHaveBeenCalled();expect(await f.store.readGlobalGuidance()).toEqual([]);
});
it.each(['before','after'] as const)('retains a failed global effect result %s its atomic save and does not retry after restart',async point=>{
 const f=await fixture('global'),write=f.store.writeGlobalGuidance.bind(f.store);
 const fault=vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async patches=>{
  if(point==='after')await write(patches);throw Error('global effect failed');
 });
 await expect(f.service.putBehaviorPatch(f.rule,f.request)).rejects.toMatchObject({status:503,message:'global effect failed',retry_policy:'do_not_replay'});
 expect(await f.service.behaviorGuidance()).toEqual(point==='after'?[f.rule]:[]);fault.mockRestore();
 const effects=vi.spyOn(f.store,'writeGlobalGuidance');
 await expect(f.restart().putBehaviorPatch(f.rule,f.request)).rejects.toMatchObject({status:503,message:'global effect failed',retry_policy:'do_not_replay'});
 expect(effects).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
});
it('leaves a stranded intent safe when both the effect and failure-result flush throw',async()=>{
 const f=await fixture('global'),write=f.store.writeInputRecord.bind(f.store);
 vi.spyOn(f.store,'writeInputRecord').mockImplementation(record=>record.state==='failed'?Promise.reject(Error('failure journal unavailable')):write(record));
 const fault=vi.spyOn(f.store,'writeGlobalGuidance').mockRejectedValue(Error('original global failure'));
 await expect(f.service.putBehaviorPatch(f.rule,f.request)).rejects.toThrow('original global failure');fault.mockRestore();
 const effects=vi.spyOn(f.store,'writeGlobalGuidance');
 await expect(f.restart().putBehaviorPatch(f.rule,f.request)).rejects.toMatchObject({status:409,retry_policy:'do_not_replay'});
 expect(effects).not.toHaveBeenCalled();
});
it('waits for a live configuration request before System replay and rejects changed source identity',async()=>{
 const f=await fixture('global'),write=f.store.writeGlobalGuidance.bind(f.store);
 let arrive!:()=>void,release!:()=>void;
 const entered=new Promise<void>(done=>{arrive=done;}),gate=new Promise<void>(done=>{release=done;});
 const effects=vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async patches=>{arrive();await gate;await write(patches);});
 const first=f.service.putBehaviorPatch(f.rule,f.request,f.rule.source_text);await entered;
 const replay=handleSystemInput(f.service,{...f.request,input:f.rule.source_text});
 const changed=f.service.recoverSystemConfigurationRequest('different text',f.request);
 // Attach rejection handling before releasing the first request.
 const changedResult=expect(changed).rejects.toThrow('请求 ID');release();
 await first;expect((await replay).category).toBe('AI_BEHAVIOR_FEEDBACK');await changedResult;expect(effects).toHaveBeenCalledOnce();
});
it('does not reuse the HTTP parent record or overwrite a foreign child record',async()=>{
 const f=await fixture('global'),parent={version:1 as const,game_id:f.before.game_id,request_id:f.request.request_id,
  fingerprint:'a'.repeat(64),state:'completed' as const,started_at:1,response:{original:'parent'}};
 await f.store.writeInputRecord(parent);await f.service.putBehaviorPatch(f.rule,f.request);
 expect(await f.store.readInputRecord(f.before.game_id,f.request.request_id)).toEqual(parent);
 const request={...f.request,request_id:randomUUID()},child=guidanceRecordId(f.before.game_id,request.request_id);
 await f.store.writeInputRecord({...parent,request_id:child});const effects=vi.spyOn(f.store,'writeGlobalGuidance');
 await expect(f.service.putBehaviorPatch({...f.rule,enabled:false},request)).rejects.toThrow('请求 ID');expect(effects).not.toHaveBeenCalled();
});
it('keeps session guidance process-local while persisting request identity',async()=>{
 const f=await fixture('session');await f.service.putBehaviorPatch(f.rule,f.request);
 expect(await f.service.behaviorGuidance()).toHaveLength(1);
 const restarted=f.restart();await restarted.putBehaviorPatch(f.rule,f.request);
 expect(await restarted.behaviorGuidance()).toEqual([]);expect(await f.store.readGlobalGuidance()).toEqual([]);expect(await f.store.read()).toEqual(f.before);
});
it('rejects a game mismatch before a global effect',async()=>{
 const f=await fixture('global'),effects=vi.spyOn(f.store,'writeGlobalGuidance');
 await expect(f.service.putBehaviorPatch(f.rule,{...f.request,game_id:randomUUID()})).rejects.toThrow('游戏已切换');expect(effects).not.toHaveBeenCalled();
});
it.each(['global','session'] as const)('replays a deleted %s System submission over real local HTTP without model work',async scope=>{
 const f=await fixture(scope);await f.service.putBehaviorPatch(f.rule,f.request,f.rule.source_text);await f.service.removeBehaviorPatch(f.rule.id,{scope});
 const restarted=f.restart(),model=vi.spyOn(restarted.ai,'systemAgent').mockRejectedValue(Error('must not invoke model'));
 const server=createApp(restarted).listen(0,'127.0.0.1');
 try{
  await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const {token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/system',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
   body:JSON.stringify({...f.request,input:f.rule.source_text})});
  expect(response.status).toBe(200);expect((await response.json()).category).toBe('AI_BEHAVIOR_FEEDBACK');expect(model).not.toHaveBeenCalled();
  expect(await restarted.behaviorGuidance()).toEqual([]);
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
it('persists an HTTP input failure without mistaking an unchanged world revision for unchanged global configuration',async()=>{
 const f=await fixture('global');
 vi.spyOn(router,'routeContext').mockResolvedValue({destination:'WORLD_INTENT',semantic:{kind:'world_action'},resolved_input:f.rule.source_text} as never);
 const execute=vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
  await f.service.putBehaviorPatch(f.rule,f.request,f.rule.source_text);throw Error('unexpected success');
 });
 const write=f.store.writeGlobalGuidance.bind(f.store),fault=vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async patches=>{
  await write(patches);throw Error('saved global response lost');
 });
 let server=createApp(f.service).listen(0,'127.0.0.1');
 const post=async()=>{
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({...f.request,input:f.rule.source_text})});
  return {status:response.status,body:await response.json()};
 };
 try{
  await once(server,'listening');const first=await post();
  expect(first.status).toBe(503);expect(first.body.retry_policy).toBe('do_not_replay');
  expect(first.body.outcome).toMatchObject({stage:'guidance_configuration',state_certain:false,receipt_ids:[]});
  expect(first.body.error).toContain('配置可能已经保存');expect(await f.store.read()).toEqual(f.before);
  expect(await f.store.readGlobalGuidance()).toEqual([f.rule]);fault.mockRestore();
  for(let i=0;i<100;i++){if((await f.store.readInputRecord(f.before.game_id,f.request.request_id))?.state==='failed')break;await new Promise(done=>setTimeout(done,5));}
  expect((await f.store.readInputRecord(f.before.game_id,f.request.request_id))?.state).toBe('failed');
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));server=createApp(f.restart()).listen(0,'127.0.0.1');await once(server,'listening');
  expect(await post()).toEqual(first);expect(execute).toHaveBeenCalledOnce();expect(await f.store.readGlobalGuidance()).toEqual([f.rule]);
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
it('returns do_not_replay from the management HTTP route after a saved global removal fails',async()=>{
 const f=await fixture('global');await f.service.putBehaviorPatch(f.rule);
 const write=f.store.writeGlobalGuidance.bind(f.store),fault=vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async patches=>{await write(patches);throw Error('removal response lost');});
 const server=createApp(f.service).listen(0,'127.0.0.1');
 try{
  await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(`${base}/api/system/behavior-guidance/${f.rule.id}/remove`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({...f.request,scope:'global'})});
  expect(response.status).toBe(503);expect((await response.json()).retry_policy).toBe('do_not_replay');expect(await f.store.readGlobalGuidance()).toEqual([]);fault.mockRestore();
  await expect(f.restart().removeBehaviorPatch(f.rule.id,{...f.request,scope:'global'})).rejects.toMatchObject({status:503,message:'removal response lost'});
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
const journalCases=(['global','session'] as const).flatMap(scope=>(['put','enabled','remove'] as const).flatMap(operation=>
 (['running','completed'] as const).flatMap(state=>(['before','after'] as const).map(point=>({scope,operation,state,point})))));
it.each(journalCases)('safely handles $scope $operation when $state journal fails $point saving',async({scope,operation,state,point})=>{
 const f=await fixture(scope);if(operation!=='put')await f.service.putBehaviorPatch(f.rule);
 const write=f.store.writeInputRecord.bind(f.store),effects=vi.spyOn(f.store,'writeGlobalGuidance');
 const fault=vi.spyOn(f.store,'writeInputRecord').mockImplementation(async record=>{
  if(record.state!==state)return write(record);
  if(point==='after')await write(record);throw Error('boundary failure');
 });
 const request={...f.request,scope},run=(service:GameService)=>operation==='put'?service.putBehaviorPatch(f.rule,request):
  operation==='enabled'?service.setBehaviorPatchEnabled(f.rule.id,false,request):service.removeBehaviorPatch(f.rule.id,request);
 await expect(run(f.service)).rejects.toMatchObject({retry_policy:'do_not_replay'});
 if(state==='running'){
  expect(effects).not.toHaveBeenCalled();expect(await f.service.behaviorGuidance()).toEqual(operation==='put'?[]:[f.rule]);
 }else expect(await f.service.behaviorGuidance()).toEqual(operation==='remove'?[]:[{...f.rule,enabled:operation!=='enabled'}]);
 fault.mockRestore();const writes=effects.mock.calls.length;
 if(state==='running'&&point==='before')return; // No durable intent and no effect: a later explicit request can start safely.
 const replay=run(f.restart());
 if(state==='completed'&&point==='after')await replay;else await expect(replay).rejects.toMatchObject({status:409});
 expect(effects).toHaveBeenCalledTimes(writes);expect(await f.store.read()).toEqual(f.before);
});
it.each(['enabled','remove'] as const)('never repeats global %s after its effect fails before or after saving',async operation=>{
 for(const point of ['before','after'] as const){
  const f=await fixture('global');await f.service.putBehaviorPatch(f.rule);
  const write=f.store.writeGlobalGuidance.bind(f.store),fault=vi.spyOn(f.store,'writeGlobalGuidance').mockImplementation(async patches=>{
   if(point==='after')await write(patches);throw Error('effect boundary failure');
  });
  const run=(service:GameService)=>operation==='remove'?service.removeBehaviorPatch(f.rule.id,{...f.request,scope:'global'}):service.setBehaviorPatchEnabled(f.rule.id,false,{...f.request,scope:'global'});
  await expect(run(f.service)).rejects.toMatchObject({status:503,retry_policy:'do_not_replay'});fault.mockRestore();
  const writes=vi.spyOn(f.store,'writeGlobalGuidance');await expect(run(f.restart())).rejects.toThrow('effect boundary failure');expect(writes).not.toHaveBeenCalled();writes.mockRestore();
 }
});

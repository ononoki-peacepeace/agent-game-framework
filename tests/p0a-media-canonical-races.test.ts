import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import type {SavePackage} from '../src/core/schema.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';

afterEach(()=>vi.restoreAllMocks());
const kinds=['style','preferences','guidance','calendar','module','activity','clarification'] as const;
type Kind=typeof kinds[number];
async function fixture(){
  const mock=new MockAIAdapter(),f=await sparseSetup(request=>mock.generate(request)),before=await f.service.current();
  const player=before.player_state.entity_id,request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const edit=(kind:Kind)=>{
    if(kind==='style')return f.service.setBehaviorConfig({scope:'narration',rule:{op:'suffix',value:'END'}},request);
    if(kind==='preferences')return f.service.setNarrativePreferences({scopes:['narration'],tone:'natural',allowed_topics:[]},request);
    if(kind==='guidance')return f.service.putBehaviorPatch({id:randomUUID(),version:1,scope:'world',category:'planning',title:'保留目标',
      trigger_semantics:'multi-step',preferred_behavior:'Preserve final objective',anti_pattern:'Do not drop it',optional_exemplar:null,
      priority:5,enabled:true,created_at:'2026-10-20T00:00:00.000Z',source_text:'保留目标',overrides:null},request);
    if(kind==='calendar')return f.service.configureCalendar({...before.calendar!,source:'media-race'},request.game_id,request.expected_revision,request.request_id);
    if(kind==='module')return f.service.manageModule({...request,module:'map',confirmed:true},'disable');
    if(kind==='activity')return f.service.performDeclaredActivity({...request,activity_id:'sleep'});
    return f.service.updateWorldClarification(before.game_id,before.state_revision,{input:'那个',question:'指谁？',created_revision:before.state_revision,at:1});
  };
  const applied=(save:SavePackage,kind:Kind)=>kind==='style'?save.behavior_config.some(rule=>rule.value==='END'):
    kind==='preferences'?save.behavior_config.some(rule=>rule.value==='natural'):kind==='guidance'?!!save.behavior_patches?.length:
    kind==='calendar'?save.calendar?.source==='media-race':kind==='module'?save.modules.map?.enabled===false:
    kind==='activity'?save.runtime.time.minute===480:!!save.pending_world_clarification;
  return {...f,before,player,request,edit,applied,avatar:()=>f.service.setAvatar(player,'new_avatar',before.game_id)};
}
it.each(kinds)('does not discard a concurrent avatar when %s starts its canonical save first',async kind=>{
  const f=await fixture(),write=f.store.write.bind(f.store);let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(save.entities.find(entity=>entity.id===f.player)!.components.identity.avatar_id!=='new_avatar'){arrive();await gate;}
    await write(save,slot);
  });
  const editing=f.edit(kind);await entered;const media=f.avatar();
  await new Promise<void>(resolve=>setImmediate(resolve));release();await Promise.all([editing,media]);
  const after=(await f.store.read())!;
  expect(after.entities.find(entity=>entity.id===f.player)!.components.identity.avatar_id).toBe('new_avatar');
  expect(f.applied(after,kind)).toBe(true);
});
it.each(kinds)('does not discard a committed %s edit when the avatar save starts first',async kind=>{
  const f=await fixture(),write=f.store.write.bind(f.store);let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(save.entities.find(entity=>entity.id===f.player)!.components.identity.avatar_id==='new_avatar'){arrive();await gate;}
    await write(save,slot);
  });
  const media=f.avatar();await entered;const editing=f.edit(kind).then(value=>({value,error:null}),error=>({value:null,error}));
  await new Promise<void>(resolve=>setImmediate(resolve));release();await media;const outcome=await editing,after=(await f.store.read())!;
  expect(after.entities.find(entity=>entity.id===f.player)!.components.identity.avatar_id).toBe('new_avatar');
  if(outcome.error)expect(outcome.error.message).toMatch(/状态已更新|State changed/);
  else if(outcome.value!==false)expect(f.applied(after,kind)).toBe(true);
});
it.each(['newGame','load','import'] as const)('does not let an older avatar save resurrect the previous world after %s',async mode=>{
  const f=await fixture();if(mode==='load')await f.service.checkpoint();
  const write=f.store.write.bind(f.store);let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{if(save.game_id===f.before.game_id){arrive();await gate;}await write(save,slot);});
  const media=f.avatar();await entered;
  const replacing=mode==='newGame'?f.service.newGame():mode==='load'?f.service.load():f.service.import(f.before.definition);
  await new Promise<void>(resolve=>setImmediate(resolve));release();await Promise.all([media,replacing]);
  expect((await f.store.read())!.game_id).not.toBe(f.before.game_id);
});
it('keeps an idle migrated read from overwriting a newly assigned avatar',async()=>{
  const f=await fixture(),legacy=structuredClone(f.before);delete legacy.routine_meta;await f.store.write(legacy);
  const write=f.store.write.bind(f.store);let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(save.entities.find(entity=>entity.id===f.player)!.components.identity.avatar_id!=='new_avatar'){arrive();await gate;}await write(save,slot);
  });
  const migrating=f.service.current();await entered;const media=f.avatar();await new Promise<void>(resolve=>setImmediate(resolve));
  release();await Promise.all([migrating,media]);const after=(await f.store.read())!;
  expect(after.entities.find(entity=>entity.id===f.player)!.components.identity.avatar_id).toBe('new_avatar');expect(after.routine_meta).toBeDefined();
});
it('matches a long-turn receipt after an avatar advances revision during narration and the turn response is lost',async()=>{
  const f=await fixture(),narrate=f.ai.narrate.bind(f.ai);let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.ai,'narrate').mockImplementation(async(...args)=>{arrive();await gate;return narrate(...args);});
  const write=f.store.write.bind(f.store);
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);if(save.runtime.receipts.some(receipt=>receipt.id===f.request.request_id))throw Error('turn response lost');});
  const recovery:InputRecovery={original_player_input:'等一分钟',trace_id:'media-during-turn',transactions:[]},persist=vi.fn(async()=>{});
  const running=withInputRecovery({game_id:f.before.game_id,recovery,persist},()=>f.service.turn({...f.request,action:{type:'WAIT',parameters:{minutes:1}}}));
  const terminal=running.catch(error=>error);await entered;
  try{await f.avatar();}finally{release();}
  expect((await terminal).message).toContain('response lost');const after=(await f.store.read())!;
  expect(after.state_revision).toBe(f.before.state_revision+2);expect(committedInputReceipts(after,recovery)).toEqual([f.request.request_id]);
  expect(after.runtime.time.minute).toBe(f.before.runtime.time.minute+1);fault.mockRestore();const writes=vi.spyOn(f.store,'write');
  await f.service.turn({...f.request,action:{type:'WAIT',parameters:{minutes:1}}});expect(writes).not.toHaveBeenCalled();
});
it.each(['avatar','fullbody'] as const)('normalizes legacy %s in its own media write while a routine lease is active',async kind=>{
  const f=await fixture(),legacy=structuredClone(f.before);delete legacy.routine_meta;await f.store.write(legacy);
  f.service.routineLease='offline-test-lease';const writes=vi.spyOn(f.store,'write');
  if(kind==='avatar')await f.avatar();else await f.service.setVisualAsset(f.player,'fullbody','new_body',f.before.game_id);
  const after=(await f.store.read())!;expect(after.routine_meta).toBeDefined();expect(writes).toHaveBeenCalledOnce();
  expect(after.state_revision).toBe(f.before.state_revision+1);
});
it('keeps HTTP failure/replay consistent after a mid-narration avatar commit and a lost world response across restart',async()=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'agf-media-turn-http-')),store=new JsonStore(directory);
  await store.write(f.before);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,f.before.definition);
  const narrate=ai.narrate.bind(ai);let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(ai,'narrate').mockImplementation(async(...args)=>{arrive();await gate;return narrate(...args);});
  const body={...f.request,input:'等待1分钟'},write=store.write.bind(store);
  const fault=vi.spyOn(store,'write').mockImplementation(async(save,slot)=>{
    await write(save,slot);if(save.runtime.time.minute>f.before.runtime.time.minute)throw Error('HTTP world response lost');
  });
  let server=createApp(service).listen(0,'127.0.0.1');
  const post=async()=>{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,{token}=await(await fetch(base+'/api/session')).json();
    const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  try{
    await once(server,'listening');const running=post();await entered;
    try{await service.setAvatar(f.player,'new_avatar',f.before.game_id);}finally{release();}
    const first=await running;expect(first.status).toBe(503);const after=(await store.read())!,record=await store.readInputRecord(body.game_id,body.request_id);
    const committed=committedInputReceipts(after,record?.recovery);expect(committed.length).toBeGreaterThan(0);
    expect(first.body.outcome.receipt_ids).toEqual(committed);expect(first.body.outcome.state_certain).toBe(true);fault.mockRestore();
    server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    const disk=new JsonStore(directory),restarted=new GameService(disk,new AIRuntime(new MockAIAdapter()),f.before.definition),writes=vi.spyOn(disk,'write');
    server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
    expect(await post()).toEqual(first);expect(writes).not.toHaveBeenCalled();expect(await disk.read()).toEqual(after);
  }finally{release();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}
});

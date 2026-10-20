import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {createApp} from '../src/server/app.js';
import {fresh} from './helpers.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'agf-calendar-recovery-')),store=new JsonStore(directory),initial=fresh();await store.write(initial);
 const service=new GameService(store,new AIRuntime(new MockAIAdapter()),initial.definition),before=await service.current();
 const calendar={version:1 as const,anchor_day:before.runtime.time.day,anchor_month:2,anchor_date:3,anchor_weekday:4,
  month_lengths:[31,28,31,30,31,30,31,31,30,31,30,31],source:'玩家确认日期映射'};
 const id=randomUUID(),recovery:InputRecovery={original_player_input:'确认日期映射',trace_id:'calendar-recovery',transactions:[]};
 const configure=(target=service,value=calendar)=>target.configureCalendar(value,before.game_id,before.state_revision,id);
 return {directory,store,service,before,calendar,id,recovery,configure,close:()=>rm(directory,{recursive:true,force:true})};
}
it('recovers a calendar write whose response was lost using its real receipt, without writing again after restart',async()=>{
 const f=await fixture();try{
  const write=f.store.write.bind(f.store),persist=vi.fn(async()=>{});
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('calendar response lost');});
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist},()=>f.configure())).rejects.toThrow('calendar response lost');
  const after=(await f.store.read())!;expect(committedInputReceipts(after,f.recovery)).toEqual([f.id]);expect(persist).toHaveBeenCalledOnce();
  expect(after.runtime.time).toEqual(f.before.runtime.time);fault.mockRestore();
  const restartedStore=new JsonStore(f.directory),restarted=new GameService(restartedStore,f.service.ai,f.before.definition),writes=vi.spyOn(restartedStore,'write');
  expect((await f.configure(restarted)).revision).toBe(after.state_revision);expect(writes).not.toHaveBeenCalled();
  expect(await restartedStore.read()).toEqual(after);
 }finally{await f.close();}
});
it('does not write a calendar if the parent prepare journal fails, then permits a safe same-ID retry',async()=>{
 const f=await fixture();try{
  const writes=vi.spyOn(f.store,'write'),persist=vi.fn(async()=>{throw Error('calendar prepare failed');});
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist},()=>f.configure())).rejects.toThrow('calendar prepare failed');
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.before);
  await withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:async()=>{}},()=>f.configure());
  expect(committedInputReceipts((await f.store.read())!,f.recovery)).toEqual([f.id]);
 }finally{await f.close();}
});
it('returns an existing calendar request before stale-revision validation and rejects changed arguments',async()=>{
 const f=await fixture();try{
  await f.configure();const after=await f.store.read(),writes=vi.spyOn(f.store,'write');
  await f.configure();expect(writes).not.toHaveBeenCalled();
  await expect(f.configure(f.service,{...f.calendar,anchor_date:4})).rejects.toThrow('请求 ID');
  expect(await f.store.read()).toEqual(after);
 }finally{await f.close();}
});
it('forwards calendar request identity through HTTP and safely retries a lost commit response after restart',async()=>{
 const f=await fixture();let server=createApp(f.service).listen(0,'127.0.0.1');
 try{
  await once(server,'listening');
  const body={calendar:f.calendar,game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:f.id};
  const post=async()=>{
   const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
   const {token}=await (await fetch(base+'/api/session')).json();
   const response=await fetch(base+'/api/calendar',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
   return {status:response.status,body:await response.json()};
  };
  const write=f.store.write.bind(f.store),fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('HTTP calendar response lost');});
  expect((await post()).status).toBe(503);const after=(await f.store.read())!;
  expect(after.runtime.receipts.some(receipt=>receipt.id===f.id)).toBe(true);fault.mockRestore();
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
  const store=new JsonStore(f.directory),restarted=new GameService(store,f.service.ai,f.before.definition),writes=vi.spyOn(store,'write');
  server=createApp(restarted).listen(0,'127.0.0.1');await once(server,'listening');
  const replay=await post();expect(replay.status).toBe(200);expect(replay.body.revision).toBe(after.state_revision);
  expect(writes).not.toHaveBeenCalled();expect(await store.read()).toEqual(after);
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.close();}
});

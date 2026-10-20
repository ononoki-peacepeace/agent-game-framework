import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {withInputRecovery,type InputRecovery} from '../src/recovery/request-context.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;await f.store.write(legacy);
  const request={game_id:legacy.game_id,expected_revision:legacy.state_revision,request_id:randomUUID()};
  return {...f,legacy,request};
}
it.each(['current','view'] as const)('does not overwrite a newer canonical commit when a stale %s read needs migration',async method=>{
  const f=await fixture(),read=f.store.read.bind(f.store);
  let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.store,'read').mockImplementationOnce(async slot=>{const snapshot=await read(slot);arrive();await gate;return snapshot;});
  const reading=f.service[method]();await entered;
  let committed;
  try{await f.service.setBehaviorConfig({scope:'narration',rule:{op:'suffix',value:'保留'}},f.request);committed=await read();}
  finally{release();}
  await reading;
  expect(await read()).toEqual(committed);expect((await read())!.runtime.receipts.some(r=>r.id===f.request.request_id)).toBe(true);
});
it('keeps legacy normalization inside its parent mutation when the parent journal fails',async()=>{
  const f=await fixture(),writes=vi.spyOn(f.store,'write');
  const recovery:InputRecovery={original_player_input:'设置旁白风格',trace_id:'migration-parent',transactions:[]};
  await expect(withInputRecovery({game_id:f.legacy.game_id,recovery,persist:async()=>{throw Error('migration parent journal down');}},()=>
    f.service.setBehaviorConfig({scope:'narration',rule:{op:'suffix',value:'保留'}},f.request))).rejects.toThrow('journal down');
  expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(f.legacy);
});
it('does not persist a concurrent migrated projection while a canonical write owns the mutation lock',async()=>{
  const f=await fixture(),write=f.store.write.bind(f.store);
  let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(save.gm_state.flags.retained){arrive();await gate;}await write(save,slot);
  });
  const mutation=f.service.agentTransaction(f.request,{flag:'retained'},save=>{save.gm_state.flags.retained=true;});
  try{
    await entered;await f.service.view();
    expect(writes).toHaveBeenCalledOnce();expect(await f.store.read()).toEqual(f.legacy);
  }finally{release();}
  await mutation;
  const after=(await f.store.read())!;expect(after.gm_state.flags.retained).toBe(true);expect(after.routine_meta).toBeDefined();
});
it.each(['current','view'] as const)('releases the migration lock after a failed %s persistence and can recover',async method=>{
  const f=await fixture(),fault=vi.spyOn(f.store,'write').mockRejectedValue(Error('migration disk down'));
  await expect(f.service[method]()).rejects.toThrow('disk down');expect(await f.store.read()).toEqual(f.legacy);
  fault.mockRestore();await f.service[method]();const after=(await f.store.read())!;
  expect(after.routine_meta).toBeDefined();expect(after.state_revision).toBe(f.legacy.state_revision);
  expect(after.runtime).toEqual(f.legacy.runtime);
});

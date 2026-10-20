import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';
import {worldImage} from '../src/core/turn-history.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(mode:'undo'|'restore'){
  const adapter=new MockAIAdapter(),f=await sparseSetup(request=>adapter.generate(request)),turn=async()=>{
    const save=await f.service.current();return f.service.turn({request_id:randomUUID(),game_id:save.game_id,
      expected_revision:save.state_revision,action:{type:'WAIT',parameters:{minutes:1}}});
  };
  const initial=await f.service.current();await turn();const first=await f.service.current();
  if(mode==='restore')await turn();
  const before=await f.service.current(),request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
  const recovery:InputRecovery={original_player_input:mode,trace_id:'history-recovery',transactions:[]};
  const persist=vi.fn(async()=>{}),run=()=>mode==='undo'?f.service.undo(request):
    f.service.restoreTurn({...request,turn_id:first.active_turn_id!});
  return {...f,before,request,recovery,persist,run,target:mode==='undo'?initial:first};
}
it.each(['undo','restore'] as const)('preserves %s authority when its storage response is lost',async mode=>{
  const f=await fixture(mode),write=f.store.write.bind(f.store);
  const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('history response lost');});
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},f.run))
    .rejects.toThrow('response lost');
  const after=(await f.store.read())!;
  expect(f.persist).toHaveBeenCalledOnce();
  expect(committedInputReceipts(after,f.recovery)).toEqual([f.request.request_id]);
  expect(worldImage(after)).toEqual(worldImage(f.target));
  expect(after.state_revision).toBe(f.before.state_revision+1);
  fault.mockRestore();const writes=vi.spyOn(f.store,'write');await f.run();
  expect(writes).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(after);
});
it.each(['undo','restore'] as const)('does not perform %s after a failed parent intent journal',async mode=>{
  const f=await fixture(mode),writes=vi.spyOn(f.store,'write');
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:async()=>{throw Error('history journal down');}},f.run))
    .rejects.toThrow('journal down');
  expect(writes).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.before);
  expect(f.recovery.transactions).toEqual([]);
});
it.each(['undo','restore'] as const)('leaves %s uncommitted on a storage failure and remains usable',async mode=>{
  const f=await fixture(mode),fault=vi.spyOn(f.store,'write').mockRejectedValue(Error('history disk unavailable'));
  await expect(withInputRecovery({game_id:f.before.game_id,recovery:f.recovery,persist:f.persist},f.run))
    .rejects.toThrow('disk unavailable');
  expect(f.persist).toHaveBeenCalledOnce();expect(await f.service.current()).toEqual(f.before);
  expect(committedInputReceipts(f.before,f.recovery)).toEqual([]);
  fault.mockRestore();await f.run();expect(worldImage(await f.service.current())).toEqual(worldImage(f.target));
});

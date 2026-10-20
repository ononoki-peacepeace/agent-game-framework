import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';
import {withInputRecovery,committedInputReceipts,type InputRecovery} from '../src/recovery/request-context.js';

afterEach(()=>vi.restoreAllMocks());
it.each(['before','after'] as const)('propagates a System module %s-write failure to authoritative request recovery',async(point)=>{
 const f=await sparseSetup(),before=await f.service.current(),write=f.store.write.bind(f.store);
 const input='我不需要生活模式了。',recovery:InputRecovery={original_player_input:input,trace_id:'system-module-fault',transactions:[]};
 const persist=vi.fn(async()=>{});
 const fault=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
  if(point==='before')throw Error('module world write failed before commit');
  await write(save,slot);throw Error('module response lost after commit');
 });
 await expect(withInputRecovery({game_id:before.game_id,recovery,persist},()=>handleSystemInput(f.service,{
  input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
 }))).rejects.toThrow(point==='before'?'before commit':'after commit');
 expect(persist).toHaveBeenCalledOnce();expect(recovery.transactions).toHaveLength(1);
 const after=(await f.store.read())!;
 expect(committedInputReceipts(after,recovery)).toEqual(point==='after'?[recovery.transactions[0].request_id]:[]);
 expect(after.runtime.time).toEqual(before.runtime.time);
 if(point==='before')expect(after).toEqual(before);
 else{expect(after.state_revision).toBe(before.state_revision+1);expect(after.definition.enabled_modules).not.toContain('routine');}
 fault.mockRestore();
 const following=await handleSystemInput(f.service,{input:'继续生活。'});
 expect(following.session?.status).toBe('completed');expect(await f.store.read()).toEqual(after);
});

import {expect,it,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';
afterEach(()=>vi.restoreAllMocks());
it('presents settled compound fallback as paragraphs while retaining every ordered fact and one settlement',async()=>{
 const f=await sparseSetup(),before=await f.service.current(),steps=['伸个懒腰','整理桌面'];
 vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
 vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'候选',minutes:2,target_id:null,facts:[],relationship:null,
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'普通局部活动',stages:[],evidence_ids:[]}});
 const narrator=vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','fixed prose capture'));
 const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:steps.join('，再')};
 await f.service.turn(request,undefined,undefined,undefined,false,undefined,steps);
 const after=await f.service.current(),text=after.last_turn!.narrative;
 expect(text).not.toMatch(/^\d+、/m);expect(text).toContain('\n\n');
 for(const step of steps)expect(text).toContain(step);
 expect(text.indexOf(steps[0])).toBeLessThan(text.indexOf(steps[1]));
 expect(after.state_revision).toBe(before.state_revision+1);
 expect(after.runtime.time.minute-before.runtime.time.minute).toBe(4);
 const calls=narrator.mock.calls.length;
 await f.service.turn(request,undefined,undefined,undefined,false,undefined,steps);
 expect(await f.service.current()).toEqual(after);expect(narrator).toHaveBeenCalledTimes(calls);
},30000);

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
it.each([0,1].flatMap(due=>['refusal','content_filter'].map(reason=>({due,reason}))))('fallback preserves the actual handoff after $due minutes on $reason',async({due,reason})=>{
 const f=await sparseSetup(),before=await f.service.current();
 before.entities.find(e=>e.id===before.player_state.entity_id)!.components.opportunities={entries:{fallback_appointment:{status:'accepted',title:'已经接受的会面'}}};
 before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'fallback_appointment',label:'已经接受的会面',at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,window:'exact',status:'accepted',source:'explicit prior appointment',resolved:false}]};
 await f.store.write(before);vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError(reason,'controlled offline narration failure','narration unavailable'));
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:5}}};
 await f.service.turn(request);const after=await f.service.current(),text=after.last_turn!.narrative;
 expect(after.resolution_receipts).toHaveLength(1);expect(after.resolution_receipts![0].time_cost).toBe(due);
 expect(text).toContain('已经接受的会面');
 if(due===0)expect(text).not.toMatch(/等了一会|等了\d+分钟/);
 else expect(text).toContain('等了1分钟');
 expect(text).not.toMatch(/等了5分钟|Core|receipt|fallback_appointment/);
 expect(after.last_turn?.presentation?.status).toBe('degraded');
 await f.service.turn(request);expect(await f.service.current()).toEqual(after);
});
it('ordinary waiting fallback retains actual elapsed minutes without inventing an obstacle',async()=>{
 const f=await sparseSetup(),before=await f.service.current();
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','controlled offline narration failure','narration unavailable'));
 await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:5}}});
 const after=await f.service.current();expect(after.last_turn?.narrative).toBe('你等了5分钟。');expect(after.foreground?.blocker).toBeFalsy();
});

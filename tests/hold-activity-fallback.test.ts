import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {executeAction} from '../src/core/runtime.js';
import {canonicalResolutionNarrative} from '../src/core/narrative-firewall.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
const activity='整理手头的资料';
const hold=(minutes=5)=>({type:'HOLD',parameters:{minutes,activity}});
async function setup(due:number|null){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 if(due!==null){
  before.entities.find(e=>e.id===before.player_state.entity_id)!.components.opportunities={entries:{hold_meeting:{status:'accepted',title:'已经接受的会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'hold_meeting',label:'已经接受的会面',at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,window:'exact',status:'accepted',source:'explicit prior appointment',resolved:false}]};
 }
 await f.store.write(before);return {...f,before};
}
it.each([0,1].flatMap(due=>(['refusal','content_filter'] as const).map(reason=>({due,reason}))))('describes actual HOLD activity and unfinished handoff after $due minutes/$reason',async({due,reason})=>{
 const f=await setup(due);vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError(reason,'offline fixture','描写未完成'));
 const body={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),action:hold()};
 await f.service.turn(body);const after=await f.service.current(),text=after.last_turn!.narrative,receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
 expect(receipt.time_cost).toBe(due);expect(text).toContain(activity);expect(text).toContain('已经接受的会面');
 expect(text).not.toContain('已到安排时间：');
 expect(after.foreground).toMatchObject({blocker:'task',reason:'已到安排时间：已经接受的会面'});
 expect(text).not.toMatch(/完成|已登记|结算|生成|hold_meeting|5分钟/);expect(text).toMatch(due===0?/尚未|还没|停/:/1分钟/);
 expect(after.last_turn!.presentation?.status).toBe('degraded');expect(after.state_revision).toBe(f.before.state_revision+1);
 await f.service.turn(body);expect(await f.service.current()).toEqual(after);
});
it('describes the actual full activity interval without certifying a larger goal',async()=>{
 const f=await setup(null);vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
 await f.service.turn({game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),action:hold()});
 const after=await f.service.current(),text=after.last_turn!.narrative;expect(text).toContain(activity);expect(text).toContain('5分钟');expect(text).not.toMatch(/完成|暂停|停了|程序|结算/);expect(after.foreground?.blocker).toBeFalsy();
});
it('retains the actual interrupt event and sixty elapsed minutes rather than requested120',async()=>{
 const f=await setup(null);f.before.definition.events.push({id:'hold_interrupt',hook:'on_time_advance',location_id:null,probability:1,once:true,public_text:'需要你回应的邀请到了。',set_flag:null,interrupt_automation:true});await f.store.write(f.before);
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
 await f.service.turn({game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),action:hold(120)});
 const after=await f.service.current(),text=after.last_turn!.narrative;expect(after.resolution_receipts!.at(-1)!.time_cost).toBe(60);expect(text).toContain(activity);expect(text).toContain('60分钟');expect(text).toContain('需要你回应的邀请到了');expect(text).not.toMatch(/120分钟|完成/);
 expect(after.event_state.fired).toContain('hold_interrupt');expect(after.event_roll_history?.filter(r=>r.event_id==='hold_interrupt')).toHaveLength(1);
});
it('replays the exact interrupted activity prose after actual disk/service recreation',async()=>{
 const f=await setup(1),directory=await mkdtemp(join(tmpdir(),'agf-hold-prose-'));
 try{
  const store=new JsonStore(directory);await store.write(f.before);const service=new GameService(store,f.ai,f.before.definition);
  vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
  const body={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),action:hold()};
  await service.turn(body);const after=await service.current(),bytes=await readFile(join(directory,'current.json'));expect(after.last_turn!.narrative).toContain(activity);expect(after.last_turn!.narrative).toContain('1分钟');
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}}),restarted=new GameService(new JsonStore(directory),ai,f.before.definition);
  await restarted.turn(body);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('uses actual receipt time conservatively when a long activity fact was truncated',async()=>{
 const f=await setup(null),turn=executeAction(f.before,{type:'HOLD',parameters:{minutes:5,activity:'整理资料'.repeat(125)}},randomUUID());
 const text=canonicalResolutionNarrative(turn.save.resolution_receipts!.at(-1)!,false);expect(text).toContain('5分钟');expect(text).not.toMatch(/完成|已登记|结算/);
});
it('retains the HOLD activity and following speech in actual compound order',async()=>{
 const mock=new MockAIAdapter(),f=await sparseSetup(r=>mock.generate(r)),before=await f.service.current();before.definition.events=[];await f.store.write(before);
 vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>input===activity?hold():{type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}});
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
 await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:activity+'，再问好'},undefined,undefined,undefined,false,undefined,[activity,'问好']);
 const after=await f.service.current(),text=after.last_turn!.narrative;expect(text).toContain(activity);expect(text).toContain('5分钟');expect(text.indexOf(activity)).toBeLessThan(text.indexOf('开了口'));expect(text).not.toMatch(/实际经过|当前位置持续进行|完成|结算/);
});

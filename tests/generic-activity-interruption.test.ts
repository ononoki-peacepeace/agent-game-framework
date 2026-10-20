import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';
import {executeFreeform} from '../src/core/freeform.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

afterEach(()=>vi.restoreAllMocks());
const input='整理手头的值班记录十分钟';
const proposal={narrative:'未结算的候选',minutes:10,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'整理记录',stages:[],evidence_ids:[]}};
async function setup(due:number|null){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 if(due!==null){
  before.entities.find(e=>e.id==='player')!.components.opportunities={entries:{activity_meeting:{status:'accepted',title:'已经接受的值班会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'activity_meeting',label:'已经接受的值班会面',
   at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 await f.store.write(before);vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
 return {...f,before};
}
it.each([0,1].flatMap(due=>(['refusal','content_filter'] as const).map(reason=>({due,reason}))))(
 'stops a pure ordinary activity after actual $due minutes/$reason without inventory or reward effects',async({due,reason})=>{
 const f=await setup(due);vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError(reason,'offline fixture','降级'));
 const body={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input};
 await f.service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
 const after=await f.service.current(),receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
 expect(receipt.time_cost).toBe(due);expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);
 if(due===0){expect(receipt.activity).toBeUndefined();expect(receipt.effects).not.toContain('activity');}
 expect(receipt.effects).not.toContain('inventory');expect(receipt.effects).not.toContain('money');
 const text=after.last_turn!.narrative;expect(text).toContain('已经接受的值班会面');expect(text).not.toMatch(/十分钟|10分钟|完成|程序|结算/);
 expect(text).toMatch(due===0?/尚未|还没|停/:/1分钟/);expect(after.foreground?.blocker).toBe('task');
 await f.service.turn(body);expect(await f.service.current()).toEqual(after);
});
it.each([0,1])('commits actual %s-minute interval as game progress and blocks dependent TALK, not engine failure',async due=>{
 const f=await setup(due);vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
 const activity:GoalInput={goal_id:'activity',type:'WORLD_ACTION',normalized_goal:input,operation_hint:'activity',referent:'值班记录',
  target_entities:[],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const talk:GoalInput={...activity,goal_id:'talk',type:'WORLD_SPEECH',normalized_goal:'向林舟问好',operation_hint:'talk',referent:'林舟',depends_on:['activity']};
 const original=input+'，再向林舟问好',plan=compileGoalContract(publicView(f.before),validatePlan({goals:[activity,talk]}),{kind:'manual',text:original});
 const result=await executePlan(f.service,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input:original},plan),after=await f.service.current();
 expect(result.outcome.type).toBe('game');expect(result.plan?.goals.map(g=>g.status)).toEqual(['blocked','pending']);
 expect(result.outcome.receipt_ids.length).toBeGreaterThan(0);if(result.outcome.type==='game')expect(result.outcome.completed_steps).toEqual([]);
 if(result.outcome.type==='game')expect(result.outcome.goal_status).toBe(due===0?'unresolved':'partial');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual([input]);
 expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);expect(result.message).toMatch(/未完成|暂停/);
});
it('stops at an actual authored event segment instead of advancing requested120',async()=>{
 const f=await setup(null);f.before.definition.events.push({id:'activity_interrupt',hook:'on_time_advance',location_id:null,probability:1,once:true,
  public_text:'值班邀请已经到了。',set_flag:null,interrupt_automation:true});
 const turn=executeFreeform(f.before,'整理值班记录两小时',{...proposal,minutes:120},randomUUID());
 expect(turn.action.time_cost).toBe(60);expect(turn.save.runtime.time.minute-f.before.runtime.time.minute).toBe(60);
 expect(turn.save.foreground?.reason).toBe('值班邀请已经到了。');expect(turn.save.event_roll_history?.filter(r=>r.event_id==='activity_interrupt')).toHaveLength(1);
 expect(turn.save.resolution_receipts!.at(-1)!.activity?.duration_minutes).toBe(60);
});
it.each([null,10])('retains a fully elapsed activity when appointment is %s minutes away',async due=>{
 const f=await setup(due),turn=executeFreeform(f.before,input,proposal,randomUUID());expect(turn.action.time_cost).toBe(10);
 expect(turn.save.resolution_receipts!.at(-1)!.activity?.duration_minutes).toBe(10);
 expect(turn.save.resolution_receipts!.at(-1)!.canonical_facts.join(' ')).not.toContain('本次普通活动因');
});

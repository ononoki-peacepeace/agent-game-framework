import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {ProviderError} from '../src/ai/failures.js';
import {executeAction} from '../src/core/runtime.js';
import {interruptedActivity} from '../src/core/completion-evidence.js';
import {interruptedHoldFact} from '../src/core/completion-evidence.js';
import {canonicalResolutionNarrative} from '../src/core/narrative-firewall.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const activity='整理'+'值班记录'.repeat(120)+'十分钟';
async function setup(due:number|null){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{familiarity:60}}};
 if(due!==null){
  before.entities.find(e=>e.id==='player')!.components.opportunities={entries:{long_activity_meeting:{status:'accepted',title:'已经接受的会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'long_activity_meeting',label:'已经接受的会面',
   at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 await f.store.write(before);return {...f,before:await f.service.current()};
}
const hold={type:'HOLD',parameters:{minutes:10,activity}};
it.each([0,1])('keeps authoritative interruption evidence for a truncated HOLD label at %s minutes',async due=>{
 const f=await setup(due),turn=executeAction(f.before,hold,randomUUID()),receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(receipt.time_cost).toBe(due);expect(receipt.canonical_facts.some(fact=>fact.length===500)).toBe(true);
 expect(interruptedActivity(receipt)).toBe(true);
 expect(receipt.canonical_facts).toContain(interruptedHoldFact(due));
 const text=canonicalResolutionNarrative(receipt,false);
 expect(text).toMatch(due===0?/尚未开始/:/1分钟便停/);expect(text).not.toMatch(/完成|十分钟|10分钟/);
});
it.each([0,1])('persists long HOLD interruption and replays without generation at %s minutes',async due=>{
 const f=await setup(due),directory=await mkdtemp(join(tmpdir(),'agf-long-hold-'));
 try{
  const store=new JsonStore(directory);await store.write(f.before);const service=new GameService(store,f.ai,f.before.definition);
  vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
  const body={game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),action:hold};
  const response=await service.turn(body),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
  expect(receipt.time_cost).toBe(due);expect(interruptedActivity(receipt)).toBe(true);
  expect(after.last_turn!.narrative).toContain('已经接受的会面');expect(after.last_turn!.narrative).not.toMatch(/完成|10分钟|十分钟/);
  const ai=new AIRuntime({name:'no-replay-generation',generate:async()=>{throw Error('Replay generated');}});
  const restarted=new GameService(new JsonStore(directory),ai,f.before.definition);
  expect(await restarted.turn(body)).toEqual(response);expect(await restarted.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('requires an exact Core pause fact consistent with actual time and successful HOLD',async()=>{
 const f=await setup(1),receipt=executeAction(f.before,hold,randomUUID()).save.resolution_receipts!.at(-1)!;
 const fact=interruptedHoldFact(1);
 expect(interruptedActivity({...receipt,canonical_facts:[fact]})).toBe(true);
 expect(interruptedActivity({...receipt,canonical_facts:[interruptedHoldFact(2)]})).toBe(false);
 expect(interruptedActivity({...receipt,canonical_facts:['声称：'+fact]})).toBe(false);
 expect(interruptedActivity({...receipt,canonical_facts:[fact],semantic_action:'WAIT'})).toBe(false);
 expect(interruptedActivity({...receipt,canonical_facts:[fact],outcome:'failure'})).toBe(false);
 expect(canonicalResolutionNarrative({...receipt,canonical_facts:[fact]},true)).not.toContain('1分钟便停');
 expect(interruptedActivity({...receipt,canonical_facts:['在当前位置持续进行「整理」，实际经过 1 分钟，因需要处理的事情而暂停']})).toBe(true);
});
it.each([0,1])('does not complete conditional long HOLD or its dependent TALK at %s minutes',async due=>{
 const f=await setup(due),base:GoalInput={goal_id:'condition',type:'CONDITIONAL_INTENT',normalized_goal:'判断我和林舟是否熟悉',target_entities:[],depends_on:[],
  condition:{kind:'familiar',entity_id:'npc_lin',description:'我和林舟比较熟'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}};
 const goals=[base,{...base,goal_id:'activity',type:'WORLD_ACTION' as const,normalized_goal:activity,operation_hint:'activity' as const,
  referent:'值班记录',condition:null,depends_on:['condition'],branch:'then' as const},
  {...base,goal_id:'speech',type:'WORLD_SPEECH' as const,normalized_goal:'向林舟问好',operation_hint:'talk' as const,
   referent:'林舟',condition:null,depends_on:['activity']}];
 const input='如果我和林舟比较熟，就'+activity+'，再向林舟问好',plan=compileGoalContract(publicView(f.before),validatePlan({goals}),{kind:'manual',text:input});
 vi.spyOn(f.ai,'interpret').mockResolvedValue(hold);vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
 const result=await executePlan(f.service,{game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID(),input},plan);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','blocked','skipped']);
 expect(result.outcome).toMatchObject({type:'game',kind:due===0?'interrupted':'partial_progress',completed_steps:[]});
 expect((await f.service.current()).resolution_receipts?.filter(r=>r.actor_id==='player')).toHaveLength(1);
 expect(result.story).not.toMatch(/完成|10分钟|十分钟/);expect(result.story).toContain('已经接受的会面');
});
it.each([null,10])('does not misclassify fully elapsed long HOLD, due=%s',async due=>{
 const f=await setup(due),turn=executeAction(f.before,hold,randomUUID()),receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(receipt.time_cost).toBe(10);expect(interruptedActivity(receipt)).toBe(false);
});

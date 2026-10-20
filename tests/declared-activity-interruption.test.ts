import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import type {SavePackage} from '../src/core/schema.js';
import {executeOpenWorldGoal} from '../src/agent/affordances.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

const credits=(save:SavePackage)=>Number((save.entities.find(e=>e.id===save.player_state.entity_id)!.components.wallet as {balances:Record<string,number>}).balances.credit);
const clock=(save:SavePackage)=>save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
async function fixture(due:number|null,activity='work'){
 let decisions=0;
 const f=await sparseSetup(async r=>{
  if((r.schema as {properties?:Record<string,unknown>}).properties?.decision)return {data:{decision:decisions++?'done':'act',candidate_id:decisions===1?'activity:'+activity:null,reason:'controlled activity',ambiguity:null}};
  throw Error('Unexpected provider stage '+r.role);
 });
 const save=await f.service.current();save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location={location_id:activity==='sleep'?'square':'station'};
 if(due!==null)save.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'appointment',label:'需要玩家处理的约定',at:clock(save)+due,window:'exact',status:'accepted',source:'explicit test appointment',resolved:false}]};
 await f.store.write(save);return {...f,before:save,decisions:()=>decisions};
}
it.each([0,1,60])('does not grant the full 120-minute work reward when interrupted after %i minutes',async due=>{
 const f=await fixture(due),request={activity_id:'work',game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()};
 await f.service.performDeclaredActivity(request);const after=await f.service.current();
 expect(clock(after)-clock(f.before)).toBe(due);expect(credits(after)).toBe(credits(f.before));
 expect(after.foreground?.blocker).toBe('task');expect(after.last_turn?.narrative).not.toContain('completed');
 await f.service.performDeclaredActivity(request);expect(await f.service.current()).toEqual(after);
});
it('does not grant full sleep recovery when only one minute elapsed',async()=>{
 const f=await fixture(1,'sleep');await f.service.performDeclaredActivity({activity_id:'sleep',game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 const after=await f.service.current();expect(clock(after)-clock(f.before)).toBe(1);
 expect(after.entities.find(e=>e.id===after.player_state.entity_id)!.components.condition?.stamina).toBe(50);
});
it.each([null,120])('retains the full declared work reward when the duration actually completes: %s',async due=>{
 const f=await fixture(due);await f.service.performDeclaredActivity({activity_id:'work',game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()});
 const after=await f.service.current();expect(clock(after)-clock(f.before)).toBe(120);expect(credits(after)-credits(f.before)).toBe(8);
});
it('stops the open goal at an interrupted activity without certifying original-goal completion',async()=>{
 const f=await fixture(1),result=await executeOpenWorldGoal(f.service,f.before,'想办法挣钱',randomUUID()),after=await f.service.current();
 expect(result.ok).toBe(false);expect(credits(after)).toBe(credits(f.before));expect(clock(after)-clock(f.before)).toBe(1);
 expect(f.decisions()).toBe(1);expect(result.message).toContain('尚未完成');
});
it('retains the actual interrupt event and elapsed time without granting full work effects',async()=>{
 const f=await fixture(null),before=await f.service.current();
 before.definition.events.push({id:'activity_interrupt',hook:'on_time_advance',location_id:null,probability:1,once:true,public_text:'需要你回应的邀请到了。',set_flag:null,interrupt_automation:true});
 await f.store.write(before);await f.service.performDeclaredActivity({activity_id:'work',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()});
 const after=await f.service.current();expect(clock(after)-clock(before)).toBe(60);expect(credits(after)).toBe(credits(before));
 expect(after.foreground?.blocker).toBe('interrupt');expect(after.event_state.fired).toContain('activity_interrupt');
 expect(after.event_roll_history?.filter(r=>r.event_id==='activity_interrupt')).toHaveLength(1);
});
it.each([0,1,120])('replays the exact settled activity after JsonStore/service restart without new effects: %i',async due=>{
 const f=await fixture(due),directory=await mkdtemp(join(tmpdir(),'agf-activity-interrupt-'));
 try{
  const store=new JsonStore(directory);await store.write(f.before);
  const ai=new AIRuntime({name:'offline-no-generation',generate:async()=>{throw Error('No provider allowed');}});
  const first=new GameService(store,ai,f.before.definition),request={activity_id:'work',game_id:f.before.game_id,expected_revision:f.before.state_revision,request_id:randomUUID()};
  await first.performDeclaredActivity(request);const after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));
  expect(credits(after)-credits(f.before)).toBe(due===120?8:0);expect(clock(after)-clock(f.before)).toBe(due);
  const restarted=new GameService(new JsonStore(directory),ai,f.before.definition);await restarted.performDeclaredActivity(request);
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

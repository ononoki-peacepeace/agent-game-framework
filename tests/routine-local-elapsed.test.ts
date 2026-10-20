import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {absoluteTime} from '../src/routine/calendar.js';
import {routineOf,sparseStep} from '../src/routine/scheduler.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

async function fixture(activity:'work'|'sleep',interrupt:boolean){
 const f=await sparseSetup(),before=await f.service.current();
 await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
  action:{type:'START_ROUTINE',parameters:{label:'既定生活',pattern:'按世界规则工作和睡眠'}}},undefined,undefined,undefined,true);
 const save=await f.service.current();save.runtime.time.minute=activity==='work'?960:0;
 save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location={location_id:activity==='work'?'station':'square'};
 if(interrupt)save.definition.events.push({id:'local_elapsed_interrupt',hook:'on_time_advance',location_id:null,probability:1,once:true,public_text:'有需要回应的事情。',set_flag:null,interrupt_automation:true});
 return {...f,save};
}
it.each(['work','sleep'] as const)('local %s block progress counts actual Core time after interruption',async activity=>{
 const f=await fixture(activity,true),before=structuredClone(f.save),after=await sparseStep(f.save,f.ai,absoluteTime(f.save)+1440);
 expect(absoluteTime(after)-absoluteTime(before)).toBe(60);
 expect(routineOf(after).block_progress).toMatchObject({minutes:60});
 expect(routineOf(after).elapsed_minutes).toBe(60);expect(routineOf(after).completed_blocks??[]).toEqual([]);
 expect(routineOf(after).interrupted).toBe(true);expect(after.foreground?.blocker).toBe('interrupt');
});
it.each([30,60])('an uninterrupted local work horizon counts exactly %i minutes',async duration=>{
 const f=await fixture('work',false),after=await sparseStep(f.save,f.ai,absoluteTime(f.save)+duration);
 expect(routineOf(after).block_progress).toMatchObject({minutes:duration});expect(routineOf(after).elapsed_minutes).toBe(duration);
});
it('retains actual prefix and interrupted work credit across disk restart before an explicit continuation',async()=>{
 const f=await fixture('work',false),directory=await mkdtemp(join(tmpdir(),'agf-local-elapsed-'));
 const credits=(s:typeof f.save)=>Number((s.entities.find(e=>e.id===s.player_state.entity_id)!.components.wallet.balances as Record<string,number>).credit);
 try{
  let save=await sparseStep(f.save,f.ai,absoluteTime(f.save)+30);
  save.definition.events.push({id:'local_prefix_interrupt',hook:'on_time_advance',location_id:null,probability:1,once:true,public_text:'有需要回应的事情。',set_flag:null,interrupt_automation:true});
  save=await sparseStep(save,f.ai,absoluteTime(save)+1440);
  expect(routineOf(save).block_progress).toMatchObject({key:'1:work',minutes:90});expect(routineOf(save).elapsed_minutes).toBe(90);
  expect(credits(save)).toBe(credits(f.save));
  const store=new JsonStore(directory);await store.write(save);const bytes=await readFile(join(directory,'current.json'));
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Local routine needs no model');}}),service=new GameService(new JsonStore(directory),ai,save.definition);
  expect(await service.current()).toEqual(save);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  // Explicit test-side acknowledgement of the foreground event; this is not a new automatic-resume policy.
  const resumed=await service.current();delete resumed.foreground;routineOf(resumed).interrupted=false;routineOf(resumed).active=true;routineOf(resumed).last_interrupt=null;
  const final=await sparseStep(resumed,ai,absoluteTime(resumed)+30);
  expect(absoluteTime(final)-absoluteTime(f.save)).toBe(120);expect(credits(final)-credits(f.save)).toBe(8);
  expect(routineOf(final).elapsed_minutes).toBe(120);expect(routineOf(final).completed_blocks).toEqual(['1:work']);
  expect(routineOf(final).block_progress).toBeUndefined();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

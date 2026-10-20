import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {absoluteTime} from '../src/routine/calendar.js';
import {sparseStep} from '../src/routine/scheduler.js';
import {validateSave} from '../src/core/state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

async function fixture(mode:'closed'|'unknown'|'local'){
 const f=await sparseSetup(),first=await f.service.current();
 await f.service.turn({request_id:randomUUID(),game_id:first.game_id,expected_revision:first.state_revision,
  action:{type:'START_ROUTINE',parameters:{label:'既定生活',pattern:'按世界规则安排生活'}}},undefined,undefined,undefined,true);
 const save=await f.service.current();save.runtime.time.minute=mode==='local'?0:960;
 if(mode==='unknown'){
  for(const place of save.definition.map!.locations)place.known_by_default=place.id==='square';
  save.definition.map!.routes=save.definition.map!.routes.filter(edge=>edge.from==='square');
  save.map_state.known_location_ids=['square'];
 }
 else{save.gm_state.flags.routine_routes_open=false;for(const edge of save.definition.map!.routes)edge.conditions=[{flag:'routine_routes_open',equals:true}];}
 return {...f,save:validateSave(save)};
}
it.each(['closed','unknown'] as const)('does not work at a remote destination when every route is %s',async mode=>{
 const f=await fixture(mode),before=structuredClone(f.save);
 await expect(sparseStep(f.save,f.ai,absoluteTime(f.save)+1440)).rejects.toThrow('没有可通行的已知路线');
 expect(f.save).toEqual(before);
});
it('still performs a local declared activity when no route is usable',async()=>{
 const f=await fixture('local'),after=await sparseStep(f.save,f.ai,absoluteTime(f.save)+1440);
 expect(after.entities.find(e=>e.id===after.player_state.entity_id)!.components.condition.stamina).toBe(66);
 expect(absoluteTime(after)-absoluteTime(f.save)).toBe(480);
});
it.each(['closed','unknown'] as const)('actual %s route refusal preserves disk time, wage and location across restart',async mode=>{
 const f=await fixture(mode),directory=await mkdtemp(join(tmpdir(),'agf-routine-unreachable-'));
 try{
  const store=new JsonStore(directory);await store.write(f.save);const bytes=await readFile(join(directory,'current.json'));
  const ai=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('No model for local blocked route');}}),service=new GameService(store,ai,f.save.definition);
  const request={request_id:randomUUID(),game_id:f.save.game_id,expected_revision:f.save.state_revision,action:{type:'CONTINUE_ROUTINE',parameters:{}}};
  await expect(service.turn(request)).rejects.toThrow('没有可通行的已知路线');
  expect(await store.read()).toEqual(f.save);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const restarted=new GameService(new JsonStore(directory),ai,f.save.definition);
  expect(await restarted.current()).toEqual(f.save);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

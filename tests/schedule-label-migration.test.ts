import {expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {migrateInstalledWorld} from '../src/routine/migration.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';

async function fixture(entry?:{status?:string;title?:string},label='已经接受的会面'){
 const f=await sparseSetup(),save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
 if(entry)player.components.opportunities={entries:{meeting_id:entry}};
 save.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'meeting_id',label,at:1440,window:'exact',status:'accepted',source:'previously authored accepted schedule',resolved:false}]};
 return {...f,save};
}
it.each([undefined,{status:'accepted',title:'   '},{status:'cancelled'}])('preserves authored schedule title when the linked entry has no usable title: %j',async entry=>{
 const f=await fixture(entry),before=structuredClone(f.save),result=migrateInstalledWorld(f.save,[]).save;
 expect(result.routine_meta?.scheduled_tasks[0].label).toBe('已经接受的会面');
 expect(result.runtime).toEqual(before.runtime);expect(result.state_revision).toBe(before.state_revision);
 expect(result.entities).toEqual(before.entities);expect(result.routine_meta?.scheduled_tasks[0].at).toBe(1440);
 const status=entry?.status==='cancelled'?'cancelled':'accepted';expect(result.routine_meta?.scheduled_tasks[0].status).toBe(status);
 const snapshot=structuredClone(result);expect(migrateInstalledWorld(result,[]).save).toEqual(snapshot);
});
it('uses an actual linked title and status in preference to an old schedule label',async()=>{
 const f=await fixture({status:'completed',title:'有来源的新标题'}),result=migrateInstalledWorld(f.save,[]).save;
 expect(result.routine_meta?.scheduled_tasks[0]).toMatchObject({label:'有来源的新标题',status:'completed',resolved:true});
});
it('does not invent a title when only the original ID label exists',async()=>{
 const f=await fixture(undefined,'meeting_id');expect(migrateInstalledWorld(f.save,[]).save.routine_meta?.scheduled_tasks[0].label).toBe('meeting_id');
});
it('preserves a metadata-only schedule through actual disk migration, handoff fallback and restart',async()=>{
 const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'agf-schedule-label-'));
 try{
  const store=new JsonStore(directory);await store.write(f.save);
  const ai=new AIRuntime({name:'offline-refusal',generate:async()=>{throw new ProviderError('refusal','controlled narration refusal','narration unavailable');}});
  const service=new GameService(store,ai,f.save.definition),migrated=await service.current();
  expect(migrated.routine_meta?.scheduled_tasks[0].label).toBe('已经接受的会面');expect(migrated.entities).toEqual(f.save.entities);expect(migrated.runtime).toEqual(f.save.runtime);
  const migratedBytes=await readFile(join(directory,'current.json'));await service.current();expect(await readFile(join(directory,'current.json'))).toEqual(migratedBytes);
  const request={game_id:migrated.game_id,expected_revision:migrated.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:5}}};
  await service.turn(request);const after=await service.current();expect(after.last_turn?.narrative).toContain('已经接受的会面');expect(after.last_turn?.narrative).not.toContain('meeting_id');expect(after.runtime.time).toEqual(migrated.runtime.time);
  const bytes=await readFile(join(directory,'current.json')),offline=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}});
  const restarted=new GameService(new JsonStore(directory),offline,f.save.definition);await restarted.turn(request);
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(offline.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

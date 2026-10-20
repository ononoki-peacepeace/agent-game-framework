import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sparseSetup} from './sparse-fixture.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import * as atomic from '../src/storage/atomic-json.js';
afterEach(()=>vi.restoreAllMocks());
it.each((['current','view'] as const).flatMap(method=>(['canonical','media','same_revision'] as const).map(writer=>({method,writer}))))(
 'keeps second-service $writer commit when delayed first-service $method migration writes',async({method,writer})=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-two-service-migration-'));
 try{
  const storeA=new JsonStore(directory),storeB=new JsonStore(directory);await storeA.write(legacy);
  const first=new GameService(storeA,f.ai,legacy.definition),second=new GameService(storeB,f.ai,legacy.definition);
  let release!:()=>void,arrive!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const write=storeA.writeMigration.bind(storeA);vi.spyOn(storeA,'writeMigration').mockImplementationOnce(async(expected,save)=>{arrive();await gate;return write(expected,save);});
  const migration=first[method]();await entered;
  let committed;
  try{
   if(writer==='canonical')await second.agentTransaction({game_id:legacy.game_id,expected_revision:legacy.state_revision,request_id:randomUUID()},{retained:true},next=>{next.gm_state.flags.second_service_retained=true;});
   else if(writer==='media')await second.setVisualAsset('player','fullbody','migration_test_asset',legacy.game_id,legacy.state_revision);
   else{const replacement=structuredClone(legacy);replacement.gm_state.flags.second_service_retained=true;await storeB.write(replacement);}
   committed=await storeB.read();
   if(writer!=='media')expect(committed!.gm_state.flags.second_service_retained).toBe(true);
   else expect(committed!.entities.find(e=>e.id==='player')!.components.visual_assets.images).toMatchObject({fullbody:'migration_test_asset'});
  }finally{release();}
  await migration;
  const after=(await storeB.read())!;
  if(writer==='same_revision'){
   // A fresh normalization may add only structural routine metadata after detecting
   // a same-revision replacement. The replacement's authority must remain intact.
   expect(after).toMatchObject(committed!);expect(after.routine_meta).toBeDefined();
  }else expect(after).toEqual(committed);
  expect(f.ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('serializes a second instance current write until an already-started migration replacement finishes',async()=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-migration-write-queue-'));
 try{
  const storeA=new JsonStore(directory),storeB=new JsonStore(join(directory,'.'));await storeA.write(legacy);
  const first=new GameService(storeA,f.ai,legacy.definition);
  let release!:()=>void,arrive!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const replace=atomic.replaceWithBoundedRetry;
  const replacements=vi.spyOn(atomic,'replaceWithBoundedRetry').mockImplementationOnce(async(...args)=>{arrive();await gate;await replace(...args);});
  const migration=first.current();await entered;
  const replacement=structuredClone(legacy);replacement.gm_state.flags.queued_writer_retained=true;
  const intended=structuredClone(replacement);
  const writing=storeB.write(replacement);
  replacement.gm_state.flags.mutated_after_enqueue=true;
  try{
   // Both calls have reached the storage API, but only the migration owns rename.
   await new Promise(resolve=>setTimeout(resolve,20));expect(replacements).toHaveBeenCalledTimes(1);
  }finally{release();}
  await migration;await writing;
  expect(await storeA.read()).toEqual(intended);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('releases storage coordination after migration persistence failure without rewriting authority',async()=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-migration-fault-'));
 try{
  const storeA=new JsonStore(directory),storeB=new JsonStore(directory);await storeA.write(legacy);const bytes=await readFile(join(directory,'current.json'));
  const first=new GameService(storeA,f.ai,legacy.definition);
  vi.spyOn(atomic,'replaceWithBoundedRetry').mockRejectedValueOnce(Error('migration rename down'));
  await expect(first.current()).rejects.toThrow('rename down');expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const replacement=structuredClone(legacy);replacement.gm_state.flags.after_failure=true;await storeB.write(replacement);
  const migrated=await first.current();expect(migrated.gm_state.flags.after_failure).toBe(true);expect(migrated.routine_meta).toBeDefined();
  expect((await readdir(directory)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('stops bounded read-migration contention without saving and recovers on a later read',async()=>{
 const f=await sparseSetup(),legacy=await f.service.current();delete legacy.routine_meta;
 const directory=await mkdtemp(join(tmpdir(),'agf-migration-contention-'));
 try{
  const store=new JsonStore(directory);await store.write(legacy);const bytes=await readFile(join(directory,'current.json'));
  const service=new GameService(store,f.ai,legacy.definition),migration=vi.spyOn(store,'writeMigration').mockResolvedValue(false);
  await expect(service.current()).rejects.toMatchObject({status:409});expect(migration).toHaveBeenCalledTimes(3);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);migration.mockRestore();expect((await service.current()).routine_meta).toBeDefined();
 }finally{await rm(directory,{recursive:true,force:true});}
});

import {expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fresh} from './helpers.js';
import {worldImage,worldKeys,imageHash,checkpointTurn,canUndo} from '../src/core/turn-history.js';
import {JsonStore} from '../src/storage/json-store.js';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {createApp} from '../src/server/app.js';
import {saveSchema} from '../src/core/schema.js';

function legacyImage(save:any){
 const copy=structuredClone(save);
 for(const key of Object.keys(copy))if(!(worldKeys as readonly string[]).includes(key))delete copy[key];
 delete copy.runtime.receipts;
 for(const entity of copy.entities){delete entity.components.visual_assets;if(entity.components.identity)delete entity.components.identity.avatar_id;}
 return JSON.parse(JSON.stringify(copy));
}
function stable(value:any):any{return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;}

it('reuses validation only on an isolated fresh read and fully validates modified writes and migrations',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'herne-read-proof-'));
 try{
  const store=new JsonStore(directory),save=fresh();await store.write(save);
  const read=await store.read();expect(store.consumeReadValidation(read!)).toBe(true);
  expect(store.consumeReadValidation(read!)).toBe(false);
  expect(store.consumeReadValidation(structuredClone(read!))).toBe(false);
  read!.player_state.entity_id='missing';await expect(store.write(read!)).rejects.toThrow();
  expect((await store.read())!.player_state.entity_id).toBe(save.player_state.entity_id);
  const service=new GameService(store,new AIRuntime(new MockAIAdapter()),save.definition);
  await service.current();await service.current();
  const spy=vi.spyOn(saveSchema,'safeParse');
  try{await service.current();expect(spy).not.toHaveBeenCalled();
   const old=await store.read();delete old!.routine_meta;await store.write(old!);spy.mockClear();
   expect((await service.current()).routine_meta).toBeDefined();expect(spy).toHaveBeenCalled();
  }finally{spy.mockRestore();}
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('projects only live world fields, preserving old checksums and isolating mutations',()=>{
 const save=fresh(),before=structuredClone(save);
 checkpointTurn(before,save,'prior');
 const expected=legacyImage(save);
 expect(worldImage(save)).toEqual(expected);
 expect(imageHash(save)).toBe(createHash('sha256').update(JSON.stringify(stable(expected))).digest('hex'));
 expect(canUndo(save)).toBe(true);
 Object.defineProperty(save,'turn_audit',{get(){throw Error('excluded history must not be traversed');}});
 const projected=worldImage(save);projected.entities[0].components.identity.name='changed';
 expect(save.entities[0].components.identity.name).not.toBe('changed');
});

it('keeps disk-backed HTTP replay, stale revision protection and Undo consistent across restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'herne-cache-http-'));
 const store=new JsonStore(directory),before=fresh();await store.write(before);
 const service=new GameService(store,new AIRuntime(new MockAIAdapter()),before.definition);
 const server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  const session=await (await fetch(base+'/api/session')).json() as {token:string};
  const headers={'Content-Type':'application/json','X-Game-Token':session.token};
  const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
   action:{type:'MOVE',target_id:'market',parameters:{}}};
  const first=await fetch(base+'/api/action',{method:'POST',headers,body:JSON.stringify(request)});
  expect(first.status).toBe(200);const result=await first.json();
  const after=await store.read();expect(after!.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
  const duplicate=await fetch(base+'/api/action',{method:'POST',headers,body:JSON.stringify(request)});
  expect(duplicate.status).toBe(200);const replay=await duplicate.json();
  expect(replay.revision).toBe(result.revision);expect(replay.time).toEqual(result.time);
  expect(replay.last_turn).toEqual(result.last_turn);
  const stale=await fetch(base+'/api/action',{method:'POST',headers,body:JSON.stringify({...request,request_id:randomUUID()})});
  expect(stale.status).toBeGreaterThanOrEqual(400);
  const restarted=new GameService(new JsonStore(directory),new AIRuntime(new MockAIAdapter()),before.definition);
  await restarted.turn(request);expect((await restarted.current()).runtime.time).toEqual(after!.runtime.time);
  await restarted.undo({request_id:randomUUID(),game_id:before.game_id,expected_revision:after!.state_revision});
  const restored=await restarted.current();expect(restored.runtime.time).toEqual(before.runtime.time);
  expect(restored.entities.find(entity=>entity.id===before.player_state.entity_id)!.components.location)
   .toEqual(before.entities.find(entity=>entity.id===before.player_state.entity_id)!.components.location);
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}
});

it('reuses disk-validated snapshots without sharing mutations and invalidates all file replacements',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'herne-cache-'));
 try{
  const store=new JsonStore(directory),save=fresh();await store.write(save);
  const a=await store.read();a!.state_revision=999;
  expect((await store.read())!.state_revision).toBe(0);
  const text=await readFile(join(directory,'current.json'),'utf8');
  const replaced=JSON.parse(text);replaced.state_revision=7;
  await writeFile(join(directory,'replacement.json'),JSON.stringify(replaced));
  await rename(join(directory,'replacement.json'),join(directory,'current.json'));
  expect((await store.read())!.state_revision).toBe(7);
  await writeFile(join(directory,'current.json'),'{"invalid":true}');
  await expect(store.read()).rejects.toThrow();
  save.state_revision=8;await store.write(save);
  expect((await store.read())!.state_revision).toBe(8);
  await rm(join(directory,'current.json'));
  expect(await store.read()).toBeNull();
 }finally{await rm(directory,{recursive:true,force:true});}
});

import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sparseSetup} from './sparse-fixture.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {ImageAssetRuntime} from '../src/media/image.js';

afterEach(()=>vi.restoreAllMocks());
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const assetId='avatar_'+createHash('sha256').update(png).digest('hex').slice(0,32);
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'agf-late-image-')),f=await sparseSetup(),save=await f.service.current();
 const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
 player.components.identity!.avatar_id='old_avatar';player.components.visual_assets={images:{fullbody:'body_old'}};
 const store=new JsonStore(join(directory,'save'));await store.write(save);
 const service=new GameService(store,f.ai,save.definition);await service.current();
 let release!:()=>void,enter!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
 const generate=vi.fn(async()=>{enter();await gate;return {bytes:png,mime_type:'image/png' as const,provider:'offline-delayed'};});
 service.configureImageGeneration(new ImageAssetRuntime({id:'offline-delayed',availability:async()=>({available:true,reason:null}),generate},join(directory,'assets')));
 return {directory,store,service,save,ai:f.ai,player:player.id,generate,release,entered};
}
it.each(['replace','clear','recrop'] as const)('keeps a newer %s binding when an older provider result arrives',async mode=>{
 const f=await fixture();try{
  const pending=f.service.generateAvatar(f.player,'离线延迟头像',f.save.game_id,f.save.state_revision).then(value=>({value,error:null}),error=>({value:null,error}));
  await f.entered;
  await f.service.setAvatar(f.player,mode==='replace'?'new_avatar':mode==='clear'?null:'old_avatar',f.save.game_id,undefined,
   mode==='recrop'?{crop_version:1,source_asset_id:'body_old',scale:2,offset_x:.1,offset_y:.2}:undefined);
  const authoritative=await f.service.current(),bytes=await readFile(join(f.directory,'save','current.json')),writes=vi.spyOn(f.store,'write');
  f.release();const result=await pending;
  expect(result.error).toMatchObject({status:409});expect(result.value).toBeNull();
  expect(await f.service.current()).toEqual(authoritative);expect(writes).not.toHaveBeenCalled();
  expect(await readFile(join(f.directory,'save','current.json'))).toEqual(bytes);
  expect(await readFile(join(f.directory,'assets','avatars',assetId+'.png'))).toEqual(png);expect(f.generate).toHaveBeenCalledTimes(1);
  const restarted=new GameService(new JsonStore(join(f.directory,'save')),f.ai,f.save.definition);
  expect(await restarted.current()).toEqual(authoritative);expect(await readFile(join(f.directory,'save','current.json'))).toEqual(bytes);
 }finally{f.release();await rm(f.directory,{recursive:true,force:true});}
});
it('checks the target binding after an already queued manual save finishes',async()=>{
 const f=await fixture();let releaseWrite!:()=>void;
 try{
  const pending=f.service.generateAvatar(f.player,'离线延迟头像',f.save.game_id,f.save.state_revision).then(value=>({value,error:null}),error=>({value:null,error}));
  await f.entered;
  const write=f.store.write.bind(f.store);let enter!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{enter();await gate;return write(save,slot);});
  const manual=f.service.setAvatar(f.player,'queued_avatar',f.save.game_id);await entered;
  f.release();await new Promise<void>(resolve=>setImmediate(resolve));releaseWrite();await manual;
  const authoritative=await f.service.current(),bytes=await readFile(join(f.directory,'save','current.json')),result=await pending;
  expect(result.error).toMatchObject({status:409});expect(result.value).toBeNull();expect(writes).toHaveBeenCalledTimes(1);
  expect(authoritative.entities.find(entity=>entity.id===f.player)!.components.identity!.avatar_id).toBe('queued_avatar');
  expect(await readFile(join(f.directory,'save','current.json'))).toEqual(bytes);expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{f.release();releaseWrite?.();await rm(f.directory,{recursive:true,force:true});}
});
it('keeps the new game when a previous-world provider result arrives',async()=>{
 const f=await fixture();try{
  const pending=f.service.generateAvatar(f.player,'离线延迟头像',f.save.game_id,f.save.state_revision).then(value=>({value,error:null}),error=>({value:null,error}));
  await f.entered;await f.service.newGame();const authoritative=await f.service.current(),bytes=await readFile(join(f.directory,'save','current.json'));
  f.release();const result=await pending;expect(result.error).toMatchObject({status:409});expect(result.value).toBeNull();
  expect(authoritative.game_id).not.toBe(f.save.game_id);expect(await f.service.current()).toEqual(authoritative);
  expect(await readFile(join(f.directory,'save','current.json'))).toEqual(bytes);expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{f.release();await rm(f.directory,{recursive:true,force:true});}
});
it.each(['unrelated-avatar','world-config'] as const)('still binds after an unrelated %s revision while the target avatar is unchanged',async mode=>{
 const f=await fixture();try{
  const pending=f.service.generateAvatar(f.player,'离线延迟头像',f.save.game_id,f.save.state_revision);
  await f.entered;
  if(mode==='unrelated-avatar')await f.service.setAvatar('npc_lin','other_avatar',f.save.game_id);
  else await f.service.setBehaviorConfig({scope:'narration',rule:{op:'suffix',value:'END'}});
  const changed=await f.service.current();f.release();const result=await pending,after=await f.service.current();
  expect(result.artifact.asset_id).toBe(assetId);expect(after.entities.find(entity=>entity.id===f.player)!.components.identity!.avatar_id).toBe(assetId);
  expect(after.state_revision).toBe(changed.state_revision+1);
  if(mode==='unrelated-avatar')expect(after.entities.find(entity=>entity.id==='npc_lin')!.components.identity!.avatar_id).toBe('other_avatar');
  else expect(after.behavior_config.some(rule=>rule.value==='END')).toBe(true);
  expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{f.release();await rm(f.directory,{recursive:true,force:true});}
});

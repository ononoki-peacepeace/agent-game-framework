import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ImageAssetRuntime} from '../src/media/image.js';
import {sparseSetup} from './sparse-fixture.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const assetId='avatar_'+createHash('sha256').update(png).digest('hex').slice(0,32);
async function fixture(existing:Buffer|null){
 const root=await mkdtemp(join(tmpdir(),'agf-existing-image-')),assets=join(root,'assets'),path=join(assets,'avatars',assetId+'.png');
 if(existing){await mkdir(join(assets,'avatars'),{recursive:true});await writeFile(path,existing);}
 const generate=vi.fn(async()=>({bytes:png,mime_type:'image/png' as const,provider:'offline-image',model:'fixed'}));
 const runtime=new ImageAssetRuntime({id:'offline-image',availability:async()=>({available:true,reason:null}),generate},assets);
 return {root,path,runtime,generate};
}
it.each(['truncated','wrong_content'] as const)('does not bind a content-addressed asset with existing %s bytes',async mode=>{
 const corrupt=mode==='truncated'?png.subarray(0,12):Buffer.concat([png,Buffer.from('different bytes')]),f=await fixture(corrupt);
 try{
  const initial=await sparseSetup(),before=await initial.service.current(),store=new JsonStore(join(f.root,'save'));await store.write(before);
  const service=new GameService(store,initial.ai,before.definition);service.configureImageGeneration(f.runtime);
  const bytes=await readFile(join(f.root,'save','current.json'));
  await expect(service.generateAvatar('player','离线测试头像',before.game_id,before.state_revision)).rejects.toThrow(/资产|图片|校验/);
  expect(await readFile(f.path)).toEqual(corrupt);expect(await service.current()).toEqual(before);
  expect(await readFile(join(f.root,'save','current.json'))).toEqual(bytes);expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it.each([false,true])('retains valid new/existing content-addressed bytes, existing=%s',async existing=>{
 const f=await fixture(existing?png:null);
 try{
  const result=await f.runtime.generateAndPersist({prompt:'离线测试头像',usage:'avatar'});
  expect(result).toMatchObject({asset_id:assetId,provider:'offline-image',model:'fixed'});expect(await readFile(f.path)).toEqual(png);
  expect(f.generate).toHaveBeenCalledTimes(1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

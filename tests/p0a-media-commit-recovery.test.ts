import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../src/server/app.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {fresh} from './helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'agf-media-commit-')),store=new JsonStore(join(directory,'save'));
  const service=new GameService(store,new AIRuntime(new MockAIAdapter()),fresh().definition);await service.newGame();
  const generate=vi.fn(async()=>({bytes:png,mime_type:'image/png' as const,provider:'offline-media'}));
  const server=createApp(service,undefined,undefined,join(directory,'assets'),{},
    {imageProvider:{id:'offline-media',availability:async()=>({available:true,reason:null}),generate}}).listen(0,'127.0.0.1');
  await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const {token}=await(await fetch(base+'/api/session')).json();const before=await service.current();
  return {directory,store,service,base,token,before,generate,
    headers:{'Content-Type':'image/png','X-Game-Token':token,'X-Game-Id':before.game_id,'X-Game-Revision':String(before.state_revision)},
    close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}};
}
describe('P0-A media persistence safety',()=>{
  it.each(['avatar','visual'] as const)('retains the referenced %s bytes when the world write commits then throws',async kind=>{
    const f=await fixture();try{
      const write=f.store.write.bind(f.store),projecting=vi.spyOn(f.service,'view');
      vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('after durable media binding');});
      const player=f.before.player_state.entity_id;
      const response=await fetch(`${f.base}/api/${kind}/${player}${kind==='visual'?'/fullbody':''}`,{method:'POST',headers:f.headers,body:png});
      expect(response.status).toBe(503);const after=(await f.store.read())!;
      expect(projecting).not.toHaveBeenCalled();
      const entity=after.entities.find(item=>item.id===player)!;
      const asset=kind==='avatar'?entity.components.identity.avatar_id:
        (entity.components.visual_assets.images as Record<string,string>).fullbody;
      expect(asset).toBeTruthy();expect(after.state_revision).toBe(f.before.state_revision+1);
      const image=await fetch(`${f.base}/api/${kind}/${asset}`);
      expect(image.status).toBe(200);expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
      expect(f.generate).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
  it('does not delete a shared generated asset when a later binding fails before commit',async()=>{
    const f=await fixture();try{
      const player=f.before.player_state.entity_id;
      const first=await f.service.generateAvatar(player,'离线头像',f.before.game_id,f.before.state_revision);
      const save=(await f.store.read())!,other=save.entities.find(entity=>entity.id!==player&&entity.components.character)!;
      vi.spyOn(f.service,'setAvatar').mockRejectedValueOnce(Error('binding refused'));
      await expect(f.service.generateAvatar(other.id,'同字节候选',save.game_id,save.state_revision)).rejects.toThrow('binding refused');
      expect((await f.store.read())!.entities.find(entity=>entity.id===player)!.components.identity.avatar_id).toBe(first.artifact.asset_id);
      expect(await readFile(join(f.directory,'assets','avatars',first.artifact.asset_id+'.png'))).toEqual(png);
      expect(f.generate).toHaveBeenCalledTimes(2);
    }finally{await f.close();}
  });
  it('clears one avatar reference without deleting a shared immutable asset',async()=>{
    const f=await fixture();try{
      const player=f.before.player_state.entity_id;
      const first=await f.service.generateAvatar(player,'离线头像',f.before.game_id,f.before.state_revision);
      const save=(await f.store.read())!,other=save.entities.find(entity=>entity.id!==player&&entity.components.character)!;
      await f.service.setAvatar(other.id,first.artifact.asset_id,save.game_id,save.state_revision);
      const response=await fetch(`${f.base}/api/avatar/${player}/clear`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':f.token},
        body:JSON.stringify({game_id:save.game_id,expected_revision:(await f.store.read())!.state_revision})});
      expect(response.status).toBe(200);
      const after=(await f.store.read())!;expect(after.entities.find(entity=>entity.id===player)!.components.identity.avatar_id).toBeNull();
      expect(after.entities.find(entity=>entity.id===other.id)!.components.identity.avatar_id).toBe(first.artifact.asset_id);
      expect((await fetch(`${f.base}/api/avatar/${first.artifact.asset_id}`)).status).toBe(200);
    }finally{await f.close();}
  });
});

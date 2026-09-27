import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { createApp } from '../src/server/app.js';
import { GameService } from '../src/server/service.js';
import { JsonStore } from '../src/storage/json-store.js';
import { sparseWorld } from './sparse-fixture.js';
import type { ImageGenerationProvider } from '../src/media/image.js';

async function close(server: any) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}

it('confirmed System media goal generates, persists, assigns and serves a visible avatar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agf-media-avatar-'));
  // Valid 1x1 PNG. This is a controlled provider artifact, not a claim about a real external provider.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const generate = vi.fn(async () => ({ bytes: png, mime_type: 'image/png' as const, provider: 'controlled-test-image', model: 'fixture-v1', metadata: { seed: 7 } }));
  const provider: ImageGenerationProvider = { id: 'controlled-test-image', availability: async () => ({ available: true, reason: null }), generate };
  const ai = new AIRuntime(new MockAIAdapter()), service = new GameService(new JsonStore(join(root, 'save')), ai, sparseWorld());
  await service.newGame();
  const server = createApp(service, undefined, undefined, join(root, 'assets'), {}, { imageProvider: provider }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + (server.address() as any).port;
    const token = (await (await fetch(base + '/api/session')).json()).token;
    const headers = { 'Content-Type': 'application/json', 'X-Game-Token': token };
    const before = (await service.view())!;
    const input = '给我的角色生成一张头像并设置上去。';
    const requested: any = await (await fetch(base + '/api/system', { method: 'POST', headers, body: JSON.stringify({ input, request_id: randomUUID(), game_id: before.game_id, expected_revision: before.revision }) })).json();
    expect(requested).toMatchObject({ category: 'MEDIA_GENERATION', needs_confirmation: true });
    expect(generate).not.toHaveBeenCalled();
    expect((await service.view())!.entities.find(entity => entity.id === before.player_id)?.components.identity?.avatar_id ?? null).toBeNull();

    const completed: any = await (await fetch(base + '/api/system', { method: 'POST', headers, body: JSON.stringify({ input, confirmed: true, session_id: requested.session?.session_id, request_id: randomUUID(), game_id: before.game_id, expected_revision: before.revision }) })).json();
    expect(completed).toMatchObject({ category: 'UNIVERSAL_GOAL', needs_confirmation: false, advanced: { provider: 'controlled-test-image', model: 'fixture-v1', provider_metadata: { seed: 7 } } });
    expect(generate).toHaveBeenCalledOnce();
    const player = completed.view.entities.find((entity: any) => entity.id === completed.view.player_id);
    const avatarId = player.components.identity.avatar_id;
    expect(avatarId).toMatch(/^avatar_[a-f0-9]{32}$/);
    const image = await fetch(base + '/api/avatar/' + avatarId);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toMatch(/^image\/png/);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await service.view())!.entities.find(entity => entity.id === before.player_id)?.components.identity?.avatar_id).toBe(avatarId);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('missing image provider gives actionable resumable guidance and resumes the original goal after configuration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agf-media-gap-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(new JsonStore(join(root,'save')),ai,sparseWorld());await service.newGame();
  let server=createApp(service,undefined,undefined,join(root,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    let base='http://127.0.0.1:'+(server.address() as any).port,token=(await (await fetch(base+'/api/session')).json()).token;
    let headers={'Content-Type':'application/json','X-Game-Token':token};const before=(await service.view())!;
    const gap:any=await (await fetch(base+'/api/system',{method:'POST',headers,body:JSON.stringify({input:'给我的角色生成一张头像并设置上去。',request_id:randomUUID(),game_id:before.game_id,expected_revision:before.revision})})).json();
    expect(gap).toMatchObject({category:'CAPABILITY_GAP',suspended_goal:{status:'waiting_for_external_prerequisite',external_blocked:true},capability_guidance:{status:'WAITING_FOR_PROVIDER',reason_kind:'adapter_missing',resumable:true}});
    expect(gap.message).toContain('只能返回文字');expect(gap.capability_guidance.options.map((option:any)=>option.label)).toEqual(['接入图片生成模型','上传一张图片','取消']);
    expect((await service.view())!.entities.find(entity=>entity.id===before.player_id)?.components.identity?.avatar_id??null).toBeNull();
    await close(server);
    const provider:ImageGenerationProvider={id:'controlled-resume-image',availability:async()=>({available:true,reason:null}),generate:async()=>({bytes:png,mime_type:'image/png',provider:'controlled-resume-image'})};
    server=createApp(service,undefined,undefined,join(root,'assets'),{},{imageProvider:provider}).listen(0,'127.0.0.1');await once(server,'listening');
    base='http://127.0.0.1:'+(server.address() as any).port;token=(await (await fetch(base+'/api/session')).json()).token;headers={'Content-Type':'application/json','X-Game-Token':token};
    const resumedResponse=await fetch(base+`/api/system/suspended-goals/${gap.suspended_goal.goal_id}/resume`,{method:'POST',headers,body:'{}'});const resumed:any=await resumedResponse.json();
    expect(resumedResponse.ok,JSON.stringify(resumed)).toBe(true);expect(resumed).toMatchObject({category:'UNIVERSAL_GOAL',title:'原目标已继续'});
    expect(resumed.view.entities.find((entity:any)=>entity.id===before.player_id).components.identity.avatar_id).toMatch(/^avatar_/);
  }finally{if(server.listening)await close(server);await rm(root,{recursive:true,force:true});}
},30000);

it('configured image adapter with missing credentials reports a provider block instead of ordinary failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agf-media-credential-'));const generate=vi.fn();
 const provider:ImageGenerationProvider={id:'credential-test',availability:async()=>({available:false,reason:'API key credential missing'}),generate};
 const service=new GameService(new JsonStore(join(root,'save')),new AIRuntime(new MockAIAdapter()),sparseWorld());await service.newGame();const server=createApp(service,undefined,undefined,join(root,'assets'),{},{imageProvider:provider}).listen(0,'127.0.0.1');await once(server,'listening');
 try{const base='http://127.0.0.1:'+(server.address() as any).port,token=(await(await fetch(base+'/api/session')).json()).token,headers={'Content-Type':'application/json','X-Game-Token':token},view=(await service.view())!,input='给我的角色生成一张头像并设置上去。';
  const first:any=await(await fetch(base+'/api/system',{method:'POST',headers,body:JSON.stringify({input,request_id:randomUUID(),game_id:view.game_id,expected_revision:view.revision})})).json();expect(first.needs_confirmation).toBe(true);
  const failed:any=await(await fetch(base+'/api/system',{method:'POST',headers,body:JSON.stringify({input,confirmed:true,session_id:first.session?.session_id,request_id:randomUUID(),game_id:view.game_id,expected_revision:view.revision})})).json();
  expect(failed).toMatchObject({category:'EXECUTION_FAILURE',capability_guidance:{status:'PROVIDER_CALL_FAILED',reason_kind:'credential_missing'}});expect(failed.message).toContain('头像未修改');expect(failed.capability_guidance.options.map((option:any)=>option.label)).toContain('配置凭证');expect(generate).not.toHaveBeenCalled();
 }finally{await close(server);await rm(root,{recursive:true,force:true});}
},30000);

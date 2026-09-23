import { request as httpRequest } from 'node:http';
import { it, expect } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Codex } from '@openai/codex-sdk';
import { createApp } from '../src/server/app.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { CodexAdapter } from '../src/ai/codex.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { readProfile } from '../src/ai/profiles.js';
import { demo, fresh, MemoryStore } from './helpers.js';
import { readFile } from 'node:fs/promises';
it('HTTP isolates GM state and protects mutations/export; malformed JSON survives', async () => {
  const service = new GameService(new MemoryStore(),new AIRuntime(new MockAIAdapter()),demo); await service.newGame();
  const server=createApp(service).listen(0,'127.0.0.1'); await once(server,'listening');
  const base='http://127.0.0.1:'+((server.address() as {port:number}).port);
  try {
    const state=await fetch(base+'/api/state'); expect(state.status).toBe(200); const body=await state.text(); expect(body).not.toContain('GM_PRIVATE_CANARY'); expect(body).not.toContain('gm_state');
    expect((await fetch(base+'/api/export',{method:'POST'})).status).toBe(403);
    expect((await fetch(base+'/api/session',{headers:{Origin:'https://evil.example'}})).status).toBe(403);
    expect(await new Promise<number>(resolve => { const req=httpRequest(base+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.end(); })).toBe(403);
    const session=await (await fetch(base+'/api/session')).json();
    const headers={'Content-Type':'application/json','X-Game-Token':session.token};
    const exported=await fetch(base+'/api/export',{method:'POST',headers,body:'{}'}); expect(await exported.text()).toContain('GM_PRIVATE_CANARY');
    expect((await fetch(base+'/api/import',{method:'POST',headers,body:'{broken'})).status).toBe(400);
    expect((await fetch(base+'/api/import',{method:'POST',headers,body:'{"schema_version":99}'})).status).toBe(400);
    expect((await fetch(base+'/api/health')).status).toBe(200);
    expect((await fetch(base+'/data/current.json')).status).toBe(404);
  } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
});
it('Codex cache failure retries once with fresh canonical prompt', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agf-ai-')); let starts=0, resumes=0;
  const client={resumeThread:()=>{resumes++;return {run:async()=>{throw new Error('invalid thread');}}},startThread:()=>{starts++;return {id:'new-id',run:async(prompt:string,options:unknown)=>({finalResponse:'{"ok":true}',items:[]})}}} as unknown as Codex;
  try { const out=await new CodexAdapter(dir,client).generate({role:'narrator',prompt:'canonical context',schema:{},threadId:'invalid'}); expect(out.recovered).toBe(true); expect(out.threadId).toBe('new-id'); expect([starts,resumes]).toEqual([1,1]); }
  finally {await rm(dir,{recursive:true,force:true});}
});
it('Codex adapter rejects unexpected tools', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agf-ai-'));
  const client={startThread:()=>({id:'x',run:async()=>({finalResponse:'{}',items:[{type:'file_change'}]})})} as unknown as Codex;
  try {await expect(new CodexAdapter(dir,client).generate({role:'narrator',prompt:'test',schema:{}})).rejects.toThrow('AI_TOOL_BOUNDARY');}
  finally {await rm(dir,{recursive:true,force:true});}
});
it('initializer compiles structured blueprint to independently portable save', async () => {
  const blueprint=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
  const runtime=new AIRuntime(new MockAIAdapter(blueprint));
  const save=await runtime.initialize('tiny world',await readProfile('content/profiles/default.json'));
  expect(save.definition.meta.id).toBe(blueprint.id); expect(save.entities.length).toBe(7); expect(save.ai.threads.world_initializer).toBe('mock-initializer');
});
it('narrator receives only public state, not hidden facts', async () => {
  let prompt='';
  const ai=new AIRuntime({name:'capture',generate:async req=>{prompt=req.prompt;return {data:{narrative:'hello',speaker:null,dialogue:null,choices:[],patches:[]}}}});
  await ai.narrate(fresh(),{id:'test',type:'WAIT',parameters:{minutes:1},actor_id:'player',source:'player',time_cost:1},['wait']);
  expect(prompt).not.toContain('GM_PRIVATE_CANARY'); expect(prompt).not.toContain('gm_state');
});

it('DeepSeek adapter uses server-side API key and structured Responses output', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { DeepSeekAdapter } = await import('../src/ai/deepseek.js');
  const result = await new DeepSeekAdapter({ apiKey: 'test-secret', fetchImpl: fakeFetch, model: 'deepseek-flash' })
    .generate({ role: 'narrator', prompt: 'canonical context', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
  expect(result.data).toEqual({ ok: true });
  expect(result.threadId).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(calls[0].input).toBe('https://api.deepseek.com/responses');
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
  const body = JSON.parse(String(calls[0].init?.body));
  expect(body.model).toBe('deepseek-flash');
  expect(body.text.format.type).toBe('json_schema');
  expect(body.text.format.schema.properties.ok.type).toBe('boolean');
});

it('LAN mode accepts private RFC1918 Host while default mode rejects it', async () => {
  const service = new GameService(new MemoryStore(),new AIRuntime(new MockAIAdapter()),demo); await service.newGame();
  const localServer=createApp(service).listen(0,'127.0.0.1'); await once(localServer,'listening');
  const localBase='http://127.0.0.1:'+((localServer.address() as {port:number}).port);
  try {
    expect(await new Promise<number>(resolve => { const req=httpRequest(localBase+'/api/health',{headers:{Host:'192.168.1.20:3100'}},res=>{res.resume();resolve(res.statusCode!);});req.end(); })).toBe(403);
  } finally { await new Promise<void>((resolve,reject)=>localServer.close(e=>e?reject(e):resolve())); }

  const lanServer=createApp(service,undefined,undefined,undefined,{allowLan:true}).listen(0,'127.0.0.1'); await once(lanServer,'listening');
  const lanBase='http://127.0.0.1:'+((lanServer.address() as {port:number}).port);
  try {
    expect(await new Promise<number>(resolve => { const req=httpRequest(lanBase+'/api/health',{headers:{Host:'192.168.1.20:3100'}},res=>{res.resume();resolve(res.statusCode!);});req.end(); })).toBe(200);
    expect(await new Promise<number>(resolve => { const req=httpRequest(lanBase+'/api/health',{headers:{Host:'8.8.8.8:3100'}},res=>{res.resume();resolve(res.statusCode!);});req.end(); })).toBe(403);
  } finally { await new Promise<void>((resolve,reject)=>lanServer.close(e=>e?reject(e):resolve())); }
});

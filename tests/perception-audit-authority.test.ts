import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {fresh,MemoryStore} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {createApp} from '../src/server/app.js';
import {listenFetchable} from './fixtures/listen-fetchable.js';

afterEach(()=>vi.restoreAllMocks());
const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
const literal=[
  '你走到门口，暂时没有新的发现。',
  '你穿过门口，走出了房间，暂时没有新的发现。',
  '你离开了当前房间，暂时没有新的发现。',
  '你进入走廊，暂时没有新的发现。',
];
const expressive=[
  '你的目光穿过门口，门外是公开可见的走廊；本次没有新的发现。',
  '你把注意力交给门边的房间，暂时没有新的发现。',
];
function initial(){
  const save=fresh();save.definition.events=[];
  save.definition.map!.locations.find(p=>p.id==='square')!.description='办公室的门开着，门外的走廊公开可见。';
  return save;
}
function runtime(text:string,grounded=true){
  let narrations=0,audits=0;
  const ai=new AIRuntime({name:'authority-audit-offline',generate:async request=>{
    if(request.role==='narrator'){narrations++;return {data:narration(text)};}
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.grounded){audits++;return {data:{grounded,reports_result:grounded,reason:grounded?'固定审核候选声明有依据':'明确的未结算移动',unsupported_claims:grounded?[]:['未结算的移动']}};}
    throw Error('Unexpected offline audit probe '+request.role);
  }});
  return {ai,narrations:()=>narrations,audits:()=>audits};
}
it.each(literal)('does not let an inconsistent positive audit authorize uncommitted literal travel: %s',async text=>{
  const store=new MemoryStore(),save=initial(),f=runtime(text);await store.write(save);
  const service=new GameService(store,f.ai,save.definition),before=await service.current();
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{focus:'门口'}}};
  const result=await service.turn(body),after=await service.current(),calls=f.ai.metrics.requests;
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.entities).toEqual(before.entities);expect(after.resolution_receipts!.filter(r=>r.request_id===body.request_id).map(r=>r.semantic_action)).toEqual(['INSPECT']);
  expect(await service.turn(body)).toEqual(result);expect(f.ai.metrics.requests).toBe(calls);
  expect(after.last_turn?.narrative).not.toBe(text);expect(after.last_turn?.presentation?.status).toBe('degraded');
});
it.each(expressive)('preserves grounded attention/metaphor without a new movement or inventory effect: %s',async text=>{
  const store=new MemoryStore(),save=initial(),f=runtime(text);await store.write(save);
  const service=new GameService(store,f.ai,save.definition),before=await service.current();
  await service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{focus:'门口'}}});
  const after=await service.current();expect(after.last_turn?.narrative).toBe(text);expect(after.last_turn?.presentation?.status).toBe('normal');
  expect(f.narrations()).toBe(1);expect(f.audits()).toBe(1);expect(after.entities).toEqual(before.entities);
});
it('keeps the existing negative-audit refusal control',async()=>{
  const store=new MemoryStore(),save=initial(),f=runtime(literal[0],false);await store.write(save);
  const service=new GameService(store,f.ai,save.definition),before=await service.current();
  await service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{focus:'门口'}}});
  expect((await service.current()).last_turn?.presentation?.status).toBe('degraded');expect(f.narrations()).toBe(3);
});
it('retains the grounded result and exact response after actual HTTP/JsonStore/service recreation without accepting literal travel',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-audit-authority-'));let server:Server|undefined;
  try{
    const save=initial(),store=new JsonStore(directory),f=runtime(literal[1]);await store.write(save);
    const service=new GameService(store,f.ai,save.definition),before=await service.current();
    server=await listenFetchable(()=>createServer(createApp(service)));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
    const base=`http://127.0.0.1:${address.port}`,token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
    const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{focus:'门口'}}};
    const response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    expect(response.status).toBe(200);const result=await response.json(),after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));
    const replayAi=new AIRuntime({name:'replay-no-generation',generate:async()=>{throw Error('Replay must not generate');}});
    const restarted=new GameService(new JsonStore(directory),replayAi,save.definition);
    expect(await restarted.turn(body)).toEqual(result);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
    expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
    expect(after.last_turn?.narrative).not.toBe(literal[1]);expect(after.last_turn?.presentation?.status).toBe('degraded');
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
    await rm(directory,{recursive:true,force:true});
  }
});

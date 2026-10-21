import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fresh,MemoryStore} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {GameService} from '../src/server/service.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {JsonStore} from '../src/storage/json-store.js';
import {createApp} from '../src/server/app.js';
import {listenFetchable} from './fixtures/listen-fetchable.js';

afterEach(()=>vi.restoreAllMocks());
const plain='你沿路来到街角商店。';
async function setup(text:string,willing=false,claims:{entity_id:string;location_id:string}[]=[]){
  const save=fresh();save.definition.events=[];
  if(willing){save.npc_agent_state??={};save.npc_agent_state.npc_lin={...emptyNpcAgentState(),travel_intent:{status:'willing',origin_location_id:'square',source_request_id:randomUUID(),recorded_revision:save.state_revision}};}
  const store=new MemoryStore();await store.write(save);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition);
  const narrate=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],presence_claims:claims});
  vi.spyOn(ai,'interpret').mockImplementation(async(_save,input)=>input==='去商店'?{type:'MOVE',target_id:'market',parameters:{}}:{type:'WAIT',parameters:{minutes:1}});
  return {save,store,ai,service,narrate};
}
  const run=async(f:Awaited<ReturnType<typeof setup>>)=>{
    const before=await f.service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),
      action:{type:'MOVE',target_id:'market',parameters:{}}};
    const response=await f.service.turn(body);
    return {before,body,response,after:await f.service.current()};
  };
  it.each([
    {text:plain+'抵达之后，林舟站在你身旁。',claims:[]},
    {text:plain,claims:[{entity_id:'npc_lin',location_id:'market'}]},
    {text:'出发前，林舟站在你身旁；但是抵达后，林舟仍站在你身旁。'+plain,claims:[]},
  ])('rejects absent prose or structured presence after MOVE: $text',async({text,claims})=>{
    const f=await setup(text,false,claims),{before,body,response,after}=await run(f);
    expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('market');expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('square');
    expect(after.runtime.time.minute-before.runtime.time.minute).toBe(6);expect(after.state_revision).toBe(before.state_revision+1);
    expect(await f.service.turn(body)).toEqual(response);
    expect(after.last_turn?.presentation?.status).toBe('degraded');
    expect(after.last_turn?.narrative).not.toContain('林舟站在你身旁');
    expect(f.narrate).toHaveBeenCalledTimes(3);
  });
  it.each([
    {text:plain,willing:false,claims:[]},
    {text:plain+'林舟与你同行，此刻站在你身旁。',willing:true,claims:[{entity_id:'npc_lin',location_id:'market'}]},
    {text:'林舟留在原地。'+plain,willing:false,claims:[]},
    {text:'出发前，林舟站在你身旁。'+plain,willing:false,claims:[]},
    {text:'你想起出发前的情景：“林舟站在你身旁。”'+plain,willing:false,claims:[{entity_id:'npc_lin',location_id:'square'}]},
  ])('preserves truthful companion/departure context after MOVE: $text',async({text,willing,claims})=>{
    const f=await setup(text,willing,claims),{after}=await run(f);
    expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe(willing?'market':'square');
    expect(after.last_turn?.narrative).toBe(text);expect(after.last_turn?.presentation?.status).toBe('normal');expect(f.narrate).toHaveBeenCalledOnce();
  });
it('keeps local compound MOVE rejected before any scene transition',async()=>{
  const f=await setup(plain),before=await f.service.current();
  await expect(f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'去商店，再等一分钟'},
    undefined,undefined,undefined,false,undefined,['去商店','等一分钟'])).rejects.toThrow('不能作为局部复合行动');
  expect(await f.service.current()).toEqual(before);expect(f.narrate).not.toHaveBeenCalled();
});
it('retains corrected MOVE prose and exact HTTP response after disk/new-service replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-move-presence-'));let server:Server|undefined;
  try{
    const f=await setup(plain+'抵达之后，林舟站在你身旁。'),store=new JsonStore(directory);await store.write(f.save);
    const service=new GameService(store,f.ai,f.save.definition),before=await service.current();
    server=await listenFetchable(()=>createServer(createApp(service)));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
    const base=`http://127.0.0.1:${address.port}`,token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
    const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'MOVE',target_id:'market',parameters:{}}};
    const response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    expect(response.status).toBe(200);const result=await response.json(),after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));
    const replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay cannot generate');}}),restarted=new GameService(new JsonStore(directory),replayAi,f.save.definition);
    expect(await restarted.turn(body)).toEqual(result);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
    expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('square');expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('market');
    expect(after.resolution_receipts?.filter(r=>r.request_id===body.request_id)).toHaveLength(1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(6);expect(f.narrate).toHaveBeenCalledTimes(3);
    expect(after.last_turn?.narrative).not.toContain('林舟站在你身旁');expect(after.last_turn?.presentation?.status).toBe('degraded');
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
    await rm(directory,{recursive:true,force:true});
  }
});

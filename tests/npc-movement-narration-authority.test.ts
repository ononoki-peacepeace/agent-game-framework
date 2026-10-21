import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fresh,MemoryStore} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {GameService} from '../src/server/service.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {JsonStore} from '../src/storage/json-store.js';
import {createApp} from '../src/server/app.js';
import {listenFetchable} from './fixtures/listen-fetchable.js';

afterEach(()=>vi.restoreAllMocks());
const departure='林舟离开了这里，沿着街角商店的方向走去。你留在原处等了一会儿。';
async function fixture(origin='square',destination='market',text=departure){
  const save=fresh();save.definition.events=[];save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:origin};
  recordNpcActivityPlans(save,sceneResultSchema.parse({understanding:'既有自主计划',narrative:'林舟准备沿已知路线出发。',dialogue:'我按计划出发。',
    speech_events:[{speaker_id:'npc_lin',utterance:'我按计划出发。',provenance:'npc_response'}],effects:[],
    npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:destination,readiness:'ready',condition:null,plan_id:null}]}),randomUUID(),origin);
  const store=new MemoryStore();await store.write(save);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition);
  const narrate=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
  return {save,store,ai,service,narrate};
}
it.each([
  {origin:'square',destination:'market',text:departure},
  {origin:'market',destination:'square',text:'林舟从街角商店出发，进入中央广场。你仍在原处等候。'},
  {origin:'market',destination:'square',text:'林舟离开街角商店，到达中央广场。你仍在原处等候。'},
  {origin:'market',destination:'square',text:'你看见林舟进入中央广场。你仍在原处等候。'},
  {origin:'square',destination:'market',text:'林舟离开了这里，你留在原处等候。'},
])('retains actual visible NPC movement $origin->$destination: $text',async({origin,destination,text})=>{
  const f=await fixture(origin,destination,text),before=await f.service.current();
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:6}}};
  const response=await f.service.turn(body),after=await f.service.current();
  expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe(destination);expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('square');
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.movement_route)).toHaveLength(1);
  expect(after.last_turn?.narrative).toBe(text);expect(after.last_turn?.presentation?.status).toBe('normal');expect(f.narrate).toHaveBeenCalledOnce();
  expect(await f.service.turn(body)).toEqual(response);expect(f.narrate).toHaveBeenCalledOnce();
});
it.each([
  {minutes:6,text:'林舟离开了这里，你也进入街角商店。',destination:'market'},
  {minutes:1,text:departure,destination:'square'},
  {minutes:6,text:'林舟从街角商店到达中央广场，随后离开了这里。',origin:'market',target:'square',destination:'square'},
  {minutes:24,text:'林舟到达河岸车站，你看清了他的动作。',origin:'market',target:'station',destination:'station'},
  {minutes:6,text:'林舟离开了这里，沿路到达街角商店。你留在原处等候。',destination:'market'},
  {minutes:6,text:'林舟进入中央广场，你也随后走到门口。',origin:'market',target:'square',destination:'square'},
])('does not authorize player travel, unfinished plans, later departures or offscreen travel: $text',async({minutes,text,origin,target,destination})=>{
  const f=await fixture(origin??'square',target??'market',text),before=await f.service.current();
  await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes}}});
  const after=await f.service.current();expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe(destination);
  expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('square');
  expect(after.last_turn?.narrative).not.toBe(text);expect(after.last_turn?.presentation?.status).toBe('degraded');
});
it('retains an actual visible NPC departure during a compound player action',async()=>{
  const f=await fixture(),before=await f.service.current(),steps=['等六分钟','再等一分钟'];
  vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>({type:'WAIT',parameters:{minutes:input===steps[0]?6:1}}));
  await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，')},
    undefined,undefined,undefined,false,undefined,steps);
  const after=await f.service.current();expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('market');
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.movement_route)).toHaveLength(1);
  expect(after.last_turn?.narrative).toBe(departure);expect(f.narrate).toHaveBeenCalledOnce();
});
it('does not reuse an earlier NPC receipt as authority for a later narrated move',async()=>{
  const f=await fixture(),before=await f.service.current();await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:6}}});
  const mid=await f.service.current();await f.service.turn({game_id:mid.game_id,expected_revision:mid.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:1}}});
  const after=await f.service.current();expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.movement_route)).toHaveLength(1);
  expect(after.last_turn?.narrative).not.toBe(departure);expect(after.last_turn?.presentation?.status).toBe('degraded');
});
it('retains NPC departure prose and one Core move through actual HTTP/disk/restarted response replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-npc-prose-authority-'));let server:Server|undefined;
  try{
    const f=await fixture(),store=new JsonStore(directory);await store.write(f.save);
    const service=new GameService(store,f.ai,f.save.definition),before=await service.current();
    server=await listenFetchable(()=>createServer(createApp(service)));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
    const base=`http://127.0.0.1:${address.port}`,token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
    const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:6}}};
    const response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    expect(response.status).toBe(200);const result=await response.json(),after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));
    const replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay cannot generate');}}),restarted=new GameService(new JsonStore(directory),replayAi,f.save.definition);
    expect(await restarted.turn(body)).toEqual(result);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
    expect(after.entities.find(e=>e.id==='npc_lin')?.components.location?.location_id).toBe('market');expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.movement_route)).toHaveLength(1);
    expect(after.last_turn?.narrative).toBe(departure);expect(after.last_turn?.presentation?.status).toBe('normal');expect(f.narrate).toHaveBeenCalledOnce();
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
    await rm(directory,{recursive:true,force:true});
  }
});

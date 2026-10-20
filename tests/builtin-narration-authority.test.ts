import {expect,it,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fresh,MemoryStore} from './helpers.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {JsonStore} from '../src/storage/json-store.js';
import {createApp} from '../src/server/app.js';
import {listenFetchable} from './fixtures/listen-fetchable.js';

afterEach(()=>vi.restoreAllMocks());
const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
const actions=[
  {type:'WAIT',parameters:{minutes:1}},
  {type:'HOLD',parameters:{minutes:1,activity:'整理已有资料'}},
  {type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}},
];
const attacks=['你进入走廊，随后回头看了看。','你拿起钥匙，把它收入背包。','你发现了新的秘密线索。'];
it.each(actions.flatMap(action=>attacks.map(prose=>({action,prose}))))('does not present uncommitted effects after built-in $action.type: $prose',async({action,prose})=>{
  const save=fresh();save.definition.events=[];
  const store=new MemoryStore();await store.write(save);const ai=new AIRuntime(new MockAIAdapter());
  const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration(prose));
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action};
  const result=await service.turn(body),after=await service.current();
  const receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
  expect(receipt.semantic_action).toBe(action.type);expect(receipt.effects).not.toContain('position');
  expect(after.entities.find(e=>e.id===save.player_state.entity_id)?.components.location).toEqual(before.entities.find(e=>e.id===save.player_state.entity_id)?.components.location);
  const calls=narrate.mock.calls.length;expect(await service.turn(body)).toEqual(result);expect(narrate).toHaveBeenCalledTimes(calls);
  expect(after.last_turn?.narrative).not.toBe(prose);expect(after.last_turn?.presentation?.status).toBe('degraded');
  expect(narrate).toHaveBeenCalledTimes(3);expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.resolution_receipts!.filter(r=>r.request_id===body.request_id)).toHaveLength(1);
});
it.each(actions)('retains grounded prose after built-in $type',async action=>{
  const save=fresh();save.definition.events=[];const store=new MemoryStore();await store.write(save);
  const ai=new AIRuntime(new MockAIAdapter()),text=action.type==='WAIT'?'你在原处等了一会儿。':action.type==='HOLD'?'你留在原处整理已有资料。':'你向林舟问了声好。';
  const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration(text)),service=new GameService(store,ai,save.definition),before=await service.current();
  await service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action});
  const after=await service.current();expect(after.last_turn?.narrative).toBe(text);expect(after.last_turn?.presentation?.status).toBe('normal');expect(narrate).toHaveBeenCalledOnce();
});
it('replays degraded built-in prose exactly after HTTP, disk persistence and a new service',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-builtin-authority-'));let server:Server|undefined;
  try{
    const save=fresh();save.definition.events=[];const store=new JsonStore(directory);await store.write(save);
    const ai=new AIRuntime(new MockAIAdapter()),prose=attacks[0],narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration(prose));
    const service=new GameService(store,ai,save.definition),before=await service.current();
    server=await listenFetchable(()=>createServer(createApp(service)));const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
    const base=`http://127.0.0.1:${address.port}`,token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
    const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:actions[0]};
    const response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    expect(response.status).toBe(200);const result=await response.json(),after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));
    const replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay cannot generate');}}),restarted=new GameService(new JsonStore(directory),replayAi,save.definition);
    expect(await restarted.turn(body)).toEqual(result);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
    expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);expect(narrate).toHaveBeenCalledTimes(3);
    expect(after.last_turn?.narrative).not.toBe(prose);expect(after.last_turn?.presentation?.status).toBe('degraded');
  }finally{
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
    await rm(directory,{recursive:true,force:true});
  }
});

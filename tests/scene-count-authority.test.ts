import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {fresh} from './helpers.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
function fixture(count=3){
 const save=fresh();save.definition.events=[];
 for(const entity of save.entities)if(entity.components.character)entity.components.location={location_id:'square'};
 const people=save.entities.filter(e=>e.components.character);expect(people).toHaveLength(3);
 for(let index=3;index<count;index++){
  const npc=structuredClone(people.find(e=>e.id==='npc_lin')!);npc.id='count_extra_'+index;
  npc.components.identity!.name='旁观者'+index;delete npc.components.relationships;save.entities.push(npc);
 }
 return save;
}
const quoted=['林舟说：“刚才这里只有两个人。”','林舟说：「那时只有一个人。」','林舟回忆道：『过去只有两个人。』'];
it.each(quoted)('preserves quoted recollection without turning it into a current headcount: %s',text=>{
 const save=fixture(),before=structuredClone(save);expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();expect(save).toEqual(before);
});
it.each([
 '这里只有三个人。过了一会儿这里只剩两个人。',
 '这里只有两个人。这里只有三个人。',
 '这里只有十二个人。',
 '这里只有12个人。',
 '林舟说：“这里只有三个人。”这里只剩两个人。',
 '林舟说：「过去只有一个人。」这里只有两个人。',
 '这里只有零个人。',
 '这里只有二十一个人。',
])('checks every unquoted asserted headcount against authority: %s',text=>{
 expect(()=>validateScenePresenceNarrative(fixture(),text)).toThrow('人数');
});
it.each(['这里只有三个人。','这里只有三个人。仍然只有三个人。','林舟说：“刚才只有两个人。”现在这里只有三个人。'])('keeps correct asserted-count controls: %s',text=>{
 expect(()=>validateScenePresenceNarrative(fixture(),text)).not.toThrow();
});
it.each(['十二','12'])('preserves a truthful %s-person scene',raw=>{
 expect(()=>validateScenePresenceNarrative(fixture(12),`这里只有${raw}个人。`)).not.toThrow();
});
it.each([{count:10,raw:'十'},{count:20,raw:'二十'},{count:21,raw:'二十一'}])('preserves the actual $raw-person roster',({count,raw})=>{
 expect(()=>validateScenePresenceNarrative(fixture(count),`这里只有${raw}个人。`)).not.toThrow();
});
it('does not allow quoted prose to bypass a conflicting structured presence claim',()=>{
 expect(()=>validateScenePresenceNarrative(fixture(),quoted[0],[{entity_id:'npc_lin',location_id:'market'}])).toThrow('权威位置');
});
const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
 interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(['quoted','later_count'] as const)('retains truthful $mode narration behavior and exact HTTP/disk/service replay',async mode=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-scene-count-'));let server:Server|undefined;
 try{
  const save=fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition),before=await service.current();
  const text=mode==='quoted'?quoted[0]:'这里只有三个人。过了一会儿这里只剩两个人。';
  const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration(text));
  server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const token=(await(await fetch(base+'/api/session',{headers:{connection:'close'}})).json() as {token:string}).token;
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:1}}};
  const response=await fetch(base+'/api/action',{method:'POST',headers:{connection:'close','content-type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
  expect(response.status).toBe(200);const result=await response.json();
  const after=(await store.read())!,bytes=await readFile(join(directory,'current.json'));
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.resolution_receipts!.filter(r=>r.request_id===body.request_id).map(r=>r.semantic_action)).toEqual(['WAIT']);
  expect(after.entities.filter(e=>e.components.character).map(e=>e.components.location)).toEqual(before.entities.filter(e=>e.components.character).map(e=>e.components.location));
  expect(narrate).toHaveBeenCalledTimes(mode==='quoted'?1:3);
  expect(after.last_turn?.presentation?.status).toBe(mode==='quoted'?'normal':'degraded');
  if(mode==='quoted')expect(after.last_turn!.narrative).toBe(text);else expect(after.last_turn!.narrative).not.toContain('两个人');
  const replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}});
  const restarted=new GameService(new JsonStore(directory),replayAi,save.definition);
  expect(await restarted.turn(body)).toEqual(result);expect(await restarted.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
 }finally{
  if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}
  await rm(directory,{recursive:true,force:true});
 }
});

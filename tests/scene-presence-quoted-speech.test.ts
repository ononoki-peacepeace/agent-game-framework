import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());

async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 for(const id of ['player','npc_lin'])save.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 return save;
}
it.each([
 '林舟说：“我已经离开这里了。”',
 '林舟说："我已经离开这里了。"',
 '林舟答道："我刚刚走出了房间。"',
 '林舟说："这里只剩一个人。"',
 '林舟说："他没有离开。"他仍站在这里。',
 '林舟说："我已经离开。"但他还在这里。',
])('preserves attributed quoted speech as a claim rather than current scene authority: %s',async text=>{
 const save=await fixture(),before=structuredClone(save);expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();expect(save).toEqual(before);
});
it.each([
 '林舟说："我没离开。"随后离开了这里。',
 '林舟说："我还在这里。"接着走出了房间。',
 '林舟说："我还在。"他和乔宁随后离开了这里。',
 '林舟说："这里有两个人。"但这里只剩一个人。',
 '林舟"离开"了这里。',
 '林舟说："我已经离开。随后他走出了房间。',
])('keeps unquoted, emphasized and malformed-quote assertions guarded: %s',async text=>{
 const save=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).toThrow();
});
it.each(['林舟说："我还在这里。"接着走出了房间。','林舟说："我还在。"他和乔宁随后离开了这里。'])(
 'repairs external quote-tail departures without committing a move, and replays disk response: %s',async text=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-quote-presence-'));try{
  const save=await fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected live generation');}});
  const narrate=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],
   patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:1}}};
  const first=await service.turn(body),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.last_turn?.narrative).not.toBe(text);expect(after.last_turn?.presentation?.status).toBe('degraded');
  expect(narrate).toHaveBeenCalledTimes(3);expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);
  expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);expect(await restarted.turn(body)).toEqual(first);
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(narrate).toHaveBeenCalledTimes(3);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

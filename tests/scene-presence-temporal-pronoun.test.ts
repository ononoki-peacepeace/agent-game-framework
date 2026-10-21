import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sparseSetup} from './sparse-fixture.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 for(const id of ['player','npc_lin'])save.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'station'};
 return save;
}
it.each([
 '林舟仍在这里。随后他和乔宁离开了这里。',
 '林舟仍在这里。接着她与乔宁走出了房间。',
 '林舟仍在这里。然后他跟乔宁离开了这里。',
 '林舟仍在这里。随即他和乔宁跨过门槛。',
 '林舟仍在这里，这时他和乔宁离开了这里。',
 '林舟仍在这里。同时他与乔宁离开了这里。',
])('checks every joined member after a temporal pronoun continuation: %s',async text=>{
 const save=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).toThrow('权威位置');
});
it.each([
 '林舟仍在这里。他和乔宁离开了这里。',
 '林舟仍在这里。随后他和乔宁没有离开这里。',
 '林舟仍在这里。随后他和乔宁准备离开这里。',
 '林舟仍在这里。随后他和乔宁走了几步。',
 '林舟仍在这里。随后乔宁与同事离开了车站。',
])('preserves existing rejection or lawful controls: %s',async text=>{
 const save=await fixture(),before=structuredClone(save);
 if(text==='林舟仍在这里。他和乔宁离开了这里。')expect(()=>validateScenePresenceNarrative(save,text)).toThrow('权威位置');
 else expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();
 expect(save).toEqual(before);
});
it.each(['随后他和乔宁离开了这里。','这时他与乔宁走出了房间。'])(
 'degrades an uncommitted departure assertion and replays saved WAIT bytes: %s',async continuation=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-temporal-presence-'));try{
  const save=await fixture(),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected live generation');}});
  const text='林舟仍在这里。'+continuation,narrator=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,
   choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:1}}};
  const first=await service.turn(request),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.last_turn?.narrative).not.toBe(text);expect(after.last_turn?.presentation?.status).toBe('degraded');
  expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['WAIT']);expect(narrator).toHaveBeenCalledTimes(3);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);
  expect(await restarted.turn(request)).toEqual(first);expect(await restarted.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(narrator).toHaveBeenCalledTimes(3);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

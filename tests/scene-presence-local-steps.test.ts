import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 for(const id of ['player','npc_lin'])save.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 await f.store.write(save);return {...f,save};
}
const legal=[
 '林舟走了几步，然后在原地停下。',
 '林舟向前走了数步，仍在这里。',
 '林舟只走了半步，便停住了。',
 '林舟走了一小步，仍站在这里。',
 '林舟走了两步，随后停下。',
];
it.each(legal)('accepts bounded local stepping without inventing departure: %s',async text=>{
 const {save}=await fixture(),before=structuredClone(save);expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();expect(save).toEqual(before);
});
it.each([
 '林舟走了几步，随后离开了这里。',
 '林舟走了数步后走出了房间。',
 '林舟走了半步，接着跨过门槛出去了。',
 '林舟走了一小步，却随即离开。',
 '林舟走了。',
])('still rejects a later actual departure assertion: %s',async text=>{
 const {save}=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).toThrow('权威位置');
});
it('keeps lawful local steps in normal prose through one settled WAIT and exact replay',async()=>{
 const f=await fixture(),text=legal[0],narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const body={game_id:f.save.game_id,expected_revision:f.save.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:1}}};
 const first=await f.service.turn(body),after=await f.service.current();
 expect(after.last_turn?.narrative).toBe(text);expect(after.last_turn?.presentation?.status).toBe('normal');expect(narrate).toHaveBeenCalledOnce();
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(after.runtime.time.minute-f.save.runtime.time.minute).toBe(1);expect(after.resolution_receipts).toHaveLength(1);
 expect(await f.service.turn(body)).toEqual(first);expect(await f.service.current()).toEqual(after);expect(narrate).toHaveBeenCalledOnce();
});

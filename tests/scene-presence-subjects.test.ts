import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {validateSave} from '../src/core/state.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(miraPresent=true){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};
 const lin=save.entities.find(e=>e.id==='npc_lin')!;lin.components.location={location_id:'square'};
 const mira=structuredClone(lin);mira.id='npc_mira';mira.components.identity={...mira.components.identity!,name:'米拉'};
 mira.components.location={location_id:miraPresent?'square':'station'};save.entities.push(mira);
 await f.store.write(validateSave(save));return {...f,save};
}
it.each([
 '林舟留在这里，米拉走出了房间。',
 '林舟没有离开，米拉随后离开了这里。',
 '林舟看了米拉一眼，随后米拉走出了房间。',
])('checks each independently named clause instead of discarding multiple subjects: %s',async text=>{
 const {save}=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).toThrow('权威位置');
});
it.each([
 '林舟站在这里，米拉也站在你面前。',
 '林舟看着远处；米拉坐在你身旁。',
])('rejects an absent person asserted present in a second named clause: %s',async text=>{
 const {save}=await fixture(false);expect(()=>validateScenePresenceNarrative(save,text)).toThrow('不在');
});
it.each([
 '林舟没有离开，米拉也没有离开。',
 '林舟的目光离开你，米拉朝你走了两步。',
 '林舟对米拉说：“你可以离开这里。”',
])('keeps lawful subjects, local motion and quoted wishes distinct: %s',async text=>{
 const {save}=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();
});
it('does not attribute the player movement clause to Lin in the NPC-only presence guard',async()=>{
 const {save}=await fixture();
 // This guard only checks NPC presence; player travel still needs separate Core evidence.
 expect(()=>validateScenePresenceNarrative(save,'林舟仍在这里，你走出了房间。')).not.toThrow();
});
it('allows an absent character to have departed without removing a different present character',async()=>{
 const {save}=await fixture(false);
 expect(()=>validateScenePresenceNarrative(save,'林舟仍站在这里，米拉已经离开了这里。')).not.toThrow();
});
it('checks named subject switches across implicit and explicit continuing clauses',async()=>{
 const {save}=await fixture();
 expect(()=>validateScenePresenceNarrative(save,'林舟的目光离开了你，随后走出房间。')).toThrow('权威位置');
 expect(()=>validateScenePresenceNarrative(save,'林舟没有离开，随后他仍站在这里。')).not.toThrow();
});
it('degrades multi-person false presence without inventing movement and replays once',async()=>{
 const f=await fixture(false),text='林舟站在这里，米拉也站在你面前。';
 const narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const request={game_id:f.save.game_id,expected_revision:f.save.state_revision,request_id:randomUUID(),
  action:{type:'WAIT',parameters:{minutes:1}}};
 await f.service.turn(request);const after=await f.service.current();
 expect(after.last_turn?.narrative).not.toBe(text);expect(after.last_turn?.presentation?.status).toBe('degraded');
 expect(after.entities.find(e=>e.id==='npc_mira')!.components.location?.location_id).toBe('station');
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);expect(narrate).toHaveBeenCalledTimes(3);
 await f.service.turn(request);expect(await f.store.read()).toEqual(after);expect(narrate).toHaveBeenCalledTimes(3);
});

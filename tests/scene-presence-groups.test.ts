import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {validateSave} from '../src/core/state.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(miraPresent=true){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const lin=save.entities.find(e=>e.id==='npc_lin')!;lin.components.location={location_id:'square'};
 const mira=structuredClone(lin);mira.id='npc_mira';mira.components.identity={...mira.components.identity!,name:'米拉'};
 mira.components.location={location_id:miraPresent?'square':'station'};save.entities.push(mira);
 await f.store.write(validateSave(save));return {...f,save};
}
it.each([
 '林舟和米拉走出了房间。',
 '林舟与米拉一起离开了这里。',
 '随后林舟、米拉二人离开了这里。',
 '林舟和米拉没有离开，但随后他们走出了房间。',
])('rejects unreceipted departure by an explicit joint subject: %s',async text=>{
 const {save}=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).toThrow('权威位置');
});
it.each(['林舟和米拉都站在你面前。','林舟与米拉仍留在这里。'])('rejects joint presence including an absent member: %s',async text=>{
 const {save}=await fixture(false);expect(()=>validateScenePresenceNarrative(save,text)).toThrow('不在');
});
it('checks a third explicit group member and escapes literal identity punctuation',async()=>{
 const {save}=await fixture();
 save.entities.find(e=>e.id==='npc_mira')!.components.identity!.name='米拉(甲)';
 const qiao=save.entities.find(e=>e.id==='npc_qiao')!;qiao.components.location={location_id:'square'};
 expect(()=>validateScenePresenceNarrative(save,'林舟、米拉(甲)以及乔宁三人一起走出了房间。')).toThrow('权威位置');
 qiao.components.location={location_id:'station'};
 expect(()=>validateScenePresenceNarrative(save,'林舟、米拉(甲)以及乔宁三人都站在这里。')).toThrow('不在');
});
it('does not make an absent member authorize the departure of another present member',async()=>{
 const {save}=await fixture(false);
 expect(()=>validateScenePresenceNarrative(save,'林舟和米拉一起离开了这里。')).toThrow('权威位置');
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'station'};
 expect(()=>validateScenePresenceNarrative(save,'林舟和米拉已经离开了这里。')).not.toThrow();
});
it.each([
 '林舟和米拉都没有离开。',
 '林舟与米拉打算离开这里。',
 '林舟和米拉朝你走了两步。',
 '林舟对米拉说：“我们离开这里吧。”',
 '林舟和米拉的同事已经离开。',
 '林舟和米拉的目光离开了你。',
])('keeps negative, future, local, quoted and other-subject descriptions legal: %s',async text=>{
 const {save}=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();
});
it('degrades unsupported joint departure and replays the authoritative WAIT once',async()=>{
 const f=await fixture(),text='林舟和米拉一起走出了房间。';
 const narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const request={game_id:f.save.game_id,expected_revision:f.save.state_revision,request_id:randomUUID(),
  action:{type:'WAIT',parameters:{minutes:1}}};
 await f.service.turn(request);const after=await f.service.current();
 expect(after.last_turn?.narrative).not.toBe(text);expect(after.last_turn?.presentation?.status).toBe('degraded');
 expect(after.entities.find(e=>e.id==='npc_mira')!.components.location?.location_id).toBe('square');
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);expect(narrate).toHaveBeenCalledTimes(3);
 await f.service.turn(request);expect(await f.store.read()).toEqual(after);expect(narrate).toHaveBeenCalledTimes(3);
});

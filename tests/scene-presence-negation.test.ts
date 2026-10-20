import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 await f.store.write(save);return {...f,save};
}
const invalid=[
 '林舟没有离开，但随后走出了房间。',
 '林舟准备离开，接着跨过门槛出去了。',
 '林舟没有走出房间；然后离开了这里。',
 '林舟没有离开却走出了房间。',
 '林舟没有犹豫地离开了这里。',
 '林舟并未停下脚步，走出了房间。',
];
it.each(invalid)('does not let an earlier denied or intended departure authorize a later assertion: %s',async text=>{
 const {save}=await fixture();expect(()=>validateScenePresenceNarrative(save,text)).toThrow('权威位置');
});
it.each([
 '林舟没有离开，仍站在这里。',
 '林舟准备离开，但还在原地。',
 '林舟没有离开，也没有走出房间。',
 '林舟尚未真正离开，仍在原地。',
 '林舟准备再离开，但还在这里。',
 '林舟如果离开房间就会走出门口。',
 '林舟的目光没有离开你，脚步也停在原地。',
 '林舟朝你走了两步，然后停下。',
 '林舟说：“我已经离开了这里。”',
])('preserves lawful denial, intention, hypothetical, attention, local step or quoted speech: %s',async text=>{
 const {save}=await fixture(),before=structuredClone(save);expect(()=>validateScenePresenceNarrative(save,text)).not.toThrow();expect(save).toEqual(before);
});
it('repairs false departure prose without moving the NPC or replaying a settled WAIT',async()=>{
 const f=await fixture(),narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:invalid[0],speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const request={game_id:f.save.game_id,expected_revision:f.save.state_revision,request_id:randomUUID(),
  action:{type:'WAIT',parameters:{minutes:1}}};
 await f.service.turn(request);const after=await f.service.current();
 expect(after.last_turn?.narrative).not.toContain('走出了房间');
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
 expect(after.last_turn?.presentation?.status).toBe('degraded');expect(narrate).toHaveBeenCalledTimes(3);
 expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);
 expect(after.runtime.time.minute-f.save.runtime.time.minute).toBe(1);
 await f.service.turn(request);expect(await f.store.read()).toEqual(after);expect(narrate).toHaveBeenCalledTimes(3);
});
it('keeps a truthful denied departure as normal prose with no extra generation',async()=>{
 const f=await fixture(),text='林舟没有离开，仍站在这里。';
 const narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:text,speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 await f.service.turn({game_id:f.save.game_id,expected_revision:f.save.state_revision,request_id:randomUUID(),
  action:{type:'WAIT',parameters:{minutes:1}}});
 const after=await f.service.current();expect(after.last_turn?.narrative).toBe(text);
 expect(after.last_turn?.presentation?.status).toBe('normal');expect(narrate).toHaveBeenCalledOnce();
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
});

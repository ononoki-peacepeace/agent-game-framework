import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validatePerceptionNarrative} from '../src/core/narrative-firewall.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';

afterEach(()=>vi.restoreAllMocks());
const input='尝试打击林舟';
const proposal=()=>({narrative:'尝试行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
 physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
 resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'本次尝试',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}} as const);
function base(){
 const save=newSave(demo);save.definition.events=[];save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 for(const entity of save.entities)if(entity.components.character)entity.components.location={location_id:'square'};
 save.entities.find(e=>e.id==='npc_lin')!.components.physical_state={awareness:'unaware',alert_to_ids:[],restrained_by:null,
  posture:'standing',eyes:'closed',transients:[]};
 return save;
}
function fixture(){
 let i=0;const turn=executeFreeform(base(),input,proposal() as never,randomUUID(),()=>[.99,.01][i++%2]);
 const receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(receipt.physical_outcome?.sight_blocked_ids).toEqual(['npc_lin']);return {save:turn.save,receipt};
}
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
 interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each([
 '乔宁站在这里，林舟看得很清楚。',
 '林舟看清了动作，乔宁留在这里。',
 '林舟没有看见，乔宁也没看见；随后林舟亲眼看见了动作。',
 '林舟和乔宁都目睹了动作过程。',
 '林舟和乔宁没有看见。随后他们看清了动作。',
])('rejects event-time impossible visual claims in multi-person prose: %s',text=>{
 const f=fixture();expect(()=>validatePerceptionNarrative(f.save,f.receipt,narration(text))).toThrow('没有视觉信息');
});
it.each([
 '林舟没有看见，乔宁看清了动作。',
 '乔宁看得很清楚，林舟只听到了声音。',
 '林舟和乔宁都没有看见。',
 '林舟没有看见。随后他也看不清。',
 '林舟和乔宁的同事看清了动作。',
])('preserves the sighted subject and nonvisual or negative controls: %s',text=>{
 const f=fixture();expect(()=>validatePerceptionNarrative(f.save,f.receipt,narration(text))).not.toThrow();
});
it('does not attribute the player observation clause to the sightless NPC',()=>{
 const f=fixture();
 expect(()=>validatePerceptionNarrative(f.save,f.receipt,narration('林舟仍站在这里，你看清了动作。'))).not.toThrow();
});
it('validates multi-person narration beats as well as the legacy paragraph',()=>{
 const f=fixture();expect(()=>validatePerceptionNarrative(f.save,f.receipt,{...narration('动作已经结束。'),
  scene_beats:[{kind:'narration',text:'乔宁站在一旁，林舟看清了动作。'}]})).toThrow('没有视觉信息');
});
it('degrades a multi-person false observation without rerolling the settled event',async()=>{
 const store=new MemoryStore(),ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,demo);
 await store.write(base());const before=await service.current(),text='乔宁站在一旁，林舟看得很清楚。';
 vi.spyOn(ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
 vi.spyOn(ai,'freeform').mockResolvedValue(proposal() as never);
 vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'不另行动',proposed_action:null,
  evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保持现状',social_response:null} as never);
 const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration(text));
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
 await service.turn(request);const after=await service.current();
 expect(after.last_turn?.narrative).not.toContain('看得很清楚');
 expect(after.last_turn?.presentation).toMatchObject({status:'degraded'});expect(narrate).toHaveBeenCalledTimes(3);
 expect(after.resolution_receipts).toHaveLength(1);expect(after.resolution_history).toHaveLength(1);
 expect(after.resolution_receipts![0].physical_outcome?.sight_blocked_ids).toEqual(['npc_lin']);
 await service.turn(request);expect(await store.read()).toEqual(after);expect(narrate).toHaveBeenCalledTimes(3);
});

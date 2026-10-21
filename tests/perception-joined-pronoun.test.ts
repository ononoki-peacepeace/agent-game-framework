import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demo} from './helpers.js';
import {newSave,publicView} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import * as freeform from '../src/core/freeform.js';
import {validatePerceptionNarrative} from '../src/core/narrative-firewall.js';
import {JsonStore} from '../src/storage/json-store.js';
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
 '林舟只听到了声音。他和乔宁看清了动作。',
 '林舟只听到了声音。随后他和乔宁都看清了动作。',
 '林舟只听到了声音，随后他和乔宁都目睹了动作过程。',
 '林舟没有看见。然后她与乔宁亲眼看见了动作。',
])('retains the sightless antecedent as a member of a joined subject: %s',text=>{
 const f=fixture();expect(()=>validatePerceptionNarrative(f.save,f.receipt,narration(text))).toThrow('没有视觉信息');
});
it.each([
 '林舟只听到了声音。随后他和乔宁都没有看见动作。',
 '林舟只听到了声音。随后乔宁看清了动作。',
 '林舟只听到了声音。随后乔宁和她的同事看清了动作。',
 '林舟只听到了声音。你站在一旁。随后你和乔宁看清了动作。',
])('preserves negative and independently sighted-subject controls: %s',text=>{
 const f=fixture(),before=structuredClone(f.save);expect(()=>validatePerceptionNarrative(f.save,f.receipt,narration(text))).not.toThrow();expect(f.save).toEqual(before);
});
it('checks a joined subject carried between typed narration beats',()=>{
 const f=fixture();expect(()=>validatePerceptionNarrative(f.save,f.receipt,{...narration('动作结束。'),scene_beats:[
  {kind:'narration',text:'林舟只听到了声音。'},{kind:'narration',text:'随后他和乔宁都看清了动作。'},
 ]})).toThrow('没有视觉信息');
});
it('still checks sightless own-speech claims in typed and legacy dialogue',()=>{
 const f=fixture();
 expect(()=>validatePerceptionNarrative(f.save,f.receipt,{...narration('动作结束。'),scene_beats:[
  {kind:'speech',speaker_id:'npc_lin',utterance:'我看清了动作。'},
 ]})).toThrow('没有视觉信息');
 expect(()=>validatePerceptionNarrative(f.save,f.receipt,{...narration('动作结束。'),speaker:'npc_lin',dialogue:'我看清了动作。'})).toThrow('没有视觉信息');
});
it.each(['paragraph','beats'] as const)('degrades the invalid %s without rerolling, and replays exact disk bytes',async mode=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-perception-joined-'));try{
  const store=new JsonStore(directory),ai=new AIRuntime(new MockAIAdapter());await store.write(base());
  const service=new GameService(store,ai,demo),before=await service.current();
  vi.spyOn(ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
  vi.spyOn(ai,'freeform').mockResolvedValue(proposal() as never);
  vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'不另行动',proposed_action:null,
   evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保持现状',social_response:null} as never);
  const original=freeform.executeFreeform;
  const core=vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{let i=0;args[4]=()=>[.99,.01][i++%2];return original(...args);});
  const text='林舟只听到了声音。随后他和乔宁都看清了动作。';
  const candidate=mode==='paragraph'?narration(text):{...narration('动作结束。'),scene_beats:[
   {kind:'narration' as const,text:'林舟只听到了声音。'},{kind:'narration' as const,text:'随后他和乔宁都看清了动作。'},
  ]};
  const narrator=vi.spyOn(ai,'narrate').mockResolvedValue(candidate);
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
  const first=await service.turn(request),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.last_turn?.presentation?.status).toBe('degraded');expect(JSON.stringify(first)).not.toContain('看清了动作');
  expect(narrator).toHaveBeenCalledTimes(3);expect(core).toHaveBeenCalledTimes(1);
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts).toHaveLength(1);expect(after.resolution_history).toHaveLength(1);
  expect(after.resolution_receipts![0].physical_outcome?.sight_blocked_ids).toEqual(['npc_lin']);
  expect(after.last_turn?.scene_beats?.some(beat=>beat.kind==='speech')??false).toBe(false);
  const restarted=new GameService(new JsonStore(directory),ai,demo),calls=ai.metrics.requests;
  // Direct turn replay reconstructs publicView; its first-call transient notices
  // are not the durable /api/input response record. Compare each contract exactly.
  const replay=await restarted.turn(request);
  expect(replay).toEqual(publicView(after));expect({...replay,notices:[]}).toEqual({...first,notices:[]});
  expect(first.notices).toEqual([...replay.notices,'场景描写校验未通过，本次展示采用已验证的场景与结算事实。']);
  expect(await restarted.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
  expect(core).toHaveBeenCalledTimes(1);expect(narrator).toHaveBeenCalledTimes(3);
 }finally{await rm(directory,{recursive:true,force:true});}
});

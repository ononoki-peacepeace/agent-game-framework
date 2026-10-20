import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {executeAction} from '../src/core/runtime.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {sparseSetup} from './sparse-fixture.js';
import * as freeform from '../src/core/freeform.js';

afterEach(()=>vi.restoreAllMocks());

function base(){
 const save=newSave(demo);save.definition.events=[];save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 for(const e of save.entities)if(e.components.character)e.components.location={location_id:e.id==='player'||e.id==='npc_lin'?'square':'station'};
 save.entities.find(e=>e.id==='npc_lin')!.components.physical_state={awareness:'unaware',alert_to_ids:[],restrained_by:null,posture:'sitting',eyes:'closed',transients:[]};
 return save;
}
function fixture(finalPhysical:boolean){
 let save=base();
 const steps:NonNullable<typeof save.resolution_receipts>=[];
 for(const physical of finalPhysical?[false,true]:[true,false]){
  const id=randomUUID();let i=0;
  save=physical?executeFreeform(save,'尝试打击林舟',{narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
   physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
   resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'接触并尝试伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}},id,()=>[.99,.01][i++%2]).save:
   executeAction(save,{type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}},id).save;
  steps.push(save.resolution_receipts!.find(r=>r.request_id===id)!);
 }
 const physical=steps.find(r=>r.physical_outcome)!;
 expect(physical.physical_outcome).toMatchObject({harmed:true,sight_blocked_ids:['npc_lin']});
 const aggregate={...steps.at(-1)!,request_id:randomUUID(),canonical_facts:steps.flatMap(r=>r.canonical_facts),effects:[...new Set(steps.flatMap(r=>r.effects))]};
 return {save,steps,aggregate};
}
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each([false,true])('rejects an unconfirmed concrete injury regardless of final child type (physical last=%s)',finalPhysical=>{
 const f=fixture(finalPhysical);
 expect(()=>validateResolvedNarrative(f.aggregate,narration('林舟的手臂骨折了。你向林舟开了口。'),false,f.steps,f.save)).toThrow(/具体伤势/);
 expect(()=>validateResolvedNarrative(f.steps.find(r=>r.physical_outcome)!,narration('林舟的手臂骨折了。'),false,[],f.save)).toThrow(/具体伤势/);
 expect(()=>validateResolvedNarrative(f.aggregate,narration('你的动作触及林舟，造成了伤害。你向林舟开了口。'),false,f.steps,f.save)).not.toThrow();
});
it.each([false,true])('retains the physical child sight limit after a later TALK (physical last=%s)',finalPhysical=>{
 const f=fixture(finalPhysical);
 expect(()=>validateResolvedNarrative(f.aggregate,narration('林舟看清了你刚才的动作。'),false,f.steps,f.save)).toThrow(/视觉信息/);
 expect(()=>validateResolvedNarrative(f.aggregate,narration('林舟仍在这里。你向林舟开了口。'),false,f.steps,f.save)).not.toThrow();
});
it.each(['injury','perception'] as const)('rejects %s in the real physical-first/TALK-last service and degrades without replaying Core',async kind=>{
 const f=await sparseSetup(),before=base();
 await f.store.write(before);
 vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>input==='向林舟问好'?{type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}}:{type:'FREEFORM_ACTION',parameters:{}});
 vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'接触并尝试伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}} as never);
 const original=freeform.executeFreeform;vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{let i=0;args[4]=()=>[.99,.01][i++%2];return original(...args);});
 const phrase=kind==='injury'?'林舟的手臂骨折了。':'林舟看清了你刚才的动作。';
 const narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({...narration(phrase),presence_claims:[]});
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'尝试打击林舟，再向林舟问好'};
 const run=()=>f.service.turn(request,undefined,undefined,undefined,false,undefined,['尝试打击林舟','向林舟问好']);
 await run();const after=await f.service.current();
 expect(narrate).toHaveBeenCalledTimes(3);expect(after.last_turn!.presentation?.status).toBe('degraded');
 expect(after.last_turn!.narrative).not.toContain(phrase);expect(after.last_turn!.narrative).toContain('伤害');expect(after.last_turn!.narrative).toContain('开了口');
 expect(after.resolution_receipts).toHaveLength(3);expect(after.state_revision).toBe(before.state_revision+1);
 await run();expect(await f.store.read()).toEqual(after);expect(narrate).toHaveBeenCalledTimes(3);
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {validateSave} from '../src/core/state.js';
import * as freeform from '../src/core/freeform.js';

afterEach(()=>vi.restoreAllMocks());

it.each(['two-events','witness','repair','compile-only','pending-retry','pending-witness','pending-repair'] as const)('bounds compound reactions and preserves child ownership: %s',async mode=>{
 const mock=new MockAIAdapter(),f=await sparseSetup(req=>mock.generate(req)),before=await f.service.current();
 before.definition.events=[];before.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 for(const e of before.entities)if(e.components.character)e.components.location={location_id:
  e.id==='player'||e.id==='npc_lin'||mode.includes('witness')&&e.id==='npc_qiao'?'square':'station'};
 before.entities.find(e=>e.id==='npc_lin')!.components.condition={hp:100,stamina:100,stress:0};
 await f.store.write(before);
 vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>input==='向林舟问好'?
  {type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}}:{type:'FREEFORM_ACTION',parameters:{}});
 vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'接触并尝试伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}} as never);
 const original=freeform.executeFreeform;
 vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{let i=0;args[4]=()=>[.99,.01][i++%2];return original(...args);});
 const response={kind:'speech' as const,speech:'先停一下。',vote_target:null,intent:'表达意愿',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'本人已决定发言',social_response:null};
 const decisions=vi.spyOn(f.ai,'npcDecision').mockResolvedValue(response);
 if(mode.includes('repair'))decisions.mockResolvedValueOnce({...response,kind:'invalid'} as never);
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
 const steps=['尝试打击林舟','尝试打击林舟','向林舟问好'];
 const req={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，再')};
 const run=()=>f.service.turn(req,undefined,undefined,undefined,mode==='compile-only',undefined,steps);
 if(mode.startsWith('pending-')){
  const write=f.store.write.bind(f.store);let failed=false;
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
   if(!failed&&save.last_turn?.presentation?.status==='degraded'){failed=true;throw Error('offline save fault');}
   return write(save,slot);
  });
  await expect(run()).rejects.toThrow('offline save fault');
  expect(await f.store.read()).toEqual(before);
 }
 await run();const after=await f.service.current();expect(()=>validateSave(after)).not.toThrow();
 const physical=after.resolution_receipts!.filter(r=>r.physical_outcome);
 expect(physical).toHaveLength(2);
 expect(decisions).toHaveBeenCalledTimes(mode==='compile-only'?0:2);
 const admitted=Object.values(after.npc_agent_state??{}).flatMap(m=>m.last_decisions.filter(d=>d.event_ref.startsWith('reaction:')));
 expect(admitted).toHaveLength(mode==='compile-only'?0:mode.includes('repair')?1:2);
 expect(admitted.every(d=>physical.some(r=>d.event_ref===`reaction:${r.request_id}`))).toBe(true);
 if(mode.includes('witness')||mode.includes('repair'))expect(admitted.every(d=>d.event_ref===`reaction:${physical[0].request_id}`)).toBe(true);
 if(mode==='compile-only')expect(after.last_turn!.scene_beats?.some(b=>b.kind==='speech')??false).toBe(false);
 else expect(after.last_turn!.scene_beats?.filter(b=>b.kind==='speech')).toHaveLength(admitted.length);
 expect(after.state_revision).toBe(before.state_revision+1);
 const count=decisions.mock.calls.length;await run();expect(await f.store.read()).toEqual(after);expect(decisions).toHaveBeenCalledTimes(count);
});

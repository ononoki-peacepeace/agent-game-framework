import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import * as freeform from '../src/core/freeform.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SceneStory} from '../src/client/SceneStory.js';

afterEach(()=>vi.restoreAllMocks());

const cases=(['refusal','timeout','fact_conflict'] as const).flatMap(reason=>[true,false].map(finalPhysical=>({reason,finalPhysical})));
it.each(cases)('retains ordered speech and physical steps after $reason (physical last: $finalPhysical)',async({reason,finalPhysical})=>{
 const mock=new MockAIAdapter(),f=await sparseSetup(request=>mock.generate(request)),before=await f.service.current();
 before.definition.events=[];before.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 for(const entity of before.entities)if(entity.components.character)entity.components.location={location_id:entity.id==='player'||entity.id==='npc_lin'?'square':'station'};
 before.entities.find(entity=>entity.id==='npc_lin')!.components.condition={hp:100,stamina:100,stress:0};
 await f.store.write(before);
 const steps=finalPhysical?['向林舟问好','尝试打击林舟']:['尝试打击林舟','向林舟问好'];
 vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>input==='向林舟问好'?
  {type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}}:{type:'FREEFORM_ACTION',parameters:{}});
 vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'身体候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'接触并尝试伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}} as never);
 const original=freeform.executeFreeform;
 vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{let i=0;args[4]=()=>[.99,.01][i++%2];return original(...args);});
 vi.spyOn(f.ai,'npcDecision').mockResolvedValue({kind:'speech',speech:'先停一下。',vote_target:null,intent:'表达意愿',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'只说这句话',social_response:null});
 const narrate=vi.spyOn(f.ai,'narrate');
 if(reason==='fact_conflict')narrate.mockResolvedValue({narrative:'虚构的进展。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[{kind:'progress',fact_index:99}],presence_claims:[]});
 else narrate.mockRejectedValue(new ProviderError(reason,'offline fixture','描写未完成'));
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，再')};
 const run=()=>f.service.turn(request,undefined,undefined,undefined,false,undefined,steps);
 await run();const after=await f.service.current(),prose=after.last_turn!.narrative;
 expect(after.resolution_receipts?.slice(-3).map(r=>r.commit_status)).toEqual(['committed','committed','committed']);
 expect(after.resolution_receipts?.slice(-3,-1).some(r=>r.physical_outcome?.harmed)).toBe(true);
 expect(prose).toMatch(/开了口|说|交谈/);
 expect(prose).toContain('林舟');expect(prose).toContain('伤害');
 expect(prose.search(/开了口|说|交谈/)<prose.indexOf('伤害')).toBe(finalPhysical);
 expect(prose).not.toMatch(/身体行动结算|进行了活动|话题：|本次行动经过|程序|回执|生成|已经保存/);
 expect(after.last_turn!.presentation?.status).toBe('degraded');
 expect(after.state_revision).toBe(before.state_revision+1);
 const html=renderToStaticMarkup(createElement(SceneStory,{view:f.service.project(after),override:null,onSelectEntity:()=>{}}));
 expect(html).toContain('开了口');expect(html).toContain('伤害');
 expect(html).toContain('先停一下。');expect(after.last_turn!.scene_beats?.some(beat=>beat.kind==='speech')).toBe(true);
 const physical=after.resolution_receipts!.slice(-3,-1).find(r=>r.physical_outcome)!;
 expect(after.npc_agent_state?.npc_lin.last_decisions.filter(d=>d.event_ref===`reaction:${physical.request_id}`)).toHaveLength(1);
 expect(after.npc_agent_state?.npc_lin.last_decisions.some(d=>d.event_ref===`reaction:${request.request_id}`)).toBe(false);
 const count=narrate.mock.calls.length;
 await run();expect(await f.store.read()).toEqual(after);expect(narrate).toHaveBeenCalledTimes(count);
 expect(count).toBe(reason==='fact_conflict'?3:1);
 const args=narrate.mock.calls[0];narrate.mockRestore();
 await f.ai.narrate(...args);
 const prompt=f.calls.findLast(call=>call.role==='narrator')!.prompt;
 const context=JSON.parse(prompt.slice(prompt.indexOf('{')));
 expect(context.significant_incidents).toHaveLength(1);
 expect(context.significant_incident.request_id).toBe(physical.request_id);
 expect(context.significant_incident.reactions.find((r:any)=>r.id==='npc_lin').decision.speech).toBe('先停一下。');
});

import {it,expect} from 'vitest';
import {AIRuntime} from '../src/ai/runtime.js';
import {decideNpc} from '../src/agent/npc-agent.js';
import {newSave} from '../src/core/state.js';
import {proposeValidatedBackground} from '../src/background/generation.js';
import {exploreLocation} from '../src/agent/location-exploration.js';
import {ProviderError} from '../src/ai/failures.js';
import type {GameService} from '../src/server/service.js';
import {demo} from './helpers.js';

const quiet=()=>({kind:'no_action',speech:null,vote_target:null,intent:'维持当前安排',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'没有新行动',social_response:null});
it.each(['schema','semantic'])('terminates after the one NPC %s correction fails, without a world write',async stage=>{
 let calls=0;const save=newSave(demo),before=structuredClone(save);
 const ai=new AIRuntime({name:'offline-fault-injection',generate:async()=>{calls++;return {data:stage==='schema'?{...quiet(),belief_updates:'wrong type'}:{...quiet(),kind:'proposed_action'}};}});
 await expect(decideNpc({ai} as GameService,save,'npc_lin',{kind:'world_event',description:'日常活动'})).rejects.toThrow();
 expect(calls).toBe(2);expect(save).toEqual(before);
});
function pendingWorld(){const save=newSave(demo);save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:0,replenishment:true};
 save.definition.background_incidents=[];save.background_state={version:1,incidents:[],event_log:[],exposure_log:[],npc_status:{},macro_arcs:[],pending_display_ids:[],last_evaluation:null,needs_generation:true,last_terminal_at:null,last_activation_at:null};return save;}
it('sends a raw Director schema failure, including path and candidate, back through its actual generation callback',async()=>{
 const save=pendingWorld(),before=structuredClone(save);let calls=0;
 const ai=new AIRuntime({name:'offline-director',generate:async request=>{
  calls++;if(calls===1)return {data:{decision:'quiet',incident:null,reason:7}};
  expect(request.prompt).toContain('"previous":{"decision":"quiet","incident":null,"reason":7}');
  expect(request.prompt).toContain('reason: invalid_type');
  return {data:{decision:'quiet',incident:null,reason:'没有符合条件的发展'}};
 }});
 const after=await proposeValidatedBackground(save,repair=>ai.proposeBackgroundContinuation(save,repair));
 expect(calls).toBe(2);expect(after.background_state?.needs_generation).toBe(false);expect(save).toEqual(before);
});
it('caps repeated invalid Director results at three and preserves the original world',async()=>{
 const save=pendingWorld(),before=structuredClone(save);let calls=0;
 const ai=new AIRuntime({name:'offline-director',generate:async()=>{calls++;return {data:{decision:'quiet',incident:null,reason:7}};}});
 await expect(proposeValidatedBackground(save,repair=>ai.proposeBackgroundContinuation(save,repair))).rejects.toThrow('三次');
 expect(calls).toBe(3);expect(save).toEqual(before);
});
it('does not ask the Director to repair transport or file/program errors',async()=>{
 for(const error of [new ProviderError('timeout','offline timeout','超时'),new Error('EACCES: file write')]){
  const save=pendingWorld(),before=structuredClone(save);let calls=0;
  await expect(proposeValidatedBackground(save,async()=>{calls++;throw error;})).rejects.toBe(error);
  expect(calls).toBe(1);expect(save).toEqual(before);
 }
});
it('terminates after one location schema correction without inventing a location',async()=>{
 const save=newSave(demo),before=structuredClone(save);let calls=0;
 const ai=new AIRuntime({name:'offline-location',generate:async()=>{calls++;return {data:{decision:'wrong_kind'}};}});
 await expect(exploreLocation({ai} as GameService,save,'附近的公共阅览室','offline-location-request')).rejects.toThrow('location_search');
 expect(calls).toBe(2);expect(save).toEqual(before);
});

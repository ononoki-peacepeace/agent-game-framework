import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {executeAction} from '../src/core/runtime.js';
import {settlePhysicalNpcReactions,type NpcDecision} from '../src/agent/npc-agent.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';
import type {GameService} from '../src/server/service.js';

// Reconstruction of tr_5ea7d99bf223, not a recorded Provider replay.
function fixture(){
  const world=structuredClone(demo);world.events=[];world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  const save=newSave(world);
  recordNpcActivityPlans(save,sceneResultSchema.parse({understanding:'本人既有离场计划',narrative:'林舟准备离开。',dialogue:'我去市场。',
    speech_events:[{speaker_id:'npc_lin',utterance:'我去市场。',provenance:'npc_response'}],effects:[],
    npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',readiness:'ready',condition:null,plan_id:null}]}),randomUUID(),'square');
  const request=randomUUID(),input='尝试打击林舟';
  const turn=executeFreeform(save,input,{narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
    physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
    resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'尝试',
      stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}},request,()=>.1);
  return {turn,request};
}
const response=(destination:string|null):NpcDecision=>({kind:'speech',speech:'别靠近，按我的安排离开。',vote_target:null,
  intent:'继续自己的计划',proposed_action:destination?{type:'MOVE',target_id:destination,reason:'离开当前现场'}:null,
  evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保持已有安排',social_response:null});

describe('physical reaction executable-plan ownership',()=>{
  it('reuses a compatible departure without resetting credit, adding plans or moving twice',async()=>{
    const {turn,request}=fixture(),old=structuredClone(turn.save.npc_agent_state!.npc_lin.plans),before=structuredClone(turn.save);
    let calls=0;const service={ai:{npcDecision:async()=>{calls++;return response('market');}}} as unknown as GameService;
    const reacted=await settlePhysicalNpcReactions(service,turn.save,request);
    expect(()=>validateSave(reacted.save)).not.toThrow();
    expect(reacted.save.npc_agent_state!.npc_lin.plans).toEqual(old);
    expect(reacted.save.runtime.time).toEqual(before.runtime.time);
    expect(turn.save).toEqual(before);
    const replay=await settlePhysicalNpcReactions(service,reacted.save,request);expect(calls).toBe(1);
    expect(replay.save.npc_agent_state!.npc_lin.plans).toEqual(old);
    const later=executeAction(reacted.save,{type:'WAIT',parameters:{minutes:6}},randomUUID()).save;
    expect(later.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
  });

  it('feeds a conflicting derived destination back to its NPC owner and preserves the original plan',async()=>{
    const {turn,request}=fixture(),old=structuredClone(turn.save.npc_agent_state!.npc_lin.plans);
    let calls=0,repair:unknown;
    const service={ai:{npcDecision:async(_profile:unknown,_context:unknown,feedback:unknown)=>{
      calls++;repair=feedback;return calls===1?response('station'):response(null);
    }}} as unknown as GameService;
    const result=await settlePhysicalNpcReactions(service,turn.save,request);
    expect(calls).toBe(2);expect(JSON.stringify(repair)).toContain('proposed_action');
    expect(JSON.stringify(repair)).toContain('station');
    expect(JSON.stringify(repair)).toContain('conflicts with its existing executable plan');
    expect(result.save.npc_agent_state!.npc_lin.plans).toEqual(old);
    expect(()=>validateSave(result.save)).not.toThrow();
  });
});

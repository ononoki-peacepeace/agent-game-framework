import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {executeAction} from '../src/core/runtime.js';
import {prepareCheck} from '../src/core/resolution.js';
import {establishTransient,readPhysicalState} from '../src/core/perception-state.js';
import {applyNpcDecision,settlePhysicalNpcReactions,type NpcDecision} from '../src/agent/npc-agent.js';
import {validatePerceptionNarrative,physicalNarrativeFallback} from '../src/core/narrative-firewall.js';
import type {GameService} from '../src/server/service.js';

/**
 * Independent acceptance for cross-turn bodily continuity and perception grounding.
 *
 * Reproduces two production failures as *general* cases — no NPC id, command wording or
 * attack type is special-cased anywhere in the assertions:
 *   REV427/428  an NPC agreed in prose to close her eyes; nothing was written to state.
 *   REV434/435  the next physical attempt adjudicated her as a fully alert defender, and
 *               her reaction line "刚才那一记，我看得很清楚" became an authoritative world fact.
 *
 * Mock labelling: the AI provider is a test double (`npcDecision` only). Dice are injected.
 * No pre-written Narrator prose is accepted as evidence; prose here is *input* under test.
 */
const input='我突然抓住林舟，再尝试伤害他';
function fixture(){
  const world=structuredClone(demo);world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  const save=newSave(world);
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
  player.components.scene_position={label:'桌旁'};npc.components.scene_position={label:'桌旁'};
  npc.components.condition={hp:100,stamina:100,stress:0};
  return save;
}
const proposal=()=>({narrative:'尝试身体行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'抓住林舟',contact_stage_id:'contact',injury_stage_id:'harm',harm_level:'serious',surprise_attempt:true},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
    stakes:'先接触，再尝试造成伤害',stages:[{id:'contact',band:'normal'},{id:'harm',band:'hard'}],evidence_ids:[],discover_facts:false}});
const rng=(values:number[])=>()=>{const value=values.shift();if(value===undefined)throw Error('unexpected extra roll');return value;};
const baseDecision=(overrides:Partial<NpcDecision>={}):NpcDecision=>({kind:'no_action',speech:null,vote_target:null,
  intent:'暂不行动',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],
  plan_proposals:[],decision_summary:'根据亲历事件决定',social_response:null,...overrides} as NpcDecision);
const check={type:'OPPOSED_CHECK' as const,domain:'physique',opposition_domain:'agility',band:'normal' as const,
  target_id:'npc_lin',physical:true};
const prose=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[]});

describe('bodily transients and perception grounding across turns',()=>{
  it('writes an NPC-declared bodily change into authoritative state with provenance and a lifetime',()=>{
    const save=fixture();
    applyNpcDecision(save,'npc_lin','social:turn-1',baseDecision({kind:'speech',
      speech:'好吧，我闭上眼。你什么时候开口，我什么时候睁眼。',
      self_state:{posture:'sitting',eyes:'closed',statement:'应对方请求坐着闭眼等待',
        duration_minutes:30,release_condition:'对方开口说话'}}));
    const state=readPhysicalState(save.entities.find(entity=>entity.id==='npc_lin'));
    expect(state).toMatchObject({posture:'sitting',eyes:'closed'});
    expect(state.transients.map(item=>[item.kind,item.source,item.source_ref])).toEqual(
      expect.arrayContaining([['posture','npc_decision','social:turn-1'],['eyes','npc_decision','social:turn-1']]));
    expect(state.transients.find(item=>item.kind==='eyes')).toMatchObject({
      release_condition:'对方开口说话',expires_at:{day:save.runtime.time.day,minute:save.runtime.time.minute+30}});
    // Survives the authoritative save contract, which is what REV435 lacked entirely.
    const reloaded=validateSave(JSON.parse(JSON.stringify(save)));
    expect(readPhysicalState(reloaded.entities.find(entity=>entity.id==='npc_lin'))).toEqual(state);
    // Posture and sight are plainly observable in a shared scene; private alertness is not.
    const view=publicView(reloaded).entities.find(entity=>entity.id==='npc_lin')!;
    expect(view.components.physical_state).toMatchObject({posture:'sitting',eyes:'closed',alert_to_ids:[]});
  });

  it('adjudicates recorded posture and sight instead of treating a blinded target as fully alert',()=>{
    const save=fixture(),target=save.entities.find(entity=>entity.id==='npc_lin')!;
    expect(prepareCheck(save,randomUUID(),check).actor_modifier).toBe(0);
    // REV435's actual state: alert, nothing else. An alert defender gains a modifier.
    target.components.physical_state={awareness:'alert',alert_to_ids:['player'],restrained_by:null};
    const alerted=prepareCheck(save,randomUUID(),check);
    expect([alerted.actor_modifier,alerted.opponent_modifier]).toEqual([0,2]);
    // Same alertness, but sight and posture are now recorded. Being "generally alert"
    // cannot help a defender who has no sight of the actor at this moment.
    applyNpcDecision(save,'npc_lin','social:turn-1',baseDecision({kind:'speech',speech:'我闭上眼。',
      self_state:{posture:'sitting',eyes:'closed',statement:'坐着闭眼等待'}}));
    const blinded=prepareCheck(save,randomUUID(),check);
    expect(blinded.opponent_modifier).toBe(0);
    expect(blinded.actor_modifier).toBeGreaterThan(alerted.actor_modifier);
    expect(blinded.circumstance_modifiers?.map(item=>item.side)).toEqual(['actor','actor']);
    // A declared lying posture is a larger, still bounded, recorded disadvantage.
    applyNpcDecision(save,'npc_lin','social:turn-2',baseDecision({kind:'speech',speech:'我躺下了。',
      self_state:{posture:'lying',statement:'躺在长椅上'}}));
    expect(prepareCheck(save,randomUUID(),check).actor_modifier).toBeGreaterThan(blinded.actor_modifier);
  });

  it('records who had no sight at settlement, states it as fact, and ends the voluntary state',()=>{
    const save=fixture();
    applyNpcDecision(save,'npc_lin','social:turn-1',baseDecision({kind:'speech',speech:'我闭上眼。',
      self_state:{eyes:'closed',statement:'应请求闭眼等待',release_condition:'对方开口说话'}}));
    const turn=executeFreeform(save,input,proposal(),randomUUID(),rng([.95,.1,.95,.1]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt.physical_outcome?.sight_blocked_ids).toEqual(['npc_lin']);
    expect(turn.facts.join(' ')).toContain('没有看见动作过程');
    // The settled event itself ends the eyes-closed state; only the receipt still records
    // what was true while the action happened.
    expect(readPhysicalState(turn.save.entities.find(entity=>entity.id==='npc_lin')).eyes).toBe('open');
    expect(validateSave(JSON.parse(JSON.stringify(turn.save))).resolution_receipts!.at(-1)!.physical_outcome)
      .toEqual(receipt.physical_outcome);
    // A sighted bystander in the same scene is not marked blind.
    const sighted=fixture();
    const open=executeFreeform(sighted,input,proposal(),randomUUID(),rng([.95,.1,.95,.1]));
    expect(open.save.resolution_receipts!.at(-1)!.physical_outcome?.sight_blocked_ids).toBeUndefined();
  });

  it('rejects a reaction line that claims an observation the NPC could not have made',async()=>{
    const save=fixture();
    applyNpcDecision(save,'npc_lin','social:turn-1',baseDecision({kind:'speech',speech:'我闭上眼。',
      self_state:{eyes:'closed',statement:'应请求闭眼等待'}}));
    const req=randomUUID();
    const turn=executeFreeform(save,input,proposal(),req,rng([.95,.1,.95,.1]));
    const seen:{sight_blocked:boolean;attempt:number}[]=[];
    const service={ai:{npcDecision:async(_p:unknown,context:{scene:{event:{sight_blocked:boolean}}})=>{
      seen.push({sight_blocked:context.scene.event.sight_blocked,attempt:seen.length+1});
      return baseDecision({kind:'speech',speech:seen.length===1
        ?'刚才那一记，我看得很清楚。'
        :'我没有看见，但我感觉到了。'});
    }}} as unknown as GameService;
    const reacted=await settlePhysicalNpcReactions(service,turn.save,req);
    // The event told the NPC it had no sight, the bad line was rejected, and the repair
    // attempt — not a dropped reaction — is what reached the world.
    expect(seen.map(entry=>entry.sight_blocked)).toEqual([true,true]);
    expect(reacted.visibleFacts.join(' ')).toContain('我没有看见');
    expect(reacted.visibleFacts.join(' ')).not.toContain('看得很清楚');
    const committed=reacted.save.resolution_receipts!.find(item=>item.request_id===req)!;
    expect(committed.canonical_facts.join(' ')).not.toContain('看得很清楚');
  });

  it('keeps an unverifiable observation out of narration and out of degraded presentation',()=>{
    const save=fixture();
    const req=randomUUID();
    applyNpcDecision(save,'npc_lin','social:turn-1',baseDecision({kind:'speech',speech:'我闭上眼。',
      self_state:{eyes:'closed',statement:'应请求闭眼等待'}}));
    const turn=executeFreeform(save,input,proposal(),req,rng([.95,.1,.95,.1]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(()=>validatePerceptionNarrative(turn.save,receipt,prose('林舟看得很清楚，立刻侧身。') as never)).toThrow('没有视觉信息');
    expect(()=>validatePerceptionNarrative(turn.save,receipt,prose('林舟没有看见，但他感到了力道。') as never)).not.toThrow();
    expect(()=>validatePerceptionNarrative(turn.save,receipt,prose('林舟猛地吸了一口气。随后他目睹了整个过程。') as never)).toThrow('没有视觉信息');
    expect(()=>validatePerceptionNarrative(turn.save,receipt,
      {...prose('屋里一阵安静。'),scene_beats:[{kind:'speech',speaker_id:'npc_lin',utterance:'我看得很清楚。'}]} as never)).toThrow('没有视觉信息');
    // Degradation reuses stored speech, so speech recorded before this rule existed —
    // exactly REV435's saved line — must not reappear as presented world content.
    const degraded=structuredClone(turn.save);
    degraded.npc_agent_state!.npc_lin.last_decisions.push({event_ref:`reaction:${req}`,kind:'speech',
      summary:'对亲历事件的回应',speech:'刚才那一记，我看得很清楚。',target_id:null,revision:degraded.state_revision});
    const fallback=physicalNarrativeFallback(degraded,receipt,false);
    expect(fallback.scene_beats.some(beat=>beat.kind==='speech')).toBe(false);
    expect(fallback.narrative).not.toContain('看得很清楚');
  });

  it('expires a declared transient with the world clock and keeps an unexpired one in force',()=>{
    const save=fixture();
    establishTransient(save,'npc_lin',{kind:'eyes',value:'closed',statement:'短暂闭眼',
      source:'npc_decision',source_ref:'social:turn-1',duration_minutes:5});
    establishTransient(save,'npc_lin',{kind:'impairment',value:'dizzy',statement:'仍然头晕',
      source:'core_action',source_ref:'action:turn-1',duration_minutes:120});
    const waited=executeAction(save,{type:'WAIT',parameters:{minutes:10}},randomUUID()).save;
    const state=readPhysicalState(waited.entities.find(entity=>entity.id==='npc_lin'));
    expect(state.eyes).toBe('open');
    expect(state.transients.map(item=>item.kind)).toEqual(['impairment']);
    // The still-live impairment keeps constraining adjudication, so expiry is not a blanket reset.
    expect(prepareCheck(waited,randomUUID(),check).actor_modifier).toBe(0);
  });

  it('leaves no bodily trace when a candidate decision is rejected to exhaustion',async()=>{
    const save=fixture(),req=randomUUID();
    applyNpcDecision(save,'npc_lin','social:turn-1',baseDecision({kind:'speech',speech:'我闭上眼。',
      self_state:{eyes:'closed',statement:'应请求闭眼等待'}}));
    const turn=executeFreeform(save,input,proposal(),req,rng([.95,.1,.95,.1]));
    const before=structuredClone(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.physical_state);
    let calls=0;
    // Never corrects itself, so every attempt is rejected and the reaction is dropped.
    // The bodily change it asked for must not survive that rejection.
    const service={ai:{npcDecision:async()=>{calls++;return baseDecision({kind:'speech',
      speech:'刚才那一记，我看得很清楚。',
      self_state:{posture:'lying',eyes:'closed',statement:'躺下并闭眼'}});}}} as unknown as GameService;
    const reacted=await settlePhysicalNpcReactions(service,turn.save,req);
    expect(calls).toBe(2);
    const after=reacted.save.entities.find(entity=>entity.id==='npc_lin')!.components.physical_state;
    expect(after).toEqual(before);
    expect(readPhysicalState(reacted.save.entities.find(entity=>entity.id==='npc_lin'))).toMatchObject(
      {posture:'unknown',eyes:'open',transients:[]});
    expect(reacted.visibleFacts.join(' ')).not.toContain('看得很清楚');
    // A dropped reaction is a presentation gap, never a silent world change.
    expect(reacted.save.resolution_receipts!.find(item=>item.request_id===req)!.canonical_facts.join(' '))
      .not.toContain('看得很清楚');
  });
});

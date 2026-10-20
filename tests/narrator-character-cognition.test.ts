import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {narratorCharacterCognition} from '../src/narrative/character-cognition.js';

const input='我突然抓住林舟，再尝试伤害他';
const proposal=()=>({narrative:'尝试身体行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'抓住林舟',contact_stage_id:'contact',injury_stage_id:'harm',
    harm_level:'serious',surprise_attempt:true},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',
    visibility:'public',stakes:'先接触，再尝试造成伤害',
    stages:[{id:'contact',band:'normal'},{id:'harm',band:'hard'}],evidence_ids:[],discover_facts:false}});
const rng=(values:number[])=>()=>{
  const value=values.shift();if(value===undefined)throw Error('unexpected extra roll');return value;};

/** The attacked character has their eyes closed; a second character is present and sighted. */
function fixture(){
  const world=structuredClone(demo);world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  const save=newSave(world);
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const target=save.entities.find(entity=>entity.id==='npc_lin')!;
  const other=save.entities.find(entity=>entity.id==='npc_qiao')!;
  player.components.scene_position={label:'桌旁'};target.components.scene_position={label:'桌旁'};
  target.components.condition={hp:100,stamina:100,stress:0};
  target.components.physical_state={awareness:'unaware',alert_to_ids:[],restrained_by:null,
    posture:'sitting',eyes:'closed',transients:[]};
  other.components.location=structuredClone(player.components.location);
  save.npc_agent_state={npc_lin:emptyNpcAgentState(),npc_qiao:emptyNpcAgentState()};
  save.npc_agent_state.npc_lin.knowledge.push({id:'rumour',proposition:'有人说仓库的钥匙不见了',
    source_type:'told_by',source_ref:'npc_qiao',learned_at:save.runtime.time,confidence:0.4});
  save.npc_agent_state.npc_lin.goals.push({id:'rest',description:'今天只想安静休息',horizon:'short',
    status:'active',origin:'self',priority:5});
  save.npc_agent_state.npc_qiao.knowledge.push({id:'own_secret',
    proposition:'乔只有自己知道的那笔欠款',source_type:'self_knowledge',source_ref:null,
    learned_at:save.runtime.time,confidence:1});
  save.gm_state.notes='GM_ONLY_TRUTH_NOT_FOR_ANY_CHARACTER';
  return save;
}

describe('narrator character cognition',()=>{
  it('reports authoritative sight and body state without inventing a second posture model',()=>{
    const save=fixture();
    const [target]=narratorCharacterCognition(save,['npc_lin']);
    expect(target.sight.blocked).toBe(true);
    expect(target.sight.reason).toContain('闭着眼');
    expect(target.authoritative_body).toMatchObject({posture:'sitting',eyes:'closed',restrained_by:null});
    expect(target.authoritative_body.summary).toContain('闭着眼');
    const [sighted]=narratorCharacterCognition(save,['npc_qiao']);
    expect(sighted.sight.blocked).toBe(false);
    // The player's own cognition is the player's, and unknown ids are skipped silently.
    expect(narratorCharacterCognition(save,[save.player_state.entity_id,'npc_missing'])).toEqual([]);
  });

  it('keeps each entry to that character own cognition and marks hearsay as hearsay',()=>{
    const save=fixture(),entries=narratorCharacterCognition(save,['npc_lin','npc_qiao','npc_lin']);
    expect(entries.map(entry=>entry.id)).toEqual(['npc_lin','npc_qiao']);
    const target=entries[0]!,other=entries[1]!;
    expect(target.own_knowledge).toEqual([{proposition:'有人说仓库的钥匙不见了',source_type:'told_by',
      confidence:0.4}]);
    expect(target.own_active_goals).toEqual([{description:'今天只想安静休息',horizon:'short'}]);
    // One character's private cognition never appears inside another's entry.
    expect(JSON.stringify(target)).not.toContain('那笔欠款');
    expect(other.own_knowledge.map(item=>item.source_type)).toEqual(['self_knowledge']);
    expect(JSON.stringify(entries)).not.toContain('GM_ONLY_TRUTH_NOT_FOR_ANY_CHARACTER');
  });

  it('tells the narrator which witness was blind, alongside the cognition it is validated against',async()=>{
    const save=fixture();
    const turn=executeFreeform(save,input,proposal() as never,randomUUID(),rng([.95,.1,.95,.1]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt.physical_outcome?.sight_blocked_ids).toEqual(['npc_lin']);
    const before=structuredClone(turn.save);
    let prompt='';
    const ai=new AIRuntime({name:'cognition-fixture',generate:async request=>{
      prompt=request.prompt;
      return {data:{narrative:'他在毫无防备中被攥住手腕，猛地绷紧了身体。',speaker:null,dialogue:null,
        choices:[],context_actions:[],patches:[],item_claims:[],stable_locations:[],mechanical_claims:[]}};
    }});
    await ai.narrate(turn.save,turn.action,turn.facts,receipt);
    const payload=JSON.parse(prompt.split('\n\n').at(-1)!);
    const cognition=payload.character_context.character_cognition as {id:string;sight:{blocked:boolean}}[];
    const blind=cognition.find(entry=>entry.id==='npc_lin')!;
    expect(blind.sight.blocked).toBe(true);
    expect(payload.significant_incident.reactions)
      .toContainEqual(expect.objectContaining({id:'npc_lin',sight_blocked:true}));
    expect(payload.significant_incident.reactions.find((entry:{id:string})=>entry.id==='npc_qiao')?.sight_blocked)
      .toBe(false);
    expect(payload.significant_incident.instruction).toContain('sight_blocked');
    expect(payload.character_context.cognition_policy).toContain('sight.blocked');
    expect(payload.character_context.cognition_policy).toContain('不是世界真相');
    // Additive only: the fields the narrator already relied on are still there.
    expect(payload.character_context.characters.length).toBeGreaterThan(0);
    expect(payload.character_context.recent_turns).toBeDefined();
    expect(payload.character_context.guidance).toBeDefined();
    expect(prompt).not.toContain('GM_ONLY_TRUTH_NOT_FOR_ANY_CHARACTER');
    // Presentation must not mutate authoritative state.
    expect(turn.save).toEqual(before);
  });
});

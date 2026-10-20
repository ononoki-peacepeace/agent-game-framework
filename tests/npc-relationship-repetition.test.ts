import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {settleRelationshipOutcomes} from '../src/agent/npc-relations.js';

const text='立即反复尝试攻击林舟十秒，直到无法继续。';
const proposal={narrative:'尝试身体行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'攻击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  repetition:{source_quote:text,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable'},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
    stakes:'先接触，再尝试造成伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[],discover_facts:false}};
it('settles one bounded relationship consequence for a whole repeated action rather than once per roll',()=>{
  const save=newSave(demo);save.definition.events=[];
  save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  save.definition.ruleset.relationship_dimensions={
    regard:{min:-100,max:100,initial:0,event_deltas:{conflict:-1,harmed:-2}},
  };
  const target=save.entities.find(entity=>entity.id==='npc_lin')!;
  target.components.condition={hp:100,stamina:100,stress:0};
  for(const entity of save.entities)delete entity.components.relationships;
  const values=Array.from({length:5},()=>[.99,.01]).flat();
  const turn=executeFreeform(save,text,proposal,randomUUID(),()=>values.shift()!);
  const receipt=turn.save.resolution_receipts!.at(-1)!;
  expect(receipt.repetition?.attempt_ids).toHaveLength(5);
  expect(receipt.physical_outcome).toMatchObject({contact:true,harmed:true,damage:25});
  expect(target.components.condition.hp).toBe(100);
  const entries=turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.relationships.entries as
    Record<string,Record<string,number>>;
  expect(entries.player.regard).toBe(-2);
  expect(receipt.result_entities?.relationship_settlement).toEqual(['v1']);
  expect(turn.save.resolution_receipts!.filter(item=>item.request_id!==turn.action.id)
    .every(item=>!item.effects.includes('relationship'))).toBe(true);
  const loaded=validateSave(JSON.parse(JSON.stringify(turn.save)));
  expect(settleRelationshipOutcomes(loaded,turn.action)).toEqual(loaded);
});

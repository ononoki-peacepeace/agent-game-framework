import {expect,it} from 'vitest';
import {fresh} from './helpers.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {narratorCharacterCognition} from '../src/narrative/character-cognition.js';
it.each([true,false])('balances salient and recent memories without changing authority (salient=%s)',salient=>{
 const save=fresh(),mind=emptyNpcAgentState();save.npc_agent_state={npc_lin:mind};
 mind.memories=Array.from({length:5},(_,i)=>({event_ref:'event_'+i,kind:'heard' as const,summary:'记录'+i,
  participant_ids:['npc_lin'],at:{day:1,minute:i},importance:salient&&i===0?3:1}));
 const before=structuredClone(save),context=narratorCharacterCognition(save,['npc_lin'])[0];
 expect(context.own_recent_experience.map(m=>m.summary)).toEqual(salient?['记录0','记录3','记录4']:['记录2','记录3','记录4']);
 expect(context.own_recent_experience.map(m=>m.at.minute)).toEqual(salient?[0,3,4]:[2,3,4]);
 expect(save).toEqual(before);
});

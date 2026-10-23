import {expect,it} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {narratorCharacterCognition} from '../src/narrative/character-cognition.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {validateSave} from '../src/core/state.js';
const cases=narrativeWorldKinds.flatMap(kind=>(['relevant','unrelated','revised'] as const).map(mode=>({kind,mode})));
it.each(cases)('keeps memory participants and relevant history: $kind/$mode',async({kind,mode})=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save);
 const memories=Array.from({length:5},(_,i)=>({event_ref:'memory_'+i,kind:'heard' as const,summary:'旧事'+i,
  participant_ids:['npc_lin','npc_qiao'],at:{day:1,minute:i},importance:i===0?3:1}));
 memories[0].summary='过去的重要事件';
 memories[1]={...memories[1],summary:'对方说下午再来，这只是原话。',participant_ids:mode==='unrelated'?['npc_lin','npc_qiao']:['npc_lin','player']};
 if(mode==='revised'){
  memories[0]={...memories[0],summary:'先前对玩家说下午再来。',participant_ids:['npc_lin','player']};
  memories[1].summary='后来对玩家说今天不来了。';
 }
 save.npc_agent_state??={};save.npc_agent_state.npc_lin={...emptyNpcAgentState(),memories};
 save.npc_agent_state.npc_qiao={...emptyNpcAgentState(),memories:[{...memories[0],event_ref:'qiao_private',summary:'乔宁自己的旧事',participant_ids:['npc_qiao']}]};
 validateSave(save);const before=structuredClone(save);
 const output=narratorCharacterCognition(save,['npc_lin','npc_qiao']);
 await mkdir('.agent-runtime/codex/memory-provenance',{recursive:true});
 await writeFile(`.agent-runtime/codex/memory-provenance/${kind}-${mode}.json`,JSON.stringify({before,output},null,2));
 const selected=output[0].own_recent_experience;
 expect(selected.map(m=>m.summary)).toEqual(mode==='unrelated'?[memories[0].summary,memories[3].summary,memories[4].summary]:[memories[0].summary,memories[1].summary,memories[4].summary]);
 expect(selected).toHaveLength(3);
 for(const entry of selected){const original=memories.find(m=>m.summary===entry.summary)!;
  expect(entry).toMatchObject({event_ref:original.event_ref,participant_ids:original.participant_ids,at:original.at,historical:true});}
 expect(JSON.stringify(output[1])).not.toContain('下午');expect(JSON.stringify(output[0])).not.toContain('乔宁自己的旧事');
 expect(save).toEqual(before);
},30000);

it('uses recorded time rather than import array order for latest relevant experience',async()=>{
 const save=structuredClone((await prepareNarrativeWorld('relationships')).save);
 const items=[
  {event_ref:'promise',kind:'heard' as const,summary:'此前约好再来',participant_ids:['npc_lin','player'],at:{day:1,minute:1},importance:3},
  {event_ref:'cancel',kind:'heard' as const,summary:'后来取消了约定',participant_ids:['npc_lin','player'],at:{day:1,minute:2},importance:1},
  {event_ref:'ordinary',kind:'heard' as const,summary:'近期日常',participant_ids:['npc_lin','npc_qiao'],at:{day:1,minute:3},importance:1},
 ];
 save.npc_agent_state??={};save.npc_agent_state.npc_lin={...emptyNpcAgentState(),memories:[items[1],items[2],items[0]]};
 validateSave(save);const before=structuredClone(save),output=narratorCharacterCognition(save,['npc_lin'])[0];
 await mkdir('.agent-runtime/codex/memory-provenance',{recursive:true});
 await writeFile('.agent-runtime/codex/memory-provenance/import-order.json',JSON.stringify({before,output},null,2));
 expect(output.own_recent_experience.map(m=>m.summary)).toEqual(items.map(m=>m.summary));
 expect(save).toEqual(before);
},30000);

it.each(['chat','clarification'])('keeps an important player memory beside later %s without exceeding three',async later=>{
 const save=structuredClone((await prepareNarrativeWorld('relationships')).save);
 const memories=[
  {event_ref:'major',kind:'heard' as const,summary:'重要的本人往事',participant_ids:['npc_lin','npc_qiao'],at:{day:1,minute:0},importance:3},
  {event_ref:'promise',kind:'heard' as const,summary:'与玩家约好明天核对公告',participant_ids:['npc_lin','player'],at:{day:1,minute:1},importance:2},
  {event_ref:'latest',kind:'heard' as const,summary:later==='chat'?'刚才与玩家问了好':'后来告诉玩家今天不来了',participant_ids:['npc_lin','player'],at:{day:1,minute:2},importance:1},
  {event_ref:'ordinary',kind:'heard' as const,summary:'和乔宁说了日常琐事',participant_ids:['npc_lin','npc_qiao'],at:{day:1,minute:3},importance:1}
 ];
 save.npc_agent_state??={};save.npc_agent_state.npc_lin={...emptyNpcAgentState(),memories};
 validateSave(save);const before=structuredClone(save),output=narratorCharacterCognition(save,['npc_lin'])[0];
 await mkdir('.agent-runtime/codex/memory-provenance',{recursive:true});
 await writeFile(`.agent-runtime/codex/memory-provenance/priority-${later}.json`,JSON.stringify({before,output},null,2));
 expect(output.own_recent_experience.map(m=>m.event_ref)).toEqual(['major','promise','latest']);
 expect(output.own_recent_experience).toHaveLength(3);expect(save).toEqual(before);
},30000);

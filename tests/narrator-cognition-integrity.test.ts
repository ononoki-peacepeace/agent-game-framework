import {AIRuntime} from '../src/ai/runtime.js';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {validateSave} from '../src/core/state.js';
import {narratorCharacterCognition} from '../src/narrative/character-cognition.js';

// Valid authored counterexamples, not a claim about generated model prose.
const background='林舟回忆了那次讨论的经过：大家先在广场核对公告，随后谈到各自的安排、来回路程和可能遇到的延误。他逐一说明了纸上标注的日期、不同地点的开放时段，以及为什么现在还无法确认所有人的空闲时间。谈话中也提到了借阅记录、未核对的条目、是否需要重新查阅原件，以及谁来告知后来才抵达的人。他说这些事项还要分别确认，不能把一个人的猜测当作所有人的共识，也不能只凭之前的草稿安排下一次会面。大家继续对照各自的笔记，整理了尚待确认的问题，并把暂时没有答案的部分留在纸上。';
const statements={
 memory:background+'最后他明确撤回先前答应明天到场的说法；明天不会赴约。',
 knowledge:background+'但有关钥匙已经找到的消息只是乔宁的猜测，尚未得到证实。',
 belief:background+'只有收到正式确认才考虑赴约；目前并不认为约定已经成立。',
};
const cases=narrativeWorldKinds.flatMap(world=>(['memory','knowledge','belief'] as const).map(field=>({world,field})));
it.each(cases)('preserves complete bounded cognition statements: $world/$field',async({world,field})=>{
 const save=structuredClone((await prepareNarrativeWorld(world)).save),mind=emptyNpcAgentState();
 const statement=statements[field];expect(background.length).toBeGreaterThan(200);expect(statement.length).toBeLessThanOrEqual(500);
 mind.memories=[{event_ref:'promise_revision',kind:'heard',summary:statements.memory,participant_ids:['npc_lin','player'],at:{...save.runtime.time},importance:3}];
 mind.knowledge=[{id:'rumour',proposition:statements.knowledge,source_type:'told_by',source_ref:'npc_qiao',learned_at:{...save.runtime.time},confidence:0.2}];
 mind.beliefs=[{id:'conditional',proposition:statements.belief,stance:'doubted',confidence:0.3,evidence_refs:['promise_revision'],updated_at:{...save.runtime.time}}];
 save.npc_agent_state??={};save.npc_agent_state.npc_lin=mind;validateSave(save);
 const before=structuredClone(save),output=narratorCharacterCognition(save,['npc_lin'])[0];
 await mkdir('.agent-runtime/codex/cognition-integrity',{recursive:true});
 await writeFile(`.agent-runtime/codex/cognition-integrity/${world}-${field}.json`,JSON.stringify({before,output,field,expected:statement},null,2));
 const actual=field==='memory'?output.own_recent_experience[0].summary:field==='knowledge'?output.own_knowledge[0].proposition:output.own_beliefs[0].proposition;
 expect(actual).toBe(statement);
 expect(output.own_knowledge[0]).toMatchObject({source_type:'told_by',source_ref:'npc_qiao',confidence:0.2});
 expect(output.own_beliefs[0].stance).toBe('doubted');
 expect(output.own_recent_experience[0]).toMatchObject({event_ref:'promise_revision',historical:true});
 expect(save).toEqual(before);
},30000);

it.each(narrativeWorldKinds)('ordinary and repaired narration retain the complete memory: %s',async world=>{
 const save=structuredClone((await prepareNarrativeWorld(world)).save),mind=emptyNpcAgentState();
 mind.memories=[{event_ref:'promise_revision',kind:'heard',summary:statements.memory,participant_ids:['npc_lin','player'],at:{...save.runtime.time},importance:3}];
 save.npc_agent_state??={};save.npc_agent_state.npc_lin=mind;
 const repeated='广场上的风带着远处的声音，林舟在树旁继续等着。';
 save.narrative_history=[{request_id:randomUUID(),narrative:repeated,dialogue:null,speaker:null,facts:[],time:{...save.runtime.time}}];
 validateSave(save);const before=structuredClone(save),payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'offline-complete-cognition',generate:async request=>{
  payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  return {data:{narrative:payloads.length===1?repeated:'风从广场边拂过，树旁的林舟仍旧等在那里。',speaker:null,dialogue:null,choices:[],patches:[]}};
 }});
 await ai.narrate(save,{id:randomUUID(),source:'player',time_cost:0,type:'TALK',actor_id:save.player_state.entity_id,target_id:'npc_lin',parameters:{topic:'核对之前的约定'}},[]);
 await mkdir('.agent-runtime/codex/cognition-integrity',{recursive:true});
 await writeFile(`.agent-runtime/codex/cognition-integrity/prompts-${world}.json`,JSON.stringify({before,payloads,quality_ratings:null},null,2));
 expect(payloads).toHaveLength(2);
 for(const payload of payloads){const own=payload.character_context.character_cognition.find((entry:{id:string})=>entry.id==='npc_lin');
  expect(own.own_recent_experience[0].summary).toBe(statements.memory);
 }
 expect(save).toEqual(before);
},30000);

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
import {fresh} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {narrativeHealth} from '../src/ai/narrative-health.js';

const answer='那天我没有去车站，也没有看见公告上的变化。';
it.each(narrativeWorldKinds.flatMap(world=>[false,true].map(same=>({world,same}))))('attributes repeated speech before regenerating: $world/same=$same',async({world,same})=>{
 const save=structuredClone((await prepareNarrativeWorld(world)).save),speaker=same?'npc_lin':'npc_qiao';
 save.narrative_history=Array.from({length:2},()=>({request_id:randomUUID(),narrative:'',dialogue:answer,speaker,facts:[],time:{...save.runtime.time}}));
 const before=structuredClone(save),payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'offline-attributed-dialogue',generate:async request=>{
  payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  return {data:{narrative:'',speaker:'npc_lin',dialogue:payloads.length===1?answer:'我没有去过那里。',choices:[],patches:[]}};
 }});
 const result=await ai.narrate(save,{id:randomUUID(),type:'TALK',actor_id:save.player_state.entity_id,target_id:'npc_lin',parameters:{topic:'你那天去过车站吗？'},source:'player',time_cost:1},[]);
 await mkdir('.agent-runtime/codex/dialogue-attribution',{recursive:true});
 await writeFile(`.agent-runtime/codex/dialogue-attribution/${world}-${same}.json`,JSON.stringify({before,payloads,result,quality_ratings:null},null,2));
 expect(payloads).toHaveLength(same?2:1);
 expect(result.speaker).toBe('npc_lin');
 if(!same)expect(result.dialogue).toBe(answer);
 expect(save).toEqual(before);
},30000);

it.each([false,true])('does not assign a generic reply from another voice to this speaker (same=%s)',same=>{
 const save=fresh();save.narrative_history=[{request_id:randomUUID(),narrative:'',dialogue:'我不知道',speaker:same?'npc_lin':'npc_qiao',facts:[],time:{...save.runtime.time}}];
 const current={narrative:'',dialogue:'我不知道',speaker:'npc_lin'};
 expect(narrativeHealth(save,current,['你向林舟询问车站的开放时间。']).detected).toBe(same);
});
it('still detects repeated descriptive prose even when the dialogue speaker changes',()=>{
 const save=fresh(),narrative='树影沿着墙角慢慢移动，广场上的脚步声渐渐远去。';
 save.narrative_history=[{request_id:randomUUID(),narrative,dialogue:null,speaker:'npc_qiao',facts:[],time:{...save.runtime.time}}];
 expect(narrativeHealth(save,{narrative,dialogue:null,speaker:'npc_lin'},[]).detected).toBe(true);
});

it.each([null,'npc_lin'])('does not invent a known speaker for legacy speech (current=%s)',speaker=>{
 const save=fresh();save.narrative_history=Array.from({length:2},()=>({request_id:randomUUID(),narrative:'',dialogue:answer,speaker:null,facts:[],time:{...save.runtime.time}}));
 expect(narrativeHealth(save,{narrative:'',dialogue:answer,speaker},[]).detected).toBe(speaker===null);
});

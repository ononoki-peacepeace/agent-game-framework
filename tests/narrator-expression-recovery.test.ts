import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {AIRuntime} from '../src/ai/runtime.js';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
const original='林舟说：“先停一下。”你等了一分钟。',refined='你等了一分钟。林舟说：“先停一下。”';
const first={narrative:original,speaker:null,dialogue:null,choices:[],patches:[],scene_beats:[{kind:'speech',speaker_id:'npc_lin',utterance:'先停一下。'},{kind:'narration',text:'你等了一分钟。'}]};
const cases=narrativeWorldKinds.flatMap(kind=>(['valid','changed_speaker','missing_speech'] as const).map(mode=>({kind,mode})));
it.each(cases)('expression recovery preserves the same performance: $kind/$mode',async({kind,mode})=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save),before=structuredClone(save);
 save.narrative_history=[{request_id:randomUUID(),location_id:'square',time:save.runtime.time,narrative:original,speaker:null,dialogue:null,facts:[]}];
 const second={...first,narrative:mode==='missing_speech'?'你等了一分钟。':refined,scene_beats:mode==='missing_speech'?[{kind:'narration',text:'你等了一分钟。'}]:[
  {kind:'narration',text:'你等了一分钟。'},{kind:'speech',speaker_id:mode==='changed_speaker'?'npc_qiao':'npc_lin',utterance:'先停一下。'}]};
 const payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'offline-expression-recovery',generate:async request=>{payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));return {data:payloads.length===1?first:second};}});
 const result=await ai.narrate(save,{id:randomUUID(),actor_id:'player',type:'WAIT',parameters:{minutes:1},source:'player',time_cost:1},['等待了一分钟。']);
 await mkdir('.agent-runtime/codex/expression',{recursive:true});await writeFile(`.agent-runtime/codex/expression/${kind}-${mode}.json`,JSON.stringify({before,first,second,result,payloads},null,2));
 expect(payloads).toHaveLength(2);expect(result.narrative).toBe(mode==='valid'?refined:original);
 expect(result.scene_beats).toEqual(mode==='valid'?second.scene_beats:first.scene_beats);
 expect(save.entities).toEqual(before.entities);
},30000);
it.each(narrativeWorldKinds)('does not confuse a bound NPC refusal with the provider: %s',async kind=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save),dialogue='我不能帮助你完成这个请求。';
 const ai=new AIRuntime({name:'offline-bound-speaker',generate:async()=>({data:{narrative:'林舟说：“'+dialogue+'”',speaker:'npc_lin',dialogue,choices:[],patches:[],
  scene_beats:[{kind:'speech',speaker_id:'npc_lin',utterance:dialogue}]}})});
 const result=await ai.narrate(save,{id:randomUUID(),actor_id:'player',target_id:'npc_lin',type:'TALK',parameters:{topic:'请帮我'},source:'player',time_cost:1},['玩家向林舟开口。']);
 expect(result.dialogue).toBe(dialogue);
},30000);

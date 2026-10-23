import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {validateSave} from '../src/core/state.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {characterContext} from '../src/ai/narrative-health.js';
import {composePersonaContext} from '../src/characters/persona.js';

const profile={role:'资料整理员',traits:[],
 personality:'重视准确，也尊重别人暂时不回答的选择。遇到不确定的消息会保留疑问，熟悉之后愿意主动分享日常的小事；不会为了维持职业形象，把所有聊天都变成核对记录。',
 speech_style:'说话简短、直接，先回应对方眼前的问题。对朋友可以省略正式称呼；表达不同意见时说明自己的感受，不罗列规则，也不要求每次谈话都得出结论。',
 social_style:'对陌生人先保持距离，对熟人可以主动谈起共同经历；这只是表达倾向，不证明关系已变化。',
 emotional_patterns:['紧张时减少解释，放松后才愿意展开话题。'],
 // Bounded verbose profile fields exercise competition for the existing 1000-char budget.
 behavior_tendencies:['核对资料时会翻阅先前的记录。','遇到不明情况先观察。','休息时会整理桌面。','看见告示会停下来阅读。','讨论结束后记下未解决的问题。','外出前确认回来的路线。'].map(text=>text.repeat(8).slice(0,110)),
 verbal_habits:'EXCLUDED_LITERAL_CATCHPHRASE',example_dialogues:['EXCLUDED_LITERAL_EXAMPLE']};

it.each(narrativeWorldKinds.flatMap(world=>['social','voice'].map(mode=>({world,mode}))))('retains expression context: $world/$mode',async({world,mode})=>{
 const save=structuredClone((await prepareNarrativeWorld(world)).save),npc=save.entities.find(e=>e.id==='npc_lin')!;
 const selected=structuredClone(profile);
 if(mode==='voice')selected.speech_style+='遇到误解时愿意回到对方原来的话题，不把纠正讲成训诫。即使暂时不愿答应，也可以直接说明自己的安排；不把婉拒写成助手式的建议清单。';
 npc.components.character=selected;validateSave(save);
 const repeated='林舟站在广场边，听着你把刚才的事情说完。';
 save.narrative_history=[{request_id:randomUUID(),narrative:repeated,dialogue:null,speaker:null,facts:[],time:{...save.runtime.time}}];
 const before=structuredClone(save),payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'offline-persona-priority',generate:async request=>{
  payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  return {data:{narrative:payloads.length===1?repeated:'你说完后，广场边的林舟仍在听着。',speaker:null,dialogue:null,choices:[],patches:[]}};
 }});
 const output=await ai.narrate(save,{id:randomUUID(),source:'player',time_cost:0,type:'TALK',actor_id:save.player_state.entity_id,target_id:npc.id,parameters:{topic:'聊聊近况'}},[]);
 const context=characterContext(save,npc.id),legacy=composePersonaContext(save,npc.id,1000,false);
 await mkdir('.agent-runtime/codex/persona-priority',{recursive:true});
 await writeFile(`.agent-runtime/codex/persona-priority/${world}-${mode}.json`,JSON.stringify({before,payloads,context,legacy,output,quality_ratings:null},null,2));
 expect(payloads).toHaveLength(2);
 for(const payload of payloads){const own=payload.character_context.characters.find((p:{id:string})=>p.id===npc.id).allowed_persona;
  expect(own.speech_style).toBe(selected.speech_style);
  expect(own.core_personality).toBe(profile.personality);
  expect(own.social_style).toBe(profile.social_style);
  expect(own.emotional_patterns).toEqual(profile.emotional_patterns);
  expect(JSON.stringify(own)).not.toContain('EXCLUDED_LITERAL');
 }
 const projected=composePersonaContext(save,npc.id,1000,false,'narration')!;
 expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1000);
 // Opt-in expression order must not change the NPC owner's legacy selection.
 expect(legacy?.fields.behavior_tendencies).toEqual(selected.behavior_tendencies);
 expect(legacy?.fields).toEqual(composePersonaContext(save,npc.id,1000,false,'decision')?.fields);
 expect(save).toEqual(before);
},30000);

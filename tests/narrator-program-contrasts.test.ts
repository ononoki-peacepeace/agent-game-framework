import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';

const variants=['reserved','expansive','remembered','trusted'] as const;
it.each(narrativeWorldKinds.flatMap(kind=>variants.map(variant=>({kind,variant}))))('voice packet $kind / $variant',async({kind,variant})=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save),id=variant==='expansive'?'npc_qiao':'npc_lin';
 const person=save.entities.find(e=>e.id===id)!,player=save.player_state.entity_id;
 person.components.character={role:'邻居',traits:[],personality:variant==='expansive'?'外向，乐于分享':'谨慎独立',
  speech_style:variant==='expansive'?'日常口语，愿意多说一点':'简短直接，不作无谓解释'};
 person.components.location=structuredClone(save.entities.find(e=>e.id===player)!.components.location);
 person.components.relationships={entries:{[player]:{trust:variant==='trusted'?70:0}}};
 save.npc_agent_state??={};save.npc_agent_state[id]=emptyNpcAgentState();
 if(variant==='remembered')save.npc_agent_state[id].memories=[{event_ref:'authored_fixture_memory',kind:'heard',
  summary:'玩家上次说明只问车站公告，不要求同行。',participant_ids:[player,id],at:save.runtime.time,importance:2}];
 const before=structuredClone(save),prompts:unknown[]=[];
 const authored=variant==='expansive'?'你想问哪一部分？我刚好有空。':variant==='remembered'?'还是只问公告？':
  variant==='trusted'?'说吧，我听着。':'什么事？';
 const ai=new AIRuntime({name:'authored-contrast-control-not-real-voice',generate:async request=>{
  prompts.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  return {data:{narrative:'',speaker:id,dialogue:authored,choices:[],context_actions:[],patches:[],interaction:null,
   item_claims:[],stable_locations:[],mechanical_claims:[]}};
 }});
 const result=await ai.narrate(save,{id:randomUUID(),type:'TALK',actor_id:player,target_id:id,
  parameters:{topic:'我想问你一件事。'},source:'player',time_cost:1},['你向对方开了口。']);
 const context=(prompts[0] as any).character_context,cognition=context.character_cognition.find((e:any)=>e.id===id);
 expect(prompts).toHaveLength(1);expect(result.dialogue).toBe(authored);
 expect(cognition.own_relationships).toContainEqual({target_id:player,dimensions:{trust:variant==='trusted'?70:0}});
 expect(cognition.own_recent_experience).toHaveLength(variant==='remembered'?1:0);
 expect(context.characters.find((e:any)=>e.id===id).allowed_persona.speech_style).toContain(variant==='expansive'?'日常口语':'简短直接');
 expect(save).toEqual(before);
 if(process.env.NARRATOR_BENCHMARK_OUTPUT)await writeFile(join(process.env.NARRATOR_BENCHMARK_OUTPUT,`V-${kind}-${variant}.json`),
  JSON.stringify({case_id:`V-${kind}-${variant}`,provenance:'authored_control_not_model_voice',rendered:result,
   prompts,contrast_group:kind,same_question:'我想问你一件事。',controlled_speech:authored,
   real_provider_output:null,quality_ratings:null,independent_review:null},null,2));
},30000);

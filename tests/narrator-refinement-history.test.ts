import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
import {fresh} from './helpers.js';
import {narratorHistory} from '../src/narrative/history.js';

it('retains attributed bounded legacy dialogue without synthesizing a new speech event',()=>{
 const save=fresh();save.narrative_history=[{request_id:randomUUID(),location_id:'station',time:{day:1,minute:10},
  narrative:'旧场景的窗台。',speaker:'npc_lin',dialogue:'原话'.repeat(400),facts:[]}];
 const before=structuredClone(save),entry=narratorHistory(save,'square',false)[0];
 expect(entry).toMatchObject({speaker:'npc_lin',historical:true,speech_events:[],time:{day:1,minute:10}});
 expect(entry.dialogue).toHaveLength(600);expect(entry.narrative).toBeUndefined();expect(save).toEqual(before);
});

const first='你在窗台前停了一会儿。';
const cases=narrativeWorldKinds.flatMap(kind=>[false,true].flatMap(remote=>[false,true].map(refusal=>({kind,remote,refusal}))));
it.each(cases)('keeps attributed history across refinement: $kind remote=$remote refusal=$refusal',async({kind,remote,refusal})=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save);
 const here=String(save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location!.location_id);
 save.narrative_history=[{request_id:randomUUID(),location_id:remote?'station':here,time:{day:1,minute:10},
  narrative:first,speaker:'npc_qiao',dialogue:null,facts:[],
  speech_events:[{speaker_id:'npc_qiao',utterance:'明天我再来。',provenance:'npc_response',source_intent:null}]}];
 const before=structuredClone(save),payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'controlled-history-contract-not-model-quality',generate:async request=>{
  payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  if(payloads.length===2&&refusal)throw new ProviderError('refusal','offline','controlled refinement refusal');
  return {data:{narrative:payloads.length===1?first:'你等了一会儿。',speaker:null,dialogue:null,choices:[],context_actions:[],
   patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};
 }});
 const result=await ai.narrate(save,{id:randomUUID(),actor_id:save.player_state.entity_id,type:'WAIT',parameters:{minutes:1},source:'player',time_cost:1},['等待了一分钟。']);
 expect(payloads).toHaveLength(2);
 const main=payloads[0].character_context.recent_turns,refined=payloads[1].character_context.recent_turns;
 expect(refined).toEqual(main);
 expect(refined[0]).toMatchObject({location_id:remote?'station':here,time:{day:1,minute:10},historical:true,
  speaker:'npc_qiao',dialogue:null,
  speech_events:[{speaker_id:'npc_qiao',utterance:'明天我再来。'}]});
 if(remote)expect(refined[0].narrative).toBeUndefined();else expect(refined[0].narrative).toBe(first);
 expect(result.narrative).toBe(refusal?first:'你等了一会儿。');
 expect(save).toEqual(before);
},30000);

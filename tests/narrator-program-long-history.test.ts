import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {narratorCharacterCognition} from '../src/narrative/character-cognition.js';
import {narratorHistory} from '../src/narrative/history.js';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';

it.each(narrativeWorldKinds)('72h Narrator evidence / %s',async kind=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-narrator72-'));try{
  const prepared=await prepareNarrativeWorld(kind),seed=structuredClone(prepared.save),player=seed.player_state.entity_id;
  seed.npc_agent_state??={};seed.npc_agent_state.npc_lin??=emptyNpcAgentState();
  seed.npc_agent_state.npc_lin.memories.push({event_ref:'authored_promise_source',kind:'heard',
   summary:'乔宁说三天后再核对公告；只是原话，不是已经履约。',participant_ids:['npc_qiao','npc_lin'],at:seed.runtime.time,importance:3});
  seed.npc_agent_state.npc_lin.goals.push({id:'narrator_open_promise',description:'等待乔宁本人核对公告',horizon:'long',status:'active',origin:'self',priority:3});
  seed.entities.find(e=>e.id==='npc_lin')!.components.relationships={entries:{[player]:{trust:15}}};
  const source=structuredClone(seed.npc_agent_state.npc_lin.memories.at(-1)),originalGoals=structuredClone(seed.npc_agent_state.npc_lin.goals);
  // All three authored fixtures use the same explicit 1440-minute calendar day.
  const at=(s:typeof seed)=>s.runtime.time.day*1440+s.runtime.time.minute;
  const ai=new AIRuntime(new MockAIAdapter());let calls=0;
  ai.narrate=async()=>{calls++;throw new ProviderError('refusal','offline72','capture actual grounded fallback');};
  let store=new JsonStore(directory);await store.write(seed);let service=new GameService(store,ai,seed.definition);
  const start=at(seed),checkpoints:unknown[]=[];let replays=0;
  for(let day=1;day<=3;day++){
   // Real daily exchanges create ordinary new experiences, rather than merely
   // jumping a clock around an otherwise untouched one-memory fixture.
   for(let exchange=0;exchange<2;exchange++){
    const now=await service.current();await service.turn({request_id:randomUUID(),game_id:now.game_id,expected_revision:now.state_revision,
     action:{type:'TALK',target_id:'npc_lin',parameters:{topic:`第${day}天的日常核对，记录${exchange+1}。`}}});
   }
   const before=await service.current(),duration=start+day*1440-at(before);
   const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
    action:{type:'WAIT',parameters:{minutes:duration}}};
   const response=await service.turn(request),after=await service.current();
   expect(at(after)-start).toBe(day*1440);
   const cognition=narratorCharacterCognition(after,['npc_lin'])[0];
   expect(after.npc_agent_state!.npc_lin.memories).toContainEqual(source);
   expect(after.npc_agent_state!.npc_lin.goals).toEqual(originalGoals);
   expect(cognition.own_active_goals.some(g=>g.description==='等待乔宁本人核对公告')).toBe(true);
   expect(cognition.own_recent_experience.some(m=>m.summary===source!.summary)).toBe(true);
   expect(after.last_turn!.narrative).toBe(`你等了${duration}分钟。`);
   const bytes=await readFile(join(directory,'current.json')),count=calls;
   store=new JsonStore(directory);service=new GameService(store,ai,seed.definition);
   expect(await service.turn(request)).toEqual(response);expect(await service.current()).toEqual(after);
   expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(calls).toBe(count);replays++;
   const here=after.entities.find(e=>e.id===player)!.components.location!.location_id;
   checkpoints.push({hours:day*24,rendered:after.last_turn,own_cognition:cognition,history:narratorHistory(after,here,false),
    prior_statement:source,goal_still_open:true,player_position:here,
    receipts:after.resolution_receipts!.filter(r=>r.request_id===request.request_id)});
  }
  expect(replays).toBe(3);
  if(process.env.NARRATOR_BENCHMARK_OUTPUT)await writeFile(join(process.env.NARRATOR_BENCHMARK_OUTPUT,`L-${kind}.json`),JSON.stringify({
   case_id:`L-${kind}`,provenance:'actual_72h_offline_fallback_not_long_model_prose',hours:72,restarts:3,checkpoints,
   structure_witness:prepared.evidence,real_provider_output:null,quality_ratings:null,independent_review:null},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},180000);

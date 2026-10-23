import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {verbosePersona} from './fixtures/narrator-persona.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {characterContext} from '../src/ai/narrative-health.js';
afterEach(()=>vi.restoreAllMocks());
it.each(narrativeWorldKinds.flatMap(world=>[false,true].map(fallback=>({world,fallback}))))('retains separate personas through commit/restart/replay: $world/$fallback',async({world,fallback})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-persona-replay-'));
 try{
  const seed=structuredClone((await prepareNarrativeWorld(world)).save);
  seed.entities.find(e=>e.id==='npc_lin')!.components.character=structuredClone(verbosePersona);
  seed.entities.find(e=>e.id==='npc_qiao')!.components.character={...structuredClone(verbosePersona),personality:'外向但尊重别人不愿回答的选择。',speech_style:'愿意用日常口语展开话题，不替对方下结论。'};
  const store=new JsonStore(directory);await store.write(seed);const payloads:Record<string,any>[]=[];
  const ai=new AIRuntime({name:'offline-persona-replay',generate:async request=>{
   payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
   if(fallback)throw new ProviderError('refusal','offline','controlled failure, not real provider');
   return {data:{narrative:'你等了一分钟。',speaker:null,dialogue:null,choices:[],patches:[]}};
  }});
  vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'没有新行动',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保持安排',social_response:null} as never);
  const service=new GameService(store,ai,seed.definition),before=await service.current();
  const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'WAIT',parameters:{minutes:1}}};
  const response=await service.turn(request),after=(await store.read())!;
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts!.filter(r=>r.request_id===request.request_id)).toHaveLength(1);
  expect(after.resolution_receipts!.find(r=>r.request_id===request.request_id)?.commit_status).toBe('committed');
  expect(payloads.length).toBeGreaterThan(0);
  for(const id of ['npc_lin','npc_qiao']){
   const original=before.entities.find(e=>e.id===id)!.components;
   expect(after.entities.find(e=>e.id===id)!.components.character).toEqual(original.character);
   expect(after.entities.find(e=>e.id===id)!.components.relationships).toEqual(original.relationships);
   for(const payload of payloads){const own=payload.character_context.characters.find((p:{id:string})=>p.id===id).allowed_persona;
    expect(own.speech_style).toBe(original.character.speech_style);expect(own.core_personality).toBe(original.character.personality);
   }
  }
  const bytes=await readFile(join(directory,'current.json')),calls=payloads.length;
  const fresh=new GameService(new JsonStore(directory),ai,seed.definition);
  expect(await fresh.turn(request)).toEqual(response);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(payloads).toHaveLength(calls);
  expect(characterContext(await fresh.current()).characters).toEqual(characterContext(after).characters);
  await mkdir('.agent-runtime/codex/persona-restart',{recursive:true});
  await writeFile(`.agent-runtime/codex/persona-restart/${world}-${fallback}.json`,JSON.stringify({request,before,after,payloads,response,save_bytes:bytes.toString(),quality_ratings:null},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},30000);

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {narratorCharacterCognition} from '../src/narrative/character-cognition.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
afterEach(()=>vi.restoreAllMocks());
it.each(narrativeWorldKinds.flatMap(kind=>[false,true].map(fallback=>({kind,fallback}))))('keeps memory provenance through real commit/restart/replay: $kind/$fallback',async({kind,fallback})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-memory-source-'));
 try{
  const seed=structuredClone((await prepareNarrativeWorld(kind)).save);
  const memories=Array.from({length:5},(_,i)=>({event_ref:'history_'+i,kind:'heard' as const,summary:'本人旧事'+i,
   participant_ids:i===1?['npc_lin','player']:['npc_lin','npc_qiao'],at:{day:1,minute:i},importance:i===0?3:1}));
  memories[1].summary='对玩家说下次再核对公告；尚未履约。';
  seed.npc_agent_state??={};seed.npc_agent_state.npc_lin={...emptyNpcAgentState(),memories};
  const store=new JsonStore(directory);await store.write(seed);const payloads:Record<string,any>[]=[];
  const ai=new AIRuntime({name:'offline-memory-provenance',generate:async request=>{
   payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
   if(fallback)throw new ProviderError('refusal','offline','controlled');
   return {data:{narrative:'你等了一分钟。',speaker:null,dialogue:null,choices:[],patches:[]}};
  }});
  vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'没有新行动',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保持安排',social_response:null} as never);
  const service=new GameService(store,ai,seed.definition),before=await service.current();
  const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'WAIT',parameters:{minutes:1}}};
  const response=await service.turn(request),after=(await store.read())!;
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  const receipt=after.resolution_receipts!.find(r=>r.request_id===request.request_id)!;expect(receipt.commit_status).toBe('committed');
  const original=before.npc_agent_state!.npc_lin.memories;
  for(const m of original)expect(after.npc_agent_state!.npc_lin.memories).toContainEqual(m);
  for(const payload of payloads){const cognition=payload.character_context.character_cognition.find((p:{id:string})=>p.id==='npc_lin');
   expect(cognition.own_recent_experience).toContainEqual({kind:memories[1].kind,event_ref:memories[1].event_ref,summary:memories[1].summary,participant_ids:memories[1].participant_ids,at:memories[1].at,historical:true});
  }
  const bytes=await readFile(join(directory,'current.json')),calls=payloads.length;
  const fresh=new GameService(new JsonStore(directory),ai,seed.definition);
  expect(await fresh.turn(request)).toEqual(response);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(payloads).toHaveLength(calls);
  expect(narratorCharacterCognition(await fresh.current(),['npc_lin'])).toEqual(narratorCharacterCognition(after,['npc_lin']));
  await mkdir('.agent-runtime/codex/memory-provenance',{recursive:true});
  await writeFile(`.agent-runtime/codex/memory-provenance/restart-${kind}-${fallback}.json`,JSON.stringify({request,before,after,payloads,response,save_bytes:bytes.toString(),quality_ratings:null},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},30000);

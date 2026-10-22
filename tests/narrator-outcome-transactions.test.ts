import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import * as freeform from '../src/core/freeform.js';
afterEach(()=>vi.restoreAllMocks());
const input='尝试打击林舟';
const cases=narrativeWorldKinds.flatMap(kind=>(['refusal','repair','exhausted'] as const).map(mode=>({kind,mode})));
it.each(cases)('keeps settlement through concrete narration and recovery: $kind/$mode',async({kind,mode})=>{
 const dir=await mkdtemp(join(tmpdir(),'agf-outcome-'));
 try{
  const seed=structuredClone((await prepareNarrativeWorld(kind)).save),store=new JsonStore(dir);
  await store.write(seed);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,seed.definition),before=await service.current();
  vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
   physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
   resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'身体尝试',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}} as never);
  vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'无新行动',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保持安排',social_response:null} as never);
  const original=freeform.executeFreeform;const core=vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{let n=0;args[4]=()=>n++%2?.99:.01;return original(...args);});
  const calls:string[]=[];
  vi.spyOn(ai,'narrate').mockImplementation(async()=>{
   if(mode==='refusal'){calls.push('provider refusal');throw new ProviderError('refusal','offline','controlled');}
   const narrative=mode==='repair'&&calls.length?'你向林舟出手，但没能碰到对方。':'林舟骨折倒地。';calls.push(narrative);
   return {narrative,speaker:null,dialogue:null,choices:[],patches:[],context_actions:[],item_claims:[],stable_locations:[],mechanical_claims:[],interaction:null} as never;
  });
  const request={input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
  const response=await service.turn(request,undefined,undefined,undefined,false,undefined,undefined,true);
  const after=(await store.read())!,receipt=after.resolution_receipts!.find(r=>r.request_id===request.request_id)!;
  await mkdir('.agent-runtime/codex/outcomes',{recursive:true});
  await writeFile(`.agent-runtime/codex/outcomes/transaction-${kind}-${mode}.json`,JSON.stringify({request,before,after,response,calls},null,2));
  expect(receipt.physical_outcome).toMatchObject({contact:false,harmed:false,damage:0});
  expect(after.entities.find(e=>e.id==='npc_lin')!.components.condition).toEqual(before.entities.find(e=>e.id==='npc_lin')!.components.condition);
  expect(after.state_revision).toBe(before.state_revision+1);expect(core).toHaveBeenCalledOnce();
  expect(after.last_turn!.narrative).toBe('你向林舟出手，但没能碰到对方。');
  expect(calls).toHaveLength(mode==='repair'?2:mode==='exhausted'?3:1);
  expect(after.last_turn!.presentation?.status??'normal').toBe(mode==='repair'?'normal':'degraded');
  const bytes=await readFile(join(dir,'current.json')),count=calls.length;
  const fresh=new GameService(new JsonStore(dir),ai,seed.definition);
  const replay=await fresh.turn(request,undefined,undefined,undefined,false,undefined,undefined,true);
  await writeFile(`.agent-runtime/codex/outcomes/replay-${kind}-${mode}.json`,JSON.stringify({response,replay},null,2));
  expect(replay).toEqual(response);
  expect(await readFile(join(dir,'current.json'))).toEqual(bytes);expect(calls).toHaveLength(count);expect(core).toHaveBeenCalledOnce();
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);

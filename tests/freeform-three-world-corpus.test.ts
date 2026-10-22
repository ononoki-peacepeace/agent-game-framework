import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {narrativeWorldKinds,prepareNarrativeWorld,type NarrativeWorldKind} from './fixtures/narrative-worlds.js';
import {freeformCorpus,corpusProposal,type FreeformCorpusSample} from './fixtures/freeform-fixed-corpus.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {WorldBlockedError} from '../src/agent/outcome.js';
import type {Inventory} from '../src/modules/inventory.js';
import type {NpcDecision} from '../src/agent/npc-agent.js';

const dice=vi.hoisted(()=>({values:null as number[]|null,calls:0}));
vi.mock('../src/core/dice.js',async original=>({...await original<typeof import('../src/core/dice.js')>(),secureRng:()=>{
 if(dice.values===null)return .5;dice.calls++;const value=dice.values.shift();if(value===undefined)throw Error('Unexpected additional Core RNG');return value;
}}));
afterEach(()=>{dice.values=null;dice.calls=0;vi.restoreAllMocks();});
const worlds=new Map<NarrativeWorldKind,ReturnType<typeof prepareNarrativeWorld>>();
async function world(kind:NarrativeWorldKind){
 let pending=worlds.get(kind);if(!pending){pending=prepareNarrativeWorld(kind);worlds.set(kind,pending);}const save=structuredClone((await pending).save);
 for(const id of ['player','npc_lin'])save.entities.find(e=>e.id===id)!.components.condition={hp:100,stamina:50,stress:0};
 return save;
}
const noAction:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'固定离线选择暂不行动',proposed_action:null,evidence_refs:[],
 belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'固定离线选择，无反应事实',social_response:null};
function runtime(sample:FreeformCorpusSample,fallback:boolean){
 const ai=new AIRuntime({name:'offline-corpus',generate:async()=>{throw Error('Unexpected live generation');}});
 const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(corpusProposal(sample));
 const decision=vi.spyOn(ai,'npcDecision').mockResolvedValue(noAction);
 const narrate=vi.spyOn(ai,'narrate').mockImplementation(async()=>{
  if(fallback)throw new ProviderError('timeout','offline-corpus-timeout','固定离线技术故障');
  return {narrative:sample.text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]};
 });return {ai,freeform,decision,narrate};
}
const normal=narrativeWorldKinds.flatMap(kind=>freeformCorpus.flatMap(sample=>[false,true].map(fallback=>({kind,sample,fallback}))));
it.each(normal)('same Freeform corpus $sample.id in $kind / fallback=$fallback',async({kind,sample,fallback})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-freeform-three-'));try{
  const save=await world(kind),store=new JsonStore(directory);await store.write(save);const f=runtime(sample,fallback),service=new GameService(store,f.ai,save.definition);
  const before=await service.current(),request={input:sample.input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  dice.values=[...sample.rolls];const response=await service.turn(request,undefined,undefined,undefined,false,undefined,undefined,true),after=await service.current();
  const receipt=after.resolution_receipts!.find(r=>r.request_id===request.request_id)!,minutes=sample.kind==='activity'?2:1;
  expect(receipt).toMatchObject({outcome:sample.outcome,commit_status:'committed',time_cost:minutes});
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(minutes);
  expect(after.resolution_receipts!.filter(r=>r.request_id===request.request_id)).toHaveLength(1);
  expect(dice.calls).toBe(sample.rolls.length);expect(dice.values).toEqual([]);
  const player=after.entities.find(e=>e.id==='player')!,npc=after.entities.find(e=>e.id==='npc_lin')!;
  expect(player.components.condition!.stamina).toBe(sample.kind==='physical'?49:50);
  expect(npc.components.condition!.stamina).toBe(sample.kind==='physical'?49:50);
  expect(npc.components.condition!.hp).toBe(sample.kind==='physical'&&sample.harmed?100-(save.definition.ruleset.physical_rules?.minor_damage??5):100);
  if(sample.kind==='physical'){
   expect(receipt.physical_outcome).toMatchObject({contact:sample.contact,harmed:sample.harmed});
   if(!sample.contact)expect(after.last_turn!.narrative).toMatch(/未能建立接触|没能建立接触|没能碰到对方/);
   if(sample.contact&&!sample.harmed)expect(after.last_turn!.narrative).toMatch(/没有.{0,15}伤害/);
  }
  const held=(player.components.inventory as Inventory).items.qa_paper??0;
  expect(held).toBe(sample.kind==='pickup'&&sample.held?1:0);
  if(sample.kind==='pickup')expect(receipt.effects.includes('inventory')).toBe(sample.held);
  if(sample.kind==='activity')expect(receipt.activity).toMatchObject({occurred:true,duration_minutes:2});
  expect(after.last_turn!.presentation?.status).toBe(fallback?'degraded':'normal');
  if(!fallback)expect(after.last_turn!.narrative).toBe(sample.text);
  const bytes=await readFile(join(directory,'current.json')),calls={freeform:f.freeform.mock.calls.length,decision:f.decision.mock.calls.length,narrate:f.narrate.mock.calls.length,rng:dice.calls};
  const fresh=new GameService(new JsonStore(directory),f.ai,save.definition);expect(await fresh.turn(request)).toEqual(response);
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect({freeform:f.freeform.mock.calls.length,decision:f.decision.mock.calls.length,narrate:f.narrate.mock.calls.length,rng:dice.calls}).toEqual(calls);
  expect(f.ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
const boundaries=['ambiguous-person','missing-item','closed-route','before-write','after-write'] as const;
it.each(narrativeWorldKinds.flatMap(kind=>boundaries.map(boundary=>({kind,boundary}))))(
 'preserves Freeform authority in $kind / $boundary',async({kind,boundary})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-freeform-boundary-'));try{
  const save=await world(kind),sample=freeformCorpus.find(s=>s.id==='contact-miss')!;
  let proposal:Awaited<ReturnType<AIRuntime['freeform']>>=corpusProposal(sample),input=sample.input as string;
  if(boundary==='ambiguous-person'){
   const clone=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);clone.id='qa_duplicate_lin';save.entities.push(clone);
   input='向林舟挥手';proposal={...corpusProposal(freeformCorpus[5]),target_id:'npc_lin'};
  }
  if(boundary==='missing-item'){
   input='用铜哨向林舟示意';proposal={...corpusProposal(freeformCorpus[5]),target_id:'npc_lin',required_conditions:[{kind:'item_held',subject_id:'qa_missing_whistle'}]};
  }
  if(boundary==='closed-route'){
   save.definition.map!.locations.find(p=>p.id==='station')!.lifecycle={origin:'existing_detail',status:'closed',visibility:'public',
    creation_reason:'固定三世界路线拒绝',source_ref:'a8_corpus',recorded_at:structuredClone(save.runtime.time)};
   input='尝试探查可达路线';proposal={...corpusProposal(freeformCorpus[5]),required_conditions:[{kind:'destination_reachable',subject_id:'station'}]};
  }
  const store=new JsonStore(directory);await store.write(save);const f=runtime(sample,true);f.freeform.mockResolvedValue(proposal);
  const service=new GameService(store,f.ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const request={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},technical=boundary==='before-write'||boundary==='after-write';
  const write=store.write.bind(store);if(technical)vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   if(next.runtime.receipts.some(r=>r.id===request.request_id)){
    if(boundary==='after-write')await write(next,slot);throw Error('offline corpus commit response failure');
   }return write(next,slot);
  });
  dice.values=technical?[...sample.rolls]:[];
  const operation=service.turn(request,undefined,undefined,undefined,false,undefined,undefined,true);
  if(technical)await expect(operation).rejects.toThrow('offline corpus commit response failure');else await expect(operation).rejects.toBeInstanceOf(WorldBlockedError);
  const after=await service.current(),committed=boundary==='after-write',fresh=new GameService(new JsonStore(directory),f.ai,save.definition);
  expect(after.state_revision-before.state_revision).toBe(Number(committed));expect(after.runtime.time.minute-before.runtime.time.minute).toBe(Number(committed));
  expect(after.entities.find(e=>e.id==='npc_lin')!.components.condition!.hp).toBe(100);
  if(committed)expect(after.resolution_receipts!.find(r=>r.request_id===request.request_id)).toMatchObject({outcome:'critical_failure',physical_outcome:{contact:false,harmed:false},commit_status:'committed'});
  else expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(dice.calls).toBe(technical?sample.rolls.length:0);if(!technical)expect(f.narrate).not.toHaveBeenCalled();
  const finalBytes=await readFile(join(directory,'current.json')),calls=[f.freeform.mock.calls.length,f.decision.mock.calls.length,f.narrate.mock.calls.length,dice.calls];
  if(committed)await fresh.turn(request);
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(finalBytes);
  expect([f.freeform.mock.calls.length,f.decision.mock.calls.length,f.narrate.mock.calls.length,dice.calls]).toEqual(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

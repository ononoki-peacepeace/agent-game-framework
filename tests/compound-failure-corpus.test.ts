import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {agentPresentation} from '../src/client/agent-presentation.js';
import * as freeform from '../src/core/freeform.js';
import {freeformCorpus,corpusProposal} from './fixtures/freeform-fixed-corpus.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {executeAction} from '../src/core/runtime.js';
import {WorldBlockedError} from '../src/agent/outcome.js';

afterEach(()=>vi.restoreAllMocks());
const physical='尝试打击林舟',speech='向林舟问好',tail='整理尚未开始的后续记录五分钟';
async function setup(sampleId:'contact-injury'|'contact-miss'|'contact-only'){
 const mock=new MockAIAdapter(),f=await sparseSetup(r=>mock.generate(r)),seed=await f.service.current();
 seed.definition.events=[];seed.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 for(const entity of seed.entities)if(entity.components.character)entity.components.location={location_id:entity.id==='player'||entity.id==='npc_lin'?'square':'station'};
 for(const id of ['player','npc_lin'])seed.entities.find(e=>e.id===id)!.components.condition={hp:100,stamina:50,stress:0};
 const sample=freeformCorpus.find(s=>s.id===sampleId)!;
 const interpret=vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,text)=>text===speech?
  {type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}}:text===tail?{type:'HOLD',parameters:{minutes:5,activity:tail}}:
  {type:'FREEFORM_ACTION',parameters:{}});
 const proposal=vi.spyOn(f.ai,'freeform').mockResolvedValue(corpusProposal(sample));
 vi.spyOn(f.ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'固定选择暂不行动',proposed_action:null,
  evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'没有反应事实',social_response:null});
 const original=freeform.executeFreeform;
 const core=vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{
  const rolls=[...sample.rolls];args[4]=()=>{const value=rolls.shift();if(value===undefined)throw Error('Unexpected additional physical RNG');return value;};
  return original(...args);
 });
 return {...f,seed,sample,interpret,proposal,core};
}
const atomic=([false,true] as const).flatMap(physicalLast=>(['contact-miss','contact-only'] as const).flatMap(sampleId=>
 (['refusal','fact_conflict'] as const).map(reason=>({physicalLast,sampleId,reason}))));
it.each(atomic)('retains truthful attempted physical/speech outcome physicalLast=$physicalLast/$sampleId/$reason',async({physicalLast,sampleId,reason})=>{
 const f=await setup(sampleId),directory=await mkdtemp(join(tmpdir(),'agf-compound-failed-'));
 try{
  const store=new JsonStore(directory);await store.write(f.seed);const service=new GameService(store,f.ai,f.seed.definition),before=await service.current();
  const narrate=vi.spyOn(f.ai,'narrate');
  if(reason==='refusal')narrate.mockRejectedValue(new ProviderError('refusal','offline','固定拒绝'));
  else narrate.mockResolvedValue({narrative:'错误的候选结果。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,
   item_claims:[],stable_locations:[],mechanical_claims:[{kind:'progress',fact_index:99}]});
  const steps=physicalLast?[speech,physical]:[physical,speech],request={input:steps.join('，再'),game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const response=await executePlan(service,request,validatePlan({goals:[goal('first',steps[0]),goal('second',steps[1],['first'])]})),after=await service.current(),prose=response.story!;
  const receipts=after.resolution_receipts!.filter(r=>r.actor_id==='player'),body=receipts.find(r=>r.physical_outcome)!;
  expect(body).toMatchObject({outcome:f.sample.outcome,physical_outcome:{contact:sampleId==='contact-only',harmed:false}});
  expect(receipts.filter(r=>r.semantic_action==='TALK')).toHaveLength(1);expect(after.state_revision-before.state_revision).toBe(2);
  expect(response.results?.map(r=>r.status)).toEqual(['completed','completed']);
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(before.definition.ruleset.talk_minutes+1);
  for(const id of ['player','npc_lin'])expect(after.entities.find(e=>e.id===id)!.components.condition!.stamina).toBe(49);
  expect(after.entities.find(e=>e.id==='npc_lin')!.components.condition!.hp).toBe(100);
  expect(prose).toMatch(/你向林舟开了口/);expect(prose).toMatch(sampleId==='contact-miss'?/(?:没能|未能).{0,12}(?:接触|碰到)/:/没有.{0,15}伤害/);
  const physicalPosition=prose.search(sampleId==='contact-miss'?/没能|未能/:/触及|碰到了/);expect(physicalPosition>=0).toBe(true);
  expect(prose.indexOf('你向林舟开了口')<physicalPosition).toBe(physicalLast);
  expect(after.last_turn!.dialogue??null).toBeNull();expect(after.last_turn!.scene_beats?.filter(b=>b.kind==='speech')??[]).toHaveLength(0);
  expect(prose).not.toMatch(/林舟受伤了|造成了伤害|整理尚未开始/);expect(after.last_turn!.presentation?.status).toBe('degraded');
  const bytes=await readFile(join(directory,'current.json')),calls=[f.core.mock.calls.length,narrate.mock.calls.length,f.ai.metrics.requests];
  const fresh=new GameService(new JsonStore(directory),f.ai,f.seed.definition);
  for(const receipt of receipts)await fresh.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:receipt.request_id,input:receipt.semantic_action==='TALK'?speech:physical});
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect([f.core.mock.calls.length,narrate.mock.calls.length,f.ai.metrics.requests]).toEqual(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

it.each((['TALK','SOCIAL_INTERACT'] as const).flatMap(type=>[false,true].map(present=>({type,present}))))(
 'classifies registered $type presence=$present from the unchanged Core rule',async({type,present})=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:present?'square':'station'};
 before.entities.find(e=>e.id==='player')!.components.location={location_id:'square'};
 const original=structuredClone(before),action={type,target_id:'npc_lin',parameters:type==='TALK'?{topic:'问好'}:{intent:'问好'}};
 if(present){
  const result=executeAction(before,action,randomUUID());expect(result.action.time_cost).toBe(before.definition.ruleset.talk_minutes);
  expect(result.save.resolution_receipts?.at(-1)?.semantic_action).toBe(type);
 }else{
  try{executeAction(before,action,randomUUID());throw Error('Expected authoritative world refusal');}
  catch(error){expect(error).toBeInstanceOf(WorldBlockedError);expect(error).toMatchObject({worldCode:'not_present'});}
 }
 expect(before).toEqual(original);
});

const goal=(id:string,text:string,depends_on:string[]=[]):GoalInput=>({goal_id:id,type:'WORLD_ACTION',normalized_goal:text,depends_on,
 target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}});
it.each([false,true].flatMap(physicalLast=>(['world','provider','before','after'] as const).map(stop=>({physicalLast,stop}))))(
 'keeps settled stages and explicit unexecuted tail physicalLast=$physicalLast/$stop',async({physicalLast,stop})=>{
 const f=await setup('contact-injury'),directory=await mkdtemp(join(tmpdir(),'agf-sequential-failed-'));
 try{
  const store=new JsonStore(directory);await store.write(f.seed);const service=new GameService(store,f.ai,f.seed.definition),before=await service.current();
  const requestedSpeech=stop==='world'&&!physicalLast?'向乔宁问好':speech;
  const steps=physicalLast?[requestedSpeech,physical]:[physical,requestedSpeech],second=steps[1];
  f.interpret.mockImplementation(async(_save,text)=>{
   if(text===second&&stop==='provider')throw new ProviderError('timeout','offline','固定第二步解释故障');
   if(text===requestedSpeech)return {type:'TALK',target_id:requestedSpeech===speech?'npc_lin':'npc_qiao',parameters:{topic:'问好'}};
   if(text===tail)throw Error('Unexecuted tail must not be interpreted');return {type:'FREEFORM_ACTION',parameters:{}};
  });
  if(stop==='world'&&physicalLast)f.proposal.mockResolvedValue({...corpusProposal(f.sample),required_conditions:[{kind:'item_held',subject_id:'missing_tool'}]});
  const narrate=vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline','固定权威降级'));
  const write=store.write.bind(store);let injected=false;
  vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   const hit=!injected&&['before','after'].includes(stop)&&(next.resolution_receipts?.filter(r=>r.actor_id==='player').length??0)>=2;
   if(hit){injected=true;if(stop==='before')throw Error('second stage before write');}
   await write(next,slot);if(hit)throw Error('second stage after write acknowledgement lost');
  });
  const request={input:[...steps,tail].join('，再'),game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const response=await executePlan(service,request,validatePlan({goals:[goal('first',steps[0]),goal('second',second,['first']),goal('tail',tail,['second'])]}));
  const after=await service.current(),receipts=after.resolution_receipts!.filter(r=>r.actor_id==='player'),committedSecond=stop==='after';
  expect(injected).toBe(['before','after'].includes(stop));expect(receipts).toHaveLength(committedSecond?2:1);
  expect(receipts.map(r=>r.semantic_action)).toEqual((committedSecond?steps:[steps[0]]).map(text=>text===requestedSpeech?'TALK':physical));
  expect(response.results?.map(r=>r.status),JSON.stringify({outcome:response.outcome,results:response.results})).toEqual(['completed',stop==='world'?'blocked':'failed','skipped']);
  expect(response.outcome.type).toBe(stop==='world'?'game':'engine_failure');
  expect(response.story).toContain(physicalLast?'你向林舟开了口':'造成了伤害');
  if(committedSecond)expect(response.story).toContain(physicalLast?'造成了伤害':'你向林舟开了口');
  expect(response.story).not.toContain(tail);expect(response.message).toMatch(/未完成|未执行|尚未|前面已经结算/);
  expect(agentPresentation(service.project(before),response).agentReply?.message).toBe(response.message);
  expect(after.entities.find(e=>e.id==='npc_lin')!.components.condition!.hp).toBe(!physicalLast||committedSecond?95:100);
  expect(after.state_revision-before.state_revision).toBe(receipts.length);
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(receipts.reduce((minutes,r)=>minutes+r.time_cost,0));
  for(const id of ['player','npc_lin'])expect(after.entities.find(e=>e.id===id)!.components.condition!.stamina).toBe(!physicalLast||committedSecond?49:50);
  const bytes=await readFile(join(directory,'current.json')),counts=[f.core.mock.calls.length,narrate.mock.calls.length,f.ai.metrics.requests];
  const fresh=new GameService(new JsonStore(directory),f.ai,f.seed.definition);
  for(const receipt of receipts)await fresh.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:receipt.request_id,input:receipt.semantic_action==='TALK'?speech:physical});
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect([f.core.mock.calls.length,narrate.mock.calls.length,f.ai.metrics.requests]).toEqual(counts);
 }finally{await rm(directory,{recursive:true,force:true});}
});

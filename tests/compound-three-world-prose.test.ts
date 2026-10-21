import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {narrativeWorldKinds,prepareNarrativeWorld,type NarrativeWorldKind} from './fixtures/narrative-worlds.js';
import {freeformCorpus,corpusProposal} from './fixtures/freeform-fixed-corpus.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {agentPresentation} from '../src/client/agent-presentation.js';
import {SceneStory} from '../src/client/SceneStory.js';
import * as freeform from '../src/core/freeform.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import type {NpcDecision} from '../src/agent/npc-agent.js';

afterEach(()=>vi.restoreAllMocks());
const bases=new Map<NarrativeWorldKind,ReturnType<typeof prepareNarrativeWorld>>();
const captureRun=randomUUID();
const sample=freeformCorpus.find(s=>s.id==='contact-miss')!;
const actions=['等一分钟','向林舟问好',sample.input,'整理已有记录两分钟','向林舟问好'];
const goal=(text:string,index:number):GoalInput=>({goal_id:'step'+index,type:'WORLD_ACTION',normalized_goal:text,depends_on:index?['step'+(index-1)]:[],
 target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}});
const noAction:NpcDecision={kind:'no_action',speech:null,vote_target:null,intent:'固定选择暂不行动',proposed_action:null,evidence_refs:[],
 belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'没有反应事实',social_response:null};
const matrix=narrativeWorldKinds.flatMap(kind=>[false,true].flatMap(fallback=>
 (['normal','missing','world','partial','after'] as const).map(boundary=>({kind,fallback,boundary}))));
it.each(matrix)('keeps all actual long stages in $kind/fallback=$fallback/$boundary',async({kind,fallback,boundary})=>{
 let base=bases.get(kind);if(!base){base=prepareNarrativeWorld(kind);bases.set(kind,base);}const prepared=await base,seed=structuredClone(prepared.save);
 for(const id of ['player','npc_lin'])seed.entities.find(e=>e.id===id)!.components.condition={hp:100,stamina:50,stress:0};
 if(boundary==='world')seed.definition.map!.locations.find(p=>p.id==='station')!.lifecycle={origin:'existing_detail',status:'closed',visibility:'public',creation_reason:'既有封闭路线',source_ref:'n3_corpus',recorded_at:{...seed.runtime.time}};
 if(boundary==='partial'){
  seed.entities.find(e=>e.id==='player')!.components.opportunities={entries:{long_meeting:{status:'accepted',title:'已接受的会面'}}};
  seed.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'long_meeting',label:'已接受的会面',
   at:seed.runtime.time.day*seed.definition.ruleset.minutes_per_day+seed.runtime.time.minute+1+seed.definition.ruleset.talk_minutes+1+1,
   window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 const directory=await mkdtemp(join(tmpdir(),'agf-long-prose-'));try{
  const store=new JsonStore(directory);await store.write(seed);
  const ai=new AIRuntime({name:'offline-long-corpus',generate:async()=>{throw Error('Unexpected live generation');}});
  const interpret=vi.spyOn(ai,'interpret').mockImplementation(async(_save,text)=>text===actions[0]?{type:'WAIT',parameters:{minutes:1}}:
   text===actions[1]?{type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}}:text===actions[3]?{type:'HOLD',parameters:{minutes:2,activity:'整理已有记录'}}:
   {type:'FREEFORM_ACTION',parameters:{}});
  vi.spyOn(ai,'npcDecision').mockResolvedValue(noAction);
  vi.spyOn(ai,'freeform').mockResolvedValue({...corpusProposal(sample),...(['missing','world'].includes(boundary)?{required_conditions:[
   boundary==='missing'?{kind:'item_held' as const,subject_id:'missing_tool'}:{kind:'destination_reachable' as const,subject_id:'station'}]}:{})});
  let rngCalls=0;const original=freeform.executeFreeform,core=vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{
   const rolls=[...sample.rolls];args[4]=()=>{rngCalls++;const value=rolls.shift();if(value===undefined)throw Error('Unexpected extra physical RNG');return value;};return original(...args);
  });
  const narrate=vi.spyOn(ai,'narrate').mockImplementation(async(_save,action,_facts,receipt)=>{
   if(fallback)throw new ProviderError('refusal','offline-long-corpus','固定拒绝');
   const narrative=action.type==='TALK'?'你向林舟问了好。':receipt?.physical_outcome?sample.text:
    action.type==='WAIT'?'你在原地等了一分钟。':`你整理了${receipt!.time_cost===1?'一':'两'}分钟已有记录。`;
   return {narrative,scene_beats:[{kind:'narration',text:narrative}],speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
  });
  const service=new GameService(store,ai,seed.definition),before=await service.current(),old=new Set(before.resolution_receipts?.map(r=>r.request_id));
  let injected=false;const write=store.write.bind(store);vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   await write(next,slot);if(boundary==='after'&&!injected&&(next.resolution_receipts?.filter(r=>r.actor_id==='player'&&!old.has(r.request_id)).length??0)===3){injected=true;throw Error('third settlement acknowledgement lost');}
  });
  const request={input:actions.join('，再'),game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const response=await executePlan(service,request,validatePlan({goals:actions.map(goal)})),after=await service.current(),receipts=after.resolution_receipts!.filter(r=>r.actor_id==='player'&&!old.has(r.request_id));
  const shown=agentPresentation(service.project(before),response),html=renderToStaticMarkup(createElement(SceneStory,{view:response.view!,override:shown.storyOverride?.text??null,onSelectEntity:()=>{}}));
  await writeFile(join(process.cwd(),'.agent-runtime/codex',`long-prose-${captureRun}-${kind}-${fallback?'fallback':'normal'}-${boundary}.json`),JSON.stringify({kind,fallback,boundary,
   request,source_structure:{modules:seed.definition.enabled_modules,receipts:prepared.evidence.map(r=>r.semantic_action)},response,receipts,html},null,2)+'\n');
  const count=['missing','world'].includes(boundary)?2:boundary==='after'?3:boundary==='partial'?4:5;
  expect(receipts).toHaveLength(count);expect(injected).toBe(boundary==='after');
  expect(response.results?.map(r=>r.status)).toEqual(boundary==='normal'?Array(5).fill('completed'):boundary==='partial'?['completed','completed','completed','blocked','skipped']:
   ['completed','completed',boundary==='after'?'failed':'blocked','skipped','skipped']);
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(receipts.reduce((minutes,r)=>minutes+r.time_cost,0));
  expect(after.entities.find(e=>e.id==='npc_lin')!.components.condition!.hp).toBe(100);
  expect(response.story).toContain(fallback?'你等了1分钟':'你在原地等了一分钟');
  const greeting=fallback?'你向林舟开了口。':'你向林舟问了好。';
  expect(response.story!.split(greeting).length-1).toBe(boundary==='normal'?2:1);
  if(count>=3){expect(response.story).toMatch(/未能建立接触|没能建立接触/);expect(core).toHaveBeenCalledOnce();}
  else{expect(core).toHaveBeenCalledOnce();expect(rngCalls).toBe(0);expect(response.story).not.toMatch(/建立接触/);}
  if(count>=4)expect(response.story).toContain('整理');else expect(response.story).not.toContain('整理');
  expect(html).toContain(fallback?'你等了1分钟':'你在原地等了一分钟');
  expect(html.split(greeting).length-1).toBe(boundary==='normal'?2:1);
  expect(response.story).not.toMatch(/受伤了|造成了伤害|微笑|点头|答应|N4_REMOTE_SHIFT_RECORD/);
  const bytes=await readFile(join(directory,'current.json')),calls=[core.mock.calls.length,interpret.mock.calls.length,narrate.mock.calls.length,ai.metrics.requests,rngCalls];
  const fresh=new GameService(new JsonStore(directory),ai,seed.definition);
  for(let index=0;index<receipts.length;index++)await fresh.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:receipts[index].request_id,input:actions[index]});
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect([core.mock.calls.length,interpret.mock.calls.length,narrate.mock.calls.length,ai.metrics.requests,rngCalls]).toEqual(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

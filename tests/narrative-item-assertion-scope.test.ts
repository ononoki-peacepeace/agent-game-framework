import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeAction} from '../src/core/runtime.js';
import {NarrativePatternError,validateResolvedNarrative,validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {itemAssertionCorpus} from './fixtures/narrative-item-assertion-corpus.js';
import {narrativeWorldKinds,prepareNarrativeWorld,corpusSave,type NarrativeWorldKind} from './fixtures/narrative-worlds.js';

type Sample=typeof itemAssertionCorpus[number];
const fixtures=new Map<NarrativeWorldKind,ReturnType<typeof prepareNarrativeWorld>>();
function fixture(kind:NarrativeWorldKind){
 let value=fixtures.get(kind);if(!value){value=prepareNarrativeWorld(kind);fixtures.set(kind,value);}return value;
}
function narration(sample:Sample){
 return {narrative:sample.text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],
  ...('speech' in sample?{scene_beats:[{kind:'speech' as const,speaker_id:'npc_lin',utterance:'纸片已经被损毁'}]}:{})};
}
const cases=narrativeWorldKinds.flatMap(kind=>itemAssertionCorpus.map(sample=>({kind,sample})));
it.each(cases)('validator $kind / $sample.id (lawful=$sample.legal)',async({kind,sample})=>{
 const save=corpusSave((await fixture(kind)).save,{category:'item',condition:sample.condition});
 const turn=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID()),before=structuredClone(turn.save);
 const receipt=turn.save.resolution_receipts!.at(-1)!;
 // Presence checks are independent: an item assertion cannot relax actor authority.
 expect(()=>validateScenePresenceNarrative(turn.save,sample.text)).not.toThrow();
 const check=()=>validateResolvedNarrative(receipt,narration(sample),false,undefined,turn.save,true);
 if(sample.legal)expect(check).not.toThrow();
 else{
  expect(check).toThrow(NarrativePatternError);
  try{check();}catch(error){expect((error as NarrativePatternError).patternKind).toBe('item_condition');}
 }
 expect(turn.save).toEqual(before);
},30000);

it.each(cases)('disk $kind / $sample.id (lawful=$sample.legal)',async({kind,sample})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-n4-item-assertion-'));try{
  const save=corpusSave((await fixture(kind)).save,{category:'item',condition:sample.condition});
  let narrations=0,audits=0;
  const ai=new AIRuntime({name:'offline-n4-item-assertion',generate:async request=>{
   if(request.role==='narrator'){narrations++;return {data:narration(sample)};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded){audits++;
    return {data:{grounded:true,reports_result:true,reason:'Offline audit cannot override Core',unsupported_claims:[]}};}
   throw Error('Unexpected offline stage '+request.role);
  }});
  const store=new JsonStore(directory);await store.write(save);
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),
   action:{type:'INSPECT',parameters:{}}};
  const response=await service.turn(request),after=await service.current();
  expect(after.entities).toEqual(before.entities);
  expect(after.state_revision-before.state_revision).toBe(1);
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  const receipts=after.resolution_receipts!.filter(receipt=>receipt.request_id===request.request_id);
  expect(receipts).toHaveLength(1);expect(receipts[0].semantic_action).toBe('INSPECT');
  expect(narrations).toBe(sample.legal?1:3);expect(audits).toBe(sample.legal?1:0);
  expect(after.last_turn?.presentation?.status).toBe(sample.legal?'normal':'degraded');
  if(sample.legal)expect(after.last_turn?.narrative).toBe(sample.text);
  else expect(after.last_turn?.narrative).not.toBe(sample.text);
  const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);
  expect(await fresh.turn(request)).toEqual(response);
  expect(await fresh.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
},30000);

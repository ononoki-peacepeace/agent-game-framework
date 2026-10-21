import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {narrativeCorpus} from './fixtures/narrative-fixed-corpus.js';
import {narrativeWorldKinds,prepareNarrativeWorld,corpusSave,type NarrativeWorldKind} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {WorldBlockedError} from '../src/agent/outcome.js';

afterEach(()=>vi.restoreAllMocks());
const seeds=new Map<NarrativeWorldKind,ReturnType<typeof prepareNarrativeWorld>>();
const fixture=(kind:NarrativeWorldKind)=>{let value=seeds.get(kind);if(!value){value=prepareNarrativeWorld(kind);seeds.set(kind,value);}return value;};
type Boundary='normal'|'ambiguous-item'|'missing-speaker'|'world-refusal'|'before-write'|'after-write';
const cases=narrativeWorldKinds.flatMap(kind=>[
 ...narrativeCorpus.filter(sample=>sample.category==='item').map(sample=>({kind,sample,boundary:'normal' as Boundary})),
 ...(['ambiguous-item','missing-speaker','world-refusal','before-write','after-write'] as const).map(boundary=>({kind,
  sample:narrativeCorpus.find(sample=>sample.id===(boundary==='missing-speaker'?'retelling-cn':'item-intact'))!,boundary})),
]);
it.each(cases)('retains authority/replay in $kind: $boundary / $sample.id',async({kind,sample,boundary})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-n4-three-worlds-'));try{
  const prepared=await fixture(kind),save=corpusSave(prepared.save,sample);
  if(boundary==='ambiguous-item'){
   const other=structuredClone(save.entities.find(e=>e.id==='qa_paper')!);other.id='qa_other_paper';other.components.item!.condition='damaged';save.entities.push(other);
  }
  if(boundary==='world-refusal')save.definition.map!.locations.find(p=>p.id==='station')!.lifecycle={origin:'existing_detail',
   status:'closed',visibility:'public',creation_reason:'固定三世界语料验证中的权威封闭地点',source_ref:'n4_world_refusal',recorded_at:structuredClone(save.runtime.time)};
  let narrations=0,audits=0;const ai=new AIRuntime({name:'offline-three-world-boundary',generate:async request=>{
   if(request.role==='narrator'){narrations++;return {data:{narrative:sample.text,speaker:null,dialogue:null,choices:[],context_actions:[],
    patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],
    ...(boundary==='missing-speaker'?{scene_beats:[{kind:'speech',speaker_id:'missing_npc',utterance:'拿起纸片'}]}:{})}};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded){audits++;return {data:{grounded:true,reports_result:true,
    reason:'Fixed offline audit cannot override Core',unsupported_claims:[]}};}
   throw Error('Unexpected offline stage '+request.role);
  }});
  const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,ai,save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),
   action:boundary==='world-refusal'?{type:'MOVE',target_id:'station',parameters:{}}:{type:'INSPECT',parameters:{}}};
  const initialBytes=await readFile(join(directory,'current.json')),write=store.write.bind(store);
  if(boundary==='before-write'||boundary==='after-write')vi.spyOn(store,'write').mockImplementation(async(next,slot)=>{
   if(next.runtime.receipts.some(r=>r.id===request.request_id)){
    if(boundary==='after-write')await write(next,slot);throw Error('offline world write response failure');
   }return write(next,slot);
  });
  let response;
  if(boundary==='world-refusal')await expect(service.turn(request)).rejects.toBeInstanceOf(WorldBlockedError);
  else if(boundary==='before-write'||boundary==='after-write')await expect(service.turn(request)).rejects.toThrow('offline world write response failure');
  else response=await service.turn(request);
  const after=await service.current(),committed=boundary!=='before-write'&&boundary!=='world-refusal';
  expect(after.state_revision-before.state_revision).toBe(Number(committed));
  expect(after.runtime.time.minute-before.runtime.time.minute).toBe(Number(committed));
  expect(after.entities).toEqual(before.entities);
  expect(after.resolution_receipts?.filter(r=>r.request_id===request.request_id)).toHaveLength(Number(committed));
  if(boundary==='world-refusal')expect(ai.metrics.requests).toBe(0);
  else{
   const legal=boundary==='normal'?sample.legal:boundary==='before-write'||boundary==='after-write';
   expect(narrations).toBe(legal?1:3);expect(audits).toBe(legal?1:0);
   if(committed){
    expect(after.last_turn?.presentation?.status).toBe(legal?'normal':'degraded');
    if(legal)expect(after.last_turn?.narrative).toBe(sample.text);else expect(after.last_turn?.narrative).not.toBe(sample.text);
   }
  }
  const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);
  if(committed){const replay=await fresh.turn(request);if(response)expect(replay).toEqual(response);}
  else expect(bytes).toEqual(initialBytes);
  expect(await fresh.current()).toEqual(after);expect(ai.metrics.requests).toBe(calls);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

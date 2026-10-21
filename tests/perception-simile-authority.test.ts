import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {executeAction} from '../src/core/runtime.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
 interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
const legal=[
 '你的目光像一条细线一样穿过门口，暂时没有新的发现。',
 '你的视线如同清水一般穿过门口，暂时没有新的发现。',
 '你的注意力仿佛一阵轻风般地进入房间，暂时没有新的发现。',
 '你的目光好似一束光般缓缓走到门边，暂时没有新的发现。',
];
const unsafe=[
 legal[0]+'随后你进入走廊。',
 '你的目光像一条细线一样穿过门口，随后你拿起钥匙。',
 '你的目光像一条细线，随后你穿过门口。',
 '你的目光像你走到门口一样穿过门口，暂时没有新的发现。',
 '你和你的目光像一条细线一样穿过门口。',
];
it.each(legal)('preserves a sensory simile without a literal player action: %s',async text=>{
 const f=await sparseSetup(),save=await f.service.current(),turn=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID());
 const before=structuredClone(turn.save),receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(()=>validateResolvedNarrative(receipt,narration(text),false,undefined,turn.save,true)).not.toThrow();expect(turn.save).toEqual(before);
});
it.each(unsafe)('still rejects literal action despite a nearby sensory simile: %s',async text=>{
 const f=await sparseSetup(),save=await f.service.current(),turn=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID());
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text),false,undefined,turn.save,true)).toThrow();
});
it.each([true,false])('keeps canonical state and disk replay while checking simile authority (legal=%s)',async valid=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-simile-authority-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  save.definition.map!.locations.find(p=>p.id==='square')!.description='门开着，门口和门外的走廊公开可见。';
  const candidate=valid?legal[0]:unsafe[0];let narrations=0,audits=0;
  const ai=new AIRuntime({name:'offline-simile-authority',generate:async request=>{
   if(request.role==='narrator'){narrations++;return {data:narration(candidate)};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded){audits++;return {data:{grounded:true,reports_result:true,
    reason:'固定离线审核认为候选有依据；Core校验仍必须独立拒绝实体移动',unsupported_claims:[]}};}
   throw Error('Unexpected offline stage');
  }});
  const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,ai,save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{focus:'门口'}}};
  const result=await service.turn(request),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['INSPECT']);expect(narrations).toBe(valid?1:3);expect(audits).toBe(valid?1:0);
  expect(after.last_turn?.presentation?.status).toBe(valid?'normal':'degraded');
  if(valid)expect(after.last_turn?.narrative).toBe(candidate);else expect(after.last_turn?.narrative).not.toBe(candidate);
  const calls=ai.metrics.requests,fresh=new GameService(new JsonStore(directory),ai,save.definition);
  expect(await fresh.turn(request)).toEqual(result);expect(await fresh.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

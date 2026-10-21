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
 '你没有拿起纸片，暂时没有新的发现。',
 '你并未捡起纸片，暂时没有新的发现。',
 '你尚未拾起纸片，暂时没有新的发现。',
 '你没有放下钥匙，暂时没有新的发现。',
 '你没有交给林舟任何物品，暂时没有新的发现。',
 '你并未递给林舟钥匙，暂时没有新的发现。',
];
const unsafe=[
 legal[0]+'随后你捡起纸片。',
 legal[3]+'随后你把钥匙放进抽屉。',
 '你没有犹豫地拿起纸片。',
 '你没有阻止林舟拿起纸片。',
 '你并非没有拿起纸片。',
 '你不是未能拿起纸片。',
 '你未曾没有拿起纸片。',
 '你不能没有拿起纸片。',
 '你不会没有拿起纸片。',
];
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 save.entities.push({id:'qa_paper',type:'item',components:{identity:{name:'纸片',description:'已登记的普通纸片',avatar_id:null},
  location:{location_id:'square'},item:{weight:.01,stackable:false,tracking:'tracked'},discovery:{known_to_player:true}}},
 {id:'qa_key',type:'item',components:{identity:{name:'钥匙',description:'玩家原已持有的钥匙',avatar_id:null},
  item:{weight:.01,stackable:false,tracking:'tracked'},discovery:{known_to_player:true}}});
 (save.entities.find(e=>e.id==='player')!.components.inventory as {items:Record<string,number>}).items.qa_key=1;
 return {...f,save};
}
it.each(legal)('preserves direct non-transfer wording: %s',async text=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID()),before=structuredClone(turn.save);
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text),false,undefined,turn.save)).not.toThrow();
 expect(turn.save).toEqual(before);
});
it.each(unsafe)('rejects positive transfer after or around a denial: %s',async text=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID());
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text),false,undefined,turn.save)).toThrow();
});
it.each([true,false])('checks negative inventory prose through disk INSPECT and exact replay (legal=%s)',async valid=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-inventory-denial-'));try{
  const f=await fixture(),candidate=valid?legal[0]:unsafe[0];let narrations=0,audits=0;
  const ai=new AIRuntime({name:'offline-inventory-denial',generate:async request=>{
   if(request.role==='narrator'){narrations++;return {data:narration(candidate)};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded){audits++;return {data:{grounded:true,reports_result:true,
    reason:'原地观察，没有新的发现；物品不得被叙述转移',unsupported_claims:[]}};}
   throw Error('Unexpected offline stage');
  }});
  const store=new JsonStore(directory);await store.write(f.save);const service=new GameService(store,ai,f.save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{}}};
  const result=await service.turn(request),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['INSPECT']);expect(narrations).toBe(valid?1:3);expect(audits).toBe(valid?1:0);
  expect(after.last_turn?.presentation?.status).toBe(valid?'normal':'degraded');
  if(valid)expect(after.last_turn?.narrative).toBe(candidate);else expect(after.last_turn?.narrative).not.toBe(candidate);
  const calls=ai.metrics.requests,fresh=new GameService(new JsonStore(directory),ai,f.save.definition);
  expect(await fresh.turn(request)).toEqual(result);expect(await fresh.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {prepareCheck} from '../src/core/resolution.js';
import {executeAction} from '../src/core/runtime.js';
import {commitTruth} from '../src/narrative/truth.js';
import type {Inventory} from '../src/modules/inventory.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';

afterEach(()=>vi.restoreAllMocks());
vi.mock('../src/core/dice.js',async original=>({...await original<typeof import('../src/core/dice.js')>(),secureRng:()=>.99}));
const description='纸片背面留着一串尚未公开的号码';
function fixture(sealed:boolean,owned=false,nested=false,exterior=false){
 const world=structuredClone(demo);world.events=[];const save=newSave(world);
 for(const id of ['player','npc_lin'])save.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 save.entities.push({id:'qa_box',type:'item',components:{identity:{name:'封存盒',description:'一个容器',avatar_id:null},
  item:{weight:1,stackable:false,container:true,tracking:'tracked',tags:sealed?['sealed']:[]},location:{location_id:'square'}}});
 if(nested)save.entities.push({id:'qa_inner',type:'item',components:{identity:{name:'内匣',description:'内层容器',avatar_id:null},
  item:{weight:.2,stackable:false,container:true,container_id:'qa_box',tracking:'tracked'},location:{location_id:'square'}}});
 save.entities.push({id:'qa_note',type:'item',components:{identity:{name:'封存纸片',description:'容器内的纸片',avatar_id:null},
  item:{weight:.01,stackable:false,container_id:nested?'qa_inner':'qa_box',tracking:'tracked'},location:{location_id:'square'},discovery:{known_to_player:false}}});
 if(owned){
  const inventory=save.entities.find(e=>e.id==='player')!.components.inventory as Inventory;
  inventory.placements={qa_box:null,...(nested?{qa_inner:'qa_box'}:{}),qa_note:nested?'qa_inner':'qa_box'};
  for(const id of ['qa_box',...(nested?['qa_inner']:[]),'qa_note']){
   inventory.items[id]=1;const entity=save.entities.find(e=>e.id===id)!;delete entity.components.location;delete entity.components.item!.container_id;
  }
 }
 commitTruth(save,{id:'qa_truth',commitment:'HARD_TRUTH',statement:'PRIVATE_CAUSE',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,known_by:[],
  evidence:[{id:'qa_secret',status:'EXISTS',description:exterior?'盒子外侧有一道旧刻痕':description,event_ref:null,discovered_by:[],
   placement:{location_id:'square',anchor_entity_id:exterior?'qa_box':'qa_note',scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
 return validateSave(save);
}
it.each([{owned:false,nested:false},{owned:false,nested:true},{owned:true,nested:false},{owned:true,nested:true}])(
 'does not discover a clue through a sealed ancestor (owned=$owned,nested=$nested)',({owned,nested})=>{
  const save=fixture(true,owned,nested),before=structuredClone(save);
  expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true}).evidence_ids).toEqual([]);
  const after=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID(),'player',()=>.99).save;
  expect(publicView(after).known_evidence).toEqual([]);expect(after.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0].discovered_by).toEqual([]);
  expect(after.resolution_receipts!.at(-1)!.canonical_facts.join(' ')).not.toContain(description);expect(save).toEqual(before);
 });
it.each([false,true])('allows reachable clues in an unsealed container (owned=%s)',owned=>{
 const save=fixture(false,owned),check=prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true});
 expect(check.evidence_ids).toEqual(['qa_secret']);
});
it('allows an exterior clue on a sealed container itself',()=>{
 const save=fixture(true,false,false,true);
 expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true}).evidence_ids).toEqual(['qa_secret']);
});
it('does not let an NPC observer or explicit evidence ID bypass a sealed ancestor',()=>{
 const save=fixture(true);
 expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true},'npc_lin').evidence_ids).toEqual([]);
 expect(()=>prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',evidence_ids:['qa_secret']})).toThrow('已有的证据');
});
it('retains previously discovered knowledge when the container later becomes sealed',()=>{
 const save=executeAction(fixture(false),{type:'INSPECT',parameters:{}},randomUUID(),'player',()=>.99).save;
 expect(publicView(save).known_evidence).toContainEqual({id:'qa_secret',description});
 save.entities.find(e=>e.id==='qa_box')!.components.item!.tags=['sealed'];const checked=validateSave(save);
 expect(prepareCheck(checked,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true}).evidence_ids).toEqual([]);
 expect(publicView(checked).known_evidence).toContainEqual({id:'qa_secret',description});
});
it('does not turn an inaccessible contained clue into degraded player prose',async()=>{
 const save=fixture(true),store=new MemoryStore();await store.write(save);const ai=new AIRuntime(new MockAIAdapter());
 vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','描写未完成'));
 const service=new GameService(store,ai,save.definition),before=await service.current();
 await service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{}}});
 const after=await service.current();expect(after.last_turn!.presentation?.status).toBe('degraded');
 expect(after.last_turn!.narrative).not.toContain(description);expect(publicView(after).known_evidence).toEqual([]);
});
it('keeps the sealed boundary on disk and replays the settled inspection after service recreation',async()=>{
 const save=fixture(true,true,true),directory=await mkdtemp(join(tmpdir(),'agf-contained-clue-'));
 try{
  const store=new JsonStore(directory);await store.write(save);const ai=new AIRuntime(new MockAIAdapter());
  vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('content_filter','offline fixture','描写未完成'));
  const service=new GameService(store,ai,save.definition),before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{}}};
  await service.turn(body);const after=await service.current();expect(publicView(after).known_evidence).toEqual([]);
  expect(after.last_turn!.narrative).not.toContain(description);expect(after.state_revision).toBe(before.state_revision+1);
  const bytes=await readFile(join(directory,'current.json')),replayAi=new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Replay must not generate');}});
  const restarted=new GameService(new JsonStore(directory),replayAi,before.definition);await restarted.turn(body);
  expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAi.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

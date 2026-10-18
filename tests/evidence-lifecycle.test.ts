import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo,MemoryStore} from './helpers.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {prepareCheck} from '../src/core/resolution.js';
import {commitTruth,registerEvidence,instantiateSeededTruth} from '../src/narrative/truth.js';
import {buildNpcAgentContext} from '../src/agent/npc-agent.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {JsonStore} from '../src/storage/json-store.js';
import type {Inventory} from '../src/modules/inventory.js';
vi.mock('../src/core/dice.js',async original=>({...await original<typeof import('../src/core/dice.js')>(),secureRng:()=>.99}));
function fixture(){
 const world=structuredClone(demo);world.events=[];const save=newSave(world);
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 save.entities.push({id:'qa_object',type:'item',components:{identity:{name:'刻痕盒',description:'盒盖有一道刻痕',avatar_id:null},
  item:{weight:1,stackable:false,tracking:'tracked'},location:{location_id:'square'}}});
 commitTruth(save,{id:'qa_truth',commitment:'HARD_TRUTH',statement:'PRIVATE_FIXED_CAUSE',seed_constraint:null,
  source:'WORLD_CREATION',created_event_ref:null,known_by:[],evidence:[{id:'qa_mark',status:'EXISTS',description:'盒盖边缘有一道旧刻痕',
   event_ref:null,discovered_by:[],placement:{location_id:'square',anchor_entity_id:'qa_object',scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
 return save;
}
const clue=(save:ReturnType<typeof fixture>)=>save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0];
const action=(save:ReturnType<typeof fixture>,type:string,parameters:Record<string,unknown>={},target_id?:string,actor?:string)=>
 executeAction(save,{type,parameters,...(target_id?{target_id}:{})},randomUUID(),'player',()=>.99,undefined,true,actor).save;
describe('canonical evidence lifecycle',()=>{
 it('does not use the old seed text as permission to discard its constraint on instantiation',()=>{
  const save=fixture();commitTruth(save,{id:'seeded',commitment:'SEEDED_TRUTH',statement:'约束A，具体经过待发生',seed_constraint:'约束A',source:'WORLD_CREATION',created_event_ref:null,known_by:[],evidence:[]});
  expect(()=>instantiateSeededTruth(save,'seeded','完全不同的原因',randomUUID())).toThrow('违反预置真相');
  expect(save.gm_state.hidden_truth!.commitments.find(t=>t.id==='seeded')!.commitment).toBe('SEEDED_TRUTH');
 });
 it('keeps the same clue attached through discovery, possession, travel, transfer and destruction',()=>{
  let save=fixture();const truth=save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.statement;
  expect(publicView(save).known_evidence).toEqual([]);
  save=action(save,'MOVE_ITEM',{item_id:'qa_object',to:'held'});
  save=action(save,'MOVE',{},'market');
  expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true}).evidence_ids).toContain('qa_mark');
  save=action(save,'INSPECT',{},'qa_object');expect(clue(save).discovered_by).toEqual(['player']);
  expect(publicView(save).known_evidence).toContainEqual({id:'qa_mark',description:'盒盖边缘有一道旧刻痕'});
  expect(JSON.stringify(publicView(save))).not.toContain('PRIVATE_FIXED_CAUSE');
  save=action(save,'TRANSFER_ITEM',{item_id:'qa_object'},'npc_qiao');
  expect((save.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_object).toBeUndefined();
  expect((save.entities.find(e=>e.id==='npc_qiao')!.components.inventory as Inventory).items.qa_object).toBe(1);
  expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true}).evidence_ids).not.toContain('qa_mark');
  save=action(save,'INSPECT',{},'qa_object','npc_qiao');
  expect(clue(save).discovered_by).toEqual(['player','npc_qiao']);
  const context=buildNpcAgentContext(save,'npc_qiao',{kind:'world_event',description:'回想自己的调查'});
  expect(context.knowledge.some(k=>k.id==='qa_mark')).toBe(true);
  expect(buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'自己的近况'}).knowledge.some(k=>k.id==='qa_mark')).toBe(false);
  save=action(save,'DAMAGE_ITEM',{extent:'destroy'},'qa_object','npc_qiao');
  expect(clue(save).status).toBe('DESTROYED');
  expect(clue(save).event_ref).toBeNull();expect(clue(save).destroyed_event_ref).toBe(save.resolution_receipts!.at(-1)!.request_id);
  expect(save.resolution_receipts!.at(-1)).toMatchObject({actor_id:'npc_qiao',semantic_action:'DAMAGE_ITEM',effects:expect.arrayContaining(['state','evidence']),at:save.runtime.time});
  expect(clue(save).description).toBe('盒盖边缘有一道旧刻痕');
  expect(save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.statement).toBe(truth);
  expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'perception',band:'normal',discover_facts:true},'npc_qiao').evidence_ids).not.toContain('qa_mark');
  expect(publicView(save).known_evidence).toHaveLength(1);
  expect(validateSave(JSON.parse(JSON.stringify(save))).gm_state.hidden_truth).toEqual(save.gm_state.hidden_truth);
 });
 it('rejects duplicated possession, fabricated causal references and remote destruction without mutation',()=>{
  const save=fixture(),bad=structuredClone(save);(bad.entities.find(e=>e.id==='player')!.components.inventory as Inventory).items.qa_object=1;
  expect(()=>validateSave(bad)).toThrow('持有物品');
  const before=structuredClone(save);save.entities.find(e=>e.id==='qa_object')!.components.location={location_id:'market'};
  expect(()=>action(save,'DAMAGE_ITEM',{extent:'destroy'},'qa_object')).toThrow('可接触');
  expect(save.resolution_receipts).toEqual(before.resolution_receipts);
  expect(()=>registerEvidence(save,'qa_truth',{id:'fabricated',status:'CAUSALLY_CREATED',description:'不存在的事件产生的线索',event_ref:'fake-event',discovered_by:[]})).toThrow('真实世界事件');
 });
 it('a failed damage check consumes action time but preserves the object and truth',()=>{
  const save=fixture(),turn=executeAction(save,{type:'DAMAGE_ITEM',target_id:'qa_object',parameters:{extent:'destroy'}},randomUUID(),'player',()=>0);
  expect(turn.save.entities.find(e=>e.id==='qa_object')!.components.item?.condition).toBeUndefined();
  expect(clue(turn.save).status).toBe('EXISTS');expect(turn.action.time_cost).toBe(1);
  expect(turn.save.resolution_receipts!.at(-1)!.outcome).not.toBe('success');
 });
 it('settles natural-language item damage through the same canonical state mutation without a human opponent',()=>{
  const save=fixture(),input='我试着把刻痕盒砸坏';
  const turn=executeFreeform(save,input,{narrative:'尝试改变物品状态',minutes:1,target_id:'qa_object',facts:[],relationship:null,
   item_change:{item_id:'qa_object',condition:'destroyed',source_quote:'把刻痕盒砸坏'},
   resolution:{type:'SIMPLE_CHECK',domain:'physique',band:'normal',visibility:'public',stakes:'尝试损坏已存在物品',stages:[],evidence_ids:[],discover_facts:false}},randomUUID(),()=>.99);
  expect(clue(turn.save).status).toBe('DESTROYED');
  expect(turn.save.resolution_receipts!.at(-1)!.effects).toEqual(expect.arrayContaining(['state','evidence','time']));
  expect(turn.save.entities.find(e=>e.id==='qa_object')!.components.item?.condition).toBe('destroyed');
  expect(clue(save).status).toBe('EXISTS');
 });
 it('uses actual disk save/reload, request deduplication and service Undo for damage state and evidence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'herne-evidence-'));
  try{
   const store=new JsonStore(directory),initial=fixture();await store.write(initial);
   const ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unexpected model call');}});
   vi.spyOn(ai,'narrate').mockImplementation(async(_s,_a,facts)=>({narrative:facts.join(' '),speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]}));
   const service=new GameService(store,ai,initial.definition),before=await service.current();
   const req={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'DAMAGE_ITEM',target_id:'qa_object',parameters:{extent:'destroy'}}};
   await service.turn(req);const after=await service.current();
   expect(clue(after).status).toBe('DESTROYED');expect(after.state_revision).toBe(before.state_revision+1);
   await new GameService(new JsonStore(directory),ai,initial.definition).turn(req);
   expect((await store.read())!.runtime.time).toEqual(after.runtime.time);
   await service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
   const undone=(await new JsonStore(directory).read())!;
   expect(undone.entities).toEqual(before.entities);expect(undone.gm_state.hidden_truth).toEqual(before.gm_state.hidden_truth);
   expect(undone.runtime.time).toEqual(before.runtime.time);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});

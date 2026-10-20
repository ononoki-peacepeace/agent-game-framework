import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeAction,applyPatches} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {settleRelationshipOutcomes} from '../src/agent/npc-relations.js';
import {buildNpcAgentContext} from '../src/agent/npc-agent.js';
import {checkpointTurn,canUndo,worldImage} from '../src/core/turn-history.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(){
  const world=structuredClone(demo);world.events=[];
  world.ruleset.relationship_dimensions={
    positive_attitude:{min:0,max:10,initial:5,event_deltas:{conflict:-1,harmed:-2}},
    signed_acquaintance:{min:-10,max:10,initial:0,event_deltas:{contact:1,conflict:1,harmed:1}},
    unknown_semantics:{min:0,max:10,initial:0},
  };
  const save=newSave(world);
  for(const entity of save.entities)delete entity.components.relationships;
  save.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'square'};
  return save;
}
const talk=(save=fixture())=>executeAction(save,{type:'TALK',target_id:'npc_qiao',parameters:{topic:'通知约定'}},
  randomUUID(),'ai',undefined,undefined,false,'npc_lin',true);
const entries=(save:ReturnType<typeof fixture>,id:string)=>save.entities.find(e=>e.id===id)!.components.relationships?.entries as
  Record<string,Record<string,number>>|undefined;

describe('receipt-bound NPC relationship settlement',()=>{
  it('settles both actual NPC participants with authored semantics, visible to their next decision only',()=>{
    const before=fixture(),image=structuredClone(before),turn=talk(before);
    expect(before).toEqual(image);
    expect(entries(turn.save,'npc_lin')).toEqual({npc_qiao:{signed_acquaintance:1}});
    expect(entries(turn.save,'npc_qiao')).toEqual({npc_lin:{signed_acquaintance:1}});
    expect(entries(turn.save,'player')).toBeUndefined();
    expect(turn.save.runtime.time).toEqual(before.runtime.time);
    expect(buildNpcAgentContext(turn.save,'npc_lin',{kind:'direct_scene',description:'再次碰面'}).relationships)
      .toEqual({npc_qiao:{signed_acquaintance:1}});
    expect(JSON.stringify(publicView(turn.save))).not.toContain('signed_acquaintance');
    expect(turn.save.resolution_receipts!.at(-1)!.effects).toContain('relationship');
  });
  it('keeps all replay protection after more than twenty dimensions, persistence and world Undo',async()=>{
    let before=fixture();
    before.definition.ruleset.relationship_dimensions=Object.fromEntries(Array.from({length:25},(_,i)=>[
      `dimension_${i}`,{min:-10,max:10,initial:0,event_deltas:{contact:1}}]));
    const directory=await mkdtemp(join(tmpdir(),'agf-relations-'));
    try{
      const store=new JsonStore(directory);await store.write(before);
      const service=new GameService(store,new AIRuntime(new MockAIAdapter()),before.definition);
      before=await service.current(); // Normalize base module setup before the tested world turn.
      const turn=talk(before);await store.write(turn.save);
      const loaded=(await store.read())!;
      expect(settleRelationshipOutcomes(loaded,turn.action)).toEqual(loaded);
      expect(Object.keys(entries(loaded,'npc_lin')!.npc_qiao)).toHaveLength(25);
      checkpointTurn(before,loaded,turn.action.id);expect(canUndo(loaded)).toBe(true);
      await store.write(loaded);
      await service.undo({request_id:randomUUID(),game_id:loaded.game_id,expected_revision:loaded.state_revision});
      const restored=await service.current();
      expect(worldImage(restored)).toEqual(worldImage(before));
      expect(entries(talk(restored).save,'npc_lin')!.npc_qiao.dimension_24).toBe(1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('rejects reverse, third-party, missing character, self and mismatched receipt authorization',()=>{
    const turn=talk(),original=structuredClone(turn.save);
    const patch={op:'relationship_delta',entity_id:'npc_qiao',target_id:'npc_lin',dimension:'signed_acquaintance',delta:1};
    expect(()=>applyPatches(turn.save,[patch],turn.action)).toThrow('只允许');
    expect(()=>applyPatches(turn.save,[{...patch,entity_id:'player'}],turn.action)).toThrow('只允许');
    expect(()=>applyPatches(turn.save,[{...patch,entity_id:'npc_lin',target_id:'npc_qiao'}],turn.action))
      .toThrow('权威事件');
    for(const change of [{actor_id:'player'},{target_id:'player'},{id:randomUUID()}])
      expect(settleRelationshipOutcomes(turn.save,{...turn.action,...change})).toEqual(original);
    const malformed=fixture();delete malformed.entities.find(e=>e.id==='npc_lin')!.components.character;
    const fakeAction={...turn.action,actor_id:'npc_lin'};
    malformed.resolution_receipts=structuredClone(turn.save.resolution_receipts);
    delete malformed.resolution_receipts![0].result_entities!.relationship_settlement;
    expect(settleRelationshipOutcomes(malformed,fakeAction)).toEqual(malformed);
    expect(turn.save).toEqual(original);
  });
  it('does not initialize components on failed validation, absent receipts or irrelevant actions',()=>{
    const before=fixture(),turn=talk(before);
    expect(settleRelationshipOutcomes(before,turn.action)).toBe(before);
    const invalid=structuredClone(turn.save);
    for(const entity of invalid.entities)delete entity.components.relationships;
    delete invalid.resolution_receipts![0].result_entities!.relationship_settlement;
    invalid.definition.ruleset.relationship_dimensions.signed_acquaintance.event_deltas!.contact=3;
    const copy=structuredClone(invalid);
    expect(()=>settleRelationshipOutcomes(invalid,turn.action)).toThrow();expect(invalid).toEqual(copy);
    const wait=executeAction(before,{type:'WAIT',parameters:{minutes:1}},randomUUID());
    expect(entries(wait.save,'npc_lin')).toBeUndefined();
    const distant=fixture();distant.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'station'};
    expect(()=>talk(distant)).toThrow('同一地点');expect(entries(distant,'npc_lin')).toBeUndefined();
  });
  it('does not infer positive sentiment from nonnegative bounds and uses only real physical contact/harm',()=>{
    const initial=fixture();initial.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
    const player=initial.entities.find(e=>e.id==='player')!,target=initial.entities.find(e=>e.id==='npc_lin')!;
    player.components.scene_position={label:'桌旁'};target.components.scene_position={label:'桌旁'};
    target.components.condition={hp:100,stamina:100,stress:0};
    const proposal={narrative:'尝试身体行动',minutes:1,target_id:'npc_lin',facts:[],
      relationship:{dimension:'positive_attitude',delta:2},
      physical_action:{kind:'harm',source_quote:'抓住林舟',contact_stage_id:'contact',injury_stage_id:'harm',harm_level:'serious',surprise_attempt:true},
      resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
        stakes:'先接触，再尝试造成伤害',stages:[{id:'contact',band:'normal'},{id:'harm',band:'hard'}],evidence_ids:[],discover_facts:false}};
    const values=[.95,.1,.95,.1];
    const turn=executeFreeform(initial,'我突然抓住林舟，再尝试伤害他',proposal,randomUUID(),()=>values.shift()!);
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt.physical_outcome).toMatchObject({contact:true,harmed:true});
    expect(entries(turn.save,'npc_lin')!.player).toEqual({positive_attitude:3,signed_acquaintance:1});
    expect(entries(turn.save,'player')!.npc_lin).toEqual({positive_attitude:4,signed_acquaintance:1});
    const missed=structuredClone(turn.save);delete missed.resolution_receipts!.at(-1)!.result_entities!.relationship_settlement;
    missed.resolution_receipts!.at(-1)!.physical_outcome!.contact=false;
    expect(settleRelationshipOutcomes(missed,turn.action)).toEqual(missed);
  });
  it('clamps authored changes and keeps legacy worlds unchanged',()=>{
    const before=fixture();before.definition.ruleset.relationship_dimensions.signed_acquaintance.initial=10;
    expect(entries(talk(before).save,'npc_lin')).toBeUndefined();
    const legacy=newSave(demo),turn=executeAction(legacy,{type:'TALK',target_id:'npc_lin',parameters:{topic:'问候'}},randomUUID());
    expect(entries(turn.save,'player')).toEqual(entries(legacy,'player'));
    expect(entries(turn.save,'npc_lin')).toEqual(entries(legacy,'npc_lin'));
  });
});

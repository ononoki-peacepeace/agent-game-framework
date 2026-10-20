import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {prepareCheck,resolveCheck} from '../src/core/resolution.js';
import {executeFreeform} from '../src/core/freeform.js';
import {capabilityDomainNames} from '../src/core/capability.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {compileWorld} from '../src/ai/authoring.js';

/**
 * Independent acceptance for P1-B: a contested body must be adjudicated from readable ability
 * data and recorded circumstances, and the locked spec must say what it was read from.
 *
 * REV435's contest ran in a world whose authoring model returned no `capability_profiles`, so the
 * world declared no capability domains, no character carried `attributes`, every modifier was 0,
 * and the only trace of that was a debug log. The dice were real; the adjudication had nothing to
 * adjudicate with. These cases are written against the *production world's shape* (a world that
 * declares no domains) and name no NPC, command wording or attack type.
 *
 * Mock labelling: no AI provider is involved. Dice are injected or unused; `prepareCheck` is
 * called directly so every assertion is on state locked before any RNG.
 */
const physicalCheck={type:'OPPOSED_CHECK' as const,domain:'physique',opposition_domain:'agility',
  band:'normal' as const,target_id:'npc_lin',physical:true};
/** The production world's shape: routine condition exists, capability data does not. */
function floorWorld(attributes=true){
  const world=structuredClone(demo);world.events=[];
  world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  if(attributes)world.enabled_modules=[...new Set([...world.enabled_modules,'attributes'])];
  expect(world.ruleset.capability_domains).toBeUndefined();
  const save=newSave(world);
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
  player.components.condition={hp:100,stamina:100,stress:0};npc.components.condition={hp:100,stamina:100,stress:0};
  player.components.scene_position={label:'桌旁'};npc.components.scene_position={label:'桌旁'};
  return {save,player,npc};
}
const basisFor=(spec:ReturnType<typeof prepareCheck>,side:'actor'|'opponent')=>
  spec.ability_basis!.find(entry=>entry.side===side)!;
const proposal=(domain='physique')=>({narrative:'尝试身体行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'injury',
    harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain,opposition_domain:'agility',band:'normal',visibility:'public',
    stakes:'尝试而非保证结果',stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],
    evidence_ids:[],discover_facts:false}});

describe('ability data and recorded circumstances decide a contested body',()=>{
  it('reads a recorded attribute through the framework domain floor in a world that declared none',()=>{
    const {save,player}=floorWorld();
    const neutral=prepareCheck(save,randomUUID(),physicalCheck);
    expect(neutral.actor_modifier).toBe(0);
    // Trained-body data recorded on the entity now reaches adjudication without the world
    // having to declare the domain mapping itself.
    player.components.attributes={values:{strength:4,agility:1},labels:{},initial_source:'已登记的体力训练'};
    const trained=prepareCheck(save,randomUUID(),physicalCheck);
    expect(trained.actor_modifier).toBe(4);
    expect(basisFor(trained,'actor')).toMatchObject({entity_id:player.id,domain:'physique',
      rule_source:'framework_default',recorded:true,modifier:4});
    // The opponent has no recorded ability, and the spec says so rather than implying a tie.
    expect(basisFor(trained,'opponent')).toMatchObject({entity_id:'npc_lin',domain:'agility',recorded:false,modifier:0});
    expect(validateSave(JSON.parse(JSON.stringify(save)))).toBeTruthy();
  });

  it('states on the locked spec that a contest had no recorded ability on either side',()=>{
    const {save}=floorWorld();
    const spec=prepareCheck(save,randomUUID(),physicalCheck);
    expect(spec.ability_basis!.every(entry=>!entry.recorded&&entry.modifier===0)).toBe(true);
    // And the statement survives into the authoritative history the receipt points at.
    resolveCheck(save,spec,(()=>{const values=[.5,.5,.5,.5];return()=>values.shift()!;})());
    const record=validateSave(JSON.parse(JSON.stringify(save))).resolution_history!.at(-1)!;
    expect((record.spec as {ability_basis?:{recorded:boolean}[]}).ability_basis!.map(entry=>entry.recorded)).toEqual([false,false]);
  });

  it('keeps a legacy value recorded under the domain key as a direct modifier',()=>{
    const {save,player}=floorWorld();
    player.components.attributes={values:{physique:3},labels:{}};
    const spec=prepareCheck(save,randomUUID(),physicalCheck);
    expect(spec.actor_modifier).toBe(3);
    expect(basisFor(spec,'actor')).toMatchObject({rule_source:'legacy_value',recorded:true,modifier:3});
  });

  it('never lets identity, gender or reputation prose change the ability half',()=>{
    const {save,player,npc}=floorWorld();
    const before=prepareCheck(save,randomUUID(),physicalCheck);
    player.components.identity.gender='female';npc.components.identity.gender='male';
    player.components.identity.description='被称为无人能挡的格斗高手';
    npc.components.identity.description='体弱的普通学者';
    const after=prepareCheck(save,randomUUID(),physicalCheck);
    expect([after.actor_modifier,after.opponent_modifier]).toEqual([before.actor_modifier,before.opponent_modifier]);
    expect(after.ability_basis).toEqual(before.ability_basis);
  });

  it('charges reach only when both positions are recorded and actually differ',()=>{
    const {save,player,npc}=floorWorld();
    const reach=(spec:ReturnType<typeof prepareCheck>)=>
      (spec.circumstance_modifiers??[]).filter(item=>item.reason.includes('登记位置不同'));
    expect(reach(prepareCheck(save,randomUUID(),physicalCheck))).toEqual([]);
    npc.components.scene_position={label:'窗边'};
    const apart=prepareCheck(save,randomUUID(),physicalCheck);
    expect(reach(apart)).toHaveLength(1);
    expect(reach(apart)[0]).toMatchObject({side:'actor',amount:-2});
    expect(apart.actor_modifier).toBeLessThan(0);
    // An unrecorded position is not evidence of distance.
    delete player.components.scene_position;
    expect(reach(prepareCheck(save,randomUUID(),physicalCheck))).toEqual([]);
  });

  it('rejects an invented physical domain in a world that declared no domains',()=>{
    const {save}=floorWorld();
    expect(capabilityDomainNames(save)).toContain('physique');
    expect(()=>executeFreeform(save,'尝试打击林舟',proposal('invented_power'),randomUUID(),
      ()=>{throw Error('no dice');})).toThrow('身体行动须');
    // The legitimate domain still resolves through the same path.
    expect(()=>executeFreeform(save,'尝试打击林舟',proposal(),randomUUID(),
      (()=>{const values=[.99,.01,.99,.01];return()=>values.shift()!;})())).not.toThrow();
  });

  it('spends the declared exertion once for a contested physical attempt',()=>{
    const {save,player}=floorWorld();
    const spec=prepareCheck(save,randomUUID(),physicalCheck);
    expect(spec.exertion).toEqual({actor:1,opponent:1});
    resolveCheck(save,spec,(()=>{const values=[.5,.5];return()=>values.shift()!;})());
    expect(save.entities.find(entity=>entity.id===player.id)!.components.condition.stamina).toBe(99);
    expect(save.entities.find(entity=>entity.id==='npc_lin')!.components.condition.stamina).toBe(99);
  });

  it('declares the reading rules for a world whose authoring model returned no profiles',async()=>{
    const draft=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
    delete draft.capability_profiles;
    const world=compileWorld(worldInitializationSchema.parse(draft),demo.prompt_profile);
    // Module selection stays need-driven, so no profiles means no attributes module...
    expect(world.enabled_modules).not.toContain('attributes');
    // ...but the domain mapping is declared regardless, so adjudication is auditable instead of
    // falling through to an unnamed legacy path.
    expect(world.ruleset.capability_domains!.physique).toMatchObject({attribute:'strength',condition_sensitive:true});
    const save=newSave(world);
    const spec=prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'physique',band:'normal'});
    expect(spec.actor_modifier).toBe(0);
    expect(basisFor(spec,'actor')).toMatchObject({rule_source:'world_rule',recorded:false});
  });

  it('records per-person ability when the authoring model did supply profiles',async()=>{
    const draft=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
    draft.capability_profiles=[draft.player,...draft.characters].map((entry:{id:string})=>({entity_id:entry.id,
      attributes:{strength:entry.id===draft.player.id?2:0},skills:[],basis:'已登记训练；其余使用中性基准'}));
    const world=compileWorld(worldInitializationSchema.parse(draft),demo.prompt_profile);
    expect(world.enabled_modules).toContain('attributes');
    const save=newSave(world);
    const spec=prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'physique',band:'normal'});
    expect(spec.actor_modifier).toBe(2);
    expect(basisFor(spec,'actor')).toMatchObject({rule_source:'world_rule',recorded:true,modifier:2});
  });
});

import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFile} from 'node:fs/promises';
import {demo} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {readProfile} from '../src/ai/profiles.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {newSave,validateSave} from '../src/core/state.js';
import {unbackedPossessionClaims} from '../src/core/possession-claims.js';
import type {StructuredLogger} from '../src/observability/index.js';
import type {SavePackage} from '../src/core/schema.js';

/**
 * Independent acceptance for the second half of P1-A: a world that already shipped with a stated
 * possession backed by no item entity must say so, exactly once, without repairing itself.
 *
 * The live world is the case this exists for. Three of its thirteen characters describe carrying
 * something that is no entity at all — the player's camera and film, one NPC's leather notebook,
 * another's reading glasses — so the Narrator describing the player using the camera was never
 * catchable downstream: `validateResolvedNarrative` forbids `item_claims` on an adjudicated action
 * and the firewall's `inventory` pattern only matches acquisition verbs, so merely *using* a
 * nonexistent object trips nothing. The framework cannot invent the item (that would be reading
 * world facts out of prose) and cannot migrate a running save unasked, so it reports.
 *
 * Mock labelling: no AI provider is ever called — `AIRuntime` is constructed with a generator that
 * throws, which is itself the assertion that nothing here reaches a model. No dice. No pre-written
 * Narrator text. Fixture worlds are the shipped `town-blueprint.json` plus biography strings shaped
 * like the live world's phrasing; nothing reads or writes `data/current.json`.
 *
 * Evidence level: C for the core function, and the service case exercises the real
 * `GameService`/`JsonStore` load path on a temp data directory (level D for that path only).
 * NOT a real model, NOT production 3100, NOT human QA.
 */
const profile=await readProfile('content/profiles/default.json');
const blueprint=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});

/** A save shaped like the live world: a stated possession, and no item entity to back it. */
function worldWithClaim(description:string,items:{id:string;name:string}[]=[]):SavePackage{
  const value=structuredClone(blueprint);
  value.player.description=description;
  for(const item of items)value.items.push({...item,description:'已声明的物品',weight:.5,price:10});
  return newSave(compileWorld(worldInitializationSchema.parse(value),profile));
}

describe('a stated possession with no item entity is reported',()=>{
  it('names every unbacked thing in a live-shaped enumeration',()=>{
    const save=worldWithClaim('在大厅长椅上醒来，随身只有相机、半卷胶片和一件沾了海雾的外套。');
    expect(unbackedPossessionClaims(save).map(entry=>entry.claim))
      .toEqual(['相机','半卷胶片','一件沾了海雾的外套']);
    // The report carries who, so an operator can act without re-deriving it from the save.
    expect(unbackedPossessionClaims(save).every(entry=>entry.entity_id==='player')).toBe(true);
  });

  it('reports nothing once the item exists, even when nobody is holding it',()=>{
    // Holding is play-mutable: a character may put a declared item down and their biography still
    // reads the same. Reporting that every load would be noise, and it is not a data defect.
    const save=worldWithClaim('开局随身带着相机。',[{id:'camera',name:'相机'}]);
    expect(save.entities.every(entity=>!Object.keys(entity.components.inventory?.items??{}).length)).toBe(true);
    expect(unbackedPossessionClaims(save)).toEqual([]);
  });

  it('reports nothing for profession, habit, history or negation',()=>{
    for(const description of ['26岁自由摄影师，靠接案维生，习惯用镜头记东西。',
      '他过去曾经随身带着一台相机。','他身上没有带着任何相机。','他身上有一道旧伤。'])
      expect(unbackedPossessionClaims(worldWithClaim(description))).toEqual([]);
  });

  it('reports nothing for the shipped blueprint as authored',()=>{
    // A check that fires on the project's own content would be a false-positive generator, and
    // an operator would learn to ignore it.
    expect(unbackedPossessionClaims(newSave(compileWorld(worldInitializationSchema.parse(structuredClone(blueprint)),profile)))).toEqual([]);
  });
});

describe('the load path reports the gap without repairing it',()=>{
  it('warns once across repeated loads and creates no item',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-possession-'));directories.push(directory);
    const warnings:{event:string;fields:unknown}[]=[];
    const logger={debug(){},info(){},error(){},
      warn(event:string,fields:unknown){warnings.push({event,fields});}} as unknown as StructuredLogger;
    const store=new JsonStore(directory);
    const seeded=validateSave(worldWithClaim('在大厅长椅上醒来，随身只有相机和半卷胶片。'));
    const itemsBefore=seeded.entities.filter(entity=>entity.type==='item').length;
    await store.write(seeded);
    const ai=new AIRuntime({name:'must-not-be-called',generate:async()=>{throw Error('模型不应被加载路径调用');}});
    const service=new GameService(store,ai,demo,[],logger);

    const first=await service.current();
    const second=await service.current();
    const gaps=warnings.filter(entry=>entry.event==='world.possession_unbacked');
    expect(gaps).toHaveLength(1);
    expect((gaps[0].fields as {metadata:{claims:{claim:string}[]}}).metadata.claims.map(entry=>entry.claim))
      .toEqual(['相机','半卷胶片']);

    // Reporting must not be a disguised migration: no entity appears, no inventory changes, and
    // the revision does not move, so a load is still a load.
    expect(second.entities).toHaveLength(first.entities.length);
    const after=await store.read();
    expect(after!.entities.filter(entity=>entity.type==='item')).toHaveLength(itemsBefore);
    expect(after!.state_revision).toBe(seeded.state_revision);
    expect(JSON.stringify(after!.entities.find(entity=>entity.id===after!.player_state.entity_id)!.components.inventory))
      .toBe(JSON.stringify(seeded.entities.find(entity=>entity.id===seeded.player_state.entity_id)!.components.inventory));
  });

  it('stays silent for a world whose declarations are complete',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-possession-ok-'));directories.push(directory);
    const warnings:string[]=[];
    const logger={debug(){},info(){},error(){},warn(event:string){warnings.push(event);}} as unknown as StructuredLogger;
    const store=new JsonStore(directory);
    await store.write(validateSave(worldWithClaim('开局随身带着相机。',[{id:'camera',name:'相机'}])));
    const ai=new AIRuntime({name:'must-not-be-called',generate:async()=>{throw Error('模型不应被加载路径调用');}});
    await new GameService(store,ai,demo,[],logger).current();
    expect(warnings.filter(event=>event==='world.possession_unbacked')).toEqual([]);
  });
});

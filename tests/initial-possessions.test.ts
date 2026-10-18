import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readProfile} from '../src/ai/profiles.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {worldCandidateIssues} from '../src/ai/world-initializer-repair.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';

const profile=await readProfile('content/profiles/default.json');
const base=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
function candidate(){
  const value=structuredClone(base);
  value.player.description='开局随身带着相机，半卷胶片已装在相机中，穿着外套。';
  value.items.push(
    {id:'camera',name:'相机',description:'随身相机',weight:0.7,price:100,container:true},
    {id:'film',name:'半卷胶片',description:'已装入相机',weight:0.05,price:10},
    {id:'coat',name:'外套',description:'正穿在身上',weight:0.6,price:30});
  value.initial_possessions=[
    {owner_id:'player',item_id:'camera',placement:'held',container_id:null,slot:'hand',location_id:null},
    {owner_id:'player',item_id:'film',placement:'inside_container',container_id:'camera',slot:null,location_id:null},
    {owner_id:'player',item_id:'coat',placement:'worn',container_id:null,slot:'body',location_id:null}];
  return value;
}
const owned=(save:ReturnType<typeof newSave>)=>save.entities.find(entity=>entity.id==='player')!.components;

describe('authored initial possessions',()=>{
  it('feeds an explicitly declared missing opening item back to world candidate repair',()=>{
    const draft=candidate();
    draft.initial_possessions=draft.initial_possessions.filter((entry:{item_id:string})=>entry.item_id!=='camera');
    expect(worldCandidateIssues(draft).map(issue=>issue.code)).toContain('initial_possession_missing');
    const absent=structuredClone(draft);
    absent.items=absent.items.filter((item:{id:string})=>!['camera','film','coat'].includes(item.id));
    expect(worldCandidateIssues(absent).map(issue=>issue.code)).toContain('initial_possession_definition_missing');
  });
  it('detects an omitted item definition even when other possessions in the same sentence are structured',()=>{
    const draft=candidate();
    draft.items=draft.items.filter((item:{id:string})=>item.id!=='film');
    draft.initial_possessions=draft.initial_possessions.filter((entry:{item_id:string})=>entry.item_id!=='film');
    expect(worldCandidateIssues(draft).filter(issue=>issue.code==='initial_possession_definition_missing')
      .map(issue=>issue.current)).toContain('半卷胶片');
  });
  it('compiles carried, nested and worn declarations into authoritative entities and reloads them',()=>{
    const draft=candidate();
    expect(worldCandidateIssues(draft)).toEqual([]);
    const world=compileWorld(worldInitializationSchema.parse(draft),profile);
    const save=validateSave(JSON.parse(JSON.stringify(newSave(world))));
    expect(world.enabled_modules).toContain('equipment');
    expect(owned(save).inventory?.items).toMatchObject({camera:1,film:1,coat:1});
    expect(owned(save).inventory).toMatchObject({placements:{film:'camera'}});
    expect(owned(save).equipment?.slots).toMatchObject({hand:'camera',body:'coat'});
    expect(save.entities.find(entity=>entity.id==='camera')?.components.item).toMatchObject({owner_id:'player',container:true});
    expect(save.entities.find(entity=>entity.id==='film')?.components.location).toBeUndefined();
  });
  it('keeps biography mentions distinct from declared current ownership',()=>{
    const draft=structuredClone(base);
    draft.player.description='他过去曾经使用过相机。';
    const save=newSave(compileWorld(worldInitializationSchema.parse(draft),profile));
    expect(owned(save).inventory?.items).toEqual({});
    expect(save.entities.some(entity=>entity.components.identity?.name==='相机')).toBe(false);
  });
  it('keeps an NPC carried item and a player-owned item stored elsewhere in their distinct places',()=>{
    const draft=candidate();
    draft.items.push({id:'notes',name:'记录本',description:'NPC 随身记录本',weight:0.2,price:12},
      {id:'spare',name:'备用箱',description:'留在车站的私人物品',weight:2,price:30});
    draft.initial_possessions.push(
      {owner_id:'npc_lin',item_id:'notes',placement:'carried',container_id:null,slot:null,location_id:null},
      {owner_id:'player',item_id:'spare',placement:'stored',container_id:null,slot:null,location_id:'station'});
    const save=newSave(compileWorld(worldInitializationSchema.parse(draft),profile));
    expect(save.entities.find(entity=>entity.id==='npc_lin')?.components.inventory).toMatchObject({items:{notes:1}});
    expect(save.entities.find(entity=>entity.id==='spare')?.components).toMatchObject({
      item:{owner_id:'player'},location:{location_id:'station'}});
    expect((owned(save).inventory as {items:Record<string,number>}).items.spare).toBeUndefined();
  });
  it('rejects missing or conflicting ownership references before compilation',()=>{
    const draft=candidate();
    draft.initial_possessions[1].container_id='missing';
    draft.initial_possessions.push({...draft.initial_possessions[0]});
    expect(worldCandidateIssues(draft).map(issue=>issue.code)).toEqual(
      expect.arrayContaining(['invalid_initial_container','duplicate_possession','occupied_initial_slot']));
  });
  it('keeps item ownership consistent when it is removed from equipment and placed in the scene',()=>{
    const save=newSave(compileWorld(worldInitializationSchema.parse(candidate()),profile));
    const unequipped=executeAction(save,{type:'UNEQUIP',parameters:{slot:'body'}},randomUUID()).save;
    const dropped=executeAction(unequipped,{type:'MOVE_ITEM',parameters:{item_id:'coat',to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    expect(((owned(dropped).inventory as {items:Record<string,number>}).items).coat).toBeUndefined();
    expect(dropped.entities.find(entity=>entity.id==='coat')?.components.item?.owner_id).toBeUndefined();
    expect(dropped.entities.find(entity=>entity.id==='coat')?.components.location?.location_id).toBe('square');
    const restored=validateSave(JSON.parse(JSON.stringify(dropped)));
    expect(restored.entities.find(entity=>entity.id==='coat')?.components.location?.location_id).toBe('square');
    const picked=executeAction(restored,{type:'MOVE_ITEM',parameters:{item_id:'coat',to:'held',container_id:null,position_label:null}},randomUUID()).save;
    const worn=executeAction(picked,{type:'EQUIP',parameters:{item_id:'coat',slot:'body'}},randomUUID()).save;
    expect(worn.entities.find(entity=>entity.id==='coat')?.components.item?.owner_id).toBe('player');
    expect(owned(worn).equipment).toMatchObject({slots:{body:'coat'}});
  });
});

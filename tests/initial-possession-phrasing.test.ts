import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {readProfile} from '../src/ai/profiles.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {worldCandidateIssues} from '../src/ai/world-initializer-repair.js';
import {newSave} from '../src/core/state.js';

/**
 * Independent acceptance for P1-A: an opening possession the world states in prose must become a
 * structured item, and the structural guard must not depend on the world happening to phrase it
 * the way the guard was written.
 *
 * The live world's player biography reads 「…在陌生设施的大厅长椅上醒来，随身只有相机、半卷胶片
 * 和一件沾了海雾的外套。」 while `pc_asano.components.inventory` is `{items:{}}` in both the live
 * entities and the embedded `definition`. The existing guard required an opening marker
 * (开局/开场/此刻/现在/目前) plus one of six verbs, so 「随身只有」 matched nothing and the camera the
 * Narrator later described was never an entity. `initial-possession-repair.ts` is correctly inert
 * here: it only restores items whose evidence is in `definition.entities`, and there is none.
 *
 * Mock labelling: no AI provider and no dice. These are pure structural-guard assertions plus
 * `compileWorld` on the town blueprint. The biography strings below are fault injections modelled
 * on the live world's phrasing, not a replay of the live world, and nothing here reads or writes
 * `data/current.json`.
 *
 * The second half of these cases is the half that must keep failing to produce items: profession,
 * habit, history and negation are never grounds to create an entity.
 */
const profile=await readProfile('content/profiles/default.json');
const base=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
/** The live world's own sentence shape: an enumeration under 「随身只有」 with no opening marker. */
const livePhrasing='26岁自由摄影师，靠接案维生，习惯用镜头记东西。在陌生设施的大厅长椅上醒来，随身只有相机、半卷胶片和一件沾了海雾的外套。';
function draft(description:string){
  const value=structuredClone(base);
  value.player.description=description;
  return value;
}
const codes=(value:unknown)=>worldCandidateIssues(value).map(issue=>issue.code);
const missing=(value:unknown)=>worldCandidateIssues(value)
  .filter(issue=>issue.code==='initial_possession_definition_missing').map(issue=>issue.current);

describe('an opening possession stated in prose must become a structured item',()=>{
  it('reports every item in the live world\'s enumeration, not just the first',()=>{
    // All three are named by one clause under a single possession phrase. Reporting only 相机
    // would let the repair loop declare one item and call the clause satisfied.
    expect(missing(draft(livePhrasing))).toEqual(expect.arrayContaining(['相机','半卷胶片','一件沾了海雾的外套']));
  });

  it('asks for the holding record once the items exist but no possession is registered',()=>{
    const value=draft(livePhrasing);
    value.items.push({id:'camera',name:'相机',description:'随身相机',weight:0.7,price:100,container:true},
      {id:'film',name:'半卷胶片',description:'已装入相机',weight:0.05,price:10},
      {id:'coat',name:'外套',description:'沾了海雾',weight:0.6,price:30});
    expect(missing(value)).toEqual([]);
    // Defining the entity is not the same as saying who holds it, and the guard separates the two.
    expect(codes(value).filter(code=>code==='initial_possession_missing')).toHaveLength(3);
  });

  it('accepts the fully declared world and compiles the stated possessions into the save',()=>{
    const value=draft(livePhrasing);
    value.items.push({id:'camera',name:'相机',description:'随身相机',weight:0.7,price:100,container:true},
      {id:'film',name:'半卷胶片',description:'已装入相机',weight:0.05,price:10},
      {id:'coat',name:'外套',description:'沾了海雾',weight:0.6,price:30});
    value.initial_possessions=[
      {owner_id:'player',item_id:'camera',placement:'held',container_id:null,slot:'hand',location_id:null},
      {owner_id:'player',item_id:'film',placement:'inside_container',container_id:'camera',slot:null,location_id:null},
      {owner_id:'player',item_id:'coat',placement:'worn',container_id:null,slot:'body',location_id:null}];
    expect(worldCandidateIssues(value)).toEqual([]);
    const save=newSave(compileWorld(worldInitializationSchema.parse(value),profile));
    const player=save.entities.find(entity=>entity.id==='player')!.components;
    expect(player.inventory?.items).toMatchObject({camera:1,film:1,coat:1});
    expect(player.inventory).toMatchObject({placements:{film:'camera'}});
  });

  it('splits an enumeration inside a container clause as well',()=>{
    expect(missing(draft('开局随身带着相机，半卷胶片和备用电池已装在相机中。')))
      .toEqual(expect.arrayContaining(['半卷胶片','备用电池']));
  });

  it('treats 、 as enumeration but a following predicate as unrelated prose',()=>{
    // `，` separates predicates, so the clause after it is not a list item. Turning it into a
    // claim would demand an item named 「他很紧张」 and block world creation outright.
    expect(missing(draft('此刻随身带着相机、备用电池，他很紧张。'))).toEqual(['相机','备用电池']);
  });

  it('does not split a declared item whose own name contains a joining word',()=>{
    const value=draft('开局身上穿着和服。');
    value.items.push({id:'kimono',name:'和服',description:'正穿在身上',weight:0.8,price:200});
    value.initial_possessions=[{owner_id:'player',item_id:'kimono',placement:'worn',container_id:null,slot:'body',location_id:null}];
    expect(worldCandidateIssues(value)).toEqual([]);
  });
});

describe('prose that is not a present possession never creates an item',()=>{
  it('ignores profession and habit, which is how the live biography opens',()=>{
    const value=draft('26岁自由摄影师，靠接案维生，习惯用镜头记东西。');
    expect(worldCandidateIssues(value)).toEqual([]);
    const save=newSave(compileWorld(worldInitializationSchema.parse(value),profile));
    expect(save.entities.find(entity=>entity.id==='player')!.components.inventory?.items).toEqual({});
    expect(save.entities.some(entity=>entity.components.identity?.name==='相机')).toBe(false);
  });

  it('ignores past tense and negated possession',()=>{
    for(const description of ['他过去曾经随身带着一台相机。','他身上没有带着任何相机。','他早已不再随身携带相机。'])
      expect(worldCandidateIssues(draft(description))).toEqual([]);
  });

  it('does not read a wound or a feeling as a carried object',()=>{
    // 「身上有」 would be a tempting anchor, but it is how injuries and scars are described.
    for(const description of ['他身上有一道旧伤。','他现在很紧张。','他手里的活还没做完。'])
      expect(worldCandidateIssues(draft(description))).toEqual([]);
  });
});

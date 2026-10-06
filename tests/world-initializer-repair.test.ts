import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {AIRuntime} from '../src/ai/runtime.js';
import {readProfile} from '../src/ai/profiles.js';
import {MemoryStore,demo} from './helpers.js';
import {GameService} from '../src/server/service.js';
import {reviewWorldNovelty} from '../src/world/novelty.js';
import {projectNoveltyRepair} from '../src/ai/world-initializer-repair.js';

const profile=await readProfile('content/profiles/default.json');
const base=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
function fixture(){
  const candidate=structuredClone(base);
  candidate.hidden_truths=[{id:'history',commitment:'HARD_TRUTH',statement:'旧桥的维护记录已经存在',seed_constraint:null,
    evidence:[{id:'record',description:'一份维护记录',location_id:'station',anchor_entity_id:null,scene_scope:null,
      discoverability:{domain:'school_records',difficulty:'normal'}}]}];
  candidate.background_incidents=[{
    id:'notice_change',title:'公告调整',summary:'居民自行处理日程变化',source:'WORLD_CREATION',
    created_at:{day:1,minute:540},earliest_activation:{day:2,minute:540},latest_activation:null,
    activation_flags:[],activation_chance:1,participants:['npc_lin'],locations:['station'],
    causal_basis:{underlying_pressure:'日程变化',actor_motivation:'减少误会',resource_constraint:'人手有限',historical_cause:'旧线路调整',social_relationship:'志愿者与居民互助',trigger:'通知发布',unintended_consequence:'有人误解调整'},
    stages:[{id:'onset',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',effects:[],exposures:[],terminal:'resolved'}],
  }];
  return candidate;
}
function runtime(outputs:unknown[]){let calls=0;return {ai:new AIRuntime({name:'controlled',generate:async()=>({data:structuredClone(outputs[Math.min(calls++,outputs.length-1)])})}),calls:()=>calls};}

describe('WorldInitializer bounded structural repair',()=>{
  it('normalizes an out-of-range shop float locally without altering world authoring',async()=>{
    const candidate=fixture();candidate.shop.cash=500000;
    const controlled=runtime([candidate]);
    const save=await controlled.ai.initialize('社区生活',profile);
    expect(controlled.calls()).toBe(1);
    const wallet=save.definition.entities.find(entity=>entity.id==='corner_shop')?.components.wallet as {balances:{credit:number}}|undefined;
    expect(wallet?.balances.credit).toBe(100000);
    expect(save.definition.gm_state.hidden_truth?.commitments[0].statement).toBe(candidate.hidden_truths[0].statement);
  });
  it('repairs machine domain while preserving unrelated NPC, map and HARD truth',async()=>{
    const bad=fixture(),repair=fixture();bad.hidden_truths[0].evidence[0].discoverability.domain='校内档案';
    repair.characters[0].name='被模型擅改的人';repair.locations[0].name='被模型擅改的地方';
    repair.hidden_truths[0].statement='被模型擅改的真相';
    const controlled=runtime([bad,repair]);
    const save=await controlled.ai.initialize('社区生活',profile);
    expect(controlled.calls()).toBe(2);
    expect(save.definition.gm_state.hidden_truth?.commitments[0].evidence[0].placement?.discoverability.domain).toBe('school_records');
    expect(save.definition.gm_state.hidden_truth?.commitments[0].statement).toBe(bad.hidden_truths[0].statement);
    expect(save.definition.entities.find(entity=>entity.id==='npc_lin')?.components.identity?.name).toBe(bad.characters[0].name);
    expect(save.definition.map?.locations[0].name).toBe(bad.locations[0].name);
  });
  it('repairs only the terminal stage field and keeps the incident',async()=>{
    const bad=fixture(),repair=fixture();bad.background_incidents[0].stages[0].terminal='none';
    repair.background_incidents[0].title='被模型擅改的案件';
    const controlled=runtime([bad,repair]);const save=await controlled.ai.initialize('社区生活',profile);
    expect(controlled.calls()).toBe(2);
    expect(save.definition.background_incidents?.[0].stages[0].terminal).toBe('resolved');
    expect(save.definition.background_incidents?.[0].title).toBe(bad.background_incidents[0].title);
  });
  it('repairs a semantic NPC reference without rewriting the incident',async()=>{
    const bad=fixture(),repair=fixture();bad.background_incidents[0].participants=['missing_npc'];
    const controlled=runtime([bad,repair]);const save=await controlled.ai.initialize('社区生活',profile);
    expect(controlled.calls()).toBe(2);
    expect(save.definition.background_incidents?.[0].participants).toEqual(['npc_lin']);
    expect(save.definition.background_incidents?.[0].title).toBe(bad.background_incidents[0].title);
  });
  it('revalidates repair and cannot discard the whole incident to evade a failing field',async()=>{
    const bad=fixture(),dropped=fixture();bad.background_incidents[0].stages[0].terminal='none';dropped.background_incidents=[];
    const controlled=runtime([bad,dropped,dropped]);
    await expect(controlled.ai.initialize('社区生活',profile)).rejects.toThrow('新世界生成结果未能通过结构校验');
    expect(controlled.calls()).toBe(3);
  });
  it('caps invalid repair attempts and leaves the previously stored world intact',async()=>{
    const bad=fixture();bad.hidden_truths[0].evidence[0].discoverability.domain='中文领域';
    const controlled=runtime([bad,bad,bad]);const storage=new MemoryStore(),service=new GameService(storage,controlled.ai,demo);
    await service.newGame();const before=await storage.read();
    await expect(service.newGame('社区生活')).rejects.toThrow('新世界生成结果未能通过结构校验');
    expect(controlled.calls()).toBe(3);
    expect(await storage.read()).toEqual(before);
  });
  it('keeps omitted events during novelty revision and judges single-source only with enough seeds',()=>{
    const original=fixture(),other=structuredClone(original.background_incidents[0]);other.id='other_notice';
    original.background_incidents.push(other);
    original.world_macro_arcs=[{id:'civic_arc',title:'社区调整',summary:'安排变化',underlying_pressure:'资源缩减',
      actor_motivations:[],resource_constraint:'人手有限',historical_cause:'旧安排',social_relationship:'居民协作',
      trigger:'通知',unintended_consequence:'误会',truth_refs:[],incident_refs:['notice_change','other_notice'],horizon:'long'}];
    const revised=structuredClone(original);revised.background_incidents.pop();
    expect((projectNoveltyRepair(original,revised) as typeof original).background_incidents).toHaveLength(2);
    expect(reviewWorldNovelty({player:{id:'player'},background_incidents:original.background_incidents,world_macro_arcs:original.world_macro_arcs}).some(issue=>issue.kind==='single_source')).toBe(false);
    const third=structuredClone(other);third.id='third_notice';original.background_incidents.push(third);original.world_macro_arcs[0].incident_refs.push(third.id);
    expect(reviewWorldNovelty({player:{id:'player'},background_incidents:original.background_incidents,world_macro_arcs:original.world_macro_arcs}).some(issue=>issue.kind==='single_source')).toBe(true);
  });
});

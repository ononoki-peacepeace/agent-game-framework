import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {readProfile} from '../src/ai/profiles.js';
import {MemoryStore,demo} from './helpers.js';
import {GameService} from '../src/server/service.js';
import {reviewWorldNovelty} from '../src/world/novelty.js';
import {projectNoveltyRepair,initialNpcRequirement,worldCandidateIssues,compiledWorldIssue} from '../src/ai/world-initializer-repair.js';

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
it('requires a clock-driven, reachable opening for a newly authored Macro Arc',()=>{
  const candidate=fixture(),seed=candidate.background_incidents[0];
  candidate.world_macro_arcs=[{id:'local_pressure',title:'逐渐显现的压力',summary:'居民间已有不同安排',
    underlying_pressure:'场地资源紧张',actor_motivations:[{actor_id:seed.participants[0],motivation:'保留现有安排'}],
    resource_constraint:'空闲时段不足',historical_cause:'旧安排沿用至今',social_relationship:'居民彼此依赖',
    trigger:'日常安排改变',unintended_consequence:'小摩擦逐渐累积',truth_refs:[],incident_refs:[seed.id],horizon:'long'}];
  seed.activation_chance=0.5;
  expect(worldCandidateIssues(candidate).map(issue=>issue.code)).toContain('opening_path_missing');
  seed.activation_chance=1;
  seed.stages[0].exposures=[{id:'opening_notice',channel:'public_notice',location_id:'station',public_text:'站台公告更新。',minimum_stage:'onset'}];
  expect(worldCandidateIssues(candidate).map(issue=>issue.code)).not.toContain('opening_path_missing');
});
function runtime(outputs:unknown[]){let calls=0;return {ai:new AIRuntime({name:'controlled',generate:async()=>({data:structuredClone(outputs[Math.min(calls++,outputs.length-1)])})}),calls:()=>calls};}

describe('WorldInitializer bounded structural repair',()=>{
  it('recognizes participant counts when the prompt puts the count after the noun',()=>{
    expect(initialNpcRequirement('初始参与者恰好13人：玩家角色1人，自主NPC：12人。')).toBe(12);
    expect(initialNpcRequirement('总参与者恰好13名；玩家1名、NPC12名。')).toBe(12);
  });
  it('validates the full initial participant count instead of the opening visible cast',async()=>{
    const premise='世界初始存在16名参与者。其中一人为玩家角色，其余15人为拥有独立人格的NPC。';
    expect(initialNpcRequirement(premise)).toBe(15);
    const bad=fixture(),repaired=fixture();
    repaired.characters=Array.from({length:15},(_,index)=>({
      ...structuredClone(bad.characters[0]),id:index===0?bad.characters[0].id:`participant_${index+1}`,name:`参与者${index+1}`,
      persona:{personality:`独立倾向${index+1}`},
    }));
    expect(worldCandidateIssues(bad,premise).map(issue=>issue.code)).toContain('initial_population_mismatch');
    expect(worldCandidateIssues(repaired,premise)).toEqual([]);
    const controlled=runtime([bad,repaired]);
    const save=await controlled.ai.initialize(premise,profile);
    expect(controlled.calls()).toBe(2);
    expect(save.entities.filter(entity=>entity.components.character)).toHaveLength(16);
  });
  it('rejects duplicate initial people and missing independent profiles without requiring a fixed cast size',()=>{
    const premise='开局共有3名参与者，其中一名玩家，另外2名NPC。';
    const candidate=fixture();
    candidate.characters=[structuredClone(candidate.characters[0]),structuredClone(candidate.characters[0])];
    candidate.characters[1].id=candidate.player.id;
    expect(worldCandidateIssues(candidate,premise).map(issue=>issue.code)).toEqual(
      expect.arrayContaining(['duplicate_character_id','initial_persona_missing']));
  });
  it('does not silently drop authored people or routes when the selected modules omit their capabilities',()=>{
    const candidate=fixture();candidate.modules=['routine'];
    expect(worldCandidateIssues(candidate,'开局共有2名参与者，玩家1名、NPC1名。').map(issue=>issue.code)).toEqual(
      expect.arrayContaining(['characters_capability_missing','map_capability_missing']));
  });
  it('maps compiled-world failures to repairable authoring roots without exposing values',()=>{
    expect(compiledWorldIssue(new Error('definition.background_incidents.1: Invalid input')).path).toBe('background_incidents.1');
    expect(compiledWorldIssue(new Error('后台案件引用未知 NPC')).path).toBe('background_incidents');
  });
  it('reports cross-entity reference paths before compiler failure and repairs only those fields',async()=>{
    const bad=fixture(),corrected=fixture();
    bad.routes[0].to='missing_room';
    bad.hidden_truths[0].evidence[0].location_id='missing_room';
    const issues=worldCandidateIssues(bad,'社区生活');
    expect(issues.map(issue=>issue.path)).toEqual(expect.arrayContaining(['routes.0.to','hidden_truths.0.evidence.0.location_id']));
    corrected.characters[0].name='不应改写的人物';
    const controlled=runtime([bad,corrected]);
    const save=await controlled.ai.initialize('社区生活',profile);
    expect(controlled.calls()).toBe(2);
    expect(save.definition.map?.routes[0].to).toBe(fixture().routes[0].to);
    expect(save.definition.entities.find(entity=>entity.id==='npc_lin')?.components.identity?.name).toBe(bad.characters[0].name);
  });
  it('commits validated initial social relationships and rejects missing people or invalid values',async()=>{
    const candidate=fixture();candidate.initial_relationships=[
      {from_id:'npc_lin',to_id:'player',dimension:'trust',value:-25},
      {from_id:'player',to_id:'npc_lin',dimension:'familiarity',value:30},
    ];
    expect(worldCandidateIssues(candidate,'社区生活')).toEqual([]);
    const save=await runtime([candidate]).ai.initialize('社区生活',profile);
    expect((save.entities.find(entity=>entity.id==='npc_lin')?.components.relationships as {entries:Record<string,Record<string,number>>}|undefined)?.entries.player?.trust).toBe(-25);
    expect((save.entities.find(entity=>entity.id==='player')?.components.relationships as {entries:Record<string,Record<string,number>>}|undefined)?.entries.npc_lin?.familiarity).toBe(30);
    candidate.initial_relationships[0].from_id='missing_person';candidate.initial_relationships[1].value=200;
    expect(worldCandidateIssues(candidate,'社区生活').map(issue=>issue.code)).toEqual(expect.arrayContaining(['unknown_character','relationship_out_of_range']));
  });
  it('assembles a complete 12-NPC world after bounded single-output truncation without dropping earlier world data',async()=>{
    const premise='开局总共13名参与者，包括玩家1名与NPC12名。';
    const candidate=fixture();candidate.characters=Array.from({length:12},(_,index)=>({
      ...structuredClone(candidate.characters[0]),id:`participant_${index+1}`,name:`参与者${index+1}`,
      persona:{personality:`不同的个人动机${index+1}`},
    }));
    candidate.background_incidents[0].participants=['participant_1'];
    candidate.background_incidents[0].stages[0].actor_id='participant_1';
    const roster={characters:candidate.characters.map((character:typeof candidate.characters[number])=>({...character,location_id:null}))};
    const body=structuredClone(candidate);delete (body as {characters?:unknown}).characters;
    body.character_locations=candidate.characters.map((character:typeof candidate.characters[number])=>({character_id:character.id,location_id:'station'}));
    let calls=0;
    const ai=new AIRuntime({name:'controlled',generate:async()=>{
      calls++;
      if(calls<=2)throw new ProviderError('max_output_tokens','finish_reason=max_output_tokens','响应截断');
      return {data:structuredClone(calls===3?roster:body)};
    }});
    const save=await ai.initialize(premise,profile);
    expect(calls).toBe(4);
    expect(save.entities.filter(entity=>entity.components.character)).toHaveLength(13);
    expect(save.definition.map?.routes.length).toBeGreaterThan(0);
    expect(save.definition.background_incidents).toHaveLength(1);
  });
  it('does not commit an incomplete staged roster after truncation',async()=>{
    const storage=new MemoryStore();let calls=0;
    const ai=new AIRuntime({name:'controlled',generate:async()=>{
      calls++;if(calls<=2)throw new ProviderError('max_output_tokens','finish_reason=max_output_tokens','响应截断');
      return {data:{characters:fixture().characters}};
    }});
    const service=new GameService(storage,ai,demo);await service.newGame();const before=await storage.read();
    await expect(service.newGame('开局总共13名参与者，玩家1名、NPC12名。')).rejects.toThrow('分段创建的人物或地点数据未满足完整性约束');
    expect(calls).toBe(3);expect(await storage.read()).toEqual(before);
  });
  it('keeps provider quota failures distinct from candidate validation and preserves the old world',async()=>{
    const storage=new MemoryStore(),ai=new AIRuntime({name:'controlled',generate:async()=>{
      throw new ProviderError('rate_limit','quota','额度限制');
    }});
    const service=new GameService(storage,ai,demo);await service.newGame();const before=await storage.read();
    await expect(service.newGame('一个有12名NPC的世界')).rejects.toThrow('模型额度或频率限制');
    expect(await storage.read()).toEqual(before);
  });
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
    await expect(controlled.ai.initialize('社区生活',profile)).rejects.toThrow('限定修复次数已用尽');
    expect(controlled.calls()).toBe(3);
  });
  it('caps invalid repair attempts and leaves the previously stored world intact',async()=>{
    const bad=fixture();bad.hidden_truths[0].evidence[0].discoverability.domain='中文领域';
    const controlled=runtime([bad,bad,bad]);const storage=new MemoryStore(),service=new GameService(storage,controlled.ai,demo);
    await service.newGame();const before=await storage.read();
    await expect(service.newGame('社区生活')).rejects.toThrow('限定修复次数已用尽');
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

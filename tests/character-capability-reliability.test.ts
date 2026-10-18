import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {prepareCheck,resolveCheck} from '../src/core/resolution.js';
import {executeFreeform,FreeformRepairableError} from '../src/core/freeform.js';
import {validateResolvedNarrative,validateScenePresenceNarrative,physicalNarrativeFallback} from '../src/core/narrative-firewall.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldCandidateIssues} from '../src/ai/world-initializer-repair.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {NarratorSchemaError} from '../src/ai/failures.js';

function fixture(){const world=structuredClone(demo);world.events=[];
 world.enabled_modules=[...new Set([...world.enabled_modules,'attributes','aptitudes','skills'])];
 world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 world.ruleset.capability_domains={lifting:{attribute:'strength',skills:['lifting'],condition_sensitive:true,exertion_cost:0},
  agility:{attribute:'agility',skills:[],condition_sensitive:true,exertion_cost:0}};
 const save=newSave(world),pc=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id==='npc_lin')!;
 pc.components.attributes={values:{strength:0},labels:{}};npc.components.attributes={values:{agility:0},labels:{}};
 pc.components.condition={hp:100,stamina:100,stress:0};npc.components.condition={hp:100,stamina:100,stress:0};return save;}
const narrative=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]});
const proposal=()=>({narrative:'尝试',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
 physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
 resolution:{type:'OPPOSED_CHECK',domain:'lifting',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'尝试而非保证结果',
 stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[],discover_facts:false}});
function rng(values:number[]){return()=>{const n=values.shift();if(n===undefined)throw Error('unexpected RNG');return n;};}

describe('declared abilities through existing attributes and skills',()=>{
 it('combines declared relevant training and base ability, never identity labels',()=>{
  const s=fixture(),pc=s.entities.find(e=>e.id===s.player_state.entity_id)!;
  pc.components.attributes={values:{strength:3},labels:{}};pc.components.skills={entries:{lifting:{name:'搬运',level:2,xp:0,next_xp:100,aptitude_ref:null,tags:[]}}};
  const spec=prepareCheck(s,randomUUID(),{type:'OPPOSED_CHECK',domain:'lifting',opposition_domain:'agility',band:'normal',target_id:'npc_lin'});
  expect(spec.actor_modifier).toBe(5);expect(spec.opponent_modifier).toBe(0);
  pc.components.identity.description='被称为天下无敌的训练家';pc.components.identity.gender='female';
  expect(prepareCheck(s,randomUUID(),{type:'SIMPLE_CHECK',domain:'unknown',band:'normal'}).actor_modifier).toBe(0);
 });
 it('preserves a seeded distribution for advantaged, even and disadvantaged actors',()=>{
  const rates:number[]=[];
  for(const strength of [-5,0,5]){const s=fixture();s.entities.find(e=>e.id===s.player_state.entity_id)!.components.attributes={values:{strength},labels:{}};
   let seed=123456789,success=0;const seeded=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
   for(let i=0;i<512;i++){const spec=prepareCheck(s,randomUUID(),{type:'OPPOSED_CHECK',domain:'lifting',opposition_domain:'agility',band:'normal',target_id:'npc_lin'});
    if(resolveCheck(s,spec,seeded).outcome==='success')success++;}
   rates.push(success/512);
  }
  console.log(JSON.stringify({sample:'seeded-opposed-abilities',seed:123456789,per_group:512,rates}));
  expect(rates[0]).toBeLessThan(rates[1]-.1);expect(rates[2]).toBeGreaterThan(rates[1]+.1);
  expect(rates.every(rate=>rate>0&&rate<1)).toBe(true);
 });
 it('does not roll or spend exertion for a deterministic act',()=>{
  const s=fixture();s.definition.ruleset.capability_domains!.lifting.exertion_cost=2;
  resolveCheck(s,prepareCheck(s,randomUUID(),{type:'DETERMINISTIC',domain:'lifting',band:'normal'}),()=>{throw Error('no dice');});
  expect(s.entities.find(e=>e.id===s.player_state.entity_id)!.components.condition.stamina).toBe(100);
 });
 it('carries fatigue into the next nonviolent attempt and charges neither the fold nor reload again',()=>{
  const s=fixture(),pc=s.entities.find(e=>e.id===s.player_state.entity_id)!;pc.components.condition.stamina=20;
  s.definition.ruleset.capability_domains!.lifting.exertion_cost=1;
  const input='在十秒内反复尝试搬运，做不了就停。';
  const raw={...proposal(),physical_action:null,target_id:null,repetition:{source_quote:input,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable'},
   resolution:{...proposal().resolution,type:'SIMPLE_CHECK',stages:[]}};
  const turn=executeFreeform(s,input,raw,randomUUID(),()=>.99);
  const checks=turn.save.resolution_history!.filter(r=>r.rolls.length);
  expect(checks).toHaveLength(5);expect(checks[0].spec.actor_modifier).toBe(0);expect(checks[1].spec.actor_modifier).toBe(-2);
  expect(turn.save.entities.find(e=>e.id===pc.id)!.components.condition.stamina).toBe(15);
  expect(validateSave(JSON.parse(JSON.stringify(turn.save))).runtime.scene_seconds).toBe(10);
 });
 it('compiles per-person authored abilities and validates incomplete profiles without changing a legacy save',async()=>{
  const draft=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
  draft.capability_profiles=[draft.player,...draft.characters].map((e:any)=>({entity_id:e.id,attributes:{strength:e.id===draft.player.id?3:0},skills:[],basis:'已登记训练；其余使用中性基准'}));
  draft.capability_profiles[0].skills=[{id:'lifting',name:'搬运训练',level:2,attribute:'strength'}];
  const candidate=worldInitializationSchema.parse(draft);
  expect(worldCandidateIssues(candidate)).toEqual([]);
  const save=newSave(compileWorld(candidate,demo.prompt_profile));
  expect(prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'lifting',band:'normal'}).actor_modifier).toBe(5);
  expect(save.entities.filter(e=>e.components.character).every(e=>e.components.attributes)).toBe(true);
  expect(save.entities.find(e=>e.id===save.player_state.entity_id)!.components.attributes.initial_source).toContain('已登记训练');
  expect(save.entities.find(e=>e.id===save.player_state.entity_id)!.components.attributes).toMatchObject({labels:{strength:'力量'}});
  draft.capability_profiles.pop();expect(worldCandidateIssues(draft).some(i=>i.code==='missing_character_capability')).toBe(true);
  const legacy=newSave(demo),before=JSON.stringify(legacy);validateSave(JSON.parse(before));expect(JSON.stringify(legacy)).toBe(before);
 });
});

describe('shared execution and narration boundaries',()=>{
 it('uses the unified target binding for a pronoun and rejects a remote target without dice or a leaked destination',()=>{
  const s=fixture(),binding={target_ids:['npc_lin']},input='我试着击中她。',raw={...proposal(),physical_action:{...proposal().physical_action,source_quote:input}};
  const t=executeFreeform(s,input,raw,randomUUID(),rng([.99,.01,.99,.01]),false,binding);
  expect(t.save.resolution_receipts!.at(-1)!.target_id).toBe('npc_lin');
  s.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'market'};
  expect(()=>executeFreeform(s,input,raw,randomUUID(),()=>{throw Error('no RNG');},false,binding)).toThrow('不在当前场景');
 });
 it('rejects replacing an authorized strike with restraint before RNG',()=>{
  const input='尝试打击林舟',raw={...proposal(),physical_action:{...proposal().physical_action,kind:'restrain',injury_stage_id:null}};
  expect(()=>executeFreeform(fixture(),input,raw,randomUUID(),()=>{throw Error('no dice');},false,
   {target_ids:['npc_lin'],physical_intent:{forms:['strike'],source_quote:input}})).toThrow('不能用抓握替换');
 });
 it('binds a local multistage person interaction through the existing contract',async()=>{
  const s=fixture(),view=publicView(s),input='尝试抓住林舟，控制身体，再推动他。';
  const goal:any={physical_intent:{forms:['restrain','push'],source_quote:input},play_action:'interact',targets:[{entity_id:'npc_lin'}],
   multi_step:true,dependencies:['接触后控制'],ambiguity:null,external_artifact:false,temporal:{at:null,recurrence:null}};
  const ai={planGoals:()=>{throw Error('no duplicate planner call');}} as unknown as AIRuntime;
  const plan=compileGoalContract(view,await createAgentPlan(ai,view,input,{semantic_goal:goal}),{kind:'manual',text:input});
  expect(plan.goals).toHaveLength(1);expect(plan.goals[0].normalized_goal).toBe(input);
 });
 it('allows grounded body expression but rejects an actual unexecuted item transfer',()=>{
  const s=fixture(),t=executeFreeform(s,'尝试打击林舟',proposal(),randomUUID(),rng([.99,.01,.01,.99])),r=t.save.resolution_receipts!.at(-1)!;
  expect(()=>validateResolvedNarrative(r,narrative('力道收进去了，她仍然站着。'),false)).not.toThrow();
  expect(()=>validateResolvedNarrative(r,narrative('你把钥匙放进背包。'),false)).toThrow();
  expect(()=>validateResolvedNarrative(r,narrative('怀里的公告纸散开来，落在地上。'),false)).toThrow();
 });
 it('permits only the real failed prefix of a mixed sequence, not a denial of all contact',()=>{
  const s=fixture(),input='尝试打击林舟，反复十秒。';const t=executeFreeform(s,input,{...proposal(),repetition:{source_quote:input,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable'}},randomUUID(),
    rng([.01,.99,.01,.99,.01,.99,.99,.01,.01,.99,.99,.01,.99,.01]));
  const r=t.save.resolution_receipts!.at(-1)!;
  expect(()=>validateResolvedNarrative(r,narrative('头三次没有碰到她。第四次触及她，最后一次造成伤害。'),false)).not.toThrow();
  expect(()=>validateResolvedNarrative(r,narrative('所有尝试都没有碰到她。'),false)).toThrow();
 });
 it('uses the same grounded physical fallback when a later Narrator schema error exhausts the existing budget',async()=>{
  const s=fixture(),store=new MemoryStore();await store.write(s);const ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unexpected provider');}});
  vi.spyOn(ai,'freeform').mockResolvedValue(proposal() as any);
  vi.spyOn(ai,'npcDecision').mockRejectedValue(new Error('isolated reaction unavailable'));
  vi.spyOn(ai,'narrate').mockRejectedValue(new NarratorSchemaError([{path:'scene_beats',code:'invalid_type',expected:'array',message:'expected array'}],{}));
  const service=new GameService(store,ai,demo);
  const result=await service.turn({game_id:s.game_id,expected_revision:0,request_id:randomUUID(),input:'尝试打击林舟'},undefined,undefined,undefined,false,undefined,undefined,true);
  const after=(await store.read())!;
  expect(after.state_revision).toBe(1);expect(after.last_turn!.narrative).not.toBe('你接触到了对方，但进一步的动作没有得手，这次没有造成已确认的伤害。');
  expect(after.last_turn!.scene_beats?.length).toBeGreaterThan(0);expect(result.notices?.length??0).toBeGreaterThan(0);
 });
});


it('establishes only an explicitly authorized control stage and retains it when a later push fails',()=>{
 const s=fixture(),input='抓住林舟，控制后再推动。';
 const raw={...proposal(),physical_action:{...proposal().physical_action,source_quote:input,control_stage_id:'hold'},
  resolution:{...proposal().resolution,stages:[{id:'contact',band:'normal'},{id:'hold',band:'normal'},{id:'injury',band:'normal'}]}};
 const result=executeFreeform(s,input,raw,randomUUID(),rng([.99,.01,.99,.01,.01,.99]),false,
  {target_ids:['npc_lin'],physical_intent:{source_quote:input,forms:['restrain','push']}});
 expect(result.save.resolution_receipts!.at(-1)!.physical_outcome).toMatchObject({contact:true,harmed:false,control_established:true,action_forms:['restrain','push']});
 expect(result.save.entities.find(e=>e.id==='npc_lin')!.components.physical_state.restrained_by).toBe(s.player_state.entity_id);
});

it('presents an observable actual NPC departure without inventing a move from an unexecuted plan',()=>{
 const s=fixture(),turn=executeFreeform(s,'尝试打击林舟',proposal(),randomUUID(),rng([.01,.99])),root=turn.save.resolution_receipts!.at(-1)!;
 const here=turn.save.entities.find(e=>e.id===s.player_state.entity_id)!.components.location.location_id;
 const route=turn.save.definition.map!.routes.find(r=>r.from===here)!;
 const moved=executeAction(turn.save,{type:'MOVE',target_id:route.to,parameters:{companions:'none'}},randomUUID(),'ai',()=>.5,undefined,false,'npc_lin',true);
 const movement=moved.save.resolution_receipts!.at(-1)!;
 expect(physicalNarrativeFallback(turn.save,root,false).narrative).not.toContain('离开');
 expect(physicalNarrativeFallback(moved.save,root,false,[movement]).narrative).toContain('离开了这里');
 expect(()=>validateResolvedNarrative(root,narrative('林舟离开了这里。你仍留在原地。'),false,[movement],moved.save)).not.toThrow();
 expect(()=>validateResolvedNarrative(root,narrative('林舟离开了这里，你也进入另一个房间。'),false,[movement],moved.save)).toThrow();
 expect(moved.save.runtime.time).toEqual(turn.save.runtime.time);
});


it('respects a world declared attribute scale without changing legacy raw values',()=>{
 const s=fixture();s.definition.ruleset.capability_domains!.lifting.attribute_baseline=10;
 s.definition.ruleset.capability_domains!.lifting.attribute_step=2;
 const actor=s.entities.find(e=>e.id===s.player_state.entity_id)!;actor.components.attributes={values:{strength:18},labels:{}};
 expect(prepareCheck(s,randomUUID(),{type:'SIMPLE_CHECK',domain:'lifting',band:'normal'}).actor_modifier).toBe(4);
 expect((actor.components.attributes as {values:Record<string,number>}).values.strength).toBe(18);
});


it('rejects an invented physical capability domain before RNG rather than silently using zero',()=>{
 const raw={...proposal(),resolution:{...proposal().resolution,domain:'invented_power'}};
 expect(()=>executeFreeform(fixture(),'尝试打击林舟',raw,randomUUID(),()=>{throw Error('no dice');})).toThrow('身体行动须');
});


it('does not turn abstract damage into a specific wound in the real Narrator sample',()=>{
 const s=fixture(),t=executeFreeform(s,'尝试打击林舟',proposal(),randomUUID(),rng([.99,.01,.99,.01]));
 const r=t.save.resolution_receipts!.at(-1)!;expect(r.physical_outcome!.harmed).toBe(true);
 expect(()=>validateResolvedNarrative(r,narrative('她喘着气，脸侧浮起淤红。'),false)).toThrow('具体伤势');
 expect(()=>validateResolvedNarrative(r,narrative('她喘着气，声音发紧，护住了身体。'),false)).not.toThrow();
 const confirmed={...r,canonical_facts:[...r.canonical_facts,'经权威伤势记录确认：脸侧淤红。']};
 expect(()=>validateResolvedNarrative(confirmed,narrative('她脸侧浮起淤红。'),false)).not.toThrow();
});


it('uses the declared neutral baseline for a missing legacy attribute without persisting a value',()=>{
 const s=fixture(),actor=s.entities.find(e=>e.id===s.player_state.entity_id)!;
 delete actor.components.attributes;delete actor.components.skills;
 s.definition.ruleset.capability_domains!.lifting.attribute_baseline=10;
 s.definition.ruleset.capability_domains!.lifting.attribute_step=2;
 const before=JSON.stringify(s);
 expect(prepareCheck(s,randomUUID(),{type:'SIMPLE_CHECK',domain:'lifting',band:'normal'}).actor_modifier).toBe(0);
 expect(JSON.stringify(s)).toBe(before);
});


it('does not turn attention into departure, while still rejecting an actual departure in the next clause',()=>{
 const s=fixture();
 expect(()=>validateScenePresenceNarrative(s,'林舟站在这里，视线一直没离开你。')).not.toThrow();
 expect(()=>validateScenePresenceNarrative(s,'林舟的目光离开了你，随后走出房间。')).toThrow('离场');
 const r=executeFreeform(s,'尝试打击林舟',proposal(),randomUUID(),rng([.01,.99])).save.resolution_receipts!.at(-1)!;
 expect(()=>validateResolvedNarrative(r,narrative('林舟的视线一直没离开你。'),false)).not.toThrow();
 expect(()=>validateResolvedNarrative(r,narrative('林舟的目光离开你，随后离开了这里。'),false)).toThrow();
});

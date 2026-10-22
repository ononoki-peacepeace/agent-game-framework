import {describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {assertFreeformGoalEvidence} from '../src/core/freeform.js';
import {resolveEntities} from '../src/agent/entities.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {executePlan} from '../src/agent/executor.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {validateResolvedNarrative,physicalNarrativeFallback} from '../src/core/narrative-firewall.js';
import {verifyGoalAlignment} from '../src/agent/goal-alignment.js';
import {narrativeLanguageIssues} from '../src/ai/visible-language.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import type {PendingTurn} from '../src/storage/json-store.js';

function fixture(){const save=newSave(demo);save.definition.events=[];save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  save.entities.find(entity=>entity.id==='npc_lin')!.components.condition={hp:100,stamina:100,stress:0};return save;}
const text='立即反复尝试攻击林舟，持续十秒，无法继续就停止。';
const proposal=()=>({narrative:'一次尝试',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  repetition:{source_quote:text,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable' as const},
  physical_action:{kind:'harm',source_quote:'攻击林舟',contact_stage_id:'hit',injury_stage_id:'hit',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
    stakes:'尝试打击',stages:[{id:'hit',band:'normal'}],evidence_ids:[],discover_facts:false}});
const narrative=(prose:string)=>({narrative:prose,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]});
const rng=(rolls:number[])=>()=>{const value=rolls.shift();if(value===undefined)throw Error('unexpected roll');return value;};
describe('immediate bounded repetition through existing Core',()=>{
  it('settles five actual attempts in ten seconds, retains individual checks and reloads',()=>{
    const before=fixture(),turn=executeFreeform(before,text,proposal(),randomUUID(),rng(Array.from({length:10},(_,i)=>i%2?.01:.99)));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt.repetition).toMatchObject({requested_seconds:10,elapsed_seconds:10,stopped_by:'duration'});
    expect(receipt.repetition!.attempt_ids).toHaveLength(5);expect(turn.save.resolution_history).toHaveLength(6);
    expect(turn.save.resolution_history!.find(record=>record.check_id===receipt.check_id)!.outcome).toBe(receipt.outcome);
    expect(receipt.rolls).toEqual([]); // a fold of recorded checks never rolls again
    expect(turn.save.runtime.time).toEqual(before.runtime.time);expect(turn.save.runtime.scene_seconds).toBe(10);
    expect(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.condition.hp).toBe(75);
    expect(validateSave(JSON.parse(JSON.stringify(turn.save))).resolution_receipts!.at(-1)).toEqual(receipt);
    expect(before.entities.find(entity=>entity.id==='npc_lin')!.components.condition.hp).toBe(100);
  });
  it('stops on a resisted attempt and retains earlier successful damage',()=>{
    const request='立即反复尝试攻击林舟十秒，任一次攻击失败就停止。';
    const turn=executeFreeform(fixture(),request,{...proposal(),repetition:{...proposal().repetition,source_quote:request,termination_mode:'until_unsuccessful_result'}},randomUUID(),rng([.99,.01,.01,.99]));
    expect(turn.save.resolution_receipts!.at(-1)!.repetition).toMatchObject({elapsed_seconds:4,stopped_by:'failed_attempt'});
    expect(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.condition.hp).toBe(95);
    expect(turn.save.resolution_receipts!.at(-1)!.physical_outcome).toMatchObject({contact:true,harmed:true,damage:5});
  });
  it('continues after a missed attempt when only inability or target loss should stop the sequence',()=>{
    const turn=executeFreeform(fixture(),text,proposal(),randomUUID(),rng([.99,.01,.01,.99,.99,.01,.01,.99,.99,.01]));
    expect(turn.save.resolution_receipts!.at(-1)!.repetition).toMatchObject({elapsed_seconds:10,stopped_by:'duration'});
    expect(turn.save.resolution_receipts!.at(-1)!.repetition!.attempt_ids).toHaveLength(5);
    expect(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.condition.hp).toBe(85);
  });
  it.each(['npc_lin',null])('counts carried seconds once and stops an incapacitated bound target (%s)',target_id=>{
    const save=fixture();save.runtime.scene_seconds=55;
    save.entities.find(entity=>entity.id==='npc_lin')!.components.condition.hp=5;
    const turn=executeFreeform(save,text,{...proposal(),target_id},randomUUID(),rng([.99,.01]));
    expect(turn.save.resolution_receipts!.at(-1)!.repetition).toMatchObject({elapsed_seconds:2,stopped_by:'target_unavailable'});
    expect(turn.save.runtime.scene_seconds).toBe(57);expect(turn.action.time_cost).toBe(0);
  });
  it('retains no-discovery results and shared second carry for a semantic perception sequence',()=>{
    const save=fixture(),request_id=randomUUID(),input='依次留意各个角落十秒。';save.runtime.scene_seconds=55;
    const raw={...proposal(),target_id:null,physical_action:null,
      repetition:{source_quote:input,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable'},
      resolution:{...proposal().resolution,type:'DETERMINISTIC',domain:'general',stages:[]}};
    const turn=executeFreeform(save,input,raw,request_id,()=>{throw Error('no extra RNG');},true);
    expect(turn.save.runtime.time.minute-save.runtime.time.minute).toBe(1);expect(turn.save.runtime.scene_seconds).toBe(5);
    expect(turn.save.resolution_receipts!.at(-1)!.canonical_facts.join(' ')).toContain('没有发现');
    expect(turn.save.resolution_history!.at(-1)!.spec.domain).toBe('perception');
    expect(()=>assertFreeformGoalEvidence(turn.save,input,request_id)).not.toThrow();
    expect(publicView(turn.save).known_evidence??[]).toEqual([]);
  });
  it('supports nonviolent repetition with a hard budget, without any Provider calls',()=>{
    const input='重复敲门十秒',raw={...proposal(),target_id:null,physical_action:null,
      repetition:{source_quote:input,duration_seconds:10,interval_seconds:1,termination_mode:'while_executable'},
      resolution:{...proposal().resolution,type:'DETERMINISTIC',domain:'general',stages:[]}};
    const save=fixture();save.definition.map!.locations.find(place=>place.id==='square')!.description+=' 广场边有一扇可以接触的木门。';
    const turn=executeFreeform(save,input,raw,randomUUID(),()=>{throw Error('no randomness for deterministic activity');});
    expect(turn.save.resolution_receipts!.at(-1)!.repetition).toMatchObject({elapsed_seconds:8,stopped_by:'budget'});
  });
  it('rejects duration substitution before rolling',()=>{
    expect(()=>executeFreeform(fixture(),text,{...proposal(),repetition:{...proposal().repetition,duration_seconds:20}},randomUUID(),()=>{throw Error('no roll');})).toThrow('秒数');
  });
  it('returns a genuine prerequisite refusal as world feedback, without a technical settlement error or commit',async()=>{
    const save=fixture(),store=new MemoryStore();await store.write(save);
    const ai=new AIRuntime({name:'fixture',generate:async()=>({data:{...proposal(),blocker:{type:'PREREQUISITE_FAILURE',reason:'眼前没有可确认的操作对象。'}}})});
    const goal={repetition:proposal().repetition,ambiguity:null,external_artifact:false,temporal:{at:null,recurrence:null},targets:[]};
    const plan=await createAgentPlan(ai,publicView(save),text,{semantic_goal:goal});
    const result=await executePlan(new GameService(store,ai,demo),{game_id:save.game_id,request_id:randomUUID(),expected_revision:0,input:text},plan,undefined,goal.repetition);
    expect(result.outcome).toMatchObject({type:'game',kind:'blocked_by_world'});
    expect(result.message).toContain('操作对象');expect((await store.read())!.state_revision).toBe(0);
  });
  it('resolves unique public given names, but does not guess between shared names',()=>{
    const save=fixture();save.entities.find(entity=>entity.id==='npc_lin')!.components.identity.name='林 舟舟';
    expect(resolveEntities(publicView(save),'与舟舟交谈').matches.map(entity=>entity.id)).toEqual(['npc_lin']);
    save.entities.push({...structuredClone(save.entities.find(entity=>entity.id==='npc_lin')!),id:'other'});
    expect(resolveEntities(publicView(save),'与舟舟交谈').confident).toBe(false);
  });
  it('keeps an immediate repeated attempt and stop condition intact instead of planning unsupported goals',async()=>{
    const save=fixture();let calls=0;const ai={planGoals:()=>{calls++;throw Error('not needed');}} as unknown as AIRuntime;
    const plan=await createAgentPlan(ai,publicView(save),text,{semantic_goal:{repetition:proposal().repetition,
      ambiguity:null,external_artifact:false,temporal:{at:null,recurrence:null},targets:[{entity_id:'npc_lin'}]}});
    expect(calls).toBe(0);expect(plan.goals).toHaveLength(1);expect(plan.goals[0]).toMatchObject({type:'WORLD_ACTION',normalized_goal:text});
  });
  it('accepts a cited absence of injury without permitting a positive invented injury',()=>{
    const turn=executeFreeform(fixture(),text,{...proposal(),repetition:null},randomUUID(),rng([.01,.99]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    const fact_index=receipt.canonical_facts.findIndex(fact=>fact.includes('没有结算伤害'));
    expect(()=>validateResolvedNarrative(receipt,{...narrative('这次没有受伤。'),mechanical_claims:[{kind:'injury',fact_index}]},false)).not.toThrow();
    expect(()=>validateResolvedNarrative(receipt,narrative('她的手臂受伤。'),false)).toThrow();
    expect(()=>validateResolvedNarrative(receipt,{...narrative('她说：“我担心受伤。”'),scene_beats:[{kind:'speech',speaker_id:'npc_lin',utterance:'我担心受伤。'}]},false)).not.toThrow();
    expect(()=>validateResolvedNarrative(receipt,narrative('她“受伤”了。'),false)).toThrow();
  });
  it('persists free-action scene beats, uses Chinese presentation guidance, and replays without another model call',async()=>{
    const save=fixture(),store=new MemoryStore();await store.write(save);let calls=0,prompt='';
    const beats=[{kind:'narration',text:'林舟停下来看着你。'},{kind:'speech',speaker_id:'npc_lin',utterance:'怎么了？'},{kind:'narration',text:'四周仍是熟悉的景象。'}];
    const ai=new AIRuntime({name:'fixture',generate:async request=>{calls++;prompt=request.prompt;
      if(request.role==='narrator')return {data:{...narrative('林舟停下来看着你。\n\n怎么了？\n\n四周仍是熟悉的景象。'),scene_beats:beats}};
      return {data:{...proposal(),repetition:null,physical_action:null,resolution:{...proposal().resolution,type:'DETERMINISTIC',stages:[]}}};}});
    const service=new GameService(store,ai,demo),request_id=randomUUID();
    await service.turn({game_id:save.game_id,request_id,input:'我向林舟示意',expected_revision:save.state_revision},undefined,undefined,undefined,false,undefined,undefined,true);
    expect((await store.read())!.last_turn!.scene_beats).toEqual(beats);expect(prompt).toContain('简体中文');expect(prompt).toContain('证据原文');
    const count=calls;await service.turn({game_id:save.game_id,request_id,input:'我向林舟示意',expected_revision:save.state_revision},undefined,undefined,undefined,false,undefined,undefined,true);expect(calls).toBe(count);
    await service.undo({game_id:save.game_id,expected_revision:(await store.read())!.state_revision,request_id:randomUUID()});expect((await store.read())!.runtime.time).toEqual(save.runtime.time);
  });
  it('uses only scenery, settled results and previously validated speech in a degraded scene',()=>{
    const turn=executeFreeform(fixture(),text,{...proposal(),repetition:null},randomUUID(),rng([.01,.99]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    const result=physicalNarrativeFallback(turn.save,receipt,false);
    expect(result.narrative).toContain('没能碰到对方');expect(result.scene_beats?.every(beat=>beat.kind==='narration')).toBe(true);
    turn.save.npc_agent_state??={};turn.save.npc_agent_state.npc_lin=emptyNpcAgentState();
    turn.save.npc_agent_state.npc_lin.last_decisions=[{event_ref:`reaction:${receipt.request_id}`,kind:'speech',summary:'要求停止',target_id:'player',revision:1,speech:'やめてください！'}];
    expect(physicalNarrativeFallback(turn.save,receipt,false).scene_beats?.every(beat=>beat.kind==='narration')).toBe(true);
  });
  it('repairs missing decided NPC speech without repeating the already resolved physical action',async()=>{
    class Store extends MemoryStore{
      pending=new Map<string,PendingTurn>();
      async readPending(id:string){return structuredClone(this.pending.get(id)??null);}
      async writePending(turn:PendingTurn){this.pending.set(turn.request_id,structuredClone(turn));}
      async clearPending(id:string){this.pending.delete(id);}
    }
    const store=new Store(),before=fixture(),request_id=randomUUID();await store.write(before);
    const candidate=executeFreeform(before,text,{...proposal(),repetition:null},request_id,rng([.99,.01]));
    await store.writePending({request_id,game_id:before.game_id,expected_revision:0,
      fingerprint:createHash('sha256').update(JSON.stringify({input:text})).digest('hex'),candidate:candidate.save,action:candidate.action,facts:candidate.facts,generic:true});
    let narrations=0,decisions=0;
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      if(request.role==='npc_decision'){decisions++;return {data:{kind:'speech',speech:'别碰我。',vote_target:null,intent:'要求停止',proposed_action:null,
        evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'拒绝继续接触',social_response:null}};}
      narrations++;return {data:narrative(narrations===1?'林舟开口了。说完后停在原地。':'你碰到了林舟，对方受了伤。林舟说：“别碰我。”')};
    }});
    const service=new GameService(store,ai,demo);await service.turn({game_id:before.game_id,expected_revision:0,request_id,input:text});
    const after=(await store.read())!;
    expect(narrations).toBe(2);expect(decisions).toBe(1);
    expect(after.resolution_history).toHaveLength(1);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
    expect(after.last_turn!.scene_beats).toContainEqual({kind:'speech',speaker_id:'npc_lin',utterance:'别碰我。'});
  });
  it('flags ordinary Japanese dialogue, but preserves registered names and authentic foreign source text',()=>{
    const view=publicView(fixture());view.entities.find(entity=>entity.id==='npc_lin')!.components.identity.name='エレナ・コヴァーチ';
    expect(narrativeLanguageIssues(narrative('エレナ・コヴァーチ看向你。'),view)).toEqual([]);
    expect(narrativeLanguageIssues({...narrative('她开口了。'),scene_beats:[{kind:'speech',speaker_id:'npc_lin',utterance:'やめてください！離してください！'}]},view)[0].path).toBe('scene_beats.0.utterance');
    view.known_evidence=[{id:'note',description:'纸条原文：「ここで待ってください」。'}];
    expect(narrativeLanguageIssues(narrative('纸条原文：「ここで待ってください」。'),view)).toEqual([]);
  });
});


describe('REV 288 authorization and targeted binding recovery',()=>{
  it('does not let a downstream binding invent repetition for a single authorized action',async()=>{
    const save=fixture(),store=new MemoryStore();await store.write(save);
    const ai=new AIRuntime({name:'single-attempt',generate:async request=>{
      if(request.role==='narrator')return {data:narrative('你做了一次尝试，周围没有新的变化。')};
      return {data:{...proposal(),physical_action:null,target_id:null,
        resolution:{...proposal().resolution,type:'DETERMINISTIC',stages:[]}}};
    }});
    const service=new GameService(store,ai,demo),request_id=randomUUID();
    await service.turn({game_id:save.game_id,expected_revision:0,request_id,input:'我立即做一次原地伸展。'},undefined,undefined,undefined,false,undefined,undefined,true);
    const after=(await store.read())!;
    expect(after.state_revision).toBe(1);
    expect(after.resolution_receipts).toHaveLength(1);
    expect(after.resolution_receipts![0].repetition).toBeUndefined();
    expect(after.runtime.scene_seconds??0).toBe(0);
  });
  it('reports the exact missing injury stage, before consuming RNG or changing state',()=>{
    const save=fixture(),raw=proposal();raw.physical_action.injury_stage_id='missing';
    try{executeFreeform(save,text,{...raw,repetition:null},randomUUID(),()=>{throw Error('must not roll');});throw Error('must reject');}
    catch(error){expect(error).toMatchObject({failure_code:'proposal_contract_invalid',diagnostics:[
      {path:'physical_action.injury_stage_id',code:'physical_contract'}]});}
    expect(save.resolution_history??[]).toEqual([]);
    expect(save.entities.find(e=>e.id==='npc_lin')!.components.condition.hp).toBe(100);
  });
  it('feeds a stage error to the one existing repair call and settles a bounded attempt despite an unfulfilled ultimate objective',async()=>{
    const save=fixture(),store=new MemoryStore();await store.write(save);let bindings=0;const prompts:string[]=[];
    const input='反复尝试打击林舟十秒，最终希望让他无法行动，本轮只做能完成的尝试。';
    const repetition={...proposal().repetition,source_quote:input};
    const ai=new AIRuntime({name:'targeted-repair',generate:async request=>{
      if(request.role==='npc_decision')throw Error('no reaction fixture');
      if(request.role==='narrator')return {data:narrative('你尝试了几次，对方仍在眼前。')};
      prompts.push(request.prompt);bindings++;
      return {data:{...proposal(),repetition,physical_action:{...proposal().physical_action,source_quote:'打击林舟',
        injury_stage_id:bindings===1?'missing':'hit'}}};
    }});
    const service=new GameService(store,ai,demo),request_id=randomUUID();
    await service.turn({game_id:save.game_id,expected_revision:0,request_id,input},undefined,undefined,undefined,false,undefined,undefined,true,undefined,false,repetition);
    const after=(await store.read())!;
    expect(bindings).toBe(2);expect(prompts[1]).toContain('physical_action.injury_stage_id');
    expect(prompts[1]).toContain('diagnostics');expect(after.state_revision).toBe(1);
    expect(after.resolution_receipts!.at(-1)!.repetition!.elapsed_seconds).toBe(10);
    expect(after.resolution_receipts!.filter(r=>r.repetition)).toHaveLength(1);
    await store.write(validateSave(JSON.parse(JSON.stringify(after))));
    await service.turn({game_id:save.game_id,expected_revision:0,request_id,input},undefined,undefined,undefined,false,undefined,undefined,true,undefined,false,repetition);
    expect(bindings).toBe(2);expect((await store.read())!.state_revision).toBe(1);
    await service.undo({game_id:save.game_id,expected_revision:1,request_id:randomUUID()});
    const undone=(await store.read())!;
    expect(undone.runtime.time).toEqual(save.runtime.time);
    expect(undone.runtime.scene_seconds??0).toBe(save.runtime.scene_seconds??0);
    expect(undone.entities.find(e=>e.id==='npc_lin')!.components.condition).toEqual(save.entities.find(e=>e.id==='npc_lin')!.components.condition);
  });
  it('records actual cumulative damage rather than nominal overkill and persists the depleted condition',()=>{
    const save=fixture();save.entities.find(e=>e.id==='npc_lin')!.components.condition.hp=7;
    const raw={...proposal(),repetition:null,physical_action:{...proposal().physical_action,harm_level:'serious'}};
    const turn=executeFreeform(save,text,raw,randomUUID(),rng([.99,.01]));
    const loaded=validateSave(JSON.parse(JSON.stringify(turn.save)));
    expect(loaded.entities.find(e=>e.id==='npc_lin')!.components.condition.hp).toBe(0);
    expect(loaded.resolution_receipts!.at(-1)!.physical_outcome!.damage).toBe(7);
    expect(save.entities.find(e=>e.id==='npc_lin')!.components.condition.hp).toBe(7);
  });
});


it('exposes an absent repetition contract to the existing alignment audit as well as a present one',async()=>{
  const save=fixture();let payload:any;
  const service={current:async()=>save,ai:{systemAgent:async(_schema:any,_profile:any,input:any)=>{
    payload=input;return {verdict:'incomplete',explanation:'重复尝试授权未进入执行参数'};
  }}} as unknown as GameService;
  const plan=await createAgentPlan({planGoals:()=>{throw Error('must not call');}} as unknown as AIRuntime,
    publicView(save),text,{semantic_goal:{repetition:proposal().repetition,ambiguity:null,external_artifact:false,
      temporal:{at:null,recurrence:null},targets:[]}});
  expect((await verifyGoalAlignment(service,text,plan,null))?.verdict).toBe('incomplete');
  expect(payload.bounded_repetition).toBeNull();
  expect(payload.repetition_alignment).toContain('incomplete');
});

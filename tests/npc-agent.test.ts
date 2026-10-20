import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {validateSave,publicView} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpcVoteBatch,MAX_NPC_AGENT_CALLS_PER_TURN,
  recordSceneObservation} from '../src/agent/npc-agent.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {interpretSemanticEntry} from '../src/agent/semantic-entry.js';
import {applyNpcProposedAction} from '../src/agent/npc-agent.js';
import {executeAction} from '../src/core/runtime.js';

const decision=(kind:'speech'|'vote'|'no_action'|'proposed_action',overrides:Record<string,unknown>={})=>({
  kind,speech:kind==='speech'?'我不同意。':null,vote_target:kind==='vote'?'npc_A':null,
  intent:'根据自己知道的信息作出选择',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],
  decision_summary:'基于个人所知作出的决定',...overrides,
});
const hidden=()=>({id:'truth_killer',commitment:'HARD_TRUTH' as const,statement:'ULTIMATE_SECRET_A: npc_A is the killer',
  seed_constraint:null,source:'GM_DECLARED' as const,created_event_ref:null,evidence:[],known_by:['npc_A']});

async function fiveNpcFixture(generate:(request:import('../src/ai/contracts.js').AIRequest)=>Promise<unknown>){
  const f=await sparseSetup(generate as never),save=await f.service.current();
  const template=save.entities.find(entity=>entity.id==='npc_lin')!;
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const location=structuredClone(player.components.location);
  save.entities=save.entities.filter(entity=>entity.id!=='npc_lin');
  save.npc_agent_state={};
  for(const letter of ['A','B','C','D','E']){
    const id=`npc_${letter}`,entity=structuredClone(template);entity.id=id;entity.components.location=structuredClone(location);
    entity.components.identity.name=`人物 ${letter}`;save.entities.push(entity);
    const state=emptyNpcAgentState();
    if(letter==='A'){
      state.private_facts.push({id:'self_act',proposition:'我自己实施了那件事',source_ref:'personal_memory'});
      state.goals.push({id:'conceal',description:'隐藏自己的行为',horizon:'short',status:'active',origin:'self_act',priority:9});
    }
    if(letter==='B')state.knowledge.push({id:'evidence_1',proposition:'看见一双鞋',source_type:'observed',source_ref:'event_1',learned_at:save.runtime.time,confidence:0.9});
    if(letter==='C')state.knowledge.push({id:'evidence_3',proposition:'听到一段争执',source_type:'observed',source_ref:'event_3',learned_at:save.runtime.time,confidence:0.8});
    if(letter==='D')state.beliefs.push({id:'suspect_b',proposition:'B 最可疑',stance:'believed',confidence:0.8,evidence_refs:[],updated_at:save.runtime.time});
    save.npc_agent_state[id]=state;
  }
  save.gm_state.hidden_truth={version:1,commitments:[hidden()]};
  await f.store.write(validateSave(save));
  return f;
}

describe('autonomous NPC foundation',()=>{
  it('does not expose a remote NPC live location or an unseen remote item in the player projection',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    npc.components.location={location_id:'market'};
    const remoteItem=save.entities.find(entity=>entity.components.item&&entity.components.location?.location_id==='market');
    const view=publicView(save);
    expect(view.entities.find(entity=>entity.id===npc.id)?.components.location).toBeUndefined();
    if(remoteItem)expect(view.entities.some(entity=>entity.id===remoteItem.id)).toBe(false);
    npc.components.location=structuredClone(save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location);
    expect(publicView(save).entities.find(entity=>entity.id===npc.id)?.components.location).toEqual(npc.components.location);
  });
  it('uses the same compact stable persona with separate private cognition',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    npc.components.character={role:'学生',traits:[],personality:'好奇但谨慎',
      behavior_tendencies:['先提问再表态'],speech_style:'简短而礼貌',example_dialogues:['我能再确认一下吗？']};
    save.npc_agent_state={npc_lin:emptyNpcAgentState()};
    save.npc_agent_state.npc_lin.private_facts.push({id:'secret',proposition:'只属于自己的记忆',source_ref:null});
    const context=buildNpcAgentContext(save,'npc_lin',{kind:'direct_scene',description:'谈话'});
    expect(JSON.stringify(context.profile.persona)).toContain('先提问再表态');
    expect(JSON.stringify(context.profile.persona)).toContain('简短而礼貌');
    expect(JSON.stringify(context.profile.persona)).not.toContain('我能再确认一下吗？');
    expect(JSON.stringify(context.profile.persona).length).toBeLessThanOrEqual(1300);
    expect(JSON.stringify(context.private_facts)).toContain('只属于自己的记忆');
  });
  it('keeps old saves compatible and private state out of PublicView, with bounded roundtrip',async()=>{
    const f=await sparseSetup(),old=await f.service.current();
    expect(old.npc_agent_state).toBeUndefined();
    const loaded=validateSave(structuredClone(old));
    expect(loaded.npc_agent_state).toBeUndefined();
    loaded.npc_agent_state={npc_lin:emptyNpcAgentState()};
    loaded.npc_agent_state.npc_lin.private_facts.push({id:'own_secret',proposition:'SECRET_ONLY_NPC',source_ref:null});
    await f.store.write(validateSave(loaded));
    const reloaded=await f.service.current();
    expect(reloaded.npc_agent_state?.npc_lin.private_facts[0].proposition).toBe('SECRET_ONLY_NPC');
    expect(JSON.stringify(publicView(reloaded))).not.toContain('SECRET_ONLY_NPC');
    expect(reloaded.npc_agent_state?.npc_lin).not.toHaveProperty('relationships');
  });

  it('isolates five NPC contexts and makes five independent votes on one revision, then Undo restores cognition',async()=>{
    const prompts:string[]=[],revisions:number[]=[];
    const f=await fiveNpcFixture(async request=>{
      if(request.role!=='npc_decision')throw Error('unexpected model role');
      prompts.push(request.prompt);
      const npc=request.prompt.match(/"npc_id":"(npc_[A-E])"/)?.[1];
      expect(npc).toBeTruthy();
      const revision=Number(request.prompt.match(/"revision":(\d+)/)?.[1]);revisions.push(revision);
      const evidence=npc==='npc_B'?['evidence_1']:npc==='npc_C'?['evidence_3']:npc==='npc_A'?['self_act']:[];
      return {data:decision('vote',{vote_target:npc==='npc_D'?'npc_B':'npc_A',evidence_refs:evidence,
        belief_updates:npc==='npc_D'?[{id:'suspect_b',proposition:'B 最可疑',stance:'believed',confidence:0.7,evidence_refs:[]}]:[],
        decision_summary:`${npc} 作了自己的判断`})};
    });
    const before=await f.service.current(),revision=before.state_revision;
    const result=await decideNpcVoteBatch(f.service,randomUUID(),['npc_A','npc_B','npc_C','npc_D','npc_E'],
      ['npc_A','npc_B','npc_C','npc_D','npc_E'],'根据各自掌握的证据投票');
    expect(result.status).toBe('committed');expect(result.decisions).toHaveLength(5);
    expect(prompts).toHaveLength(5);expect(new Set(revisions)).toEqual(new Set([revision]));
    expect(prompts.every(prompt=>!prompt.includes('ULTIMATE_SECRET_A'))).toBe(true);
    expect(prompts.find(prompt=>prompt.includes('"npc_id":"npc_A"'))).toContain('self_act');
    expect(prompts.find(prompt=>prompt.includes('"npc_id":"npc_B"'))).not.toContain('self_act');
    expect(prompts.find(prompt=>prompt.includes('"npc_id":"npc_E"'))).not.toContain('evidence_1');
    const after=validateSave(await f.store.read());
    expect(after.state_revision).toBe(revision+1);
    expect(after.npc_agent_state?.npc_D.beliefs[0].proposition).toBe('B 最可疑');
    expect(after.gm_state.hidden_truth?.commitments[0].statement).toContain('npc_A is the killer');
    expect(after.runtime.receipts.at(-1)?.revision).toBe(after.state_revision);
    await f.service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
    const undone=await f.service.current();
    expect(undone.npc_agent_state?.npc_D.last_decisions).toEqual([]);
    expect(undone.npc_agent_state?.npc_D.beliefs[0].confidence).toBe(0.8);
  });

  it('rejects invented evidence before voting commits and pauses cleanly at the call budget',async()=>{
    const f=await fiveNpcFixture(async()=>({data:decision('vote',{evidence_refs:['hidden_evidence']})}));
    const before=await f.service.current();
    await expect(decideNpcVoteBatch(f.service,randomUUID(),['npc_A','npc_B'],['npc_A','npc_B'],'投票')).rejects.toThrow(/evidence/);
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
    const paused=await decideNpcVoteBatch(f.service,randomUUID(),Array.from({length:MAX_NPC_AGENT_CALLS_PER_TURN+1},(_,i)=>`voter_${i}`),
      ['npc_A'],'投票');
    expect(paused.status).toBe('paused');expect((await f.service.current()).state_revision).toBe(before.state_revision);
    expect(f.calls.filter(call=>call.role==='npc_decision').length).toBe(2);
  });

  it('shares only witnessed speech in event order and keeps private facts and distant NPCs isolated',async()=>{
    const f=await fiveNpcFixture(async()=>{throw Error('no model expected')});
    const save=await f.service.current();
    save.entities.find(entity=>entity.id==='npc_C')!.components.location.location_id='station';
    const sceneId=randomUUID();
    save.narrative_history=[{request_id:sceneId,narrative:'两人说话。',dialogue:null,speaker:null,facts:[],
      speech_events:[{speaker_id:'npc_A',utterance:'钥匙在仓库。',provenance:'npc_response',source_intent:null}],
      player_input:'',revision:save.state_revision,time:save.runtime.time,location_id:String(save.entities.find(e=>e.id==='player')!.components.location.location_id)}];
    recordSceneObservation(save,sceneId,[{speaker_id:'npc_A',utterance:'钥匙在仓库。'}]);
    const b=buildNpcAgentContext(save,'npc_B',{kind:'direct_scene',description:'谈话'});
    const c=buildNpcAgentContext(save,'npc_C',{kind:'direct_scene',description:'谈话'});
    expect(JSON.stringify(b.memories)).toContain('钥匙在仓库');
    expect(JSON.stringify(c)).not.toContain('钥匙在仓库');
    // The witness gains sourced hearsay; the absent NPC gains nothing at all.
    expect(save.npc_agent_state?.npc_B.knowledge.map(item=>item.id))
      .toEqual(['evidence_1',`heard:${sceneId}:npc_A`]);
    expect(save.npc_agent_state?.npc_B.knowledge.at(-1))
      .toMatchObject({source_type:'told_by',source_ref:'npc_A',confidence:0.4});
    expect(save.npc_agent_state?.npc_C.knowledge).toEqual([
      {id:'evidence_3',proposition:'听到一段争执',source_type:'observed',source_ref:'event_3',
        learned_at:save.runtime.time,confidence:0.8}]);
    expect(JSON.stringify(b)).not.toContain('ULTIMATE_SECRET_A');
    expect(JSON.stringify(b)).not.toContain('我自己实施了那件事');
    expect(JSON.stringify(buildNpcAgentContext(save,'npc_A',{kind:'direct_scene',description:'谈话'}))).toContain('我自己实施了那件事');
  });

  it('uses an independent decision in a significant Natural Scene and rejects composer rewrites',async()=>{
    const calls:string[]=[];
    const f=await sparseSetup(async request=>{
      calls.push(request.role);
      if(request.role==='npc_decision')return {data:decision('speech',{speech:'我自己会决定。'})};
      if(request.prompt.includes('fixed_npc_decision'))return {data:{understanding:'对话',narrative:'他回应了。',dialogue:'我自己会决定。',
        speech_events:[{speaker_id:'npc_lin',utterance:'我自己会决定。',provenance:'npc_response'}],effects:[]}};
      throw Error('unexpected call');
    });
    const seed=await f.service.current(),player=seed.entities.find(e=>e.id==='player')!,npc=seed.entities.find(e=>e.id==='npc_lin')!;
    npc.components.location=structuredClone(player.components.location);
    seed.npc_agent_state={npc_lin:emptyNpcAgentState()};
    seed.npc_agent_state.npc_lin.private_facts.push({id:'own_secret',proposition:'自己的私事',source_ref:null});
    await f.store.write(seed);
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:seed.game_id,
      expected_revision:seed.state_revision,input:'你怎么决定？'},undefined,null,false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'} as never);
    expect(calls).toContain('npc_decision');expect(result.message).toContain('我自己会决定');
    const after=await f.service.current();
    expect(after.npc_agent_state?.npc_lin.last_decisions).toHaveLength(1);
    expect(after.narrative_history?.at(-1)?.speech_events?.[0].utterance).toBe('我自己会决定。');
    expect(after.resolution_receipts?.some(receipt=>receipt.semantic_action==='TALK')).toBeFalsy();
  });

  it('settles an NPC move and scene memory in one Core-backed Undo unit',async()=>{
    let destination='';
    const f=await sparseSetup(async request=>request.role==='npc_decision'
      ?{data:decision('proposed_action',{proposed_action:{type:'MOVE',target_id:destination,reason:'自己选择离开'}})}
      :{data:{understanding:'离开现场',narrative:'他转身离开。',dialogue:null,speech_events:[],effects:[]}});
    const before=await f.service.current();
    const player=before.entities.find(e=>e.id==='player')!,npc=before.entities.find(e=>e.id==='npc_lin')!;
    npc.components.location=structuredClone(player.components.location);
    before.npc_agent_state={npc_lin:emptyNpcAgentState()};
    before.npc_agent_state.npc_lin.private_facts.push({id:'self',proposition:'自己有事要走',source_ref:null});
    await f.store.write(before);
    destination=before.definition.map!.routes.find(route=>route.from===player.components.location.location_id)?.to??'';
    expect(destination).toBeTruthy();
    await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
      input:'你现在想做什么？'},undefined,null,false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'} as never);
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.entities.find(e=>e.id===npc.id)?.components.location.location_id).toBe(destination);
    expect(after.entities.find(e=>e.id==='player')?.components.location.location_id).toBe(player.components.location.location_id);
    expect(after.resolution_receipts?.at(-1)).toMatchObject({actor_id:npc.id,semantic_action:'MOVE',commit_status:'committed'});
    expect(after.npc_agent_state?.npc_lin.last_decisions).toHaveLength(1);
    await f.service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
    const undone=await f.service.current();
    expect(undone.entities.find(e=>e.id===npc.id)?.components.location.location_id).toBe(player.components.location.location_id);
    expect(undone.npc_agent_state?.npc_lin.last_decisions).toEqual([]);
  });

  it('does not turn a missing player choice into a scene assertion even when an NPC is in front',async()=>{
    const f=await sparseSetup(async request=>{
      expect(request.prompt).not.toContain('ULTIMATE_SECRET_A');
      return {data:{domain:'ambiguous',kind:'clarification',confidence:0.9,answer:null,answer_basis:null,
        evidence_ids:[],clarification:'你要指认哪一位候选人？',clarification_cause:'missing_player_choice',
        speech_target_id:null,interaction_lane:null,player_speech_mode:null,temporal_wait:null,open_goal_context:null}};
    });
    const save=await f.service.current(),player=save.entities.find(e=>e.id==='player')!;
    save.entities.find(e=>e.id==='npc_lin')!.components.location=structuredClone(player.components.location);
    save.gm_state.hidden_truth={version:1,commitments:[hidden()]};
    await f.store.write(save);
    const decision=await interpretSemanticEntry(f.service,f.service.project(save),'我根据已有线索指出真正的凶手。','WORLD');
    expect(decision?.kind).toBe('clarification');
    expect(decision?.clarification).toContain('哪一位');
    expect((await f.service.current()).state_revision).toBe(save.state_revision);
    expect(f.calls.filter(call=>call.role==='npc_decision')).toHaveLength(0);
  });

  it('rejects a Scene Composer rewrite before committing the NPC decision',async()=>{
    const f=await sparseSetup(async request=>request.role==='npc_decision'
      ?{data:decision('speech',{speech:'我拒绝。'})}
      :{data:{understanding:'对话',narrative:'他答应了。',dialogue:'我答应。',
        speech_events:[{speaker_id:'npc_lin',utterance:'我答应。',provenance:'npc_response'}],effects:[]}});
    const save=await f.service.current(),player=save.entities.find(e=>e.id==='player')!,npc=save.entities.find(e=>e.id==='npc_lin')!;
    npc.components.location=structuredClone(player.components.location);
    save.npc_agent_state={npc_lin:emptyNpcAgentState()};
    save.npc_agent_state.npc_lin.goals.push({id:'own_goal',description:'自主决定',horizon:'short',status:'active',origin:'self',priority:5});
    await f.store.write(save);
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:save.game_id,
      expected_revision:save.state_revision,input:'你愿意吗？'},undefined,null,false,
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'} as never);
    expect(result.outcome?.type).toBe('engine_failure');
    expect((await f.service.current()).state_revision).toBe(save.state_revision);
    expect((await f.service.current()).npc_agent_state?.npc_lin.last_decisions).toEqual([]);
  });

  it('leaves unsupported persistent proposals uncommitted and does not call NPC models per background tick',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const unsupported=applyNpcProposedAction(structuredClone(before),randomUUID(),'npc_lin',
      {type:'CREATE_ITEM',target_id:null,reason:'想凭空获得物品'});
    expect(unsupported.settled).toBe(false);
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
    let world=before;
    for(let i=0;i<4;i++)world=executeAction(world,{type:'WAIT',parameters:{minutes:60}},randomUUID(),'player',undefined,undefined,false).save;
    expect(world.runtime.time.minute).toBe(before.runtime.time.minute+240);
    expect(f.calls.filter(call=>call.role==='npc_decision')).toHaveLength(0);
  });
});

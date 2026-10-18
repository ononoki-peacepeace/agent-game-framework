import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { handleAgentInput } from '../src/agent/executor.js';
import { validateSave } from '../src/core/state.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SceneStory} from '../src/client/SceneStory.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {sceneEnsembleContext,validateSoftContacts,sceneResultSchema} from '../src/agent/scene-interaction.js';
import {agentPresentation} from '../src/client/agent-presentation.js';

type Semantic = { kind: 'world_action'; interaction_lane: 'natural_scene' | 'world_transaction' | 'open_goal'; player_speech_mode?:'none'|'verbatim'|'intent' };
const sceneReply = (narrative: string, dialogue: string | null, effects: unknown[] = []) => ({ data: { understanding: '普通场景交流', narrative, dialogue,
  speech_events:dialogue?[{speaker_id:'npc_lin',utterance:dialogue,provenance:'npc_response'}]:[], effects } });

async function sceneFixture(script: (input: string, count: number, prompt: string) => unknown) {
  let sceneCalls = 0;
  const f = await sparseSetup(async request => {
    const properties = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if(properties.domain)return {data:{domain:'world',kind:'world_action',confidence:.98,
      answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
      interaction_lane:'natural_scene',player_speech_mode:request.prompt.includes('我当着他们')?'intent':'verbatim'}} as never;
    if(properties.authorized)return {data:{authorized:request.prompt.includes('那我先走了'),
      explanation:'只核对玩家原始授权。'}} as never;
    if(properties.verdict)return {data:{verdict:request.prompt.includes('我要杀了你')?'drift':'aligned',explanation:'核对已授权意图。'}} as never;
    // The executor also verifies that the settled action still preserves the original request.
    if(properties.preserved)return {data:{preserved:true,reason:'与原请求一致。'}} as never;
    if (properties.understanding) {
      sceneCalls += 1;
      const encoded = request.prompt.match(/"player_input":("(?:[^"\\]|\\.)*")/)?.[1] ?? '""';
      return script(JSON.parse(encoded) as string, sceneCalls, request.prompt) as never;
    }
    if (request.role === 'narrator') return { data: { narrative: '你照做了。', speaker: null, dialogue: null, choices: [], patches: [] } } as never;
    throw new Error('unexpected AI call');
  });
  const save = await f.service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
  npc.components.location = structuredClone(player.components.location);
  await f.store.write(save);
  return { f, npcId: npc.id, sceneCalls: () => sceneCalls };
}
const say = async (f: { service: Parameters<typeof handleAgentInput>[0] }, input: string, semantic?: Semantic) => {
  const before = await f.service.current();
  return handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input }, undefined, null, false, semantic as never);
};
const count = (save: { resolution_receipts?: unknown[] }) => save.resolution_receipts?.length ?? 0;

describe('natural scene interaction routing', () => {
  it('repairs an uncommitted NPC departure instead of making the scene list follow invented narration',async()=>{
    const {f,npcId,sceneCalls}=await sceneFixture((input,count)=>({data:{understanding:'确认当前人物',
      narrative:count===1?'林舟跨过门槛，离开了这里。':'林舟仍在原地，转头回应。',dialogue:'我在这里。',
      speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:'我在这里。',provenance:'npc_response'}],effects:[]}}));
    const before=await f.service.current();
    const result=await say(f,'你还在这里吗？',
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(sceneCalls()).toBe(2);expect(result.message).not.toContain('跨过门槛');
    expect(after.entities.find(entity=>entity.id===npcId)?.components.location)
      .toEqual(before.entities.find(entity=>entity.id===npcId)?.components.location);
    expect(after.state_revision).toBe(before.state_revision+1);
  });
  it('persists an NPC own departure plan, then uses a later authoritative MOVE and restores it with Undo',async()=>{
    const {f,npcId}=await sceneFixture(input=>({data:{understanding:'散会后的打算',
      narrative:'对方决定稍后离开。',dialogue:'我去市场看看。',speech_events:[
        {speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:npcId,utterance:'我去市场看看。',provenance:'npc_response'}],effects:[],
      npc_activity_intents:[{npc_id:npcId,speech_index:1,destination_id:'market',
        readiness:'ready',condition:null,plan_id:null}]}}));
    await say(f,'散会后你有什么打算？',
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const planned=await f.service.current();
    expect(planned.entities.find(item=>item.id===npcId)?.components.location?.location_id).toBe('square');
    expect(planned.npc_agent_state?.[npcId]?.plans.some(plan=>plan.status==='active'&&
      plan.activity?.destination_id==='market')).toBe(true);
    await f.service.turn({request_id:randomUUID(),game_id:planned.game_id,
      expected_revision:planned.state_revision,action:{type:'WAIT',parameters:{minutes:7}}});
    const moved=await f.service.current();
    expect(moved.entities.find(item=>item.id===npcId)?.components.location?.location_id).toBe('market');
    expect(moved.resolution_receipts?.filter(receipt=>receipt.actor_id===npcId&&
      receipt.semantic_action==='MOVE'&&receipt.commit_status==='committed')).toHaveLength(1);
    await f.service.undo({request_id:randomUUID(),game_id:moved.game_id,expected_revision:moved.state_revision});
    const undone=await f.service.current();
    expect(undone.runtime.time).toEqual(planned.runtime.time);
    expect(undone.entities.find(item=>item.id===npcId)?.components.location?.location_id).toBe('square');
    expect(undone.npc_agent_state?.[npcId]?.plans.some(plan=>plan.status==='active'&&plan.activity)).toBe(true);
  });
  it('accumulates short exchanges and settles a group discussion through the world clock once',async()=>{
    const {f,npcId}=await sceneFixture(input=>{
      const speeches=[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        ...Array.from({length:8},(_,index)=>({speaker_id:npcId,
          utterance:`第${index+1}位回应者说明自己目前观察到的情况，并提出还需要核对的具体问题。`,provenance:'npc_response'}))];
      return {data:{understanding:'多人现场讨论',narrative:'众人在大厅依次交换意见。',
        dialogue:speeches.at(-1)!.utterance,speech_events:speeches,effects:[]}};
    });
    const before=await f.service.current();
    await say(f,'好。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const short=await f.service.current();
    expect(short.runtime.scene_seconds).toBeGreaterThan(0);
    const longInput='我先说明目前已经确认的现场情况，并请大家依次讲出自己的观察、疑问和接下来的安排。'.repeat(6);
    await say(f,longInput,{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='NATURAL_SCENE_TIME'
      &&receipt.commit_status==='committed').length).toBe(2);
    expect(after.state_revision).toBe(before.state_revision+2);
    expect(after.narrative_history?.at(-1)?.speech_events).toHaveLength(9);
  });
  it('runs existing time events and restores both clock and event on Undo',async()=>{
    const {f,npcId}=await sceneFixture(input=>({data:{understanding:'讨论安排',narrative:'两人认真交换安排。',
      dialogue:'我听到了，我们再核对一次。',speech_events:[
        {speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:npcId,utterance:'我听到了，我们再核对一次。',provenance:'npc_response'}],effects:[]}}));
    const before=await f.service.current();
    before.definition.events.push({id:'meeting_clock_event',hook:'on_time_advance',location_id:null,
      probability:1,once:true,public_text:'',set_flag:'meeting_clock_fired'});
    await f.store.write(before);
    await say(f,'我们需要把已经知道的情况逐项说明，再一起确认接下来的安排。'.repeat(12),
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(after.gm_state.flags.meeting_clock_fired).toBe(true);
    expect(after.resolution_receipts?.at(-1)).toMatchObject({semantic_action:'NATURAL_SCENE_TIME',
      commit_status:'committed'});
    await f.service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
    const undone=await f.service.current();
    expect(undone.runtime.time).toEqual(before.runtime.time);
    expect(undone.gm_state.flags.meeting_clock_fired).toBeUndefined();
    expect(undone.runtime.scene_seconds??0).toBe(before.runtime.scene_seconds??0);
  });
  it('settles an ordinary conversation and shows the NPC reply as one scene result',async()=>{
    const {f,npcId}=await sceneFixture(input=>({data:{understanding:'普通场景交流',
      narrative:'对方转身听你说话。',dialogue:'今天还算平静。',speech_events:[
        {speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:npcId,utterance:'今天还算平静。',provenance:'npc_response'}],effects:[]}}));
    const before=await f.service.current();
    const result=await say(f,'你好，今天过得怎么样？',
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.narrative_history?.at(-1)?.speech_events?.some(event=>
      event.speaker_id===npcId&&event.utterance==='今天还算平静。')).toBe(true);
    expect(agentPresentation(f.service.project(before),result).agentReply).toBeNull();
    expect(result.message).toContain('今天还算平静。');
  });
  it('persists a spoken NPC relay commitment through the scene transaction',async()=>{
    const {f,npcId}=await sceneFixture(input=>({data:{understanding:'人物接受委托',
      narrative:'他听完后答应帮忙传话。',dialogue:'我去通知。',speech_events:[
        {speaker_id:'player',utterance:'请帮我通知乔宁来广场。',provenance:'generated_from_player_intent'},
        {speaker_id:npcId,utterance:'我去通知。',provenance:'npc_response'}],effects:[],
      social_commitments:[{npc_id:npcId,speech_index:1,kind:'relay',status:'accepted',
        message:'请乔宁到广场集合',organizer_id:'player',activity_location_id:'square',
        activity_at:{day:1,minute:1200},destination_ids:['station'],recipient_ids:[],condition:null}]}}));
    const before=await f.service.current();
    const result=await say(f,'请你帮我通知乔宁来广场。',
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'});
    const after=await f.service.current();
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.npc_agent_state?.[npcId]?.social_tasks).toMatchObject([
      {kind:'relay',status:'active',destination_ids:['station'],activity_location_id:'square'}]);
  });
  it.each([
    ['declined','cancelled',null],
    ['conditional','blocked','先完成手头的事'],
  ] as const)('settles an NPC %s to relay without forcing acceptance',async(status,stored,condition)=>{
    const {f,npcId}=await sceneFixture(()=>({data:{understanding:'人物自主回应委托',
      narrative:'他听完请求后作出回应。',dialogue:status==='declined'?'我不去。':'我得先忙完。',
      speech_events:[{speaker_id:'player',utterance:'请你通知乔宁到广场集合。',
        provenance:'generated_from_player_intent'},
        {speaker_id:npcId,utterance:status==='declined'?'我不去。':'我得先忙完。',
        provenance:'npc_response'}],effects:[],social_commitments:[{
          npc_id:npcId,speech_index:1,kind:'relay',status,
          message:'通知乔宁到广场集合',organizer_id:'player',activity_location_id:'square',
          activity_at:{day:1,minute:1200},destination_ids:['station'],recipient_ids:[],condition,
        }]}}));
    const before=await f.service.current();
    const result=await say(f,'请你通知乔宁到广场集合，可以吗？',
      {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'});
    const after=await f.service.current();
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.npc_agent_state?.[npcId]?.social_tasks[0]).toMatchObject({status:stored,condition});
    expect(after.state_revision).toBe(before.state_revision+1);
  });
  it('keeps a conversation while an authorized room inspection settles with no discovery',async()=>{
    const {f,npcId}=await sceneFixture((input)=>({data:{understanding:'交谈并检查现场',
      narrative:'你边说边留意周围。',dialogue:'我在听。',speech_events:[
        {speaker_id:'player',utterance:'我想边聊边看看这里。',provenance:'generated_from_player_intent'},
        {speaker_id:npcId,utterance:'我在听。',provenance:'npc_response'}],
      effects:[{kind:'inspect',source_quote:'仔细检查房间'}]}}));
    const ai=f.ai;
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'你检查了房间。',minutes:3,target_id:null,
      facts:[],relationship:null,required_conditions:[],blocker:null,resolution:{type:'DETERMINISTIC',
        domain:'investigation',band:'normal',visibility:'public',stakes:'检查当前房间',stages:[],
        evidence_ids:[],discover_facts:true}} as never);
    vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你检查了房间，没有发现新的线索。',speaker:null,
      dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],
      stable_locations:[],mechanical_claims:[]} as never);
    vi.spyOn(ai,'systemAgent').mockImplementation(async(schema)=>{
      const properties=(await import('zod')).z.toJSONSchema(schema).properties as Record<string,unknown>;
      if(properties.authorized)return {authorized:true,explanation:'玩家明确要求调查'} as never;
      if(properties.verdict)return {verdict:'aligned',explanation:'玩家授权说话'} as never;
      if(properties.grounded)return {grounded:true,reports_result:true,reason:'与凭据一致',unsupported_claims:[]} as never;
      return {preserved:true,reason:'符合原目标'} as never;
    });
    const before=await f.service.current(),input='一边和她聊天，一边仔细检查房间';
    const result=await say(f,input,{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'});
    const after=await f.service.current();
    expect(result.message).toContain('我在听');
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+3);
    expect(after.resolution_receipts?.some(receipt=>receipt.commit_status==='committed'&&
      receipt.canonical_facts.includes('你进行了观察或搜索，在这次检查范围内没有发现明显异常或新的线索。'))).toBe(true);
    expect(after.narrative_history?.some(entry=>entry.speech_events?.some(event=>event.speaker_id===npcId))).toBe(true);
    expect(result.message).toContain('我在听');
    expect(result.story).toContain('没有发现');
    expect(agentPresentation(f.service.project(before),result).storyOverride?.text).toContain('没有发现');
  });
  it('keeps accepted, continued and released ordinary contact across committed scene turns',async()=>{
    const {f,npcId}=await sceneFixture((input)=>({data:{understanding:'人物自然接触',narrative:'对方对你的接近作出了自己的反应。',
      dialogue:null,speech_events:[],effects:[],soft_contacts:[{npc_id:npcId,
        action:input.includes('继续')?'continue':input.includes('松开')?'release':'attempt',
        result:input.includes('松开')?'ended':'active',description:'短暂拥抱',source_quote:input}]}}));
    const semantic={kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'} as const;
    for(const [input,status] of [['我试着拥抱对方','active'],['我继续保持拥抱','active'],['我慢慢松开','ended']] as const){
      const before=await f.service.current();
      const result=await say(f,input,semantic);
      const after=await f.service.current();
      expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
      expect(agentPresentation(f.service.project(before),result).agentReply).toBeNull();
      expect(after.state_revision).toBe(before.state_revision+1);
      expect(after.npc_agent_state?.[npcId]?.contact_state?.status).toBe(status);
      expect(validateSave(after).npc_agent_state?.[npcId]?.contact_state?.status).toBe(status);
    }
  });
  it('does not promote a refused contact into an already ongoing one',async()=>{
    const {f,npcId}=await sceneFixture(()=>({data:{understanding:'人物拒绝接触',narrative:'对方避开了。',
      dialogue:null,speech_events:[],effects:[]}}));
    const save=await f.service.current();
    const refused=sceneResultSchema.parse({understanding:'拒绝',narrative:'对方避开了。',dialogue:null,
      speech_events:[],effects:[],soft_contacts:[{npc_id:npcId,action:'attempt',result:'refused',
        description:'拥抱',source_quote:'拥抱'}]});
    const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id;
    save.npc_agent_state??={};save.npc_agent_state[npcId]={...emptyNpcAgentState(),contact_state:{status:'refused',
      description:'拥抱',location_id:String(here),source_request_id:randomUUID(),recorded_revision:save.state_revision}};
    expect(()=>validateSoftContacts(refused,'拥抱',save,[npcId])).not.toThrow();
    const invented={...refused,soft_contacts:[{npc_id:npcId,action:'continue' as const,result:'active' as const,
      description:'拥抱',source_quote:'继续拥抱'}]};
    expect(()=>validateSoftContacts(invented,'继续拥抱',save,[npcId])).toThrow('接触状态');
    expect(()=>validateSoftContacts(invented,'继续拥抱',save,[])).toThrow('接触状态');
  });
  it('keeps repeated NPC turns in model order while other present NPCs stay silent',async()=>{
    const {f,npcId,sceneCalls}=await sceneFixture((input)=>({data:{understanding:'多人现场',narrative:'交谈起了波澜。',
      dialogue:'那就先等等。',speech_events:[
        {speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:npcId,utterance:'我听见了。',provenance:'npc_response'},
        {speaker_id:'npc_peer',utterance:'我不同意。',provenance:'npc_response'},
        {speaker_id:npcId,utterance:'你为什么这么想？',provenance:'npc_response'},
        {speaker_id:'npc_peer',utterance:'因为门还锁着。',provenance:'npc_response'},
        {speaker_id:npcId,utterance:'那就先等等。',provenance:'npc_response'}],
      beats:[{kind:'speech',speech_index:0},{kind:'speech',speech_index:1},
        {kind:'speech',speech_index:2},{kind:'speech',speech_index:3},
        {kind:'speech',speech_index:4},{kind:'speech',speech_index:5}],effects:[]}}));
    const save=await f.service.current(),first=save.entities.find(entity=>entity.id===npcId)!;
    for(const id of ['npc_peer','npc_silent_1','npc_silent_2']){
      const copy=structuredClone(first);copy.id=id;copy.components.identity.name=id;
      save.entities.push(copy);save.npc_agent_state={...save.npc_agent_state,[id]:emptyNpcAgentState()};
    }
    await f.store.write(validateSave(save));
    const result=await say(f,'你们怎么看？',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(sceneCalls()).toBe(1);
    expect(after.narrative_history?.at(-1)?.speech_events?.map(event=>event.speaker_id)).toEqual([
      'player',npcId,'npc_peer',npcId,'npc_peer',npcId]);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    const html=renderToStaticMarkup(createElement(SceneStory,{view:f.service.project(after),override:null,onSelectEntity:()=>{}}));
    expect(html.match(/scene-beat-speech/g)).toHaveLength(6);
    expect(html).not.toContain('npc_silent_1');
    expect(html).not.toContain('npc_silent_2');
  });
  it('continues one dense valid scene once without repeating speech or settling another action',async()=>{
    const prompts:string[]=[];
    const {f,npcId,sceneCalls}=await sceneFixture((input,count,prompt)=>{
      prompts.push(prompt);
      const speech_events=count===1?[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        ...Array.from({length:7},(_,index)=>({speaker_id:npcId,utterance:`第${index+1}句`,provenance:'npc_response'}))]:
        [{speaker_id:npcId,utterance:'第8句',provenance:'npc_response'},
          {speaker_id:npcId,utterance:'第9句',provenance:'npc_response'}];
      return {data:{understanding:'继续现场交流',narrative:count===1?'先前的交谈。':'交谈自然停下。',
        dialogue:count===1?'第7句':'第9句',speech_events,
        beats:speech_events.map((_,speech_index)=>({kind:'speech',speech_index})),
        continuation:count===1?'scene_continues':'complete',effects:[],travel_intents:[]}};
    });
    const before=await f.service.current();
    const result=await say(f,'你们怎么看？',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=validateSave(await f.service.current());
    expect(sceneCalls()).toBe(2);
    expect(prompts[1]).toContain('prior_fragment');
    expect(prompts[1]).toContain('第7句');
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(after.last_turn?.scene_beats?.filter(beat=>beat.kind==='speech').map(beat=>beat.utterance))
      .toEqual(['你们怎么看？',...Array.from({length:9},(_,index)=>`第${index+1}句`)]);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    const html=renderToStaticMarkup(createElement(SceneStory,{view:f.service.project(after),override:null,onSelectEntity:()=>{}}));
    expect(html.match(/第7句/g)).toHaveLength(1);
    expect(html.match(/第8句/g)).toHaveLength(1);
  });
  it('ends a dense scene at a player decision without an extra continuation call',async()=>{
    const {f,npcId,sceneCalls}=await sceneFixture((input)=>({data:{understanding:'等待玩家',narrative:'他们都望向你。',
      dialogue:'你决定吧。',speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        ...Array.from({length:7},(_,index)=>({speaker_id:npcId,utterance:index===6?'你决定吧。':`补充${index}`,
          provenance:'npc_response'}))],continuation:'await_player',effects:[]}}));
    await say(f,'你们怎么看？',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    expect(sceneCalls()).toBe(1);
  });
  it('records explicit NPC travel consent as an intention without moving anyone in the conversation',async()=>{
    const {f,npcId}=await sceneFixture(()=>({data:{understanding:'邀请一同出发',
      narrative:'他看向通往外面的路。',dialogue:'好，我一起去。',
      speech_events:[{speaker_id:npcId,utterance:'好，我一起去。',provenance:'npc_response'}],
      effects:[],travel_intents:[{npc_id:npcId,status:'willing'}]}}));
    const before=await f.service.current();
    await say(f,'要不要和我一起去附近看看？',{kind:'world_action',interaction_lane:'natural_scene'});
    const after=await f.service.current();
    expect(after.npc_agent_state?.[npcId].travel_intent).toMatchObject({status:'willing',
      source_request_id:expect.any(String),recorded_revision:after.state_revision});
    expect(after.entities.find(entity=>entity.id===npcId)?.components.location?.location_id)
      .toBe(before.entities.find(entity=>entity.id===npcId)?.components.location?.location_id);
    expect(after.runtime.time).toEqual(before.runtime.time);
  });
  it('repairs one uncommitted scene proposal and records only the valid scene beat',async()=>{
    const {f,sceneCalls}=await sceneFixture((_input,count)=>count===1?
      {data:{understanding:'注视',narrative:'他听见你告白。',dialogue:null,
        speech_events:[{speaker_id:'player',utterance:'我喜欢你。',provenance:'generated_from_player_intent'}],effects:[]}}:
      {data:{understanding:'注视',narrative:'你看着眼前的人。',dialogue:'怎么了？',
        speech_events:[{speaker_id:'npc_lin',utterance:'怎么了？',provenance:'npc_response'}],effects:[]}});
    const before=await f.service.current();
    const result=await say(f,'我看着他。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'});
    const after=await f.service.current();
    expect(sceneCalls()).toBe(2);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.narrative_history?.at(-1)?.player_input).toBe('我看着他。');
    expect(after.narrative_history?.at(-1)?.speech_events?.some(event=>event.speaker_id===after.player_state.entity_id)).toBe(false);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('provides distinct bounded persona contexts to one ordinary scene call',async()=>{
    const prompts:string[]=[];
    const {f,npcId,sceneCalls}=await sceneFixture((_input,_count,prompt)=>{
      prompts.push(prompt);return sceneReply('两人各自回应。','我听见了。');
    });
    const save=await f.service.current(),first=save.entities.find(entity=>entity.id===npcId)!;
    first.components.character={role:'学生',traits:[],personality:'活泼好奇',
      behavior_tendencies:['主动开启话题'],speech_style:'随意、快速',example_dialogues:['今天有新书吗？']};
    const second=structuredClone(first);second.id='npc_reserved';second.components.identity.name='谨慎的人';
    second.components.character={role:'研究员',traits:[],personality:'谨慎内敛',
      behavior_tendencies:['先确认事实'],speech_style:'正式、简短',example_dialogues:['先核实一下。']};
    save.entities.push(second);await f.store.write(save);
    await say(f,'今天怎么样？',{kind:'world_action',interaction_lane:'natural_scene'});
    expect(sceneCalls()).toBe(1);
    expect(prompts[0]).toContain('主动开启话题');expect(prompts[0]).toContain('随意、快速');
    expect(prompts[0]).toContain('先确认事实');expect(prompts[0]).toContain('正式、简短');
    expect(prompts[0]).not.toContain('今天有新书吗？');
    expect(prompts[0]).not.toContain('先核实一下。');
    expect(prompts[0]).toContain('人格、价值和说话习惯影响角色当下选择');
    expect(prompts[0]).toContain('dialogue_output_instruction');
    expect(prompts[0]).toContain('以整个现场而非逐句问答组织 beats');
    expect(prompts[0]).toContain('人物原本正在做的事');
    expect(prompts[0]).toContain('这些仍须 effects 提案及程序结算');
    expect(prompts[0]).toContain('不以完整解决玩家问题为目标');
    expect(prompts[0]).not.toContain('Framework example system.guidance');
  });
  it('provides actor-scoped ensemble context and records NPC-to-NPC exchange in one scene call',async()=>{
    const prompts:string[]=[];
    const {f,npcId,sceneCalls}=await sceneFixture((_input,_count,prompt)=>{
      prompts.push(prompt);
      return {data:{understanding:'场景中的交谈',narrative:'两人短暂交谈。',dialogue:'我刚才也看见了。',
        speech_events:[{speaker_id:'player',utterance:'那边发生了什么？',provenance:'verbatim_player_input'},
          {speaker_id:npcId,utterance:'你也看到了？',provenance:'npc_response'},
          {speaker_id:'npc_peer',utterance:'我刚才也看见了。',provenance:'npc_response'}],
        beats:[{kind:'speech',speech_index:0},{kind:'speech',speech_index:1},
          {kind:'narration',text:'另一人转向他。'},{kind:'speech',speech_index:2}],effects:[]}};
    });
    const save=await f.service.current(),first=save.entities.find(entity=>entity.id===npcId)!;
    const peer=structuredClone(first);peer.id='npc_peer';peer.components.identity.name='旁边的人';
    peer.components.world_resident={origin_incident_id:'origin',entrance_reason:'在场',created_at:{day:0,minute:0},
      entered_world_at:{day:0,minute:0},importance:'minor',lifecycle:'active',home_location_id:null,
      motivation:'想弄清刚才的动静'};
    peer.components.relationships={entries:{[npcId]:{trust:40}}};
    save.entities.push(peer);
    save.npc_agent_state={...save.npc_agent_state,[npcId]:emptyNpcAgentState(),npc_peer:emptyNpcAgentState()};
    save.npc_agent_state.npc_peer.knowledge.push({id:'seen',proposition:'亲眼看见有人经过',
      source_type:'observed',source_ref:null,learned_at:save.runtime.time,confidence:.8});
    await f.store.write(validateSave(save));
    const before=await f.service.current();
    const result=await say(f,'那边发生了什么？',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(sceneCalls()).toBe(1);
    expect(prompts[0]).toContain('想弄清刚才的动静');
    expect(prompts[0]).toContain('亲眼看见有人经过');
    expect(prompts[0]).toContain('"other_id":"'+npcId+'"');
    expect(prompts[0]).toContain('NPC 可以对 NPC 说话');
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(after.narrative_history?.at(-1)?.speech_events?.map(event=>event.speaker_id))
      .toEqual(['player',npcId,'npc_peer']);
    const html=renderToStaticMarkup(createElement(SceneStory,{view:f.service.project(after),override:null,onSelectEntity:()=>{}}));
    expect(html.indexOf('你也看到了？')).toBeLessThan(html.indexOf('我刚才也看见了。'));
    expect(html.match(/我刚才也看见了。/g)).toHaveLength(1);
  });
  it('keeps absent NPCs and unrelated history out of the local ensemble context',async()=>{
    const {f,npcId}=await sceneFixture(()=>sceneReply('安静。',null));
    const save=await f.service.current();
    const distant=structuredClone(save.entities.find(entity=>entity.id===npcId)!);
    distant.id='npc_distant';distant.components.location.location_id='station';
    save.entities.push(distant);
    save.npc_agent_state={npc_distant:emptyNpcAgentState()};
    save.npc_agent_state.npc_distant.goals.push({id:'far_goal',description:'远处的私人计划',horizon:'short',
      status:'active',origin:'self',priority:8});
    const view=f.service.project(save),here=view.entities.find(entity=>entity.id===view.player_id)?.components.location?.location_id;
    const present=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character&&
      entity.components.location?.location_id===here);
    const ensemble=sceneEnsembleContext(save,present);
    expect(ensemble.map(person=>person.npc_id)).toEqual([npcId]);
    expect(JSON.stringify(ensemble)).not.toContain('远处的私人计划');
  });
  it('commits one ordered scene and renders each utterance once, without a second dialogue card',async()=>{
    const {f}=await sceneFixture((input)=>({data:{understanding:'对话',narrative:'旧版场景摘要。',dialogue:'我听见了。',
      speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:'我听见了。',provenance:'npc_response'}],
      beats:[{kind:'narration',text:'他先看了你一眼。'},{kind:'speech',speech_index:0},
        {kind:'narration',text:'他把视线移回门口。'},{kind:'speech',speech_index:1}],effects:[]}}));
    const before=await f.service.current();
    const result=await say(f,'你听见了吗？',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const saved=validateSave(await f.store.read());
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(saved.state_revision).toBe(before.state_revision+1);
    expect(saved.last_turn?.scene_beats?.map(beat=>beat.kind)).toEqual(['narration','speech','narration','speech']);
    expect(saved.last_turn?.dialogue).toBeNull();
    expect(saved.resolution_receipts).toEqual(before.resolution_receipts);
    const html=renderToStaticMarkup(createElement(SceneStory,{view:f.service.project(saved),override:null,onSelectEntity:()=>{}}));
    expect(html).toContain('scene-performance');
    expect(html).not.toContain('dialogue-card');
    expect(html.match(/我听见了。/g)).toHaveLength(1);
    expect(html.indexOf('他先看了你一眼。')).toBeLessThan(html.indexOf('你听见了吗？'));
    expect(html.indexOf('你听见了吗？')).toBeLessThan(html.indexOf('他把视线移回门口。'));
    expect(html.indexOf('他把视线移回门口。')).toBeLessThan(html.indexOf('我听见了。'));
    await f.service.undo({request_id:randomUUID(),game_id:saved.game_id,expected_revision:saved.state_revision});
    expect((await f.service.current()).last_turn?.scene_beats).toBeUndefined();
  });
  it('repairs an uncommitted scene with repeated speech indices before any world change',async()=>{
    const {f,sceneCalls}=await sceneFixture((input,n)=>({data:{understanding:'对话',narrative:'他听了你的问话。',dialogue:'没听清。',
      speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:'没听清。',provenance:'npc_response'}],
      beats:n===1?[{kind:'speech',speech_index:0},{kind:'speech',speech_index:0}]:
        [{kind:'speech',speech_index:0},{kind:'speech',speech_index:1}],effects:[]}}));
    const before=await f.service.current();
    const result=await say(f,'你听清了吗？',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    const after=await f.service.current();
    expect(sceneCalls()).toBe(2);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.last_turn?.scene_beats?.filter(beat=>beat.kind==='speech').map(beat=>beat.utterance))
      .toEqual(['你听清了吗？','没听清。']);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('keeps non-mechanical performance in the visible scene and carries it into the next exchange',async()=>{
    const prompts:string[]=[];
    const {f,npcId,sceneCalls}=await sceneFixture((_input,count,prompt)=>{
      prompts.push(prompt);
      return sceneReply(count===1?'他把目光移向地面，停了一瞬。':'他重新抬起眼，语气缓了些。',
        count===1?'我想一想。':'我听着。');
    });
    const before=await f.service.current();
    const npc=before.entities.find(entity=>entity.id===npcId)!;
    npc.components.identity.description='站在广场边，手里没有东西。';
    await f.store.write(before);
    const first=await say(f,'你愿意听我说吗？',{kind:'world_action',interaction_lane:'natural_scene'});
    const second=await say(f,'那我继续说。',{kind:'world_action',interaction_lane:'natural_scene'});
    const after=await f.service.current();
    expect(sceneCalls()).toBe(2);
    expect(prompts[0]).toContain('scene_performance_instruction');
    expect(prompts[0]).toContain('final_scene_checks');
    expect(prompts[0]).toContain('树影落在石砖上');
    expect(prompts[0]).toContain('站在广场边，手里没有东西');
    expect(prompts[1]).toContain('他把目光移向地面，停了一瞬。');
    expect(first.message).toContain('他把目光移向地面，停了一瞬。');
    expect(second.message).toContain('他重新抬起眼，语气缓了些。');
    expect(after.narrative_history?.slice(-2).map(entry=>entry.narrative)).toEqual([
      '他把目光移向地面，停了一瞬。','他重新抬起眼，语气缓了些。']);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(after.runtime.time).toEqual(before.runtime.time);
  });
  it('persists ordered player and NPC speech, reloads it, and removes the last pair on Undo', async () => {
    const {f,npcId}=await sceneFixture((input,n)=>({data:{understanding:'对话',narrative:'两人交谈。',
      dialogue:`第${n}次回答。`,speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:`第${n}次回答。`,provenance:'npc_response'}],effects:[]}}));
    for(const input of ['你今天怎么这么早就在家？','昨晚下雨了吗？','那你今天忙吗？'])
      await say(f,input,{kind:'world_action',interaction_lane:'natural_scene'});
    const saved=validateSave(await f.store.read());
    expect(saved.narrative_history?.slice(-3).map(entry=>entry.speech_events?.map(event=>event.utterance)))
      .toEqual([['你今天怎么这么早就在家？','第1次回答。'],['昨晚下雨了吗？','第2次回答。'],['那你今天忙吗？','第3次回答。']]);
    expect(saved.narrative_history?.at(-1)?.speech_events?.[0]).toMatchObject({speaker_id:'player',provenance:'verbatim_player_input',source_intent:null});
    expect(saved.narrative_history?.at(-1)?.revision).toBe(saved.state_revision);
    expect(saved.resolution_receipts?.some(receipt=>receipt.semantic_action==='TALK')??false).toBe(false);
    await f.service.undo({request_id:randomUUID(),game_id:saved.game_id,expected_revision:saved.state_revision});
    const reverted=await f.service.current();
    expect(reverted.narrative_history?.at(-1)?.player_input).toBe('昨晚下雨了吗？');
    expect(reverted.narrative_history?.some(entry=>entry.player_input==='那你今天忙吗？')).toBe(false);
  });

  it('passes the saved invitation to the next scene without turning claims into world facts', async () => {
    const prompts:string[]=[];
    const {f}=await sceneFixture((input,n,prompt)=>{
      prompts.push(prompt);
      return {data:{understanding:'对话',narrative:'他听着。',dialogue:n===1?'我想想。':'你是说晚饭？',
        speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
          {speaker_id:'npc_lin',utterance:n===1?'我想想。':'你是说晚饭？',provenance:'npc_response'}],effects:[]}};
    });
    const before=await f.service.current();
    before.gm_state.notes='PRIVATE_SCENE_TEST_TRUTH';
    await f.store.write(before);
    await say(f,'晚上一起去吃饭吗？',{kind:'world_action',interaction_lane:'natural_scene'});
    await say(f,'那你答应吗？',{kind:'world_action',interaction_lane:'natural_scene'});
    expect(prompts[1]).toContain('晚上一起去吃饭吗？');
    expect(prompts[1]).toContain('speech_events');
    expect(prompts[1]).toContain('recent_partner_exchanges');
    expect(prompts[1]).not.toContain('PRIVATE_SCENE_TEST_TRUTH');
    expect((await f.service.current()).resolution_receipts?.length??0).toBe(before.resolution_receipts?.length??0);
    await say(f,'你老婆就在楼上。',{kind:'world_action',interaction_lane:'natural_scene'});
    const after=await f.service.current();
    expect(after.narrative_history?.at(-1)?.speech_events?.[0]?.utterance).toBe('你老婆就在楼上。');
    expect(after.entities).toEqual(before.entities);
    expect(after.gm_state).toEqual(before.gm_state);
  });

  it('records generated player speech with provenance and permits ordered NPC interjections', async () => {
    const {f,npcId}=await sceneFixture(()=>({data:{understanding:'骂人',narrative:'旁边的人听见了。',dialogue:'你怎么这么说？',
      speech_events:[{speaker_id:'player',utterance:'你到底有完没完？',provenance:'generated_from_player_intent'},
        {speaker_id:'npc_lin',utterance:'你怎么这么说？',provenance:'npc_response'},
        {speaker_id:'npc_second',utterance:'别吵了。',provenance:'npc_response'},
        {speaker_id:'npc_lin',utterance:'这话太重了。',provenance:'npc_response'}],effects:[]}}));
    const seed=await f.service.current();
    const npc=seed.entities.find(entity=>entity.id===npcId)!;
    seed.entities.push({...structuredClone(npc),id:'npc_second'});
    await f.store.write(seed);
    const result=await say(f,'我骂他。',{kind:'world_action',interaction_lane:'natural_scene'});
    const saved=validateSave(await f.store.read());
    const events=saved.narrative_history?.at(-1)?.speech_events??[];
    expect(events.map(event=>event.speaker_id)).toEqual(['player',npcId,'npc_second',npcId]);
    expect(events[0]).toMatchObject({utterance:'你到底有完没完？',provenance:'generated_from_player_intent',source_intent:'我骂他。'});
    expect(result.message).toContain('别吵了');
    expect(saved.last_turn?.narrative).toContain('别吵了');
    expect(saved.last_turn?.dialogue).toBe('这话太重了。');
    expect(saved.resolution_receipts?.some(receipt=>receipt.semantic_action==='TALK')??false).toBe(false);
  });

  it('rejects player speech that exceeds the upstream authorization before any commit', async () => {
    const {f}=await sceneFixture(()=>({data:{understanding:'观察',narrative:'你看着他。',dialogue:null,
      speech_events:[{speaker_id:'player',utterance:'我喜欢你。',provenance:'generated_from_player_intent'}],effects:[]}}));
    const before=await f.service.current();
    const failure=await say(f,'我看着他。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'});
    expect(failure.outcome).toMatchObject({type:'engine_failure',code:'schema_failure',stage:'natural_scene'});
    expect(failure.presentation).toBe('failure');
    expect(String(failure.message)).not.toContain('未授权');
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.narrative_history).toEqual(before.narrative_history);
  });

  it('reports an absent speaker as a structured scene validation failure', async () => {
    const {f}=await sceneFixture(()=>({data:{understanding:'交谈',narrative:'有人回应。',dialogue:null,
      speech_events:[{speaker_id:'npc_missing',utterance:'不在场的声音。',provenance:'npc_response'}],effects:[]}}));
    const failure=await say(f,'我试着和他谈谈。',{kind:'world_action',interaction_lane:'natural_scene'});
    expect(failure.outcome).toMatchObject({type:'engine_failure',code:'schema_failure',stage:'natural_scene'});
  });

  it('rejects rewritten verbatim player dialogue', async () => {
    const {f}=await sceneFixture(()=>({data:{understanding:'提问',narrative:'他听着。',dialogue:'刚出去。',
      speech_events:[{speaker_id:'player',utterance:'你今天去了哪里？',provenance:'generated_from_player_intent'},
        {speaker_id:'npc_lin',utterance:'刚出去。',provenance:'npc_response'}],effects:[]}}));
    const before=await f.service.current();
    const failure=await say(f,'我说：“昨天去哪了？”',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    expect(failure.outcome).toMatchObject({type:'engine_failure',code:'schema_failure'});
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });

  it('resolves a semantic source-mode mismatch for a described speech intent', async () => {
    const {f}=await sceneFixture(()=>({data:{understanding:'询问',narrative:'他抬头。',dialogue:'刚在家。',
      speech_events:[{speaker_id:'player',utterance:'林舟，你昨晚去了哪里？',provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:'刚在家。',provenance:'npc_response'}],effects:[]}}));
    await say(f,'我当着他们的面问林舟昨晚去了哪里。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    expect((await f.service.current()).narrative_history?.at(-1)?.speech_events?.[0]).toMatchObject({
      utterance:'林舟，你昨晚去了哪里？',provenance:'generated_from_player_intent',source_intent:'我当着他们的面问林舟昨晚去了哪里。'});
  });

  it.each([
    ['我很生气地骂他两句。','你这样做太过分了，能不能别再烦我？'],
    ['我问他昨天去哪了。','你昨天去了哪里？'],
  ])('records an authorized realization of %s without changing the source intent', async (input,utterance) => {
    const {f}=await sceneFixture(()=>({data:{understanding:'说话',narrative:'他听完。',dialogue:'我听见了。',
      speech_events:[{speaker_id:'player',utterance,provenance:'generated_from_player_intent'},
        {speaker_id:'npc_lin',utterance:'我听见了。',provenance:'npc_response'}],effects:[]}}));
    await say(f,input,{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'});
    const event=(await f.service.current()).narrative_history?.at(-1)?.speech_events?.[0];
    expect(event).toMatchObject({utterance,provenance:'generated_from_player_intent',source_intent:input});
    expect(utterance).not.toMatch(/我要杀|我保证|我答应/);
  });

  it('keeps explicit quotation verbatim and allows an observation with no player speech', async () => {
    const {f}=await sceneFixture(input=>input.includes('昨天去哪了')?{data:{understanding:'提问',narrative:'他抬头。',dialogue:'刚去了车站。',
      speech_events:[{speaker_id:'player',utterance:'昨天去哪了？',provenance:'verbatim_player_input'},
        {speaker_id:'npc_lin',utterance:'刚去了车站。',provenance:'npc_response'}],effects:[]}}:
      {data:{understanding:'注视',narrative:'你看着他。',dialogue:'怎么了？',
        speech_events:[{speaker_id:'npc_lin',utterance:'怎么了？',provenance:'npc_response'}],effects:[]}});
    await say(f,'我说：“昨天去哪了？”',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'});
    expect((await f.service.current()).narrative_history?.at(-1)?.speech_events?.[0]?.utterance).toBe('昨天去哪了？');
    await say(f,'我看着他。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'none'});
    const saved=await f.service.current();
    expect(saved.narrative_history?.at(-1)?.player_input).toBe('我看着他。');
    expect(saved.narrative_history?.at(-1)?.speech_events?.some(event=>event.speaker_id==='player')).toBe(false);
  });

  it('requires an actual player utterance for an authorized speech intent', async () => {
    const {f}=await sceneFixture(()=>sceneReply('他看着你。','什么事？'));
    const before=await f.service.current();
    const failure=await say(f,'我问他昨天去哪了。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'});
    expect(failure.outcome).toMatchObject({type:'engine_failure',code:'schema_failure'});
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });

  it('blocks a generated threat that was not part of the player speech intent', async () => {
    const {f}=await sceneFixture(()=>({data:{understanding:'骂人',narrative:'他听着。',dialogue:'你冷静点。',
      speech_events:[{speaker_id:'player',utterance:'我要杀了你。',provenance:'generated_from_player_intent'},
        {speaker_id:'npc_lin',utterance:'你冷静点。',provenance:'npc_response'}],effects:[]}}));
    const before=await f.service.current();
    const failure=await say(f,'我骂他。',{kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'intent'});
    expect(failure.outcome).toMatchObject({type:'engine_failure',code:'schema_failure'});
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
  });

  it('accepts old history without player speech and does not invent an utterance', async () => {
    const {f}=await sceneFixture(()=>sceneReply('他看过来。','你好。'));
    const seed=await f.service.current();
    seed.narrative_history=[{request_id:randomUUID(),narrative:'过去说了几句。',dialogue:'你好。',speaker:'npc_lin',facts:[]}];
    await f.store.write(validateSave(seed));
    expect((await f.service.current()).narrative_history?.[0]?.player_input).toBeUndefined();
    await say(f,'今天还好吗？',{kind:'world_action',interaction_lane:'natural_scene'});
    const saved=await f.service.current();
    expect(saved.narrative_history?.[0]?.speech_events).toBeUndefined();
    expect(saved.narrative_history?.[1]?.player_input).toBe('今天还好吗？');
  });
  it('runs ordinary conversation on the natural_scene lane without a TALK transaction', async () => {
    const { f, npcId, sceneCalls } = await sceneFixture((_input, n) => sceneReply('他抬眼看向你。', `第${n}句回应。`));
    const before = await f.service.current();
    for (const line of ['最近怎么样？', '你搬来这里多久了？', '哈哈，原来是这样。']) {
      const result = await say(f, line, { kind: 'world_action', interaction_lane: 'natural_scene' });
      expect(result.presentation).toBe('story');
      expect(result.time_advanced).toBe(0);
    }
    const after = await f.service.current();
    expect(count(after)).toBe(count(before));
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.last_turn?.dialogue).toBe('第3句回应。');
    expect(after.last_turn?.speaker).toBe(npcId);
    expect(sceneCalls()).toBe(3);
  });

  it('never enters the scene lane without the upstream lane decision (deterministic reads stay 0-call)', async () => {
    const { f, sceneCalls } = await sceneFixture(() => sceneReply('不该发生。', null));
    const before = await f.service.current();
    // No semantic lane: the request keeps whatever deterministic/planner path it had before.
    await handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input: '现在几点？' }, undefined, null, false, undefined).catch(() => undefined);
    expect(sceneCalls()).toBe(0);
    // A transaction/open-goal lane also never touches the scene lane.
    await handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input: '最近怎么样？' }, undefined, null, false, { kind: 'world_action', interaction_lane: 'world_transaction' } as never).catch(() => undefined);
    expect(sceneCalls()).toBe(0);
  });

  it('escalates a settlement effect from inside ordinary conversation and never fakes the rest', async () => {
    const { f } = await sceneFixture(input => input.includes('五百')
      ? sceneReply('你把话说完。', '那怎么好意思。', [{ kind: 'unsupported', reason: '这个世界还没有结算转账的方式。' }])
      : sceneReply('你们聊完，各自散开。', '路上小心。', [{ kind: 'move', destination: '河岸车站' }]));
    const before = await f.service.current();
    const moved = await say(f, '那我先走了，回头见。', { kind: 'world_action', interaction_lane: 'natural_scene' });
    const afterMove = await f.service.current();
    expect(String(moved.message)).toContain('移动到河岸车站');
    expect((afterMove.resolution_receipts ?? []).filter(receipt => receipt.semantic_action === 'MOVE')).toHaveLength(1);
    expect(afterMove.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    const rejoined = await f.service.current();
    rejoined.entities.find(entity => entity.id !== rejoined.player_state.entity_id && entity.components.character)!.components.location =
      structuredClone(rejoined.entities.find(entity => entity.id === rejoined.player_state.entity_id)!.components.location);
    await f.store.write(rejoined);
    const paid = await say(f, '这五百块送你，拿着。', { kind: 'world_action', interaction_lane: 'natural_scene' });
    const afterPay = await f.service.current();
    expect(String(paid.message)).toContain('后续变化现在没有实际发生');
    expect(count(afterPay)).toBe(count(afterMove));
    expect(afterPay.runtime.time).toEqual(afterMove.runtime.time);
  });
  it('does not turn an NPC suggestion into an unauthorized player move',async()=>{
    const {f}=await sceneFixture(()=>sceneReply('他建议你去车站。','你可以去车站看看。',
      [{kind:'move',destination:'河岸车站'}]));
    const before=await f.service.current();
    const result=await say(f,'你有什么建议？',{kind:'world_action',interaction_lane:'natural_scene'});
    const after=await f.service.current();
    expect(result.message).toContain('未获得玩家授权');
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location)
      .toEqual(before.entities.find(entity=>entity.id===before.player_state.entity_id)?.components.location);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
});

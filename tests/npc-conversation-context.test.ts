import {afterEach,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {MemoryStore} from './helpers.js';
import {sparseWorld} from './sparse-fixture.js';
import {executeAction} from '../src/core/runtime.js';
import {npcPresentInView} from '../src/shared/interaction-context.js';

let server:Server|undefined;
afterEach(async()=>{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;});

async function setup(){
  const semanticInputs:unknown[]=[],scenePrompts:string[]=[];
  const ai=new AIRuntime({name:'npc-conversation-fixture',generate:async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    const context=JSON.parse(request.prompt.split('\n\n').at(-1)!) as Record<string,any>;
    if(properties.domain){
      semanticInputs.push(context);
      const target=context.explicit_interaction?.target_id as string|undefined;
      if(!target)return {data:{domain:'world',kind:'read_only',confidence:.98,answer:'公开资料中的地点说明。',
        answer_basis:'reasoned_advice',evidence_ids:[],clarification:null,speech_target_id:null,
        interaction_lane:'deterministic_read'}};
      // Reproduce the actual failure proposal once: the semantic owner must repair it,
      // rather than allowing /api/input to return this assistant answer.
      if(semanticInputs.filter((entry:any)=>entry.input===context.input&&entry.explicit_interaction).length===1)
        return {data:{domain:'world',kind:'read_only',confidence:.98,answer:'错误的游戏助手资料答复。',
          answer_basis:'reasoned_advice',evidence_ids:[],clarification:null,speech_target_id:null,
          interaction_lane:'deterministic_read'}};
      return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.98,
        answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:target,
        interaction_lane:'natural_scene',player_speech_mode:'verbatim'}};
    }
    if(properties.preserved)return {data:{preserved:true,reason:'保留原始请求与选中对象'}};
    if(properties.understanding){
      scenePrompts.push(request.prompt);
      const input=context.player_input as string,partner=context.partner.id as string;
      return {data:{understanding:'回应当前交谈者',narrative:'对方听完你的问题，略作思索。',
        dialogue:'我只知道眼前这些，其他的事不能确定。',speech_events:[
          {speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
          {speaker_id:partner,utterance:'我只知道眼前这些，其他的事不能确定。',provenance:'npc_response'}],effects:[]}};
    }
    throw Error(`unexpected model call: ${Object.keys(properties).join(',')}`);
  }});
  const store=new MemoryStore(),service=new GameService(store,ai,sparseWorld());
  await service.newGame();
  const save=await service.current(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  save.gm_state.notes='PRIVATE_FIXTURE_TRUTH_NOT_KNOWN_TO_NPC';
  const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
  npc.components.location=structuredClone(player.components.location);
  const other=structuredClone(npc);other.id='npc_other';other.components.identity.name='另一位在场人物';
  save.entities.push(other);await store.write(save);
  server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await (await fetch(`${base}/api/session`)).json()).token;
  const input=async(text:string,target?:string)=>{
    const view=(await service.view())!;
    const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
      body:JSON.stringify({request_id:randomUUID(),game_id:view.game_id,expected_revision:view.revision,input:text,
        ...(target?{interaction:{source:'npc_interaction',target_id:target,mode:'conversation'}}:{})})});
    return {status:response.status,body:await response.json()};
  };
  return {service,input,npcId:npc.id,otherId:other.id,semanticInputs,scenePrompts};
}

it('keeps a selected NPC question out of the assistant, repairs misrouting, and persists speech with Undo',async()=>{
  const f=await setup(),before=await f.service.current();
  const generic=await f.input('这里是哪里？');
  expect(generic.body.intent).toBe('WORLD_QUERY');
  expect((await f.service.current()).state_revision).toBe(before.state_revision);
  const spoken=await f.input('这里是哪里？',f.npcId),after=await f.service.current();
  expect(spoken.status).toBe(200);
  expect(spoken.body.presentation).toBe('story');
  expect(spoken.body.message).toContain('我只知道眼前这些');
  expect(spoken.body.message).not.toContain('错误的游戏助手');
  expect(after.state_revision).toBeGreaterThan(before.state_revision);
  expect(after.narrative_history?.at(-1)?.player_input).toBe('这里是哪里？');
  expect(after.narrative_history?.at(-1)?.speech_events?.map(event=>event.speaker_id)).toEqual([after.player_state.entity_id,f.npcId]);
  expect(after.narrative_history?.at(-1)?.speech_events?.[0]).toMatchObject({provenance:'verbatim_player_input'});
  expect(f.semanticInputs.some((entry:any)=>entry.explicit_interaction?.target_id===f.npcId)).toBe(true);
  expect(f.scenePrompts.at(-1)).toContain(`"id":"${f.npcId}"`);
  expect(f.scenePrompts.at(-1)).not.toContain('PRIVATE_FIXTURE_TRUTH_NOT_KNOWN_TO_NPC');
  await f.service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
  expect((await f.service.current()).narrative_history?.some(entry=>entry.player_input==='这里是哪里？')??false).toBe(false);
});

it('switches explicit recipients, leaves generic questions unbound, and rejects an unavailable target',async()=>{
  const f=await setup();
  const first=await f.input('我为什么在这里？',f.npcId);
  expect(first.body.presentation).toBe('story');
  const second=await f.input('你怎么看这件事？',f.otherId);
  expect(second.body.presentation).toBe('story');
  const current=await f.service.current();
  expect(current.interaction_context?.target_entity_id).toBe(f.otherId);
  expect(current.narrative_history?.at(-1)?.speech_events?.at(-1)?.speaker_id).toBe(f.otherId);
  const generic=await f.input('这里是哪里？');
  expect(generic.body.intent).toBe('WORLD_QUERY');
  const before=await f.service.current();
  const invalid=await f.input('你知道吗？','npc_missing');
  expect(invalid.status).toBe(409);
  expect((await f.service.current()).state_revision).toBe(before.state_revision);
});

it('uses the restored authoritative location after Undo instead of a stale conversation reference',async()=>{
  const f=await setup(),before=await f.service.current();
  expect(npcPresentInView((await f.service.view())!,f.npcId)).toBe(true);
  const id=randomUUID();
  await f.service.agentTransaction({request_id:id,game_id:before.game_id,expected_revision:before.state_revision},
    {isolated_departure:true},next=>{
      const moved=executeAction(next,{type:'MOVE',target_id:'market',parameters:{companions:'none'}},
        randomUUID(),'ai',undefined,undefined,false,f.npcId,true);Object.assign(next,moved.save);
    });
  const absent=await f.service.current();
  expect(npcPresentInView((await f.service.view())!,f.npcId)).toBe(false);
  expect((await f.input('你知道吗？',f.npcId)).status).toBe(409);
  await f.service.undo({request_id:randomUUID(),game_id:absent.game_id,expected_revision:absent.state_revision});
  expect((await f.service.current()).state_revision).toBeGreaterThan(absent.state_revision);
  expect(npcPresentInView((await f.service.view())!,f.npcId)).toBe(true);
  expect((await f.input('这里是哪里？',f.npcId)).body.presentation).toBe('story');
});

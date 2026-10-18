import {afterEach,describe,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server/app.js';
import {sparseWorld} from './sparse-fixture.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';
import type {AIRequest} from '../src/ai/contracts.js';
import {ProviderError} from '../src/ai/failures.js';
import {orderedSceneBeats,sceneResultSchema} from '../src/agent/scene-interaction.js';

// Real logs retain failure codes, event counts and provenance, NOT the failed
// prose or beat indices. These are explicit isolated reconstructions, not recordings.
const servers:Server[]=[];
const directories:string[]=[];
afterEach(async()=>{for(const s of servers.splice(0))await new Promise<void>(r=>s.close(()=>r()));
 for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});
async function isolatedSetup(generate:(request:AIRequest)=>Promise<any>){
 const path=await mkdtemp(join(tmpdir(),'agf-social-http-'));directories.push(path);
 const calls:AIRequest[]=[];
 const ai=new AIRuntime({name:'social-http-reconstruction',generate:async request=>{calls.push(request);return generate(request);}});
 const store=new JsonStore(path),service=new GameService(store,ai,sparseWorld());await service.newGame();
 return {service,store,ai,calls};
}
const scene=(input:string,answer:string,indices=[0,1])=>({understanding:'普通交流',narrative:'林舟停下来听你说话。',
 dialogue:answer,speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
 {speaker_id:'npc_lin',utterance:answer,provenance:'npc_response'}],
 beats:[{kind:'narration',text:'林舟停下来听你说话。'},...indices.map(speech_index=>({kind:'speech',speech_index}))],effects:[]});

describe('ordinary social interaction recovery through HTTP and durable commit',()=>{
 it('moves then observes the current scene without inventing a single-person target',async()=>{
   const destination=sparseWorld().map!.locations.find(location=>location.id==='market')!.name;
   const input=`前往${destination}，然后查看当前环境和有哪些人在活动。`;
   const f=await isolatedSetup(async request=>{
     const p=(request.schema as any).properties??{};
     if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
       answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
       interaction_lane:'world_transaction',player_speech_mode:'none',goal_spec:{objective:input,play_action:'other',
         targets:[],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
         dependencies:[],world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null}}};
     if(p.preserved)return {data:{preserved:true,reason:'保留移动和现场观察'}};
     if(p.verdict)return {data:{verdict:'aligned',explanation:'只执行明确授权的两个阶段'}};
     if(p.goals)return {data:{goals:[{goal_id:'move',type:'WORLD_ACTION',normalized_goal:`前往${destination}`,operation_hint:'move',referent:destination,
       target_entities:[],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}},
       {goal_id:'see',type:'WORLD_ACTION',normalized_goal:'查看当前环境和有哪些人在活动',operation_hint:'presence_query',referent:null,
       target_entities:[],depends_on:['move'],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}};
     if(p.resolution)return {data:{narrative:'尝试查看四周',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,
       required_conditions:[],resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',
         stakes:'查看当前可见环境',stages:[],evidence_ids:[]}}};
     if(request.role==='narrator')return {data:{narrative:'你查看了眼前的环境，没有确认新的发现。',speaker:null,dialogue:null,choices:[],patches:[]}};
     throw Error('Unexpected observation call: '+Object.keys(p).join(','));
   });
   const before=await f.service.current(),server=createApp(f.service).listen(0,'127.0.0.1');servers.push(server);
   await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}`;
   const {token}=await (await fetch(base+'/api/session')).json() as any;
   const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
     body:JSON.stringify({input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
   const result=await response.json() as any,after=await f.service.current();
   expect(result.outcome.type,JSON.stringify(result.message)).not.toBe('engine_failure');
   expect(after.active_goal?.plan.status,JSON.stringify({message:result.message,plan:result.plan,outcome:result.outcome,
     calls:f.calls.map(c=>Object.keys((c.schema as any).properties??{}))})).toBe('completed');
   expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('market');
   expect(after.resolution_history?.some(record=>record.spec.domain==='perception')).toBe(true);
   expect(after.resolution_receipts?.filter(r=>r.semantic_action==='MOVE'&&r.commit_status==='committed')).toHaveLength(1);
 });
 it('normalizes an unambiguous complete one-based presentation without changing words',()=>{
   const result=sceneResultSchema.parse(scene('最近怎么样？','还好。',[1,2]));
   expect(orderedSceneBeats(result)?.filter(b=>b.kind==='speech')).toEqual([
     {kind:'speech',speaker_id:'player',utterance:'最近怎么样？'},
     {kind:'speech',speaker_id:'npc_lin',utterance:'还好。'}]);
 });
 it.each(['subjective','refusal','unknown','lie','help','repair','exhausted','alignment_transport'] as const)('%s',async mode=>{
   let calls=0;
   const input=mode==='help'?'需要我帮忙吗？':'你现在怎么看我？';
   const answer=mode==='refusal'?'我现在不想谈这个。':mode==='unknown'?'我没有听说过。':
     mode==='lie'?'我从没有去过市场。':'我觉得你有些急，不过我想再了解你一点。';
   const f=await isolatedSetup(async request=>{
     const p=(request.schema as any).properties??{};
     if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',confidence:.99,
       answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:'npc_lin',
       interaction_lane:'natural_scene',player_speech_mode:mode==='alignment_transport'?'intent':'verbatim'}} as never;
     if(p.preserved)return {data:{preserved:true,reason:'保持原请求'}} as never;
     if(p.verdict){
       if(mode==='alignment_transport'&&request.prompt.includes('realized_player_speech'))
         throw new ProviderError('timeout','isolated transport timeout','isolated timeout');
       return {data:{verdict:'aligned',explanation:'保留原始意图'}} as never;
     }
     if(p.understanding){calls++;
       if(mode==='repair'&&calls===2){
         expect(request.prompt).toContain('validation_feedback');
         expect(request.prompt).toContain('speech_indices');
         expect(request.prompt).toContain('previous_output');
       }
       const proposal=scene(input,answer,mode==='exhausted'||mode==='repair'&&calls===1?[1]:[1,2]);
       if(mode==='alignment_transport')proposal.speech_events[0].provenance='generated_from_player_intent';
       return {data:proposal} as never;
     }
     throw Error('Unexpected model call: '+Object.keys(p).join(','));
   });
   const save=await f.service.current();
   save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
   await f.store.write(save);
   const server=createApp(f.service).listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');
   const base=`http://127.0.0.1:${(server.address() as any).port}`;
   const {token}=await (await fetch(base+'/api/session')).json() as any;
   const body={request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input,
     interaction:{source:'npc_interaction',target_id:'npc_lin',mode:'conversation'}};
   const post=()=>fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
   const http=await post();const response=await http.json() as any;
   expect(http.status,JSON.stringify(response)).toBe(200);
   const after=await f.service.current();
   if(mode==='exhausted'||mode==='alignment_transport'){
     expect(calls).toBe(mode==='exhausted'?2:1);expect(after.state_revision).toBe(save.state_revision);
     expect(response.outcome.type).toBe('engine_failure');return;
   }
   expect(response.presentation).not.toBe('failure');
   expect(after.state_revision,JSON.stringify({message:response.message,outcome:response.outcome,clarification:response.clarification,
     calls:f.calls.map(c=>Object.keys((c.schema as any).properties??{}))})).toBe(save.state_revision+1);
   expect(after.last_turn?.scene_beats?.some(b=>b.kind==='speech'&&b.speaker_id==='npc_lin'&&b.utterance===answer)).toBe(true);
   expect(after.entities.map(e=>[e.id,e.components.location])).toEqual(save.entities.map(e=>[e.id,e.components.location]));
   // An utterance is not automatically a relationship or objective world fact.
   expect(after.entities.map(e=>e.components.relationships)).toEqual(save.entities.map(e=>e.components.relationships));
   expect(after.gm_state).toEqual(save.gm_state);
   expect(after.npc_agent_state?.npc_lin?.memories.some(m=>m.summary.includes(answer))).toBe(true);
   const count=calls;await post();expect(calls).toBe(count);
   const reload=await f.store.read();expect(reload?.last_turn).toEqual(after.last_turn);
   await f.service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
   const undone=await f.service.current();expect(undone.runtime.time).toEqual(save.runtime.time);
 });
});

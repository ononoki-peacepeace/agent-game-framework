import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SceneStory} from '../src/client/SceneStory.js';
import {demo} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {NarratorSchemaError} from '../src/ai/failures.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';

const resources:{server:Server;directory:string}[]=[];
afterEach(async()=>{for(const {server,directory} of resources.splice(0)){
  await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
}});
describe('presentation degradation survives actual Agent HTTP and saved views',()=>{
  it.each(['fact_conflict','schema'] as const)('keeps %s degradation separate from settled world outcome, including replay and UI',async mode=>{
    const input='尝试打击林舟',directory=await mkdtemp(join(tmpdir(),'agf-narration-degraded-'));
    const ai=new AIRuntime({name:'narration-degradation-reconstruction',generate:async request=>{
      const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
        answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
        interaction_lane:'world_transaction',player_speech_mode:'none',goal_spec:{objective:input,play_action:'interact',targets:[],
          desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
          dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null}}} as never;
      if(p.goals)return {data:{goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:input,operation_hint:'other',referent:'林舟',
        target_entities:['npc_lin'],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}} as never;
      if(p.verdict)return {data:{verdict:'aligned',explanation:'保留本次尝试'}} as never;
      if(p.parameters_json)return {data:{type:'FREEFORM_ACTION',target_id:'npc_lin',parameters_json:'{}',clarification:null}} as never;
      throw Error('Unexpected reconstruction stage '+Object.keys(p).join(','));
    }});
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
      physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
      resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'尝试',
        stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}} as never);
    vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'保持自己的安排',proposed_action:null,
      evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'不新增行动',social_response:null} as never);
    const narrator=vi.spyOn(ai,'narrate');
    if(mode==='schema')narrator.mockRejectedValue(new NarratorSchemaError([{path:'scene_beats',code:'invalid_type',expected:'array',message:'expected array'}],{}));
    else narrator.mockResolvedValue({narrative:'你拿起了一把不存在的钥匙。',speaker:null,dialogue:null,choices:[],context_actions:[],
      patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[{kind:'inventory',fact_index:0}]} as never);
    const store=new JsonStore(directory),service=new GameService(store,ai,demo),world=structuredClone(demo);world.events=[];
    await store.write(newSave(world));const before=await service.current();
    const server=createApp(service).listen(0,'127.0.0.1');resources.push({server,directory});await once(server,'listening');
    const port=(server.address() as {port:number}).port;expect([3100,3101]).not.toContain(port);
    const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json() as {token:string};
    const body={input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
    const post=()=>fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    const response=await post(),result=await response.json() as any;
    expect(response.status,JSON.stringify(result)).toBe(200);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(result.view.last_turn.presentation).toMatchObject({status:'degraded',reasons:expect.any(Array)});
    expect(result.view.last_turn.presentation.reasons.length).toBeGreaterThan(0);
    expect(result.narration).toEqual(result.view.last_turn.presentation);
    expect(result.view.notices.join('')).toContain('降级');
    expect(result.message).not.toContain('钥匙');
    expect(renderToStaticMarkup(createElement(SceneStory,{view:result.view,override:null,onSelectEntity:()=>{}}))).toContain('场景描写已降级');
    const after=(await store.read())!;
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(publicView(validateSave(JSON.parse(JSON.stringify(after)))).last_turn).toEqual(result.view.last_turn);
    const calls=narrator.mock.calls.length;
    expect((await post()).status).toBe(200);
    expect(await store.read()).toEqual(after);expect(narrator).toHaveBeenCalledTimes(calls);expect(freeform).toHaveBeenCalledTimes(1);
  });
});

import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {WorldBlockedError} from '../src/agent/outcome.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';

// Reconstruction of P0-D, NOT a replay of missing production model candidates.
// Frozen acceptance: framework-reliability-handoff/ACCEPTANCE.v1.json (external review pending).
const input='尝试打击林舟';
const proposal=()=>({narrative:'未执行的候选',minutes:3,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
    stakes:'尝试而非保证结果',stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[],discover_facts:false}});
function start(depart=true){
  const world=structuredClone(demo);world.events=[];
  world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  for(const route of world.map!.routes)if([route.from,route.to].includes('square')&&[route.from,route.to].includes('market'))route.travel_minutes=3;
  const save=newSave(world);
  if(depart)recordNpcActivityPlans(save,sceneResultSchema.parse({understanding:'已作出的离场安排',
    narrative:'林舟准备按自己的安排去市场。',dialogue:'我现在去市场。',
    speech_events:[{speaker_id:'npc_lin',utterance:'我现在去市场。',provenance:'npc_response'}],effects:[],
    npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',readiness:'ready',condition:null,
      plan_id:null,steps:[{type:'MOVE',target_id:'market',description:'前往市场',duration_minutes:null,speech:null}],not_before:null}]}),
    randomUUID(),'square');
  return save;
}
const resources:{server:Server;directory:string}[]=[];
afterEach(async()=>{for(const {server,directory} of resources.splice(0)){
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(directory,{recursive:true,force:true});
}});

describe('P0-D dynamic settlement preconditions',()=>{
  it('control: actual time scheduler executes the previously authorized departure',()=>{
    const before=start(),after=executeAction(before,{type:'WAIT',parameters:{minutes:3}},randomUUID()).save;
    expect(after.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
    expect(after.resolution_receipts?.some(r=>r.actor_id==='npc_lin'&&r.movement_route?.destination_id==='market')).toBe(true);
    expect(before.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('square');
  });

  it('aborts before contact RNG when time advancement invalidates the real target; leaks no candidate changes',()=>{
    const before=start(),snapshot=structuredClone(before),request=randomUUID();
    const rng=vi.fn(()=>.99);
    for(let replay=0;replay<2;replay++){
      expect(()=>executeFreeform(before,input,proposal(),request,rng)).toThrow(WorldBlockedError);
      expect(before).toEqual(snapshot);
    }
    expect(rng).not.toHaveBeenCalled();
  });

  it('retains normal Core contact adjudication when the target remains present',()=>{
    const before=start(false),snapshot=structuredClone(before),values=[.99,.01,.99,.01],rng=vi.fn(()=>values.shift()!);
    const result=executeFreeform(before,input,proposal(),randomUUID(),rng);
    expect(result.save.resolution_receipts!.at(-1)!.physical_outcome).toMatchObject({target_id:'npc_lin',contact:true,harmed:true});
    expect(rng).toHaveBeenCalledTimes(4);
    expect(result.save.runtime.time.minute-before.runtime.time.minute).toBe(3);
    expect(before).toEqual(snapshot);
  });

  it('uses the isolated HTTP input/planner/service/Core path and replays obstruction without another proposal or commit',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-reliability-causal-'));
    let proposals=0,narrations=0;
    const ai=new AIRuntime({name:'causal-reconstruction',generate:async request=>{
      const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
        answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
        interaction_lane:'world_transaction',player_speech_mode:'none',goal_spec:{objective:input,play_action:'interact',targets:[],
          desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
          dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null}}} as never;
      if(p.goals)return {data:{goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:input,operation_hint:'other',referent:'林舟',
        target_entities:['npc_lin'],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}} as never;
      if(p.verdict)return {data:{verdict:'aligned',explanation:'原始身体尝试'}} as never;
      if(p.parameters_json)return {data:{type:'FREEFORM_ACTION',target_id:'npc_lin',parameters_json:'{}',clarification:null}} as never;
      if(p.resolution){proposals++;return {data:proposal()} as never;}
      if(request.role==='narrator')narrations++;
      throw Error('Unexpected reconstruction stage '+Object.keys(p).join(','));
    }});
    const store=new JsonStore(directory),service=new GameService(store,ai,demo);
    await store.write(start());
    // Capture the authoritative loaded state after existing startup migrations,
    // before this request. Do not confuse setup migration with action effects.
    const before=await service.current();
    const server=createApp(service).listen(0,'127.0.0.1');resources.push({server,directory});await once(server,'listening');
    const port=(server.address() as {port:number}).port;expect([3100,3101]).not.toContain(port);
    const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json() as {token:string};
    const body={input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
    const post=()=>fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    const first=await post(),result=await first.json() as {outcome:unknown};
    expect(first.status,JSON.stringify(result)).toBe(200);
    expect(result.outcome).toMatchObject({type:'game',kind:'blocked_by_world',receipt_ids:[],revision:before.state_revision});
    expect(await store.read()).toEqual(before);
    expect((await post()).status).toBe(200);
    expect(await store.read()).toEqual(before);
    expect(proposals).toBe(1);expect(narrations).toBe(0);
  });
});

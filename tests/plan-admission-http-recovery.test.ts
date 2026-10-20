import {afterEach,describe,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';

const servers:Server[]=[];
const directories:string[]=[];
afterEach(async()=>{
  for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});
});

describe('plan admission recovery through the real HTTP route',()=>{
  it.each(['entity','location'] as const)('feeds a mistaken %s-target MOVE back to planning, revalidates, commits once and replays safely',async targetKind=>{
    const input='我走到长条桌旁，在一张固定座椅上坐下。';
    const directory=await mkdtemp(join(tmpdir(),'agf-admission-recovery-'));directories.push(directory);
    let planCalls=0;
    const prompts:string[]=[];
    const ai=new AIRuntime({name:'isolated-admission-fixture',generate:async request=>{
      prompts.push(request.prompt);
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
        answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
        interaction_lane:'world_transaction',player_speech_mode:'none',goal_spec:{objective:input,play_action:'move',
          targets:[{kind:targetKind,role:targetKind==='location'?'destination':'object',reference:'长条桌旁的固定座椅',entity_id:null}],
          desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
          dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null}}} as never;
      if(properties.goals){planCalls++;
        if(planCalls===2){expect(request.prompt).toContain('plan_binding_invalid');
          expect(request.prompt).toContain('previous_output');expect(request.prompt).toContain('长条桌旁的固定座椅');}
        const first={goal_id:'g1',type:'WORLD_ACTION',normalized_goal:planCalls===1?input:'我走到长条桌旁',
          ...(planCalls===1?{operation_hint:'move',referent:'长条桌旁的固定座椅'}:{}),
          target_entities:[],depends_on:[],condition:null,branch:null,
          temporal_scope:{scope:'now',day_offset:0,window:'any'}};
        return {data:{goals:planCalls===1?[first]:[first,{goal_id:'g2',type:'WORLD_ACTION',
          normalized_goal:'在一张固定座椅上坐下',target_entities:[],depends_on:['g1'],condition:null,branch:null,
          temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}} as never;}
      if(properties.verdict)return {data:{verdict:'aligned',explanation:'保留原始完整行动'}} as never;
      if(properties.parameters_json)return {data:{type:'FREEFORM_ACTION',target_id:null,parameters_json:'{}',clarification:null}} as never;
      if(properties.resolution)return {data:{narrative:'尝试走近桌边并坐下。',minutes:2,target_id:null,
        facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
        resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',
          stakes:'普通局部行动',stages:[],evidence_ids:[]}}} as never;
      if(request.role==='narrator')return {data:{narrative:'你走到桌旁，在可用的座位上坐下。',
        speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,
        item_claims:[],stable_locations:[],mechanical_claims:[]}} as never;
      throw Error('Unexpected isolated provider stage: '+Object.keys(properties).join(','));
    }});
    const store=new JsonStore(directory),service=new GameService(store,ai,sparseWorld());await service.newGame();
    const before=await service.current(),here=String(before.entities.find(entity=>entity.id===before.player_state.entity_id)!
      .components.location?.location_id);
    before.definition.map!.locations.find(location=>location.id===here)!.description='长条桌与固定座椅。';
    // This reconstruction has no public inter-location route to choose; the
    // historic REV390 request entered the goal planner rather than route choice.
    before.definition.map!.routes=[];
    before.environment_state={resolutions:[{id:'known_table',location_id:here,name:'长条桌',aliases:[],
      status:'present',classification:'environment_detail',entity_id:null,description:'房间里有长条桌。',
      take_allowed:false,source_request_id:randomUUID(),at:structuredClone(before.runtime.time),
      known_by:[before.player_state.entity_id]},{id:'known_fixed_seat',location_id:here,name:'固定座椅',aliases:[],
      status:'present',classification:'environment_detail',entity_id:null,description:'长条桌旁有固定座椅。',
      take_allowed:false,source_request_id:randomUUID(),at:structuredClone(before.runtime.time),
      known_by:[before.player_state.entity_id]}]};
    await store.write(before);
    const server=createApp(service).listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const {token}=await (await fetch(base+'/api/session')).json() as {token:string};
    const body={input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
    const post=()=>fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json',
      'X-Game-Token':token},body:JSON.stringify(body)});
    const response=await post(),result=await response.json() as {outcome:{type:string;kind:string};message:string};
    const after=await service.current();
    expect(response.status).toBe(200);
    expect(result.outcome,JSON.stringify({result,planCalls,events:service.logger.entries({limit:1000})
      .filter(entry=>entry.request_id===body.request_id).map(entry=>({event:entry.event,metadata:entry.metadata}))})).toMatchObject({type:'game',kind:'completed'});
    expect(after.state_revision).toBe(before.state_revision+1);
    const added=after.resolution_receipts?.slice(before.resolution_receipts?.length??0)??[];
    expect(added).toHaveLength(3);
    expect(added.every(receipt=>receipt.commit_status==='committed')).toBe(true);
    expect(added.at(-1)?.effects).toEqual(expect.arrayContaining(['position','activity','time']));
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.scene_position?.label)
      .toBe('长条桌旁');
    expect(planCalls).toBe(2);
    const events=service.logger.entries({limit:1000}).filter(entry=>entry.request_id===body.request_id);
    expect(events.filter(entry=>entry.event==='agent.plan_attempt')).toHaveLength(2);
    expect(events.some(entry=>entry.event==='agent.recovery.decision'&&
      entry.metadata?.failure_stage==='plan_admission'&&entry.metadata?.recoverable===true)).toBe(true);
    const replay=await post();expect(replay.status).toBe(200);
    expect((await replay.json() as {outcome:{kind:string}}).outcome.kind).toBe('completed');
    expect((await service.current()).state_revision).toBe(after.state_revision);
    expect(planCalls).toBe(2);
    expect(prompts.some(prompt=>prompt.includes('plan_binding_invalid'))).toBe(true);
  });
});

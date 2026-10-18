import {afterEach,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {demo,MemoryStore} from './helpers.js';
import {StructuredLogger} from '../src/observability/logger.js';

const opened:{server:Server;directory:string}[]=[];
afterEach(async()=>{for(const {server,directory} of opened.splice(0)){
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(directory,{recursive:true,force:true});
}});

async function livePath(slot:boolean){
  const logger=new StructuredLogger({directory:null,level:'debug'});
  let plannerCalls=0,npcCalls=0;
  const ai=new AIRuntime({name:'semantic-fixture',generate:async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(request.role==='gm_reasoning'&&'domain' in properties){
      return {data:{domain:'world',kind:'world_action',confidence:.98,answer:null,answer_basis:null,
        evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'world_transaction',
        temporal_wait:slot?{standalone:true,mode:'until',duration_minutes:null,target_day_offset:0,
          target_minute:1320}:null}};
    }
    if(request.role==='narrator')return {data:{narrative:'街灯逐渐亮起，你看见夜里的街道。',
      speaker:null,dialogue:null,choices:[],patches:[]}};
    if(request.role==='npc_decision'){
      npcCalls++;
      return {data:{kind:'no_action',speech:null,vote_target:null,intent:'继续自己的日常',
        proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],
        plan_proposals:[],decision_summary:'当前无需额外行动'}};
    }
    plannerCalls++;
    throw Error(`Unexpected planning call: ${request.role}`);
  }});
  const store=new MemoryStore(),service=new GameService(store,ai,demo,[],logger);
  await service.newGame();const save=await service.current();
  save.runtime.time={day:1,minute:624};await store.write(save);
  const directory=await mkdtemp(join(tmpdir(),'agf-wait-http-'));
  const server=createApp(service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  opened.push({server,directory});await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await(await fetch(`${base}/api/session`)).json() as {token:string}).token;
  return {service,logger,base,token,plannerCalls:()=>plannerCalls,npcCalls:()=>npcCalls};
}

async function input(base:string,token:string,service:GameService,text:string){
  const before=await service.current();const request_id=randomUUID();
  const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'content-type':'application/json','X-Game-Token':token},
    body:JSON.stringify({request_id,game_id:before.game_id,expected_revision:before.state_revision,input:text})});
  expect(response.ok,await response.clone().text()).toBe(true);
  return {request_id,result:await response.json(),before,after:await service.current()};
}

it('live HTTP semantics keeps a direct wait until 22:00 out of generic activity',async()=>{
  const f=await livePath(false);
  const {request_id,result,before,after}=await input(f.base,f.token,f.service,'我一直等到晚上十点');
  expect(after.runtime.time).toEqual({day:1,minute:1320});
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.resolution_receipts?.filter(r=>r.request_id===request_id)).toHaveLength(1);
  expect(after.resolution_receipts?.find(r=>r.request_id===request_id)).toMatchObject({
    semantic_action:'WAIT',time_cost:696,commit_status:'committed'});
  expect(result.outcome).toMatchObject({kind:'completed',stage:'temporal_wait'});
  expect(f.plannerCalls()).toBe(0);
  expect(f.npcCalls()).toBeGreaterThan(0);
  expect(f.logger.entries({event:'agent.temporal_wait.admission'}).at(-1)?.metadata).toMatchObject({
    source:'clock_grammar',target:{day:1,minute:1320},minutes:696});
  const skill=f.logger.entries({event:'skill.completed'}).at(-1)!;
  expect(skill.metadata).toMatchObject({skill_id:'temporal_wait',revision_before:before.state_revision,
    revision_after:after.state_revision,receipt_ids:[request_id]});
  expect(f.logger.entries({event:'save.commit'}).at(-1)?.trace_id).toBe(skill.trace_id);
});

it('a semantic time slot handles a standalone natural wait beyond the clock grammar',async()=>{
  const f=await livePath(true);
  const {after,result}=await input(f.base,f.token,f.service,'我就留在这里，等夜色深到十点整');
  expect(after.runtime.time).toEqual({day:1,minute:1320});
  expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe('WAIT');
  expect(result.outcome.kind).toBe('completed');
  expect(f.plannerCalls()).toBe(0);
  expect(f.npcCalls()).toBeGreaterThan(0);
  expect(f.logger.entries({event:'agent.temporal_wait.admission'}).at(-1)?.metadata.source).toBe('semantic_slot');
});

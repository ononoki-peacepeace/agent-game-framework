import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';
import recording from './fixtures/qa27-rest.json' with {type:'json'};
import {ProviderError} from '../src/ai/failures.js';
import {boundLocalDestination} from '../src/core/freeform.js';

const resources:{directory:string;servers:Server[]}[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const r of resources.splice(0)){
  for(const s of r.servers)await new Promise<void>(resolve=>s.close(()=>resolve()));
  await rm(r.directory,{recursive:true,force:true});
}});
async function fixture(fault='none'){
 const directory=await mkdtemp(join(tmpdir(),'agf-rest-')),resource={directory,servers:[] as Server[]};resources.push(resource);
 const stages:string[]=[];
 let releaseNarrator=()=>{},notifyNarrator=()=>{};
 const narratorStarted=new Promise<void>(resolve=>{notifyNarrator=resolve;});
 const narratorGate=new Promise<void>(resolve=>{releaseNarrator=resolve;});
 const ai=new AIRuntime({name:'rest-recording',generate:async request=>{
  const p=(request.schema as any).properties??{};
  if(p.interaction_lane){stages.push('semantic');return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
    answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'world_transaction',
    goal_spec:{objective:recording.input,play_action:'wait',targets:[],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',world_mutation:true,external_artifact:false,multi_step:false}}};}
  if(p.preserved)return {data:{preserved:true,reason:'保留休息授权'}};
  if(p.verdict)return {data:{verdict:'aligned',explanation:'保留休息'}};
  if(p.goals){stages.push('planner');return {data:{goals:recording.plan.goals.map(g=>({goal_id:g.goal_id,type:g.type,normalized_goal:g.normalized_goal,
    depends_on:g.depends_on,condition:g.condition,branch:g.branch,temporal_scope:g.temporal_scope,target_entities:[],operation_hint:g.operation_hint,referent:g.referent}))}};}
  if(p.resolution){stages.push('core_proposal');return {data:{narrative:'按授权休息',minutes:10,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,
    required_conditions:[],resolution:{type:'DETERMINISTIC',domain:'rest',band:'normal',visibility:'public',stakes:'普通休息',stages:[],evidence_ids:[]}}};}
  if(request.role==='narrator'){stages.push('narrator');notifyNarrator();
    if(fault==='response_loss')await narratorGate;
    if(fault==='narrator_failure')throw new ProviderError('timeout','isolated narrator timeout','timeout');
    if(fault==='narrator_schema'&&stages.filter(s=>s==='narrator').length===1)return {data:{narrative:42}};
    return {data:{narrative:'你在长椅上休息了十分钟，随后重新留意起大厅。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],item_claims:[],stable_locations:[],mechanical_claims:[]}};}
  throw Error(`unexpected ${request.role}: ${Object.keys(p)}`);
 }});
 const store=new JsonStore(directory),service=new GameService(store,ai,sparseWorld());await service.newGame();
 const save=await service.current();save.state_revision=348;save.runtime.time={day:1,minute:926};
 save.definition.map!.locations.find(l=>l.id==='square')!.name='中央大厅';
 save.definition.map!.locations.find(l=>l.id==='square')!.description='中央大厅一侧摆着长椅。';await store.write(save);
 const before=await service.current();
 if(fault==='postcommit'||fault==='postcommit_invariant'){
  const original=service.turn.bind(service);vi.spyOn(service,'turn').mockImplementation(async(...args)=>{
    await original(...args);
    if(fault==='postcommit_invariant'){
      // Deliberately simulate a legacy committed image whose activity evidence
      // is missing. Never fabricate success or apply this to a production save.
      const committed=await service.current();for(const receipt of committed.resolution_receipts??[]){delete receipt.activity;receipt.effects=receipt.effects.filter(e=>e!=='activity');}
      await store.write(committed);
    }
    throw Error('isolated response projection failed after commit');
  });
 }
 if(fault==='save'){
  const original=store.write.bind(store);vi.spyOn(store,'write').mockImplementation(async(s,...args)=>{if(s.state_revision>348)throw Error('isolated write failure');return original(s,...args);});
 }
 if(fault==='completion_guard'){
  const original=service.turn.bind(service);vi.spyOn(service,'turn').mockImplementation(async(...args)=>{
    const guard=args[8];args[8]=(before,next,id)=>{
      const receipt=next.resolution_receipts?.find(r=>r.request_id===id);if(receipt){delete receipt.activity;receipt.effects=receipt.effects.filter(e=>e!=='activity');}
      guard?.(before,next,id);
    };return original(...args);
  });
 }
 const open=async(s:GameService)=>{
  // An ephemeral OS port can be on fetch's forbidden-port list. Rebind the
  // isolated test server instead of turning a legal game result into a flake.
  for(let attempt=0;attempt<10;attempt++){
    const server=createApp(s,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
    await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    try{
      const {token}=await(await fetch(base+'/api/session')).json() as any;
      resource.servers.push(server);
      return {base,post:async(path:string,body:unknown,signal?:AbortSignal)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body),signal});return {status:r.status,data:await r.json() as any};}};
    }catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(!/bad port/i.test(String((error as {cause?:unknown}).cause??error)))throw error;}
  }
  throw Error('Could not allocate a fetch-compatible test port');
 };
 return {store,service,ai,before,stages,open,narratorStarted,releaseNarrator,...await open(service)};
}
it.each(['none','postcommit','narrator_schema','narrator_failure'])('recorded rest reaches authoritative success, %s',async fault=>{
 const f=await fixture(fault),body={input:recording.input,game_id:f.before.game_id,expected_revision:348,request_id:randomUUID()};
 const response=await f.post('/api/input',body),after=await f.service.current();
 expect(response.status).toBe(200);expect(response.data.outcome.type).toBe('game');
 expect(after.state_revision).toBe(349);expect(after.runtime.time.minute).toBe(936);
 expect(after.entities.find(e=>e.id==='player')?.components.location).toEqual({location_id:'square'});
 expect(after.entities.find(e=>e.id==='player')?.components.scene_position).toBeUndefined();
 expect(after.resolution_receipts?.find(r=>r.actor_id==='player')).toMatchObject({time_cost:10,commit_status:'committed',activity:{occurred:true,duration_minutes:10}});
 expect(response.data.outcome.receipt_ids).toHaveLength(1);
 if(fault==='narrator_failure')expect(response.data.story??response.data.message).not.toContain('未完成安全结算');
 else expect(response.data.story??response.data.message).toContain('休息');
 expect(f.stages.slice(0,3)).toEqual(['semantic','planner','core_proposal']);
 expect(f.stages.filter(s=>s==='narrator').length).toBeGreaterThan(0);
 expect(f.stages.filter(s=>s==='narrator').length).toBeLessThanOrEqual(3);
 expect((await f.post('/api/input',body)).data).toEqual(response.data);expect((await f.service.current()).state_revision).toBe(349);
 const reloaded=new GameService(new JsonStore(f.store.directory),f.ai,sparseWorld()),reopened=await f.open(reloaded);
 expect((await reopened.post('/api/input',body)).data).toEqual(response.data);
 const status=await(await fetch(reopened.base+`/api/input/status/${body.request_id}?game_id=${body.game_id}`)).json() as any;
 expect(status.state).toBe('completed');
 await reopened.post('/api/undo',{game_id:body.game_id,expected_revision:349,request_id:randomUUID()});
 expect((await reloaded.current()).runtime.time.minute).toBe(926);
});
it.each(['save','completion_guard'])('%s leaves authoritative world unchanged',async fault=>{
 const f=await fixture(fault);await f.post('/api/input',{input:recording.input,game_id:f.before.game_id,expected_revision:348,request_id:randomUUID()});
 expect(await f.service.current()).toEqual(f.before);
});
it('client disconnect during narration recovers the eventual committed result without replay',async()=>{
 const f=await fixture('response_loss'),body={input:recording.input,game_id:f.before.game_id,expected_revision:348,request_id:randomUUID()},controller=new AbortController();
 const pending=f.post('/api/input',body,controller.signal).catch(error=>error);
 await f.narratorStarted;controller.abort();expect((await pending).name).toBe('AbortError');f.releaseNarrator();
 let status:any;
 for(let attempt=0;attempt<50;attempt++){
   status=await(await fetch(f.base+`/api/input/status/${body.request_id}?game_id=${body.game_id}`)).json();
   if(status.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,20));
 }
 expect(status.state).toBe('completed');expect(status.result.outcome.type).toBe('game');
 expect((await f.post('/api/input',body)).data).toEqual(status.result);
 expect((await f.service.current()).runtime.time.minute).toBe(936);expect(f.stages.filter(s=>s==='core_proposal')).toHaveLength(1);
});
it('only binds canonical local anchors, never action text or an unregistered map region',async()=>{
 const f=await fixture(),save=await f.service.current();
 save.entities.push({id:'bench_anchor',type:'item',components:{identity:{name:'长椅',description:'固定座椅',avatar_id:null},location:{location_id:'square'},item:{weight:10,stackable:false}}});
 expect(boundLocalDestination(save,'走到长椅')).toBe('长椅');
 for(const input of [recording.input,'走到长椅坐下','走到长椅站起','走到未登记的露台'])expect(boundLocalDestination(save,input)).toBeNull();
 save.entities.find(e=>e.id==='bench_anchor')!.components.location={location_id:'market'};
 expect(boundLocalDestination(save,'走到长椅')).toBeNull();
});
it('reports committed progress when later completion verification is genuinely inconsistent',async()=>{
 const f=await fixture('postcommit_invariant'),body={input:recording.input,game_id:f.before.game_id,expected_revision:348,request_id:randomUUID()};
 const r=await f.post('/api/input',body);
 expect(r.data.outcome).toMatchObject({type:'engine_failure',state_certain:true,revision:349});
 expect(r.data.outcome.receipt_ids).toHaveLength(1);expect(r.data.outcome.committed_steps).toHaveLength(1);
 expect(r.data.message).toContain('已经结算');expect(r.data.message).not.toContain('没有完成安全结算');
 expect(r.data.story).toContain('休息');expect((await f.service.current()).runtime.time.minute).toBe(936);
 expect((await f.post('/api/input',body)).data).toEqual(r.data);expect(f.stages.filter(s=>s==='core_proposal')).toHaveLength(1);
});

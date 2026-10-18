import {afterEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {goalSpecSchema,type GoalSpec,type CapabilityPlan} from '../src/system/goals.js';
import {StructuredLogger} from '../src/observability/logger.js';
import {composeCapabilityPlan,executeUniversalPlan} from '../src/system/resolver.js';
import {CapabilityRegistry,capabilityRegistry} from '../src/system/capabilities.js';
import {capabilityDigest} from '../src/system/understanding.js';
import type {OpenGoalControl} from '../src/agent/plan-schema.js';
import recordedCancel from './fixtures/qa26-open-goal-cancel.json' with {type:'json'};

const resources:{directory:string;servers:Server[]}[]=[];
const systemResult=(data:any)=>data.system_handoff?.result??data;
afterEach(async()=>{for(const r of resources.splice(0)){
  for(const server of r.servers)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(r.directory,{recursive:true,force:true});
}});

// Only the reported understanding *shape* is retained (unclear + quests). Full
// original provider output / latest request Trace was unavailable. All prose,
// UUIDs and semantic decisions below are explicitly synthetic, never recordings.
async function setup(mode:'semantic'|'understanding'|'legacy'|'recorded'='semantic'){
  const directory=await mkdtemp(join(tmpdir(),'agf-system-goals-'));
  const resource={directory,servers:[] as Server[]};resources.push(resource);
  let control:OpenGoalControl={kind:'cancel',target:'current'};
  let goalPatch:Partial<GoalSpec>={},planPatch:((plan:CapabilityPlan)=>CapabilityPlan)|null=null;
  const calls:string[]=[];
  const goal=()=>goalSpecSchema.parse({...mode==='recorded'&&control.kind==='cancel'&&control.target===recordedCancel.goal.goal_control.target?
    structuredClone(recordedCancel.goal):{objective:'只操作指定的玩家开放目标',goal_control:control,
    persistence:'session',world_mutation:false,external_artifact:false,multi_step:false},...goalPatch});
  const ai=new AIRuntime({name:'isolated-system-control',generate:async request=>{
    const p=(request.schema as any).properties??{};
    if(p.interaction_lane){calls.push('semantic');return {data:{domain:'system',kind:'system_operation',
      operation_plane:'system_management',confidence:.99,answer:null,answer_basis:null,evidence_ids:[],
      clarification:null,speech_target_id:null,interaction_lane:'deterministic_read',
      goal_spec:mode==='semantic'||mode==='recorded'?goal():{...goal(),goal_control:null}}};}
    if(p.aligned){calls.push('plane_alignment');return {data:{aligned:true,reason:'仅管理玩家开放目标'}};}
    if(p.likely_workflow){calls.push('understanding');
      expect(request.prompt).toContain('open_goal.cancel');
      return {data:{understood:['仅取消指定开放目标，不影响其他暂停目标'],requested_change:'指定目标管理',
        target_surfaces:mode==='legacy'?['quests']:['open_goals'],entities:[],unresolved:[],
        likely_workflow:mode==='legacy'?'unclear':'goal_management',goal_control:mode==='legacy'?null:control,
        side_effect_class:'canonical',confidence:.99}};
    }
    if(p.steps&&p.goal){calls.push('capability_plan');
      expect(request.prompt).toContain('open_goal.cancel');
      const plan=composeCapabilityPlan(goal())!;return {data:planPatch?planPatch(plan):plan};
    }
    throw Error(`Unexpected model stage ${request.role}: ${Object.keys(p).join(',')}`);
  }});
  const logger=new StructuredLogger({directory:null,level:'debug'});
  const store=new JsonStore(directory),service=new GameService(store,ai,sparseWorld(),[],logger);await service.newGame();
  const save=await service.current();
  const plan=compileGoalContract(service.project(save),validatePlan({goals:[{goal_id:'one',type:'WORLD_ACTION',
    normalized_goal:'尝试使用尚未取得的钥匙',operation_hint:'other',referent:null,target_entities:[],depends_on:[],
    condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}),{kind:'manual',text:'原始目标'});
  plan.status='blocked';plan.goals[0].status='blocked';
  if(mode==='recorded')plan.plan_id=recordedCancel.goal.goal_control.target;
  save.active_goal={plan,waiting_question:'缺少既有条件',options:[]};
  save.paused_goals=Array.from({length:3},()=>({plan:{...structuredClone(plan),plan_id:randomUUID()},waiting_question:null,options:[]}));
  if(mode==='recorded'){
    save.state_revision=343;save.runtime.time={day:1,minute:905};
    const pausedIds=recordedCancel.goal.constraints[1].match(/[0-9a-f-]{36}/g)!;
    save.paused_goals.forEach((paused,index)=>{
      paused.plan.plan_id=pausedIds[index];
      if(index>0){paused.plan.status='pending';paused.plan.goals[0].status='pending';}
    });
  }
  // If management accidentally schedules the world, this overdue scheduler will
  // try a forbidden NPC model call, or mutate receipts/state and fail the checks.
  save.npc_autonomy_last_at={day:1,minute:0};
  await store.write(save);
  const before=await service.current();
  const open=async(s:GameService)=>{
    const server=createApp(s,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
    resource.servers.push(server);await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const {token}=await (await fetch(base+'/api/session')).json() as {token:string};
    return {post:async(path:string,body:unknown,authorized=true)=>{
      const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Game-Token':token}:{})},body:JSON.stringify(body)});
      return {status:response.status,data:await response.json() as any};
    }};
  };
  const connection=await open(service);
  const request=async(kind:OpenGoalControl['kind'],target:string,path='/api/input')=>{
    control={kind,target};const current=await service.current();
    const body={game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID(),
      input:mode==='recorded'&&kind==='cancel'&&target===recordedCancel.goal.goal_control.target?recordedCancel.input:
        `请${kind==='query'?'查询':kind==='resume'?'恢复':'取消'}目标 ${target}，只操作这一项，不影响其他暂停目标。`};
    return {body,...await connection.post(path,body)};
  };
  return {service,ai,store,before,calls,goal,open,request,logger,...connection,setControl:(c:OpenGoalControl)=>{control=c;},
    setGoalPatch:(patch:Partial<GoalSpec>)=>{goalPatch=patch;},setPlanPatch:(patch:(plan:CapabilityPlan)=>CapabilityPlan)=>{planPatch=patch;}};
}

describe('System delegates Open Goal control to the authoritative persistent executor',()=>{
  // Recorded GoalSpec/CapabilityPlan from the durable failed response, not an
  // idealized empty-output GoalSpec. The outer Semantic envelope and alignment
  // response were not persisted and are explicitly reconstructed above.
  it.each(['semantic','understanding','legacy','recorded'] as const)('%s: HTTP selection -> cancel commit -> query, reload, replay, Undo',async mode=>{
    const f=await setup(mode),id=f.before.active_goal!.plan.plan_id;
    const first=await f.request('cancel',id),after=await f.service.current();
    expect(first.status,JSON.stringify(first.data)).toBe(200);
    expect(systemResult(first.data).message,JSON.stringify(first.data)).toContain('已终止');
    expect(systemResult(first.data).advanced?.goal_control).toMatchObject({status:'cancelled',goal_id:id,receipt_ids:[first.body.request_id]});
    if(mode==='recorded'){
      const result=systemResult(first.data);
      expect(result.advanced.goal).toEqual(recordedCancel.goal);
      expect(result.advanced.plan).toEqual(recordedCancel.plan);
      const authorized=f.logger.entries({event:'system.goal_control.authorized'})[0];
      expect(authorized.request_id).toBe(first.body.request_id);
      expect(authorized.metadata).toMatchObject({output_scope:'single_goal_control_result',output_kinds:['state_change']});
      expect(f.logger.entries({event:'system.goal_control.rejected'})).toHaveLength(0);
    }
    expect(after.active_goal?.plan.status).toBe('failed');
    expect(after.paused_goals).toEqual(f.before.paused_goals);
    expect(after.state_revision).toBe(f.before.state_revision+1);
    expect(after.runtime.time).toEqual(f.before.runtime.time);
    expect(after.entities).toEqual(f.before.entities);
    expect(after.npc_agent_state).toEqual(f.before.npc_agent_state);
    expect(after.npc_autonomy_last_at).toEqual(f.before.npc_autonomy_last_at);
    expect(after.resolution_receipts).toEqual(f.before.resolution_receipts);
    expect(after.runtime.receipts).toHaveLength(f.before.runtime.receipts.length+1);
    expect(after.runtime.receipts.at(-1)?.id).toBe(first.body.request_id);
    expect(f.calls).toEqual(mode==='semantic'||mode==='recorded'?['semantic','plane_alignment']:mode==='understanding'?['semantic','plane_alignment','understanding']:['semantic','plane_alignment','understanding','capability_plan']);
    const duplicate=await f.post('/api/input',first.body);
    expect(duplicate.data).toEqual(first.data);expect((await f.service.current()).state_revision).toBe(after.state_revision);
    const reload=new GameService(new JsonStore(f.store.directory),f.ai,sparseWorld()),reopened=await f.open(reload),calls=f.calls.length;
    expect((await reload.current()).paused_goals).toEqual(f.before.paused_goals);
    expect((await reopened.post('/api/input',first.body)).data).toEqual(first.data);expect(f.calls).toHaveLength(calls);
    const query=await f.request('query',id);
    expect(query.status).toBe(200);expect(systemResult(query.data).message).toContain('failed');
    expect((await f.service.current()).state_revision).toBe(after.state_revision);
    const undo=await reopened.post('/api/undo',{game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    expect(undo.status,JSON.stringify(undo.data)).toBe(200);
    const restored=await reload.current();
    expect(restored.active_goal?.plan.status).toBe('blocked');expect(restored.paused_goals).toEqual(f.before.paused_goals);
    expect(restored.entities).toEqual(f.before.entities);expect(restored.runtime.time).toEqual(f.before.runtime.time);
    f.setControl({kind:'cancel',target:id});
    const old=await executeUniversalPlan(reload,composeCapabilityPlan(f.goal())!,{request_id:first.body.request_id,expected_revision:restored.state_revision});
    expect(old).toMatchObject({handled:true,kind:'EXECUTION_FAILURE'});
    expect((await reload.current()).state_revision).toBe(restored.state_revision);
  });

  it('rejects missing targets and repeated cancellation does not commit again',async()=>{
    const f=await setup();
    const missing=await f.request('cancel',randomUUID());
    expect(systemResult(missing.data).message).toContain('没有符合条件');expect(await f.service.current()).toEqual(f.before);
    await f.request('cancel',f.before.active_goal!.plan.plan_id);
    const cancelled=await f.service.current();
    const repeat=await f.request('cancel',f.before.active_goal!.plan.plan_id);
    expect(systemResult(repeat.data).message).toContain('已经结束');expect(await f.service.current()).toEqual(cancelled);
  });

  it('System endpoint cancels a specified paused plan without touching the other plans',async()=>{
    const f=await setup(),id=f.before.paused_goals![1].plan.plan_id;
    const result=await f.request('cancel',id,'/api/system'),after=await f.service.current();
    expect(result.status,JSON.stringify(result.data)).toBe(200);expect(result.data.message).toContain('已终止');
    expect(after.active_goal).toEqual(f.before.active_goal);
    expect(after.paused_goals).toEqual(f.before.paused_goals!.filter(item=>item.plan.plan_id!==id));
    expect(after.runtime.time).toEqual(f.before.runtime.time);
  });

  it('explicit resume selects the named saved plan and uses its existing contract executor',async()=>{
    const f=await setup(),save=await f.service.current();
    const name=String(save.entities.find(e=>e.id==='npc_lin')!.components.identity.name);
    const plan=compileGoalContract(f.service.project(save),validatePlan({goals:[{goal_id:'presence',type:'WORLD_LOOKUP',
      normalized_goal:`确认${name}的公开位置`,operation_hint:'presence_query',referent:name,target_entities:[],
      depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}),
      {kind:'manual',text:`确认${name}的公开位置`});
    save.paused_goals![1]={plan,waiting_question:null,options:[]};await f.store.write(save);
    const selected=await f.request('resume',plan.plan_id),after=await f.service.current();
    expect(selected.status,JSON.stringify(selected.data)).toBe(200);
    expect(systemResult(selected.data).advanced?.goal_control).toMatchObject({kind:'resume',goal_id:plan.plan_id,status:'resumed'});
    expect(after.active_goal?.plan.plan_id).toBe(plan.plan_id);
    expect(after.active_goal?.plan.status).toBe('completed');
    expect(after.active_goal?.plan.goals[0].contract?.evidence_refs.length).toBeGreaterThan(0);
    expect(after.paused_goals?.some(p=>p.plan.plan_id===save.active_goal!.plan.plan_id)).toBe(true);
    expect(after.paused_goals?.some(p=>p.plan.plan_id===plan.plan_id)).toBe(false);
    expect(after.entities).toEqual(save.entities);expect(after.runtime.time).toEqual(save.runtime.time);
    expect(f.calls).toEqual(['semantic','plane_alignment']);
    await f.request('resume',plan.plan_id);
    expect((await f.service.current()).state_revision).toBe(after.state_revision);
    await f.post('/api/undo',{game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    const restored=await f.service.current();
    f.setControl({kind:'resume',target:plan.plan_id});
    expect(await executeUniversalPlan(f.service,composeCapabilityPlan(f.goal())!,{
      request_id:selected.body.request_id,expected_revision:restored.state_revision})).toMatchObject({kind:'EXECUTION_FAILURE'});
    expect(await f.service.current()).toEqual(restored);
  });

  it('enforces HTTP authorization, capability availability and executor permissions before mutation',async()=>{
    const f=await setup();f.setControl({kind:'cancel',target:f.before.active_goal!.plan.plan_id});
    expect((await f.post('/api/input',{input:'管理目标'},false)).status).toBe(403);
    const plan=composeCapabilityPlan(f.goal())!;
    expect(await executeUniversalPlan(f.service,plan,{}, {permissions:[]})).toMatchObject({kind:'EXECUTION_FAILURE'});
    const registry=new CapabilityRegistry(capabilityRegistry.all().filter(item=>item.id!=='open_goal.cancel'));
    expect(await executeUniversalPlan(f.service,plan,{}, {registry})).toMatchObject({kind:'CAPABILITY_GAP'});
    const mismatch=structuredClone(plan);mismatch.steps[0].input.target=f.before.paused_goals![0].plan.plan_id;
    expect(await executeUniversalPlan(f.service,mismatch)).toMatchObject({kind:'EXECUTION_FAILURE'});
    expect(await executeUniversalPlan(f.service,plan,{game_id:randomUUID()})).toMatchObject({kind:'EXECUTION_FAILURE'});
    expect(await executeUniversalPlan(f.service,plan,{expected_revision:f.before.state_revision+1})).toMatchObject({kind:'EXECUTION_FAILURE'});
    expect(await f.service.current()).toEqual(f.before);
    const digest=capabilityDigest(f.service.project(f.before),f.before) as any;
    expect(digest.executable_capabilities.some((entry:any)=>entry.id==='open_goal.cancel'&&entry.available)).toBe(true);
  });

  it.each([
    ['state write',{desired_state:[{path:'wallet.balance',value:100,target_ref:'player'}]},'goal.desired_state.length'],
    ['independent output',{desired_outputs:[{kind:'entity_delete',description:'另行删除一个人物'}]},'goal.desired_outputs.independent'],
    ['multiple operations',{multi_step:true},'goal.multi_step'],
    ['dependent operation',{dependencies:['执行另一个动作']},'goal.dependencies.length'],
    ['external artifact',{external_artifact:true},'goal.external_artifact'],
    ['player action',{play_action:'move'},'goal.play_action'],
    ['entity target',{targets:[{kind:'entity',reference:'玩家',entity_id:'player'}]},'goal.targets.length'],
  ] as const)('rejects %s through HTTP without swallowing independent intent',async(_name,patch,field)=>{
    const f=await setup('recorded');f.setGoalPatch(structuredClone(patch) as Partial<GoalSpec>);
    const result=await f.request('cancel',f.before.active_goal!.plan.plan_id),r=systemResult(result.data);
    expect(r.category).toBe('EXECUTION_FAILURE');expect(r.advanced.reason_code).toBe('goal_control_authorization_mismatch');
    expect(r.advanced.authorization_issues.map((issue:any)=>issue.field)).toContain(field);
    expect(f.logger.entries({event:'system.goal_control.rejected'})[0].metadata).toMatchObject({reason_code:'goal_control_authorization_mismatch'});
    expect(await f.service.current()).toEqual(f.before);
  });

  it.each(['target','kind','invalid_uuid','two_controls'] as const)('rejects inconsistent capability plan: %s',async mode=>{
    const f=await setup('legacy');
    f.setPlanPatch(plan=>{
      if(mode==='target')plan.steps[0].input.target=randomUUID();
      if(mode==='kind')plan.steps[0].capability_id='open_goal.resume';
      if(mode==='invalid_uuid')plan.steps[0].input.target='not-a-uuid';
      if(mode==='two_controls')plan.steps.push({...structuredClone(plan.steps[0]),step_id:'second_control'});
      return plan;
    });
    const result=await f.request('cancel',f.before.active_goal!.plan.plan_id),r=systemResult(result.data);
    expect(r.category,JSON.stringify(r.advanced)).toBe('EXECUTION_FAILURE');
    expect(r.advanced.reason_code).toBe('goal_control_authorization_mismatch');
    expect(r.advanced.authorization_issues.map((issue:any)=>issue.field)).toContain(
      mode==='target'?'control.target':mode==='kind'?'control.kind':mode==='invalid_uuid'?'control.valid':'steps.length');
    expect(await f.service.current()).toEqual(f.before);
  });
});

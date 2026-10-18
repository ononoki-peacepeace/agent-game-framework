import {afterEach,expect,it,vi} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import type {Server} from 'node:http';
import {sparseSetup} from './sparse-fixture.js';
import {createApp} from '../src/server/app.js';
import {routeContext} from '../src/system/context-router.js';
import {handleSystemInput} from '../src/system/agent.js';
import type {GoalSpec} from '../src/system/goals.js';

const open:{server:Server;directory:string}[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const item of open.splice(0)){
  await new Promise<void>(resolve=>item.server.close(()=>resolve()));
  await rm(item.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
}});
const goal=(text:string,output:GoalSpec['desired_outputs'][number],reference:string,
  desired_state:GoalSpec['desired_state']=[]):GoalSpec=>({objective:text,
  targets:[{kind:'entity',reference,entity_id:null}],desired_state,desired_outputs:[output],
  constraints:[],persistence:'canonical',temporal:{at:null,recurrence:null},dependencies:[],
  world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null});
const semantic=(kind:'world_action'|'system_operation',plane:'play'|'world_authoring'|'framework_development'|'system_management',
  spec:GoalSpec|null)=>({domain:kind==='world_action'?'world':'system',kind,confidence:.98,
  answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
  interaction_lane:kind==='world_action'?'world_transaction':null,operation_plane:plane,goal_spec:spec});
async function fixture(decide:(input:string,recovery?:unknown)=>ReturnType<typeof semantic>,verify=()=>true,
  covered=(_data:unknown)=>true){
  const f=await sparseSetup();Object.defineProperty(f.ai.adapter,'name',{value:'semantic-plane-fixture'});
  const calls:{kind:string;input:string;recovery?:unknown}[]=[];
  vi.spyOn(f.ai,'systemAgent').mockImplementation(async(schema,_profile,data)=>{
    const properties=(z.toJSONSchema(schema) as {properties?:Record<string,unknown>}).properties??{};
    if('aligned' in properties){calls.push({kind:'alignment',input:String((data as any).original_user_request)});
      return {aligned:verify(),reason:'按原始请求审核操作平面'} as never;}
    if('covered' in properties){calls.push({kind:'coverage',input:String((data as any).original_user_request)});
      const complete=covered(data);
      return {covered:complete,uncovered:complete?[]:['附加身份资料']} as never;}
    if('domain' in properties){const input=String((data as any).input);calls.push({kind:'semantic',input,
      recovery:(data as any).semantic_recovery??(data as any).recovery});
      return decide(input,(data as any).recovery) as never;}
    throw Error('unexpected semantic owner bypass');
  });
  const directory=await mkdtemp(join(tmpdir(),'agf-semantic-plane-'));
  const server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');open.push({server,directory});
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const token=(await(await fetch(base+'/api/session')).json()).token;
  const post=async(path:string,input:string)=>{
    const before=await f.service.current();
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
      body:JSON.stringify({input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
    return {status:response.status,body:await response.json()};
  };
  return {...f,post,calls};
}

it('creates a named world character through the world-authoring capability, not development',async()=>{
  const input='新增白川琉璃',f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建当前世界人物'},'白川琉璃')));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(after.entities.filter(entity=>entity.components.identity?.name==='白川琉璃')).toHaveLength(1);
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(f.calls.map(call=>call.kind)).toEqual(['semantic','alignment','coverage']);
});

it('keeps the same world-authoring semantics when entered through the game composer',async()=>{
  const input='新增白川琉璃',f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建当前世界人物'},'白川琉璃')));
  const result=await f.post('/api/input',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.system_handoff?.result?.category).toBe('UNIVERSAL_GOAL');
  expect(after.entities.filter(entity=>entity.components.identity?.name==='白川琉璃')).toHaveLength(1);
});

it('normalizes a redundant action label only inside the semantic owner and audits the plane',async()=>{
  const input='新增白川琉璃';
  const f=await fixture(text=>semantic('world_action','world_authoring',
    goal(text,{kind:'entity_create',description:'创建当前世界人物'},'白川琉璃')));
  const result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(f.calls.map(call=>call.kind)).toEqual(['semantic','alignment','coverage']);
  expect(after.entities.filter(entity=>entity.components.identity?.name==='白川琉璃')).toHaveLength(1);
});

it('keeps framework capability development separate from world creation',async()=>{
  const input='给游戏增加人物创建系统',f=await fixture(text=>semantic('system_operation','framework_development',
    {...goal(text,{kind:'feature',description:'开发人物创建能力'},'人物创建系统'),
      targets:[],world_mutation:false,external_artifact:true}));
  const before=await f.service.current(),result=await handleSystemInput(f.service,{input},
    semantic('system_operation','framework_development',
      {...goal(input,{kind:'feature',description:'开发人物创建能力'},'人物创建系统'),targets:[],world_mutation:false,external_artifact:true}) as never);
  const after=await f.service.current();
  expect(result.directive?.kind).toBe('extension_development');
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.entities).toEqual(before.entities);
});

it('routes finding a named person as play without creating or editing that person',async()=>{
  const input='我去找白川琉璃',f=await fixture(()=>semantic('world_action','play',null));
  const before=await f.service.current(),routed=await routeContext(f.service,input,'system_input');
  expect(routed.destination).toBe('WORLD_INTENT');
  expect(routed.semantic?.operation_plane).toBe('play');
  expect((await f.service.current()).state_revision).toBe(before.state_revision);
});

it('renames the player through an authorized world edit, never a task toggle',async()=>{
  const input='把玩家名字改成藤代澪',f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'state_change',description:'玩家角色名称变更'},'我',
      [{path:'identity.name',value:'藤代澪',target_ref:'target'}])));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.identity?.name).toBe('藤代澪');
  expect(after.state_revision).toBe(before.state_revision+1);
});

it('rejects a wrong high-impact plane at the semantic owner before world write',async()=>{
  const input='新增白川琉璃',f=await fixture(text=>semantic('system_operation','framework_development',
    {...goal(text,{kind:'feature',description:'开发功能'},'白川琉璃'),targets:[],world_mutation:false}),()=>false);
  const before=await f.service.current(),routed=await routeContext(f.service,input,'system_input');
  expect(routed.destination).toBe('AMBIGUOUS');
  expect(f.calls.map(call=>call.kind)).toEqual(['semantic','alignment','semantic','alignment']);
  expect((await f.service.current()).state_revision).toBe(before.state_revision);
  expect((await f.service.current()).entities).toEqual(before.entities);
});

it('revises a wrong first plane only at the semantic boundary, then uses the authorized capability',async()=>{
  const input='新增白川琉璃';let attempts=0;
  const f=await fixture(text=>{
    attempts++;
    return attempts===1?semantic('system_operation','framework_development',
      {...goal(text,{kind:'feature',description:'开发功能'},'白川琉璃'),targets:[],world_mutation:false}):
      semantic('system_operation','world_authoring',
        goal(text,{kind:'entity_create',description:'创建当前世界人物'},'白川琉璃'));
  },()=>attempts>1);
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(f.calls.map(call=>call.kind)).toEqual(['semantic','alignment','semantic','alignment','coverage']);
  expect(f.calls[2].recovery).toMatchObject({failure_code:'semantic_plane_alignment',
    previous_plane:'framework_development'});
  expect(after.entities.filter(entity=>entity.components.identity?.name==='白川琉璃')).toHaveLength(1);
  expect(after.state_revision).toBe(before.state_revision+1);
});

it('blocks a world-edit GoalSpec that changes the authorized target',async()=>{
  const input='新增白川琉璃',f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建当前世界人物'},'白石悠')),()=>false);
  const before=await f.service.current(),result=await routeContext(f.service,input,'system_input'),after=await f.service.current();
  expect(result.destination).toBe('AMBIGUOUS');
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.entities).toEqual(before.entities);
});

it('reports a world-authoring capability gap without granting development authority',async()=>{
  const input='给白川琉璃建立长期社会网络',f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'relationship',description:'创建长期社会网络'},'白川琉璃')));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('CAPABILITY_GAP');
  expect(result.body.directive).toBeUndefined();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.entities).toEqual(before.entities);
});

it('vetoes a character creation plan that would silently omit an authorized attribute',async()=>{
  const input='新增白川琉璃，她是栖枝高中学生。';
  const f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建白川琉璃并登记学生身份'},'白川琉璃')),()=>true,()=>false);
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('CAPABILITY_GAP');
  expect(f.calls.filter(call=>call.kind==='coverage')).toHaveLength(4);
  expect(f.calls.filter(call=>call.kind==='semantic')).toHaveLength(2);
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.entities).toEqual(before.entities);
});

it('returns an omitted Profile field to the semantic owner and succeeds after a bounded correction',async()=>{
  const input='新增白川琉璃，她是栖枝高中学生。';
  const f=await fixture((text,recovery)=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建人物并登记学生身份'},'白川琉璃',
      recovery?[{path:'character.role',value:'栖枝高中学生',target_ref:'target'}]:[])),()=>true,
    data=>Boolean((data as any).authoritative_goal.desired_state.length));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(f.calls.filter(call=>call.kind==='semantic')[1].recovery).toMatchObject({
    failure_code:'goal_capability_coverage',failure_stage:'world_authoring_precommit'});
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.entities.find(entity=>entity.components.identity?.name==='白川琉璃')?.components.character?.role)
    .toBe('栖枝高中学生');
});

it('atomically creates a character with multiple existing Profile fields',async()=>{
  const input='新增白川琉璃，她是栖枝高中学生，性格冷静，讲话简短。';
  const states:GoalSpec['desired_state']=[
    {path:'character.role',value:'栖枝高中学生',target_ref:'target'},
    {path:'character.personality',value:'冷静',target_ref:'target'},
    {path:'character.speech_style',value:'简短',target_ref:'target'},
  ];
  const f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建人物并登记明确的人设'},'白川琉璃',states)));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  const created=after.entities.filter(entity=>entity.components.identity?.name==='白川琉璃');
  expect(created).toHaveLength(1);
  expect(created[0].components.character).toMatchObject({role:'栖枝高中学生',personality:'冷静',speech_style:'简短'});
  expect(after.state_revision).toBe(before.state_revision+1);
});

it('uses the explicit identity name rather than a descriptive target reference',async()=>{
  const input='新增白川琉璃，她是栖枝高中学生。';
  const f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建人物并登记学生身份'},'新角色 白川琉璃',[
      {path:'identity.name',value:'白川琉璃',target_ref:'新角色 白川琉璃'},
      {path:'character.role',value:'栖枝高中学生',target_ref:'新角色 白川琉璃'},
    ])));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.entities.find(entity=>entity.components.identity?.name==='白川琉璃')?.components.character?.role)
    .toBe('栖枝高中学生');
  expect(after.entities.some(entity=>entity.components.identity?.name==='新角色 白川琉璃')).toBe(false);
});

it('rejects an unsupported Profile path before any character is created',async()=>{
  const input='新增白川琉璃并设置尚未支持的秘密资料';
  const f=await fixture(text=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建人物和秘密资料'},'白川琉璃',
      [{path:'character.secret_fate',value:'未提供能力',target_ref:'target'}])));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.body.category).toBe('CAPABILITY_GAP');
  expect(result.body.advanced?.missing).toContain('character.secret_fate');
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.entities).toEqual(before.entities);
});

it('returns invalid Profile parameters to the semantic owner before an atomic retry',async()=>{
  const input='新增白川琉璃，性格谨慎。';
  const f=await fixture((text,recovery)=>semantic('system_operation','world_authoring',
    goal(text,{kind:'entity_create',description:'创建人物并登记性格'},'白川琉璃',[
      {path:'character.personality',value:'谨慎',target_ref:'target'},
      ...(recovery?[]:[{path:'identity.gender',value:'女',target_ref:'target'}]),
    ])));
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(f.calls.filter(call=>call.kind==='semantic')[1].recovery).toMatchObject({
    failure_code:'profile_parameters_invalid'});
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.entities.find(entity=>entity.components.identity?.name==='白川琉璃')?.components.character?.personality)
    .toBe('谨慎');
});

it('returns a downstream authorization mismatch to the one semantic owner for correction',async()=>{
  const input='新增白川琉璃';let attempts=0;
  const f=await fixture(text=>{
    attempts++;
    const spec=goal(text,{kind:'entity_create',description:'创建当前世界人物'},'白川琉璃');
    return semantic('system_operation','world_authoring',
      attempts===1?{...spec,world_mutation:false}:spec);
  });
  const before=await f.service.current(),result=await f.post('/api/system',input),after=await f.service.current();
  expect(result.status).toBe(200);
  expect(result.body.category).toBe('UNIVERSAL_GOAL');
  expect(f.calls.map(call=>call.kind)).toEqual(['semantic','alignment','semantic','alignment','coverage']);
  expect(after.entities.filter(entity=>entity.components.identity?.name==='白川琉璃')).toHaveLength(1);
  expect(after.entities.some(entity=>entity.components.identity?.name==='白石悠')).toBe(false);
  expect(after.state_revision).toBe(before.state_revision+1);
});

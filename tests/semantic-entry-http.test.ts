import {afterEach,expect,it,vi} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {demo,fresh,MemoryStore} from './helpers.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {ProviderError} from '../src/ai/failures.js';
import {agentResult} from '../src/agent/contracts.js';
import {publicView} from '../src/core/state.js';

const openServers:{server:Server;directory:string}[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const {server,directory} of openServers.splice(0)){
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});

async function setup(recoverEvidence=false){
  const seen:string[]=[],contexts:Record<string,any>[]=[];
  const ai=new AIRuntime({name:'semantic-fixture',generate:async request=>{
    if(request.role!=='gm_reasoning')throw Error('unexpected provider call');
    const properties=(request.schema as {properties?:Record<string,unknown>})?.properties??{};
    if('verdict' in properties){
      const data=JSON.parse(request.prompt.split('\n\n').at(-1)!) as {original_request:string};
      return {data:{verdict:data.original_request==='尝试打开仓库的锁'?'incomplete':'aligned',
        explanation:'核对原请求与完整计划。'}};
    }
    if('message' in properties&&Object.keys(properties).length===1)return {data:{message:'风格设置已按实际结果处理。'}};
    const prompt=request.prompt;
    const input=JSON.parse(prompt.split('\n\n').at(-1)!) as {input:string;world:{interaction_context:unknown};pending_clarification:unknown;
      public_evidence:{id:string;value:any}[]};
    seen.push(input.input);
    contexts.push(input);
    if(input.input==='请缩短此后旁白')return {data:{domain:'system',kind:'system_operation',confidence:.98,
      answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null}};
    if(input.input==='前一回合和谁交谈'){
      const fact=input.public_evidence.find(entry=>entry.id==='last_dialogue');
      return {data:{domain:'world',kind:'read_only',confidence:.98,
        answer:`前一回合与${fact?.value.speaker??'未登记人物'}交谈。`,answer_basis:'world_fact',
        evidence_ids:['last_dialogue'],clarification:null,speech_target_id:null}};
    }
    if(input.input==='盘点身上所有已登记物品')return {data:{domain:'world',kind:'read_only',confidence:.98,
      answer:'目前背包为空。',answer_basis:'world_fact',
      evidence_ids:['entity:player.inventory.items'],clarification:null,speech_target_id:null}};
    if(input.input==='谈谈乔宁所在位置')return {data:{domain:'world',kind:'read_only',confidence:.98,
      answer:'乔宁在market，玩家在square，林舟也在square。',answer_basis:'world_fact',
      evidence_ids:['entity:npc_qiao.location.location_id','entity:player.location.location_id'],clarification:null,speech_target_id:null}};
    if(input.input==='你别这样说了')return {data:{domain:'ambiguous',kind:'clarification',confidence:.55,
      answer:null,answer_basis:null,evidence_ids:[],clarification:'你是在询问，还是要求修改回复风格？',speech_target_id:null}};
    if(input.input==='我说的是回复风格')return {data:{domain:'system',kind:'read_only',confidence:.96,
      answer:'明白，我们可以先讨论回复风格。',answer_basis:'reasoned_advice',evidence_ids:[],clarification:null,speech_target_id:null}};
    if(['去河岸车站','尝试打开仓库的锁','先去街角商店，再去河岸车站','在院内尝试攀墙',
      '我想去河岸车站领取寄存的行李','去河岸车站并签收包裹'].includes(input.input))
      return {data:{domain:'world',kind:'world_action',confidence:.98,
      answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null}};
    if(input.input==='凭空认定我有秘密钥匙吗？'&&recoverEvidence&&seen.filter(value=>value===input.input).length===2)
      return {data:{domain:'world',kind:'read_only',confidence:.97,
        answer:'现有公开资料无法确认你有这把钥匙。',answer_basis:'unknown',evidence_ids:[],clarification:null,speech_target_id:null}};
    if(input.input==='凭空认定我有秘密钥匙吗？')return {data:{domain:'world',kind:'read_only',confidence:.97,
      answer:'你拥有秘密钥匙。',answer_basis:'world_fact',evidence_ids:['invented:key'],clarification:null,speech_target_id:null}};
    return {data:{domain:'world',kind:'read_only',confidence:.97,
      answer:'这是一个可以讨论的设想；目前没有执行角色行动。',answer_basis:'reasoned_advice',
      evidence_ids:[],clarification:null,speech_target_id:null}};
  }});
  const planned=vi.spyOn(ai,'planGoals').mockImplementation(async(_view,input)=>{
    if(input==='去河岸车站并签收包裹')return {goals:[{goal_id:'travel',type:'WORLD_ACTION',
      normalized_goal:'前往河岸车站',depends_on:['missing_delivery'],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],operation_hint:'move',
      referent:'河岸车站'}]};
    if(input==='我想去河岸车站领取寄存的行李'){
      const first:GoalInput={goal_id:'travel',type:'WORLD_ACTION',normalized_goal:'前往河岸车站',depends_on:[],
        condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],
        operation_hint:'move',referent:'河岸车站'};
      return {goals:[first,{...first,goal_id:'collect',normalized_goal:'领取寄存的行李',depends_on:['travel'],
        operation_hint:'other',referent:'寄存的行李'}]};
    }
    if(input==='在院内尝试攀墙')return {goals:[{goal_id:'attempt',type:'WORLD_ACTION',normalized_goal:input,
      depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},
      target_entities:[],operation_hint:'other'}]};
    if(input==='先去街角商店，再去河岸车站'){
      const first:GoalInput={goal_id:'first',type:'WORLD_ACTION',normalized_goal:'去街角商店',depends_on:[],
        condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],
        operation_hint:'move',referent:'街角商店'};
      return {goals:[first,{...first,goal_id:'second',normalized_goal:'去河岸车站',depends_on:['first'],referent:'河岸车站'}]};
    }
    const goal:GoalInput={goal_id:'move',type:'WORLD_ACTION',normalized_goal:input,depends_on:[],
      condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[],
      operation_hint:'move',referent:'河岸车站'};
    return {goals:[goal]};
  });
  vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你沿着道路来到河岸车站。',speaker:null,
    dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,
    item_claims:[],stable_locations:[],mechanical_claims:[]});
  const service=new GameService(new MemoryStore(),ai,structuredClone(demo));
  await service.newGame();
  const directory=await mkdtemp(join(tmpdir(),'agf-semantic-entry-'));
  const server=createApp(service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');openServers.push({server,directory});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
  const post=async(path:string,input:string)=>{
    const save=await service.current();
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
      body:JSON.stringify({request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input})});
    return {response,body:await response.json() as Record<string,any>};
  };
  return {service,ai,seen,contexts,planned,post};
}

it('keeps discussions and hypothetical questions read only across both HTTP composers',async()=>{
  const env=await setup(),before=await env.service.current();
  const first=await env.post('/api/input','如果我明天想旅行，会发生什么？');
  const second=await env.post('/api/system','我可以先讨论旅行计划吗？');
  expect(first.response.ok).toBe(true);expect(first.body.message).toContain('讨论');
  expect(second.response.ok).toBe(true);expect(second.body.category).toBe('SYSTEM_ANSWER');
  expect(second.body.directive).toBeUndefined();expect(env.planned).not.toHaveBeenCalled();
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.entities).toEqual(before.entities);
  expect(env.seen).toEqual(['如果我明天想旅行，会发生什么？','我可以先讨论旅行计划吗？']);
  expect(env.contexts[1].world.interaction_context).toBeNull();
});

it('keeps the original request available while resolving a clarification',async()=>{
  const env=await setup(),before=await env.service.current();
  const first=await env.post('/api/input','你别这样说了');
  expect(first.body.intent).toBe('CLARIFICATION');
  const second=await env.post('/api/input','我说的是回复风格');
  expect(second.body.message).toContain('讨论回复风格');
  expect(env.contexts[1].pending_clarification.input).toBe('你别这样说了');
  expect((await env.service.current()).state_revision).toBe(before.state_revision);
});

it('answers committed conversation history and an empty inventory without a world turn',async()=>{
  const env=await setup(),seed=await env.service.current();
  seed.last_turn={narrative:'你们在广场交谈。',speaker:'npc_lin',dialogue:'明天见。',choices:[],context_actions:[]};
  seed.narrative_history=[{request_id:randomUUID(),narrative:'你们在广场交谈。',speaker:'npc_lin',
    dialogue:'明天见。',facts:[]}];
  await env.service.storage.write(seed);
  const history=await env.post('/api/input','前一回合和谁交谈');
  const inventory=await env.post('/api/input','盘点身上所有已登记物品');
  expect(history.body.message).toContain('林舟');
  expect(inventory.body.message).toContain('背包为空');
  expect(env.contexts[0].public_evidence.some((entry:{id:string})=>entry.id==='last_dialogue')).toBe(true);
  expect(env.contexts[1].public_evidence.some((entry:{id:string})=>entry.id==='entity:player.inventory.items')).toBe(true);
  const after=await env.service.current();
  expect(after.state_revision).toBe(seed.state_revision);
  expect(after.runtime.time).toEqual(seed.runtime.time);
  expect(after.resolution_receipts).toEqual(seed.resolution_receipts);
});

it('passes the complete public location and route catalog as citable read-only evidence',async()=>{
  const env=await setup(),before=await env.service.current(),view=await env.service.view();
  const result=await env.post('/api/system','谈谈乔宁所在位置');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  const evidence=env.contexts[0].public_evidence as {id:string;value:any}[];
  for(const place of view!.locations){
    expect(evidence.find(entry=>entry.id===`location:${place.id}`)?.value).toMatchObject({id:place.id,name:place.name});
  }
  for(const [index,route] of view!.routes.entries()){
    expect(evidence.find(entry=>entry.id===`route:${index}`)?.value).toEqual(route);
  }
  expect((await env.service.current()).state_revision).toBe(before.state_revision);
});

it('hands a world-composer configuration request to existing System permissions',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','请缩短此后旁白');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(result.body.intent).toBe('SYSTEM_META_INTENT');
  expect(result.body.system_handoff.result.category).toBe('BEHAVIOR_CONFIGURATION');
  const after=await env.service.current();
  expect(after.behavior_config?.length).toBeGreaterThan(before.behavior_config?.length??0);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.resolution_receipts).toEqual(before.resolution_receipts);
});

it('sends authorized movement through the existing contract and world transaction',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','去河岸车站');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(env.planned).toHaveBeenCalledTimes(1);
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('station');
  expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe('MOVE');
});

it('uses the same semantic decision for a world action entered in System',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/system','去河岸车站');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(result.body.category).toBe('IN_WORLD_INPUT');
  expect(env.planned).toHaveBeenCalledTimes(1);
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision+1);
  expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('station');
});

it('blocks a substituted preparation before any MOVE receipt or time change',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','尝试打开仓库的锁');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(result.body.message).toContain('只规划出准备步骤');
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  expect(after.entities).toEqual(before.entities);
});

it('allows a complete authorized two-step route with two committed MOVE receipts',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','先去街角商店，再去河岸车站');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  const after=await env.service.current();
  expect(after.state_revision,JSON.stringify(result.body)).toBeGreaterThan(before.state_revision);
  expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
  expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('station');
  expect(after.resolution_receipts?.filter(receipt=>receipt.commit_status==='committed').map(receipt=>receipt.semantic_action)).toEqual(['MOVE','MOVE']);
});

it('preserves a final goal after its preparation and blocks unsupported completion before committing',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','我想去河岸车站领取寄存的行李');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(result.body.plan?.execution_order).toEqual(['travel','collect']);
  expect(result.body.plan?.goals.map((goal:GoalInput)=>goal.normalized_goal)).toEqual(['前往河岸车站','领取寄存的行李']);
  expect(result.body.plan?.goals[1].depends_on).toEqual(['travel']);
  expect(result.body.plan?.goals[1].status).toBe('blocked');
  expect(result.body.message).toContain('领取寄存的行李');
  expect(result.body.message).toContain('缺少可验证的执行或完成方式');
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  expect(after.entities).toEqual(before.entities);
});

it('reports conversion failure against the original request rather than calling preparation a complete plan',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','去河岸车站并签收包裹');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(result.body.message).toContain('去河岸车站并签收包裹');
  expect(result.body.message).toContain('无效依赖');
  expect(result.body.message).not.toContain('只规划出准备步骤');
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.resolution_receipts).toEqual(before.resolution_receipts);
});

it('resolves known entity IDs in read-only answers on both composers and in action feedback',async()=>{
  const env=await setup(),before=await env.service.current();
  for(const path of ['/api/input','/api/system']){
    const result=await env.post(path,'谈谈乔宁所在位置');
    expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
    expect(result.body.message).toContain('街角商店');
    expect(result.body.message).toContain('中央广场');
    expect(result.body.message).not.toMatch(/\b(?:market|square)\b/);
  }
  const feedback=agentResult('WORLD_ACTION','已在station看到npc_lin。',{view:publicView(before)});
  expect(feedback.message).toContain('河岸车站');
  expect(feedback.message).toContain('林舟');
  expect(feedback.message).not.toContain('npc_lin');
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.resolution_receipts).toEqual(before.resolution_receipts);
});

it('keeps provider truncation diagnostics out of the HTTP action result',async()=>{
  const env=await setup(),before=await env.service.current();
  vi.spyOn(env.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
  vi.spyOn(env.ai,'freeform').mockRejectedValue(new ProviderError('max_output_tokens','hidden detail',
    'DeepSeek 响应未完成：输出达到最大 Token 限制（max_output_tokens），响应未完成'));
  const result=await env.post('/api/input','在院内尝试攀墙');
  expect(result.response.ok,JSON.stringify(result.body)).toBe(true);
  expect(result.body.message).toContain('模型响应未完整生成');
  expect(JSON.stringify(result.body)).not.toContain('max_output_tokens');
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.resolution_receipts).toEqual(before.resolution_receipts);
});

it('rejects unsupported factual evidence before any world action or development task',async()=>{
  const env=await setup(),before=await env.service.current();
  const result=await env.post('/api/input','凭空认定我有秘密钥匙吗？');
  expect(result.response.ok).toBe(true);expect(result.body.intent).toBe('CLARIFICATION');
  expect(result.body.message).not.toContain('你拥有秘密钥匙');
  expect(env.planned).not.toHaveBeenCalled();
  const after=await env.service.current();
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(env.seen).toEqual(['凭空认定我有秘密钥匙吗？','凭空认定我有秘密钥匙吗？']);
});

it('reinterprets once before side effects when the first answer cites invented evidence',async()=>{
  const env=await setup(true),before=await env.service.current();
  const result=await env.post('/api/input','凭空认定我有秘密钥匙吗？');
  expect(result.response.ok).toBe(true);
  expect(result.body.message).toContain('无法确认');
  expect(env.planned).not.toHaveBeenCalled();
  expect((await env.service.current()).state_revision).toBe(before.state_revision);
  expect(env.seen).toHaveLength(2);
});

it('retries a truncated freeform response once with a bounded shorter prompt',async()=>{
  const requests:{prompt:string;maxOutputTokens?:number}[]=[];
  const ai=new AIRuntime({name:'fixture',generate:async request=>{
    requests.push({prompt:request.prompt,maxOutputTokens:request.maxOutputTokens});
    throw new ProviderError('max_output_tokens','incomplete','provider incomplete');
  }});
  await expect(ai.freeform(fresh(),'尝试翻过院墙')).rejects.toBeInstanceOf(ProviderError);
  expect(requests).toHaveLength(2);
  expect(requests[1].prompt.length).toBeLessThan(requests[0].prompt.length);
  expect(requests.map(request=>request.maxOutputTokens)).toEqual([4000,6000]);
});

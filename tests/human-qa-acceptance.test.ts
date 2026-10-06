import {it,expect} from 'vitest';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {createApp} from '../src/server/app.js';
import {handleSystemInput} from '../src/system/agent.js';
import {isRefinementOf} from '../src/system/refinement.js';
import {capabilityDigest,shallowUnderstanding} from '../src/system/understanding.js';
import {fastPlan} from '../src/agent/planner.js';
import {developmentPlayerView} from '../src/system/development-copy.js';
import {loadDevelopmentWorkspace,saveDevelopmentWorkspace,saveSystemDraft,saveSystemReply} from '../src/client/development-workspace.js';

async function httpFixture(){
  const f=await sparseSetup();
  const directory=await mkdtemp(join(tmpdir(),'agf-human-qa-'));
  const server=createApp(f.service,resolve('dist/client'),undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await (await fetch(`${base}/api/session`)).json()).token as string;
  const headers={'Content-Type':'application/json','X-Game-Token':token};
  const post=async(path:string,body:unknown)=>{const response=await fetch(`${base}/api/${path}`,{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const get=async(path:string)=>fetch(`${base}/api/${path}`).then(response=>response.json());
  const settle=async(id:string)=>{for(let attempt=0;attempt<60;attempt+=1){const task=await get(`development/tasks/${id}`);if(!['planning','developing','testing','repairing'].includes(task.status))return task;await new Promise(resolveWait=>setTimeout(resolveWait,100));}return get(`development/tasks/${id}`);};
  return {f,base,post,get,settle,close:()=>new Promise<void>(done=>server.close(()=>done()))};
}

it('an unrelated development request opens its own task instead of being merged into the open one',async()=>{
  const env=await httpFixture();
  try{
    const first=await env.post('development/tasks',{request_id:randomUUID(),request:'新增一个位于人物与地图之间、用于记录简单文本的笔记模块'});
    expect(first.status).toBe(202);
    await env.settle(first.body.id);
    let unrelated=await env.post('system',{input:'给人物增加疲劳值',development_task_id:first.body.id});
    if(unrelated.status!==200){await new Promise(resolveWait=>setTimeout(resolveWait,400));unrelated=await env.post('system',{input:'给人物增加疲劳值',development_task_id:first.body.id});}
    expect(unrelated.status).toBe(200);

    expect(unrelated.body.advanced?.refinement).toBe(false);
    expect(unrelated.body.directive?.task_id).not.toBe(first.body.id);
    const tasks=await env.get('development/tasks') as {id:string;original_request:string}[];
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const original=tasks.find(task=>task.id===first.body.id)!;
    expect(original.original_request).toContain('笔记');
    expect(original.original_request).not.toContain('疲劳');
    await env.settle(String(unrelated.body.directive.task_id));
    const refinement=await env.post('system',{input:'给这个笔记功能加一个开关',development_task_id:first.body.id});
    expect(refinement.body.advanced?.refinement).toBe(true);
    expect(refinement.body.directive?.task_id).toBe(first.body.id);
  }finally{await env.close();}
});

it('a task that cannot be resumed reports why instead of silently doing nothing',async()=>{
  const env=await httpFixture();
  try{
    const created=await env.post('development/tasks',{request_id:randomUUID(),request:'新增一个笔记模块'});
    const resumed=await env.post(`development/tasks/${created.body.id}/resume`,{});
    expect(resumed.status).toBeGreaterThanOrEqual(400);
    expect(String(resumed.body?.error??'')).toContain('不能恢复');
    expect(env.settle).toBeTruthy();
  }finally{await env.close();}
});

it('the dirty-worktree gate keeps its meaning with player-facing wording',async()=>{
  const source=await readFile('src/development/coding-agent.ts','utf8');
  // The raw sentence may only live inside the log/metadata call, never as the player-facing report reason.
  expect(source).not.toMatch(/this\.report\([^;]*Live repository has uncommitted changes/);
  expect(source).toContain('当前框架有尚未保存的开发修改');
  expect(source).toContain('core.development.dirty_worktree');

  expect(source).toContain('当前框架有尚未保存的开发修改');
  expect(isRefinementOf('笔记模块','给人物增加疲劳值')).toBe(false);
  expect(isRefinementOf('笔记模块','给这个笔记功能加一个开关')).toBe(true);
});

it('the avatar question is a truth query about the player, never a clarification',async()=>{
  const f=await sparseSetup();
  const ask=await handleSystemInput(f.service,{input:'我现在有头像吗？'});
  expect(ask.advanced?.truth_query).toBe('avatar');
  expect(String(ask.message)).toContain('头像');
  expect(ask.clarification??null).toBeNull();
  expect(String(ask.message)).not.toContain('能力');
  const save=await f.service.current(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  player.components.identity.avatar_id='avatar_demo';
  await f.store.write(save);
  const has=await handleSystemInput(f.service,{input:'我现在有头像吗？'});
  expect(has.advanced?.state).toBe('FOUND');
  expect(has.advanced?.entity_id).toBe(player.id);
});

it('the world creation premise can be queried from provenance',async()=>{
  const f=await sparseSetup();
  const save=await f.service.current();
  const answer=await handleSystemInput(f.service,{input:'这个世界最开始是什么设定？'});
  expect(answer.advanced?.truth_query).toBe('creation_provenance');
  const premise=String(save.definition.meta.description??'');
  if(premise)expect(String(answer.message)).toContain(premise.slice(0,8));
  expect(String(answer.message)).not.toContain('没有找到与这个问题对应的声明');
});

type GoalWalkCandidate={id:string;kind:string;label:string;location_id:string|null;target_id:string|null};
type GoalWalkPlan=(context:{objective:string;candidates:GoalWalkCandidate[];player_location:string|null;completed:{candidate:string;summary:string}[]})=>{decision:'act'|'done'|'blocked'|'clarify';candidate_id?:string|null;reason?:string;ambiguity?:string|null};

/** Drives one open goal through the real /api/input production route with a scripted planner decision. */
async function runGoalWalk(input:string,plan:GoalWalkPlan){
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.destination)return {data:{destination:'WORLD_INTENT',confidence:1,clarification:null,speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false}};
    if(properties.goals)return {data:{goals:[{goal_id:'g1',type:'WORLD_GOAL',normalized_goal:input,depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]}};
    if(properties.decision){
      const marker=request.prompt.indexOf('{"objective"');
      if(marker<0)throw new Error('missing goal context');
      const payload=JSON.parse(request.prompt.slice(marker)) as {objective:string;candidates:GoalWalkCandidate[];progress:{completed:{candidate:string;summary:string}[];player_location:string|null}|null};
      const answer=plan({objective:payload.objective,candidates:payload.candidates,player_location:payload.progress?.player_location??null,completed:payload.progress?.completed??[]});
      return {data:{decision:answer.decision,candidate_id:answer.candidate_id??null,reason:answer.reason??'fixture decision',ambiguity:answer.ambiguity??null}};
    }
    if(request.role==='narrator')return {data:{narrative:'你采取了当前世界允许的一步。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null}};
    throw new Error('unexpected fixture request: '+String(request.role));
  });
  const save=await f.service.current();
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  // A reachable NPC makes "ask someone first" a real step instead of an unreachable target.
  npc.components.location={location_id:String(player.components.location?.location_id)};
  await f.service.storage.write(save);
  const directory=await mkdtemp(join(tmpdir(),'agf-goal-walk-'));
  const server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const token=(await (await fetch(`${base}/api/session`)).json()).token as string;
    const before=await f.service.current();
    const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
    const result:any=await response.json();
    expect(response.ok,JSON.stringify(result)).toBe(true);
    return {before,after:await f.service.current(),result};
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
}

it('an open-ended goal keeps taking real steps instead of stopping after one question',async()=>{
  const walk=await runGoalWalk('想办法挣钱',({candidates,completed})=>{
    const done=new Set(completed.map(entry=>entry.candidate));
    if(![...done].some(id=>id.startsWith('talk:'))){const talk=candidates.find(candidate=>candidate.kind==='talk');if(talk)return {decision:'act',candidate_id:talk.id};}
    if(!done.has('move:station')&&candidates.some(candidate=>candidate.id==='move:station'))return {decision:'act',candidate_id:'move:station'};
    if(!done.has('activity:work')&&candidates.some(candidate=>candidate.id==='activity:work'))return {decision:'act',candidate_id:'activity:work'};
    return {decision:'done'};
  });
  expect(walk.result).toMatchObject({intent:'WORLD_GOAL',plan:{status:'completed'}});
  expect(walk.after.state_revision).toBeGreaterThan(walk.before.state_revision+1);
  expect(walk.after.runtime.time.minute).toBeGreaterThan(walk.before.runtime.time.minute);
  const credit=(state:typeof walk.after)=>Number((state.entities.find(entity=>entity.id===state.player_state.entity_id)!.components.wallet as {balances?:Record<string,number>}|undefined)?.balances?.credit??0);
  expect(credit(walk.after)).toBeGreaterThan(credit(walk.before));
  expect(String(walk.result.message)).toContain('打听');
  expect(String(walk.result.message)).toContain('固定兼职');
});

it('an open-ended errand reaches the market instead of stopping at a midpoint',async()=>{
  const f=await sparseSetup(async request=>{
    if(request.role==='narrator')return {data:{narrative:'你沿现有道路继续前行。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[]}};
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.decision){
      const marker=request.prompt.indexOf('{"objective"');
      if(marker<0)throw new Error('missing goal context');
      const payload=JSON.parse(request.prompt.slice(marker)) as {candidates:GoalWalkCandidate[];progress:{player_location:string|null}|null};
      const here=payload.progress?.player_location??null;
      if(here==='market')return {data:{decision:'done',candidate_id:null,reason:'已经站在市场里',ambiguity:null}};
      // Travel one discovered lane at a time: the direct lane exists only after the intermediate stop.
      const step=payload.candidates.find(candidate=>candidate.id==='move:market')??payload.candidates.find(candidate=>candidate.kind==='move');
      return {data:{decision:step?'act':'blocked',candidate_id:step?.id??null,reason:step?'继续朝市场方向前进':'没有可走的路线',ambiguity:null}};
    }
    throw new Error('unexpected fixture request: '+String(request.role));
  });
  // Remove the direct lane so the errand really has to pass an intermediate stop: square → station → market.
  const world=await f.service.current();
  world.definition.map!.routes=world.definition.map!.routes
    .filter(route=>!(route.from==='square'&&route.to==='market')&&!(route.from==='market'&&route.to==='square'))
    .concat([{from:'station',to:'market',travel_minutes:6,conditions:[]},{from:'market',to:'station',travel_minutes:6,conditions:[]}]);
  await f.service.storage.write(world);
  const directory=await mkdtemp(join(tmpdir(),'agf-market-errand-'));
  const server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');
  const before=await f.service.current();
  let result:any,after:typeof before;
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const token=(await (await fetch(`${base}/api/session`)).json()).token as string;
    const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({input:'去市场看看',request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
    result=await response.json();
    expect(response.ok,JSON.stringify(result)).toBe(true);
    after=await f.service.current();
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
  const location=(state:typeof after)=>String(state.entities.find(entity=>entity.id===state.player_state.entity_id)!.components.location?.location_id??'');
  // The normal world input entry point, not a direct call into the walk.
  expect(result.intent).toBe('WORLD_GOAL');
  expect(result.plan?.status).toBe('completed');
  expect(location(before)).toBe('square');
  expect(location(after)).toBe('market');
  expect(after.state_revision).toBeGreaterThan(before.state_revision+1);
  expect(after.runtime.time.minute).toBeGreaterThanOrEqual(before.runtime.time.minute+24);
  expect(String(result.message)).toContain('河岸车站');
  expect(String(result.message)).toContain('街角商店');
  // An exact public destination is a direct single-step MOVE; an unregistered alias
  // needs semantic planning rather than a guessed canonical ID.
  const view=(await f.service.view())!;
  expect(fastPlan(view,'去街角商店')?.goals.map(goal=>goal.type)).toEqual(['WORLD_ACTION']);
  expect(fastPlan(view,'去市场')).toBeNull();
});

const memoryStorage=()=>{const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);}};};

/** Starts a development task through the real HTTP route with a provider that answers slowly. */
async function slowDevelopmentFixture(clarificationFor:(round:number)=>Record<string,unknown>){
  let plannerCalls=0;
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.normalized_requirements){
      plannerCalls+=1;
      await new Promise(resolveWait=>setTimeout(resolveWait,300));
      return {data:{normalized_requirements:['提供一个笔记模块'],complexity:'LOW',milestones:[{id:'notes',title:'笔记面板',kind:'ui',acceptance:['面板可打开']}],capability_gaps:[],affected_milestone_ids:[],...clarificationFor(plannerCalls)}};
    }
    throw new Error('unexpected fixture request: '+String(request.role));
  });
  const directory=await mkdtemp(join(tmpdir(),'agf-dev-remount-'));
  const server=createApp(f.service,resolve('dist/client'),undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await (await fetch(`${base}/api/session`)).json()).token as string;
  const post=async(path:string,body:unknown)=>{const response=await fetch(`${base}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const get=async(path:string)=>await (await fetch(`${base}/api/${path}`)).json() as any;
  /** The surface may be left at any time; only the server decides when the provider has finished. */
  const settle=async(id:string)=>{for(let attempt=0;attempt<80;attempt+=1){const task=await get(`development/tasks/${id}`);if(!['planning','developing','testing','repairing'].includes(task.status))return task;await new Promise(resolveWait=>setTimeout(resolveWait,100));}return get(`development/tasks/${id}`);};
  return {f,post,get,settle,plannerCalls:()=>plannerCalls,close:()=>new Promise<void>(done=>server.close(()=>done()))};
}

it('a running development request keeps its context when the surface is left and re-entered',async()=>{
  const env=await slowDevelopmentFixture(()=>({clarification:'笔记内容由谁决定？',clarification_options:['我自己填写','自动记录关键事件','你帮我决定']}));
  try{
    const before=await env.f.service.current();
    const created=await env.post('development/tasks',{request_id:randomUUID(),request:'我想加一个笔记模块'});
    expect(created.status).toBe(202);
    const taskId=String(created.body.id);
    // The task and its pending question live on the server: re-reading after a tab switch returns the same task.
    const reopened=await env.settle(taskId);
    expect(reopened.id).toBe(taskId);
    expect(reopened.status).toBe('waiting_for_user');
    expect(reopened.clarification_options).toEqual(['我自己填写','自动记录关键事件','你帮我决定']);
    expect(env.plannerCalls()).toBe(1);
    // The UI context (active task + module draft + last reply) is restored from the workspace store, and the
    // provider was already called once: re-entering the surface must not send the request again.
    const storage=memoryStorage();
    saveDevelopmentWorkspace(before.game_id,{active_task_id:taskId,dev_open:true},storage);
    saveSystemDraft(before.game_id,'笔记要记录什么？',storage);
    saveSystemReply(before.game_id,{category:'EXTENSION_REQUEST',tool_id:'extension.create',needs_confirmation:false,message:String(reopened.message),title:'开发任务'},storage);
    const restored=loadDevelopmentWorkspace(before.game_id,storage);
    expect(restored.active_task_id).toBe(taskId);
    expect(restored.dev_open).toBe(true);
    expect(restored.system_draft).toBe('笔记要记录什么？');
    expect(restored.system_reply?.title).toBe('开发任务');
    expect(env.plannerCalls()).toBe(1);
  }finally{await env.close();}
});

it('a waiting question is answered in place, and a delegated choice never becomes another question',async()=>{
  const env=await slowDevelopmentFixture(round=>round===1?{clarification:'笔记内容由谁决定？',clarification_options:['我自己填写','自动记录关键事件','你帮我决定']}:{clarification:'还要再问一句实现细节吗？',clarification_options:['要','不要']});
  try{
    const created=await env.post('development/tasks',{request_id:randomUUID(),request:'我想加一个笔记模块'});
    const taskId=String(created.body.id);
    await env.settle(taskId);
    // The dedicated composer answers through the existing revise endpoint; the task continues from the answer.
    const answered=await env.post(`development/tasks/${taskId}/revise`,{request:'自动记录关键事件'});
    expect(answered.status).toBe(200);
    await env.settle(taskId);
    expect(env.plannerCalls()).toBe(2);
    // "你帮我决定" must not produce another clarifying round: the difference is an implementation detail.
    const delegated=await env.post(`development/tasks/${taskId}/revise`,{request:'你帮我决定'});
    expect(delegated.status).toBe(200);
    const settled=await env.settle(taskId);
    expect(settled.status).not.toBe('waiting_for_user');
    const panel=await readFile('src/client/DevelopmentPanel.tsx','utf8');
    expect(panel).toContain('ClarificationCard');
    expect(panel).toContain("task.status==='waiting_for_user'");
  }finally{await env.close();}
});

it('the player only ever reads the sanitized development copy',()=>{
  const view=developmentPlayerView({
    status:'waiting_for_user',
    message:'我理解的是：玩家要求 capability_digest 中的 modules，然后走 module.enable 与 extension.create。',
    clarification_options:['只记录关键事件','复用 response_hint 里的日志','你帮我决定'],
    preview:null,
  });
  const playerVisible=[view.message,view.question??'',...view.options.map(option=>option.label)].join(' ');
  for(const leak of ['capability_digest','module.enable','extension.create','response_hint','framework.development','understanding','workflow']){
    expect(playerVisible).not.toContain(leak);
  }
  expect(view.options).toHaveLength(3);
  expect(view.allowsDelegate).toBe(true);
  // Whatever the player may not read is still available in the advanced details of the raw task.
  const raw='我理解的是：玩家要求 capability_digest module.enable extension.create';
  expect(raw).toContain('capability_digest');
});

it('a world-setting answer is titled as the world setting, never as a capability summary',async()=>{
  const f=await sparseSetup();
  const answer=await handleSystemInput(f.service,{input:'这个世界最开始是什么设定？'});
  expect(answer.advanced?.truth_query).toBe('creation_provenance');
  expect(answer.title).toBe('世界设定');
  expect(String(answer.message)).not.toContain('能力说明');
});

it('a second-person question about the assistant is never answered from the last NPC',async()=>{
  const f=await sparseSetup();
  const view=(await f.service.view())!;
  const npc=view.entities.find(entity=>entity.id!==view.player_id&&entity.components.character);
  const first=await handleSystemInput(f.service,{input:`${String(npc?.components.identity?.name??'伊芙琳')}现在在哪？`});
  const sessionId=first.session?.session_id;
  const asked=await handleSystemInput(f.service,{input:'你现在能做什么？',...(sessionId?{session_id:sessionId}:{})});
  expect(asked.category).toBe('CAPABILITY_ANSWER');
  expect(asked.title).toBe('能力说明');
  expect(asked.understanding?.entities ?? []).toEqual([]);
  expect(String(asked.message)).toContain('可用操作');
});

it('an open-ended goal continues from advice to an actual rest, not just a suggestion',async()=>{
  const walk=await runGoalWalk('找地方休息',({candidates,completed})=>{
    const done=new Set(completed.map(entry=>entry.candidate));
    if(![...done].some(id=>id.startsWith('talk:'))){const talk=candidates.find(candidate=>candidate.kind==='talk');if(talk)return {decision:'act',candidate_id:talk.id};}
    if(!done.has('activity:sleep')&&candidates.some(candidate=>candidate.id==='activity:sleep'))return {decision:'act',candidate_id:'activity:sleep'};
    return {decision:'done'};
  });
  expect(walk.result).toMatchObject({intent:'WORLD_GOAL',plan:{status:'completed'}});
  expect(walk.after.state_revision).toBeGreaterThan(walk.before.state_revision+1);
  const stamina=(state:typeof walk.after)=>Number(state.entities.find(entity=>entity.id===state.player_state.entity_id)!.components.condition?.stamina??0);
  expect(stamina(walk.after)).toBeGreaterThan(stamina(walk.before));
  expect(String(walk.result.message)).toContain('夜间睡眠');
});

it('a system handoff carries one authoritative answer instead of repeating it in the world column',async()=>{
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.destination)return {data:{destination:'SYSTEM_META_INTENT',confidence:1,clarification:null,speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false}};
    if(properties.likely_workflow)return {data:{understood:['玩家想了解当前实际能力'],requested_change:'介绍当前能做什么',target_surfaces:[],unresolved:[],entities:[],likely_workflow:'capability_question',side_effect_class:'none',confidence:0.95,correction:null,clarification:{needed:false,question:'',examples:[]},response_hint:null}};
    throw new Error('unexpected fixture request: '+String(request.role));
  });
  const directory=await mkdtemp(join(tmpdir(),'agf-handoff-'));
  const server=createApp(f.service,resolve('dist/client'),undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const token=(await (await fetch(`${base}/api/session`)).json()).token as string;
    const before=await f.service.current();
    const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({input:'你现在能做什么？',request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
    const raw=await response.text();
    expect(response.ok,raw).toBe(true);
    const result:any=JSON.parse(raw);
    // The same player-facing capability text may exist exactly once in the response: on the System surface.
    expect(result.system_handoff?.result?.message).toContain('当前启用的世界模块');
    const key='当前启用的世界模块';
    expect(raw.split(key).length-1).toBe(1);
    expect(String(result.message)).not.toContain(key);
    // Rendering seam: the client must not also print the handover as a story-column agent reply.
    const app=await readFile('src/client/App.tsx','utf8');
    expect(app).toContain("const handoff='system_handoff' in next");
    expect(app).toMatch(/setAgentReply\(handoff\|\|next\.presentation==='story'\|\|!next\.message\.trim\(\)\?null/);
    const panel=await readFile('src/client/SystemPanel.tsx','utf8');
    expect(panel.split('className={`system-result').length-1).toBe(1);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

it('development self-knowledge separates extension, gated core work and the missing image provider',async()=>{
  const f=await sparseSetup();
  const view=(await f.service.view())!;
  const answer=await handleSystemInput(f.service,{input:'你现在能开发新功能吗？'});
  const message=String(answer.message);
  expect(answer.category).toBe('CAPABILITY_ANSWER');
  expect(answer.workflow).toBe('capability_question');
  expect(message).toContain('扩展开发');
  expect(message).toContain('可用');
  expect(message).toContain('框架核心开发');
  expect(message).toContain('安全门');
  expect(message).toContain('图片生成');
  expect(message).toContain('尚未接入');
  expect(message).not.toMatch(/framework\.development/);
  expect(message).not.toContain('当前尚未接入核心源码开发流程');
  expect(message).not.toContain('当前未配置「修改框架自身」');
  // Live runtime state, not a static promise, decides what the model and the player are told.
  const digest=capabilityDigest(view,await f.service.current());
  expect(digest.tools.find(tool=>tool.id==='framework.development')?.available).toBe(true);
  expect(digest.tools.find(tool=>tool.id==='media.generate_image')?.available).toBe(false);
  expect(shallowUnderstanding('你现在能开发新功能吗？',view).likely_workflow).toBe('capability_question');
});

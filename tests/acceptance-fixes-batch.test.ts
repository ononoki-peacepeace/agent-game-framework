import {it,expect,afterEach} from 'vitest';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {sparseSetup} from './sparse-fixture.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {validateSave} from '../src/core/state.js';
import type {SavePackage} from '../src/core/schema.js';
import {recentReferent} from '../src/core/recent-referent.js';
import {detectBehaviorScopes,behaviorSummary} from '../src/ai/behavior.js';
import {handleSystemInput} from '../src/system/agent.js';
import {routeContext} from '../src/system/context-router.js';
import {sanitizePlayerText} from '../src/system/player-copy.js';
import {configureDefaultLogger,StructuredLogger} from '../src/observability/index.js';

afterEach(()=>{configureDefaultLogger(new StructuredLogger({directory:null}));});

/** A world whose save has no calendar anywhere: the shape of the real legacy save that exposed the checkpoint bug. */
function legacyWorld(){
  const world=structuredClone(demo);
  delete (world as {calendar?:unknown}).calendar;
  return world;
}
function fixtureAdapter(){

  const npcName='伊芙琳';
  return {name:'checkpoint-fixture',generate:async(request:{role:string;schema:any;prompt:string})=>{
    const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(request.role==='narrator'&&props.narrative)return {data:{narrative:'她抬头看了你一眼。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[]}};
    if(props.facts)return {data:{narrative:'你挥出一拳。',minutes:1,target_id:null,facts:['发生肢体冲突。'],relationship:null}};
    if(props.type)return {data:{type:'FREEFORM_ACTION',target_id:null,parameters_json:'{}',clarification:null}};
    throw Error(`unexpected fixture request ${request.role} ${npcName}`);
  }};
}
async function saveWithoutCalendar(directory:string){
  const world=legacyWorld();
  const store=new JsonStore(directory);
  const service=new GameService(store,new AIRuntime(fixtureAdapter() as never),world);
  await service.newGame();
  const save=await service.current();
  delete (save as {calendar?:unknown}).calendar;
  delete (save.definition as {calendar?:unknown}).calendar;
  await store.write(save);
  return {store,service};
}

it('P0-1 A/D/E: a save without any calendar still commits a world turn with a valid checkpoint',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-checkpoint-'));
  const {store,service}=await saveWithoutCalendar(directory);
  const save=await service.current();
  const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  npc.components.location=structuredClone(save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location);
  await store.write(save);
  const view=await service.turn({game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),action:{type:'TALK',target_id:npc.id,parameters:{topic:'骂你臭傻逼'}}});
  expect(String(view.last_turn?.narrative)).toContain('她抬头');
  const written=await store.read();
  expect(written!.turn_checkpoint).toBeTruthy();
  expect(Object.prototype.hasOwnProperty.call(written!.turn_checkpoint!.before,'calendar')).toBe(false);
  expect(()=>validateSave(JSON.parse(JSON.stringify(written)))).not.toThrow();
});

it('P0-1 B/C: the checkpoint survives a reload and Undo restores the world including the calendar',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-checkpoint-reload-'));
  const world=structuredClone(demo);
  const store=new JsonStore(directory);
  const service=new GameService(store,new AIRuntime(fixtureAdapter() as never),world);
  await service.newGame();
  const before=await service.current();
  const npc=before.entities.find(entity=>entity.id!==before.player_state.entity_id&&entity.components.character)!;
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  await service.turn({...request,action:{type:'TALK',target_id:npc.id,parameters:{topic:'你好'}}});
  const afterTurn=await store.read();
  expect(()=>validateSave(JSON.parse(JSON.stringify(afterTurn)))).not.toThrow();
  const restarted=new GameService(new JsonStore(directory),new AIRuntime(fixtureAdapter() as never),world);
  const reloaded=await restarted.current();
  expect(reloaded.turn_checkpoint).toBeTruthy();
  const undone=await restarted.undo({request_id:randomUUID(),game_id:reloaded.game_id,expected_revision:reloaded.state_revision});
  expect(undone.revision).toBeGreaterThan(reloaded.state_revision-1);
  expect((await restarted.current()).calendar).toEqual(before.calendar);
});

it('P0-2 A/C/F: a new goal never inherits an older pending System write',async()=>{
  const f=await sparseSetup();
  const before=await f.service.current();
  const asked=await handleSystemInput(f.service,{input:'彻底移除商店系统。'});
  expect(asked.needs_confirmation).toBe(true);
  const fresh=await handleSystemInput(f.service,{input:'在人物和关系之间新增潜力模块'});
  expect(fresh.needs_confirmation??false).toBe(false);
  const second=await handleSystemInput(f.service,{input:'潜力模块要和属性系统联动'});
  expect(second.needs_confirmation??false).toBe(false);
  const after=await f.service.current();
  expect(after.definition.enabled_modules).toEqual(before.definition.enabled_modules);
  expect(after.state_revision).toBe(before.state_revision);
});

it('P0-2 B/D/E: a continuation cannot execute a write that the current sentence did not ask for',async()=>{
  const f=await sparseSetup();
  const before=await f.service.current();
  // A clarification about a style scope leaves the session open ...
  const asked=await handleSystemInput(f.service,{input:'关闭生活模式'});
  expect(asked.session?.status).toBe('completed');
  expect(String(asked.message)).toContain('已停用');
  const disabled=await f.service.current();
  expect(disabled.definition.enabled_modules).not.toContain('routine');
  // ... and the next, unrelated sentence must not re-run any planned module write.
  const unrelated=await handleSystemInput(f.service,{input:'潜力要和属性联动'});
  expect(String(unrelated.tool_id??'')).not.toMatch(/^module\./);
  const after=await f.service.current();
  expect(after.definition.enabled_modules).toEqual(disabled.definition.enabled_modules);
  expect(after.state_revision).toBe(disabled.state_revision);
  expect(after.definition.enabled_modules).not.toEqual(before.definition.enabled_modules);
});

it('P0-2 router: a clarification answer carries context but never pre-authorises an execution',async()=>{
  const f=await sparseSetup(async()=>({data:{destination:'AMBIGUOUS',confidence:0.3,clarification:'你是对人物说，还是调整游戏设置？',speech_target_id:null,resolved_input:'关闭任务模块',world_input:null,end_conversation:false}}));
  const before=await f.service.current();
  const first=await routeContext(f.service,'你别这样说了','system_input');
  expect(first.destination).toBe('AMBIGUOUS');
  await routeContext(f.service,'我说的是回复风格','system_input');
  // The router is read-only: whatever merged sentence it may report, no module, revision or time changes here.
  const after=await f.service.current();
  expect(after.definition.enabled_modules).toEqual(before.definition.enabled_modules);
  expect(after.state_revision).toBe(before.state_revision);
  expect(after.runtime.time).toEqual(before.runtime.time);
});



it('P1-1: recent salience is derived from canonical history and reaches the router and planner',async()=>{
  const f=await sparseSetup();
  const save=await f.service.current();
  const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  npc.components.identity.name='伊芙琳';
  save.last_turn={narrative:'伊芙琳后退了半步，捂住脸。',speaker:npc.id,dialogue:null,choices:[],context_actions:[]};
  save.action_facts=[{request_id:randomUUID(),actor_id:save.player_state.entity_id,target_id:npc.id,input:'我打了伊芙琳一拳',facts:['发生肢体冲突。'],time:{day:1,minute:600}}];
  save.runtime.receipts=[];
  delete save.interaction_context;
  await f.store.write(save);
  const referent=recentReferent(await f.service.current());
  expect(referent.primary).toMatchObject({id:npc.id,name:'伊芙琳'});
  expect(referent.conflict_target).toMatchObject({id:npc.id});
  const prompts:string[]=[];
  const f2=await sparseSetup(async(request)=>{
    prompts.push(request.prompt);
    if(request.role==='intent_interpreter')return {data:{goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:'再揍她一拳',depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[npc.id]}]}};
    throw Error('unexpected');
  });
  const save2=await f2.service.current();
  const npc2=save2.entities.find(entity=>entity.id!==save2.player_state.entity_id&&entity.components.character)!;
  npc2.components.identity.name='伊芙琳';
  save2.last_turn={narrative:'伊芙琳后退了半步，捂住脸。',speaker:npc2.id,dialogue:null,choices:[],context_actions:[]};
  save2.action_facts=[{request_id:randomUUID(),actor_id:save2.player_state.entity_id,target_id:npc2.id,input:'我打了伊芙琳一拳',facts:['发生肢体冲突。'],time:{day:1,minute:600}}];
  save2.runtime.receipts=[];
  delete save2.interaction_context;
  await f2.store.write(save2);
  const router=await routeContext(f2.service,'再揍她一拳','world_input');
  expect(JSON.stringify(router)).not.toMatch(/没有前文|没有 pending|interaction_context/);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.some(prompt=>prompt.includes('recent_scene')&&prompt.includes('伊芙琳'))).toBe(true);
});

it('P1-2: the System composer only ever holds what the player typed here',async()=>{
  const source=await readFile('src/client/SystemPanel.tsx','utf8');
  expect(source).not.toMatch(/setInput\(handoff\.input\)/);
  const app=await readFile('src/client/App.tsx','utf8');
  expect(app).not.toMatch(/系统会判断这是行动/);
  expect(app).not.toMatch(/不会在你确认前发送给 AI/);
});

it('P2: closing a system that is already closed answers in the player language',async()=>{
  const f=await sparseSetup();
  const first=await handleSystemInput(f.service,{input:'关闭生活模式'});
  expect(String(first.message)).toContain('已停用');
  const again=await handleSystemInput(f.service,{input:'关闭生活模式'});
  expect(String(again.message)).toContain('本来就是关闭的');
  expect(String(again.message)).not.toMatch(/routine|quests|module/);
});

it('P1-3: a request naming narration and dialogue configures both scopes with a bounded style value',async()=>{

  expect(detectBehaviorScopes('把今后的叙述与对话文字风格调整为更文学化')).toEqual(['narration','dialogue']);
  const f=await sparseSetup();
  const result=await handleSystemInput(f.service,{input:'把今后的叙述与对话文字风格调整为更文学化'});
  expect(result.category).toBe('BEHAVIOR_CONFIGURATION');
  const rules=(await f.service.current()).behavior_config??[];
  expect(rules.map(rule=>rule.scope).sort()).toEqual(['dialogue','narration']);
  expect(rules.every(rule=>rule.op==='tone'&&rule.value==='literary')).toBe(true);
  const summary=behaviorSummary(rules);
  expect(summary).toContain('更有文学性');
  expect(summary).not.toContain('把今后的叙述与对话文字风格调整为更文学化');
});

it('P2-2: internal vocabulary never reaches the player',()=>{
  const cleaned=sanitizePlayerText('当前没有进行中的交谈、没有 pending 的上一轮请求、也没有 interaction_context。');
  expect(cleaned).not.toMatch(/pending|interaction_context|public_state|canonical/);
  expect(sanitizePlayerText('')).toBeTruthy();
  expect(sanitizePlayerText('你是指刚才的伊芙琳吗？')).toContain('伊芙琳');
});

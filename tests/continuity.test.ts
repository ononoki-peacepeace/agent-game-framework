import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {characterContext,narrativeHealth} from '../src/ai/narrative-health.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {routeContext} from '../src/system/context-router.js';
import {worldImage,checkpointTurn} from '../src/core/turn-history.js';
import {publicView,validateSave} from '../src/core/state.js';
import {fresh,MemoryStore} from './helpers.js';
import type {AIRequest} from '../src/ai/contracts.js';

const prose={narrative:'她收起书，望向门口，退到同伴身边。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[]};
const route=(destination:string,extra:Record<string,unknown>={})=>({destination,confidence:.95,clarification:null,speech_target_id:null,world_input:null,end_conversation:false,...extra});
async function setup(generate?:(req:AIRequest)=>Promise<any>,disk?:string){
 const save=fresh();save.definition.events=[];save.gm_state.notes='GM_SECRET_NOT_FOR_NARRATOR';
 const player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
 npc.components.location=structuredClone(player.components.location);npc.components.character.traits=['谨慎','不爱冒险'];
 const calls:AIRequest[]=[],store=disk?new JsonStore(disk):new MemoryStore();await store.write(validateSave(save));
 const ai=new AIRuntime({name:'test',generate:async req=>{calls.push(req);return generate?generate(req):{data:prose};}});
 const service=new GameService(store,ai,save.definition);await service.current();
 const tx=async()=>{const s=await service.current();return {request_id:randomUUID(),game_id:s.game_id,expected_revision:s.state_revision};};
 const talk=async()=>service.turn({...await tx(),action:{type:'TALK',target_id:npc.id,parameters:{topic:'刚才的事你怎么看？'}}});
 return {save,player,npc,calls,store,ai,service,tx,talk};
}

describe('persistent focus and atomic world undo',()=>{
 it('BUY Undo restores both wallets, inventory and shop stock',async()=>{
  const f=await setup(),s=await f.service.current(),shop=s.entities.find(e=>e.components.shop)!;
  shop.components.location=structuredClone(f.player.components.location);await f.store.write(s);const before=await f.service.current();
  const item=Object.keys(shop.components.shop.stock as object)[0];await f.service.turn({...await f.tx(),action:{type:'BUY',target_id:shop.id,parameters:{item_id:item,quantity:1}}});
  expect(worldImage(await f.service.current())).not.toEqual(worldImage(before));await f.service.undo(await f.tx());expect(worldImage(await f.service.current())).toEqual(worldImage(before));
 });
 it('one TALK restores relationship enrichment, completed quest and executed future intent together',async()=>{
  const f=await setup();await f.service.manageModule({...await f.tx(),module:'quests',confirmed:true},'enable');
  const s=await f.service.current(),actor=s.entities.find(e=>e.id===s.player_state.entity_id)!,futureId=randomUUID(),now=s.runtime.time.day*1440+s.runtime.time.minute;
  actor.components.quests={entries:{conversation_quest:{title:'交流任务',status:'accepted',summary:'明确任务',objectives:[],deadline:null,tags:[],metadata:{}}}};
  s.definition.task_rules=[{task_id:'conversation_quest',book:'quests',location_id:String(actor.components.location.location_id),start_at:now,end_at:now+100,steps:[{action:'TALK',target_id:f.npc.id,minimum_minutes:1}]}];
  s.future_intents=[{id:futureId,plan_id:randomUUID(),goal_id:'talk',created_at:s.runtime.time,source_text:'准备交流',target_date:s.runtime.time.day,time_window:'any',target_entities:[f.npc.id],goal:'交流',condition:null,condition_expected:true,status:'due',completed_by_request:null}];await f.store.write(validateSave(s));
  f.ai.adapter.generate=async()=>({data:{...prose,patches:[{op:'relationship_delta',entity_id:actor.id,target_id:f.npc.id,dimension:'trust',delta:1}]}});
  const before=await f.service.current();await f.service.turn({...await f.tx(),action:{type:'TALK',target_id:f.npc.id,parameters:{topic:'完成约定交流'}}},undefined,undefined,undefined,false,futureId);
  const after=await f.service.current();expect(after.future_intents![0].status).toBe('completed');expect(after.task_progress?.conversation_quest).toBe(1);expect((after.entities.find(e=>e.id===actor.id)!.components.quests.entries as any).conversation_quest.status).toBe('completed');
  expect(after.entities.find(e=>e.id===actor.id)!.components.relationships).not.toEqual(actor.components.relationships);
  await f.service.undo(await f.tx());expect(worldImage(await f.service.current())).toEqual(worldImage(before));
 });
 it('Generic local movement Undo restores scene position, action facts and focus',async()=>{
  const f=await setup();await f.talk();const before=await f.service.current();f.ai.adapter.generate=async()=>({data:{narrative:'你停在屋外。',minutes:1,target_id:null,facts:['来到屋外'],relationship:null}});
  await f.service.turn({...await f.tx(),input:'我出门到屋外。'});const moved=await f.service.current();expect(moved.entities.find(e=>e.id===f.player.id)!.components.scene_position.label).toBe('屋外');
  await f.service.undo(await f.tx());expect(worldImage(await f.service.current())).toEqual(worldImage(before));
 });
 it('a canonical NPC departure invalidates focus permanently until a new interaction',async()=>{
  const f=await setup();await f.talk();const move=async(location:string)=>f.service.agentTransaction(await f.tx(),{location},s=>{s.entities.find(e=>e.id===f.npc.id)!.components.location.location_id=location;});
  await move('station');await move('square');expect((await f.service.view())!.interaction_context).toBeUndefined();await f.talk();expect((await f.service.view())!.interaction_context?.target_entity_id).toBe(f.npc.id);
 });
 it('NPC can initiate and end focus without being forced to speak',async()=>{
  let status:'active'|'ended'='active';let target='';
  const f=await setup(async()=>({data:{...prose,interaction:{target_id:target,status}}}));target=f.npc.id;
  await f.service.turn({...await f.tx(),action:{type:'WAIT',parameters:{minutes:1}}});expect((await f.service.view())!.interaction_context?.target_entity_id).toBe(target);
  status='ended';await f.talk();expect((await f.service.view())!.interaction_context).toBeUndefined();expect((await f.service.current()).last_turn!.dialogue).toBeNull();
 });
 it('explicit farewell ends focus in the same undoable transaction',async()=>{
  const f=await setup();await f.talk();await f.service.turn({...await f.tx(),end_conversation:true,action:{type:'TALK',target_id:f.npc.id,parameters:{topic:'先聊到这里，再见'}}});
  expect((await f.service.view())!.interaction_context).toBeUndefined();await f.service.undo(await f.tx());expect((await f.service.view())!.interaction_context?.target_entity_id).toBe(f.npc.id);
 });
 it('failed Undo storage write leaves committed state and checkpoint intact',async()=>{
  const f=await setup();await f.talk();const before=await f.service.current(),write=f.store.write.bind(f.store);
  f.store.write=async()=>{throw Error('disk failure');};await expect(f.service.undo(await f.tx())).rejects.toThrow('disk failure');
  f.store.write=write;expect(await f.service.current()).toEqual(before);expect((await f.service.view())!.can_undo).toBe(true);
 });
 it('presentation changes survive Undo',async()=>{
  const f=await setup();await f.talk();const s=await f.service.current();s.entities.find(e=>e.id===f.npc.id)!.components.identity.avatar_id='new_avatar';s.state_revision++;await f.store.write(s);
  await f.service.undo(await f.tx());expect((await f.service.current()).entities.find(e=>e.id===f.npc.id)!.components.identity.avatar_id).toBe('new_avatar');
 });
 it('TALK establishes focus; undo restores the complete before image and preserves style',async()=>{
  const f=await setup(),before=await f.service.current();await f.talk();
  expect((await f.service.view())!.interaction_context?.target_entity_id).toBe(f.npc.id);
  await f.service.setBehaviorConfig({scope:'narration',instruction:'故事写得更文学一点'});
  const configured=await f.service.current();expect((await f.service.view())!.can_undo).toBe(true);
  const request=await f.tx();await f.service.undo(request);const after=await f.service.current();
  expect(worldImage(after)).toEqual(worldImage(before));expect(after.behavior_config).toEqual(configured.behavior_config);
  expect(after.state_revision).toBeGreaterThan(configured.state_revision);expect(after.turn_audit).toHaveLength(1);
  expect(after.turn_checkpoint).toBeUndefined();await f.service.undo(request);expect((await f.service.current()).state_revision).toBe(after.state_revision);
  await expect(f.service.undo(await f.tx())).rejects.toThrow('没有可安全撤回');
 });
 it('new continuation keeps abandoned history and has a new active turn',async()=>{
  const f=await setup();await f.talk();const abandoned=(await f.service.current()).active_turn_id;await f.service.undo(await f.tx());
  await f.service.turn({...await f.tx(),action:{type:'WAIT',parameters:{minutes:3}}});const s=await f.service.current();
  expect(s.active_turn_id).not.toBe(abandoned);expect(s.turn_audit![0].turn_id).toBe(abandoned);expect(s.turn_checkpoint!.parent_turn_id).toBeNull();
 });
 it('switches targets and invalidates focus when either participant leaves',async()=>{
  const f=await setup();await f.talk();const s=await f.service.current(),other=structuredClone(f.npc);other.id='another_person';s.entities.push(other);await f.store.write(s);
  await f.service.turn({...await f.tx(),action:{type:'TALK',target_id:other.id,parameters:{topic:'你好'}}});
  expect((await f.service.view())!.interaction_context?.target_entity_id).toBe(other.id);
  const left=await f.service.current();left.entities.find(e=>e.id===other.id)!.components.location.location_id='station';await f.store.write(left);
  expect((await f.service.view())!.interaction_context).toBeUndefined();
  await f.service.turn({...await f.tx(),action:{type:'MOVE',target_id:'station',parameters:{}}});expect((await f.service.view())!.interaction_context).toBeUndefined();
 });
 it('MOVE undo restores location, scene position and last turn',async()=>{
  const f=await setup();await f.talk();const before=await f.service.current();
  await f.service.turn({...await f.tx(),action:{type:'MOVE',target_id:'station',parameters:{}}});await f.service.undo(await f.tx());
  expect(worldImage(await f.service.current())).toEqual(worldImage(before));
 });
 it('checkpoint survives a JsonStore and service restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agf-undo-'));try{const f=await setup(undefined,dir),before=await f.service.current();await f.talk();
   const restarted=new GameService(new JsonStore(dir),f.ai,before.definition);expect((await restarted.view())!.can_undo).toBe(true);
   await restarted.undo(await f.tx());expect(worldImage(await restarted.current())).toEqual(worldImage(before));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('a full before image restores money, inventory, quests, future plans and GM consequences together',async()=>{
  const f=await setup(),before=await f.service.current(),after=structuredClone(before);
  const actor=after.entities.find(e=>e.id===after.player_state.entity_id)!;
  (actor.components.wallet.balances as Record<string,number>).credit=0;actor.components.inventory.items={};
  after.gm_state.flags.changed=true;after.runtime.time.minute+=4;after.event_state.counts={};after.future_intents=[];
  after.action_facts=[{request_id:randomUUID(),actor_id:actor.id,target_id:f.npc.id,input:'测试后果',facts:['冲突已经发生'],time:after.runtime.time}];
  after.state_revision++;checkpointTurn(before,after,randomUUID());await f.store.write(validateSave(after));
  await f.service.undo(await f.tx());expect(worldImage(await f.service.current())).toEqual(worldImage(before));
 });
 it('rejects stale revisions and conflicting canonical changes without partial restoration',async()=>{
  const f=await setup(),stale=await f.tx();await f.talk();await expect(f.service.undo(stale)).rejects.toThrow('状态已更新');
  const s=await f.service.current();s.gm_state.flags.later=true;s.state_revision++;await f.store.write(s);
  await expect(f.service.undo(await f.tx())).rejects.toThrow('没有可安全撤回');expect(await f.service.current()).toEqual(s);
 });
});

describe('shared context gate and production HTTP routes',()=>{
 it('world shorthand receives persistent focus; system source never receives it',async()=>{
  const f=await setup(async req=>({data:(req.schema as any).properties.destination?route('WORLD_INTENT'):prose}));await f.talk();
  await routeContext(f.service,'你觉得呢？','world_input');expect(f.calls.at(-1)!.prompt).toContain('"target_entity_id":"'+f.npc.id+'"');
  await routeContext(f.service,'你觉得呢？','system_input');expect(f.calls.at(-1)!.prompt).toContain('"interaction_context":null');expect(f.calls.at(-1)!.prompt).not.toContain('"target_entity_id"');
 });
 it('ambiguity and low confidence never modify the save and carry clarification context',async()=>{
  const f=await setup(async()=>({data:route('SYSTEM_META_INTENT',{confidence:.4,clarification:'对人物说，还是修改回复风格？'})}));const before=await f.service.current();
  expect((await routeContext(f.service,'你别这样说了','world_input')).destination).toBe('AMBIGUOUS');
  await routeContext(f.service,'我说的是回复风格','world_input');expect(f.calls.at(-1)!.prompt).toContain('你别这样说了');expect(await f.service.current()).toEqual(before);
 });
 it('HTTP auto-handoff both ways, focused followup, clarification and Undo use real handlers',async()=>{
  let decision=route('SYSTEM_META_INTENT');
  const f=await setup(async req=>{const p=(req.schema as any).properties;if(p.destination)return {data:decision};if(req.role==='narrator')return {data:prose};throw Error('fallback to existing System understanding');});
  const dir=await mkdtemp(join(tmpdir(),'agf-http-')),server=createApp(f.service,undefined,undefined,join(dir,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const base='http://127.0.0.1:'+(server.address() as any).port,token=(await(await fetch(base+'/api/session')).json()).token;
   const post=async(path:string,body:any)=>{const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});const data=await r.json();expect(r.ok,JSON.stringify(data)).toBe(true);return data;};
   const before=await f.service.current();const meta=await post('input',{...await f.tx(),input:'以后故事更文学一点'});
   expect(meta.intent).toBe('SYSTEM_META_INTENT');expect((await f.service.current()).runtime.time).toEqual(before.runtime.time);expect((await f.service.current()).behavior_config).not.toEqual([]);
   decision=route('WORLD_INTENT',{speech_target_id:f.npc.id,world_input:'刚才怎么了？'});
   const world=await post('system',{...await f.tx(),input:'我过去问这位同伴怎么了'});expect(world.category).toBe('IN_WORLD_INPUT');expect(world.view.interaction_context.target_entity_id).toBe(f.npc.id);
   expect(await(await fetch(base+'/api/development/tasks')).json()).toEqual([]);
   decision=route('WORLD_INTENT',{speech_target_id:f.npc.id,world_input:'你觉得呢？'});await post('input',{...await f.tx(),input:'你觉得呢？'});
   const focused=await f.service.current();expect(focused.interaction_context?.target_entity_id).toBe(f.npc.id);
   decision=route('AMBIGUOUS',{clarification:'你是对人物说，还是修改回复风格？'});await post('input',{...await f.tx(),input:'你别这样说了'});expect(await f.service.current()).toEqual(focused);
   const undone=await post('undo',await f.tx());expect(undone.revision).toBeGreaterThan(focused.state_revision);expect((await f.service.current()).behavior_config).not.toEqual([]);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
 });
});

describe('bounded character continuity and safety',()=>{
 it('context includes public persona, relationship, scene and recent events, never GM notes',async()=>{
  const f=await setup();await f.talk();const context=JSON.stringify(characterContext(await f.service.current(),f.npc.id));
  expect(context).toContain('谨慎');expect(context).toContain('relationship');expect(context).toContain('scene');expect(context).toContain('recent_turns');expect(context).not.toContain('GM_SECRET');
 });
 it('brief contextual silence does not require length or regeneration',async()=>{
  const f=await setup();expect(narrativeHealth(await f.service.current(),{narrative:'她退到门后，沉默。',dialogue:null},['她向门后退去。']).detected).toBe(false);
 });
 it('repeated narration regenerates only once and cannot substitute new relationship patches',async()=>{
  let count=0;const f=await setup(async()=>({data:++count===1?prose:{...prose,narrative:'她握紧门把，避开你的目光。',patches:[{op:'relationship_delta',entity_id:'player',target_id:'unknown',dimension:'trust',delta:2}]}}));
  const s=await f.service.current();s.narrative_history=[{request_id:randomUUID(),narrative:prose.narrative,dialogue:null,speaker:null,facts:[]}];await f.store.write(s);
  await f.talk();expect(count).toBe(2);expect((await f.service.current()).last_turn!.narrative).toContain('门把');expect((await f.service.current()).entities.find(e=>e.id==='player')!.components.relationships).toEqual(s.entities.find(e=>e.id==='player')!.components.relationships);
 });
 it('a second repetitive result is accepted without a third call',async()=>{
  const f=await setup();const s=await f.service.current();s.narrative_history=[{request_id:randomUUID(),narrative:prose.narrative,dialogue:null,speaker:null,facts:[]}];await f.store.write(s);await f.talk();expect(f.calls).toHaveLength(2);
 });
 it('provider refusal is system degradation, never NPC speech; next turn still works',async()=>{
  let refused=true;const f=await setup(async()=>{if(refused)throw new ProviderError('content_filter','','拒绝');return {data:prose};});
  const before=await f.service.current();await f.talk();const failed=await f.service.current();expect(f.calls).toHaveLength(1);expect(failed.runtime.time).not.toEqual(before.runtime.time);expect(failed.last_turn!.dialogue).toBeNull();expect(failed.last_turn!.narrative).not.toContain('作为 AI');
  refused=false;await f.talk();expect((await f.service.current()).last_turn!.narrative).toBe(prose.narrative);
 });
 it('refusal text in schema-valid narration is rejected before enrichment',async()=>{
  const f=await setup(async()=>({data:{...prose,narrative:'作为 AI 我不能生成这个内容。'}}));await f.talk();expect((await f.service.current()).last_turn!.narrative).not.toContain('作为 AI');
 });
 it('System raw understanding stays in advanced; default extension header is conditional',async()=>{
  const system=await readFile('src/client/SystemPanel.tsx','utf8'),extension=await readFile('src/client/ExtensionPanel.tsx','utf8');
  expect(system.indexOf('JSON.stringify(result.understanding')).toBeGreaterThan(system.indexOf('<details className="system-advanced">'));
  expect(extension).toContain('{showDevelopment&&<><h3>功能扩展');
 });
});

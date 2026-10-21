import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demo} from './helpers.js';
import {newSave,publicView,type validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {decideNpc,applyNpcDecision,recordSceneObservation,type NpcDecision} from '../src/agent/npc-agent.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';

const spec=JSON.parse(await readFile(new URL('../docs/npc-adaptation72-scenarios.v1.json',import.meta.url),'utf8')) as {
 hours:number;step_minutes:number;restart_after_hours:number[];worlds:('trade'|'relations'|'calendar')[]};
const ids=['npc_lin','npc_qiao','npc_mei'];
type Save=ReturnType<typeof validateSave>;
const entity=(save:Save,id:string)=>save.entities.find(e=>e.id===id)!;
const minute=(save:Save)=>save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
const quiet=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'保留自己的长期事务',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'等待本人下一次核对方法',social_response:null});
function seed(kind:typeof spec.worlds[number]){
 const world=structuredClone(demo);world.events=[];world.runtime.time={day:1,minute:540};
 const third=structuredClone(world.entities.find(e=>e.id==='npc_lin')!);third.id='npc_mei';third.components.identity.name='梅青';world.entities.push(third);
 for(const id of ids)world.entities.find(e=>e.id===id)!.components.location={location_id:'square'};
 const depot=structuredClone(world.map!.locations.find(p=>p.id==='market')!);depot.id='closed_depot';depot.name='封闭仓库';
 depot.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'固定适应性场景的封闭地点',source_ref:'fixture',recorded_at:world.runtime.time};
 world.map!.locations.push(depot);world.map!.routes.push({from:'square',to:depot.id,travel_minutes:6,conditions:[]});
 if(kind!=='trade'){world.enabled_modules=world.enabled_modules.filter(m=>m!=='commerce');world.entities=world.entities.filter(e=>e.id!=='corner_shop');}
 if(kind==='calendar')world.calendar={version:1,anchor_day:1,anchor_month:1,anchor_date:1,anchor_weekday:1,month_lengths:[31,28,31,30,31,30,31,31,30,31,30,31],source:'明确创作的适应性场景日历'};
 if(kind==='calendar'){
  world.background_event_policy={enabled:true,target_active_incidents:2,max_dormant_incidents:2,minimum_gap_minutes:180,replenishment:false};
  world.background_incidents=['resolved','pending'].map((suffix,index)=>({id:'adaptive_'+suffix,title:'已登记的车站事务',summary:'人物持续事务的既有背景进展',source:'WORLD_PACKAGE' as const,
   created_at:world.runtime.time,earliest_activation:{day:2,minute:540},latest_activation:null,activation_flags:[],activation_chance:1,participants:['npc_lin'],locations:['station'],
   stages:[{id:'start',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',effects:[{kind:'set_flag' as const,flag:'adaptive_'+suffix+'_started'}],exposures:[],terminal:'none' as const},
    {id:'finish',earliest_after_minutes:1440,latest_after_minutes:null,required_flags:index?['never_authorized']:[],actor_id:'npc_lin',effects:[{kind:'set_flag' as const,flag:'adaptive_'+suffix+'_finished'}],exposures:[],terminal:'resolved' as const}]}));
 }
 world.ruleset.relationship_dimensions={familiarity:{min:0,max:100,initial:0,event_deltas:{contact:1}}};
 const save=newSave(world);save.npc_agent_state={};
 for(const id of ids){
  const npc=entity(save,id);delete npc.components.relationships;npc.components.wallet={balances:{credit:23}};
  const state=emptyNpcAgentState();state.last_daily_at={...save.runtime.time};state.last_autonomous_at={...save.runtime.time};
  state.private_facts=[{id:'own_secret',proposition:'PRIVATE_ADAPTATION_'+id,source_ref:null}];
  state.goals=[{id:'long_goal',description:'持续维护本人的事务与邻里来往',horizon:'long',status:'active',origin:'self',priority:5}];
  state.plans=[{id:'original',goal_id:'long_goal',intention:'先观察，再前往仓库处理事务',status:'active',execution:{steps:[
   {type:'INSPECT',target_id:null,description:'确认当前广场环境',duration_minutes:null,speech:null},
   {type:'MOVE',target_id:'closed_depot',description:'前往仓库',duration_minutes:null,speech:null}],cursor:0,not_before:null,
   condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}}];
  save.npc_agent_state[id]=state;
 }
 save.npc_daily_last_at={...save.runtime.time};save.npc_autonomy_last_at={...save.runtime.time};return save;
}
it.each(spec.worlds)('adaptive %s world:72 hours, six owner revisions, exact authority and three fresh service replays',async kind=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-adaptation72-')),started=performance.now();
 const initial=seed(kind),start=minute(initial);let calls=0,ownerCalls=0,allowOwner=false,phase=0;
 const makeAi=()=>new AIRuntime({name:'adaptive72-offline',generate:async request=>{
  calls++;if(request.role!=='npc_decision')throw Error('Unexpected adaptive72 role '+request.role);
  if(!allowOwner)return {data:quiet()};ownerCalls++;
  const context=JSON.parse(request.prompt.split('\n\n').at(-1)!).context;
  if(!phase||context.objective_ids.plans.includes('review_'+phase))return {data:quiet()};
  // A new fact does not compel abandonment of a viable bounded method. Let the
  // fixed per-turn action budget finish it before choosing the next method.
  if(context.active_plans.some((p:{id:string})=>p.id.startsWith('review_')))return {data:quiet()};
  if(phase===1)expect(context.plan_recovery).toMatchObject([{plan_id:'original',cursor:1,blocked_reason:'core_rejected'}]);
  if(phase===2)expect(JSON.stringify(context.memories)).toContain('今天的登记安排已确认');
  if(phase>=3)expect(context.own_wallet).toEqual({balances:{credit:0}});
  if(phase>=5){expect(context.scene.location_id).toBe('station');expect(Object.values(context.relationships).some(v=>(v as {familiarity:number}).familiarity>0)).toBe(true);}
  const steps=[...(phase===4?[{type:'MOVE',target_id:'station',description:'本人改到车站处理事务',duration_minutes:null,speech:null}]:[]),
   {type:'HOLD',target_id:null,description:'依据当前事实继续本人事务',duration_minutes:2,speech:null},
   {type:'INSPECT',target_id:null,description:'核对本人方法执行后的当前环境',duration_minutes:null,speech:null},
   ...(phase===4||kind==='relations'?[{type:'TALK',target_id:context.npc_id==='npc_lin'?'npc_qiao':'npc_lin',description:'核对邻里安排',duration_minutes:null,speech:'我已经核对了本人的安排。'}]:[])];
  return {data:{...quiet(),plan_updates:context.active_plans.map((p:{id:string})=>({plan_id:p.id,status:'abandoned'})),
   plan_proposals:[{id:'review_'+phase,goal_id:'long_goal',intention:'根据当前事实保留目标并调整方法',steps,
    ...(kind==='calendar'?{not_before:{day:context.time.day,minute:context.time.minute+60}}:{})}]}};
 }});
 let store=new JsonStore(directory),service=new GameService(store,makeAi(),initial.definition);await store.write(initial);
 let current=await service.current(),completedAssertions=false,last:{body:{game_id:string;expected_revision:number;request_id:string};operation:unknown;response:unknown}|undefined;
 const receipts=new Map<string,string>(),cursors=new Map<string,number>(),prefixes=new Map<string,string>();
 const tx=async(operation:unknown,mutate:(save:Save)=>void)=>{
  const body={game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID()};
  const response=await service.agentTransaction(body,operation,mutate);current=await service.current();last={body,operation,response};
 };
 const replay=async()=>{
  const bytes=await readFile(join(directory,'current.json')),beforeCalls=calls;
  expect(await service.agentTransaction(last!.body,last!.operation,()=>{throw Error('replayed mutator must not run');})).toEqual(last!.response);
  expect(calls).toBe(beforeCalls);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
 };
 try{
  for(let hour=0;hour<spec.hours;hour+=spec.step_minutes/60){
   phase=hour<9?0:hour<12?1:hour<24?2:hour<36?3:hour<48?4:hour<60?5:6;
   if(hour===9)for(const id of ids){const prefix=current.npc_agent_state![id].plans[0].execution!.last_receipt_id;expect(prefix).toBeTruthy();prefixes.set(id,prefix!);}
   if(hour===12)await tx({fixture:'witnessed_new_fact'},save=>recordSceneObservation(save,randomUUID(),[{speaker_id:'npc_qiao',utterance:'今天的登记安排已确认。'}],ids));
   if(hour===24)await tx({fixture:'authoritative_resource_update'},save=>{for(const id of ids)entity(save,id).components.wallet={balances:{credit:0}};});
   if(kind==='trade'&&hour%24===0){
    if(entity(current,'player').components.location?.location_id!=='market')await tx({fixture:'actual_player_commute'},save=>Object.assign(save,executeAction(save,{type:'MOVE',target_id:'market'},randomUUID()).save));
    await tx({fixture:'actual_daily_purchase'},save=>Object.assign(save,executeAction(save,{type:'BUY',target_id:'corner_shop',parameters:{item_id:'bread',quantity:1}},randomUUID()).save));
   }
   for(const id of ids){
    allowOwner=true;let decision:NpcDecision;
    try{decision=await decideNpc(service,current,id,{kind:'world_event',description:'本人核对实际的新事实、资源、位置与关系'});}finally{allowOwner=false;}
    if(decision.plan_proposals.length)await tx({owner:id,phase},save=>applyNpcDecision(save,id,`owner:${id}:${phase}`,decision));
   }
   if(kind==='calendar'&&hour===9){
    await tx({fixture:'before_scheduled_time'},save=>Object.assign(save,executeAction(save,{type:'WAIT',parameters:{minutes:30}},randomUUID()).save));
    for(const id of ids)expect(current.npc_agent_state![id].plans.find(p=>p.id==='review_1')!.execution).toMatchObject({cursor:0,time_credit_minutes:0,blocked_reason:'not_due'});
   }
   const target=start+(hour+spec.step_minutes/60)*60,elapsed=target-minute(current);expect(elapsed).toBeGreaterThan(0);
   await tx({fixture:'paid_world_interval',target},save=>Object.assign(save,executeAction(save,{type:'WAIT',parameters:{minutes:elapsed}},randomUUID()).save));
   expect(minute(current)).toBe(target);expect(JSON.stringify(publicView(current))).not.toContain('PRIVATE_ADAPTATION_');
   for(const receipt of current.resolution_receipts??[]){const encoded=JSON.stringify(receipt);if(receipts.has(receipt.request_id))expect(encoded).toBe(receipts.get(receipt.request_id));receipts.set(receipt.request_id,encoded);}
   expect(new Set((current.resolution_receipts??[]).map(r=>r.request_id)).size).toBe(current.resolution_receipts?.length??0);
   for(const id of ids){
    const state=current.npc_agent_state![id];expect(state.goals).toEqual(initial.npc_agent_state![id].goals);
    for(const plan of state.plans){const key=id+':'+plan.id,cursor=plan.execution!.cursor;expect(cursor).toBeGreaterThanOrEqual(cursors.get(key)??0);cursors.set(key,cursor);}
   }
   const completedHours=hour+spec.step_minutes/60;
   if(completedHours%12===0){await replay();process.stdout.write('ADAPTIVE72_CHECKPOINT '+JSON.stringify({world:kind,hours:completedHours,elapsed_ms:Math.round(performance.now()-started)})+'\n');}
   if(spec.restart_after_hours.includes(completedHours)){
    const before=structuredClone(current);store=new JsonStore(directory);service=new GameService(store,makeAi(),initial.definition);current=await service.current();expect(current).toEqual(before);await replay();
   }
  }
  for(const id of ids){
   const plans=current.npc_agent_state![id].plans;expect(plans).toHaveLength(7);expect(plans[0]).toMatchObject({status:'abandoned',execution:{cursor:1}});
   expect(plans.slice(1).map(p=>p.status)).toEqual(Array(6).fill('completed'));
   const originalReceipt=current.resolution_receipts?.filter(r=>r.actor_id===id&&r.semantic_action==='INSPECT'&&r.request_id===prefixes.get(id))??[];
   expect(originalReceipt).toHaveLength(1);
  }
  if(kind==='trade'){expect((entity(current,'player').components.wallet as {balances:Record<string,number>}).balances.credit).toBe(76);expect((entity(current,'player').components.inventory as {items:Record<string,number>}).items.bread).toBe(3);}
  if(kind==='calendar'){
   expect(current.background_state?.incidents.find(i=>i.id==='adaptive_resolved')?.status).toBe('resolved');
   expect(current.background_state?.incidents.find(i=>i.id==='adaptive_pending')?.status).toBe('active');
   expect(current.gm_state.flags.adaptive_resolved_finished).toBe(true);expect(current.gm_state.flags.adaptive_pending_finished).toBeUndefined();
   expect(current.background_state?.exposure_log).toHaveLength(0);
  }
  expect(minute(current)-start).toBe(spec.hours*60);
  completedAssertions=true;
 }finally{
  process.stdout.write('ADAPTIVE72_METRICS '+JSON.stringify({world:kind,hours:(minute(current)-start)/60,completed_assertions:completedAssertions,restarts:spec.restart_after_hours.length,receipts:receipts.size,offline_calls:calls,owner_calls:ownerCalls,real_provider_calls:0,elapsed_ms:Math.round(performance.now()-started)})+'\n');
  await rm(directory,{recursive:true,force:true});
 }
},240000);

it.each(spec.worlds)('adaptive boundary %s:missing listener and pre-persistence failure retain exact authority then retry once',async kind=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-adaptation-boundary-'));
 try{
  const store=new JsonStore(directory),initial=seed(kind);await store.write(initial);let calls=0;
  const bad:NpcDecision={...quiet(),plan_updates:[{plan_id:'original',status:'abandoned'}],plan_proposals:[{id:'unknown_listener',goal_id:'long_goal',intention:'尝试联系不存在的人',
   steps:[{type:'TALK',target_id:'missing_npc',description:'询问安排',duration_minutes:null,speech:'请问今天有什么安排？'}]}]};
  const invalid=new GameService(store,new AIRuntime({name:'adaptive-boundary-offline',generate:async()=>{calls++;return {data:bad};}}),initial.definition);
  const before=await invalid.current(),bytes=await readFile(join(directory,'current.json')),writes=vi.spyOn(store,'write');
  await expect(decideNpc(invalid,before,'npc_lin',{kind:'world_event',description:'核对缺失对象'})).rejects.toThrow();
  expect(calls).toBe(2);expect(writes).not.toHaveBeenCalled();expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const good:NpcDecision={...quiet(),plan_updates:[{plan_id:'original',status:'abandoned'}],plan_proposals:[{id:'valid_retry',goal_id:'long_goal',intention:'在原地继续事务',
   steps:[{type:'HOLD',target_id:null,description:'本人核对准备',duration_minutes:2,speech:null}]}]};
  const service=new GameService(store,new AIRuntime({name:'adaptive-boundary-offline',generate:async()=>{calls++;return {data:quiet()};}}),initial.definition);
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},operation={fixture:'owner_revision_retry'};
  writes.mockRejectedValueOnce(Error('fixture failure before replacement persistence'));
  await expect(service.agentTransaction(body,operation,save=>applyNpcDecision(save,'npc_lin','valid-owner-retry',good))).rejects.toThrow('fixture failure before replacement persistence');
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect((await store.read())!.npc_agent_state).toEqual(before.npc_agent_state);
  const first=await service.agentTransaction(body,operation,save=>applyNpcDecision(save,'npc_lin','valid-owner-retry',good));
  const saved=await readFile(join(directory,'current.json')),writeCount=writes.mock.calls.length,callCount=calls;
  expect(await service.agentTransaction(body,operation,()=>{throw Error('retry replay must not mutate');})).toEqual(first);
  expect(await readFile(join(directory,'current.json'))).toEqual(saved);expect(writes).toHaveBeenCalledTimes(writeCount);expect(calls).toBe(callCount);
  const current=await service.current();
  await service.agentTransaction({game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID()},{fixture:'paid_retry_execution'},
   save=>Object.assign(save,executeAction(save,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save));
  const after=await service.current();expect(after.npc_agent_state!.npc_lin.plans.filter(p=>p.id==='valid_retry')).toHaveLength(1);
  expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='valid_retry')!.status).toBe('completed');
  expect(after.npc_agent_state!.npc_lin.goals).toEqual(before.npc_agent_state!.npc_lin.goals);
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='HOLD')).toHaveLength(1);
  process.stdout.write('ADAPTIVE_BOUNDARY_METRICS '+JSON.stringify({world:kind,offline_calls:calls,real_provider_calls:0})+'\n');
 }finally{vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});}
});

import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import type {AIRequest} from '../src/ai/contracts.js';
import type {RoutineResult} from '../src/ai/routine.js';
import {createApp} from '../src/server/app.js';
import {demo,MemoryStore} from './helpers.js';
const eventPlan={version:1,blocks:[{id:'first',weekdays:[1,2,3,4,5,6,7],start_minute:540,activity_id:'event_test',candidate_ids:[]},{id:'second',weekdays:[1,2,3,4,5,6,7],start_minute:660,activity_id:'event_test',candidate_ids:[]}],interrupt_policy:['重要事件暂停'],clarification:null};
function eventWorld(){return {...structuredClone(demo),calendar:{version:1 as const,anchor_day:1,anchor_month:1,anchor_date:1,anchor_weekday:1,month_lengths:[31,28,31,30,31,30,31,31,30,31,30,31],source:'test authored calendar'},routine_rules:{version:1 as const,activities:[{id:'event_test',label:'资料整理开放事件',kind:'event' as const,duration:120,location_id:null,mode:'ai' as const,effects:[],source:'测试用已确认事件'}]}};}
function result(req:AIRequest):RoutineResult {
 const input=JSON.parse(req.prompt.split('\n\n').at(-1)!);const start=input.canonical_state.time;
 const total=start.minute+120, dayLength=1440;
 return {segment:{start,end:{day:start.day+Math.floor(total/dayLength),minute:total%dayLength},summary:'完成了一段公共资料整理工作。'},activities:[{kind:'work',summary:'完成上午的资料整理并领取事先约定的报酬。',participants:['player']}],visits:[],patches:[{op:'wallet_delta',key:'credit',target_id:null,delta:8,reason:'已约定的两小时资料整理工资'}],checks:[],interrupt:false,interrupt_reason:null,next_arrangement:'午后阅读',references:{entity_ids:['player'],task_ids:[],activity_ids:['event_test']}} as RoutineResult;
}
async function setup(transform:(r:RoutineResult,req:AIRequest)=>RoutineResult=(r)=>r) {
 const calls:AIRequest[]=[];const store=new MemoryStore();
 const service=new GameService(store,new AIRuntime({name:'fixture',generate:async req=>{if(req.role==='routine_compiler')return {data:eventPlan};calls.push(req);return {data:transform(result(req),req),threadId:'routine-thread'};}}),eventWorld());
 await service.newGame();await service.current();
 return {service,store,calls};
}
async function request(service:GameService,type='START_ROUTINE',parameters?:Record<string,unknown>) {
 const s=await service.current();return {request_id:randomUUID(),game_id:s.game_id,expected_revision:s.state_revision,action:{type,parameters:parameters??(type==='START_ROUTINE'?{label:'日常',pattern:'正常整理资料，遇到重要事情停下'}:{})}};
}
it('START and CONTINUE settle real outcomes once, reuse GM thread, preserve map',async()=>{
 const {service,calls}=await setup();const before=await service.current();const req=await request(service);
 await service.turn(req);await service.turn(req);expect(calls).toHaveLength(1);
 const middle=await service.current();expect(middle.game_id).toBe(before.game_id);expect(middle.definition.map).toEqual(before.definition.map);
 await service.turn(await request(service,'CONTINUE_ROUTINE'));const after=await service.current();
 expect(calls).toHaveLength(2);expect(calls[1].threadId).toBe('routine-thread');expect(calls.every(c=>c.role==='gm_reasoning')).toBe(true);
 expect(after.runtime.time.minute-before.runtime.time.minute).toBe(240);
 expect((after.entities.find(e=>e.id==='player')!.components.wallet.balances as any).credit).toBe((before.entities.find(e=>e.id==='player')!.components.wallet.balances as any).credit+16);
 expect(after.entities.find(e=>e.id==='player')!.components.routine.history).toHaveLength(2);
});
it('HTTP retains revision checks and accepts distinct legacy START/CONTINUE envelopes',async()=>{
 const {service}=await setup();const server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
 try{const token=(await (await fetch(base+'/api/session')).json()).token;const post=(body:unknown)=>fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
 const req=await request(service,'START_ROUTINE',{label:'工作',pattern:'按原计划工作',activities:[],chunk_minutes:60,max_minutes:1440});const response=await post(req);expect(response.status).toBe(202);const job=await response.json();await fetch(base+'/api/routine/jobs/'+job.job_id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:'{}'});for(let i=0;i<100&&service.routineLease;i++)await new Promise(r=>setTimeout(r,5));
 const stale={...req,request_id:randomUUID(),expected_revision:999};expect((await post(stale)).status).toBe(409);
 const next=await post(await request(service,'START_ROUTINE',{label:'日常',pattern:'工作',max_minutes:1440}));expect(next.status).toBe(202);const nextJob=await next.json();await fetch(base+'/api/routine/jobs/'+nextJob.job_id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:'{}'});for(let i=0;i<100&&service.routineLease;i++)await new Promise(r=>setTimeout(r,5));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
for(const [name,mutate] of Object.entries({
 empty:(r:RoutineResult)=>({...r,activities:[],patches:[]}),
 unknownPatch:(r:RoutineResult)=>({...r,patches:[{...r.patches[0],op:'set_map'}]}),
 excessive:(r:RoutineResult)=>({...r,patches:[{...r.patches[0],delta:70},{...r.patches[0],delta:70}]}),
 unknownCurrency:(r:RoutineResult)=>({...r,patches:[{...r.patches[0],key:'gold'}]}),
 backward:(r:RoutineResult)=>({...r,segment:{...r.segment,end:{day:0,minute:0}}}),
 fakeRoll:(r:RoutineResult)=>({...r,segment:{...r.segment,summary:'D20=17，因此得到了收入。'}}),
 gambleWithoutRng:(r:RoutineResult)=>({...r,activities:[{...r.activities[0],kind:'gambling'}]}),
}))it('rejects '+name+' without changing time, revision, IDs, receipts or canonical state',async()=>{
 const {service,store}=await setup(mutate as any);const before=await store.read();await expect(service.turn(await request(service))).rejects.toThrow();expect(await store.read()).toEqual(before);
});
it('interrupt at current time returns control without rewards or time loss',async()=>{
 const {service}=await setup(r=>({...r,segment:{...r.segment,end:r.segment.start,summary:'导师希望与你讨论一个新任务。'},activities:[],patches:[],interrupt:true,interrupt_reason:'需要玩家决定是否接受邀请'}));
 const before=await service.current();const out=await service.turn(await request(service));const r=out.entities.find(e=>e.id===out.player_id)!.components.routine;
 expect(out.time).toEqual(before.runtime.time);expect(r.active).toBe(false);expect(r.interrupted).toBe(true);
});
it('world interrupt hooks pause at a segment boundary',async()=>{
 const {service,store}=await setup();const save=await service.current();save.definition.events.push({id:'invitation',hook:'on_time_advance',location_id:null,probability:1,once:true,public_text:'有人带来需要决定的邀请',set_flag:null,interrupt_automation:true});await store.write(save);
 const out=await service.turn(await request(service));const r=out.entities.find(e=>e.id===out.player_id)!.components.routine;expect(r.active).toBe(false);expect(r.last_interrupt).toContain('邀请');
});
it('formal dice are generated by program and delivered to the second GM call',async()=>{
 const {service,calls}=await setup((r,req)=>{const data=JSON.parse(req.prompt.split('\n\n').at(-1)!);return data.random_results.length?r:{...r,activities:[],patches:[],checks:[{id:'work_check',expression:'1d20',reason:'已约定的普通工作质量检定'}]};});
 const out=await service.turn(await request(service));expect(calls).toHaveLength(2);const data=JSON.parse(calls[1].prompt.split('\n\n').at(-1)!);expect(data.random_results[0].total).toBeGreaterThanOrEqual(1);expect(data.random_results[0].total).toBeLessThanOrEqual(20);
 const history=out.entities.find(e=>e.id===out.player_id)!.components.routine.history as any[];expect(history[0].random_results).toEqual(data.random_results);
});
it('disk failure never commits GM state and the original request can be retried',async()=>{
 const {service,store}=await setup();const before=await store.read();const write=store.write.bind(store);store.write=async()=>{throw Error('disk full')};const req=await request(service);await expect(service.turn(req)).rejects.toThrow('disk full');expect(await store.read()).toEqual(before);store.write=write;await service.turn(req);expect((await service.current()).state_revision).toBe(1);
});
it('state/threads/history survive a new service and failed AI is not downgraded to elapsed time',async()=>{
 const {service,store}=await setup();await service.turn(await request(service));const before=await service.current();const restarted=new GameService(store,new AIRuntime({name:'offline',generate:async()=>{throw Error('offline')}}),demo);expect(await restarted.current()).toEqual(before);await expect(restarted.turn(await request(restarted,'CONTINUE_ROUTINE'))).rejects.toThrow('offline');expect(await restarted.current()).toEqual(before);
});
it('serializes concurrent mutation while a routine GM is running',async()=>{
 let release!:()=>void;const store=new MemoryStore();const service=new GameService(store,new AIRuntime({name:'slow',generate:async req=>{if(req.role==='routine_compiler')return {data:eventPlan};await new Promise<void>(r=>release=r);return {data:result(req)}}}),eventWorld());await service.newGame();const req=await request(service);const pending=service.turn(req);await new Promise(r=>setTimeout(r,10));await expect(service.checkpoint()).rejects.toThrow('正在执行');release();await pending;
});

it('movement follows canonical routes and interrupts before unperformed work pays',async()=>{
 const {service,store}=await setup(r=>({...r,visits:['station']}));const before=await service.current();before.definition.events.push({id:'travel_decision',hook:'on_location_enter',location_id:'station',probability:1,once:true,public_text:'站长请你决定是否接下临时委托',set_flag:null,interrupt_automation:true});await store.write(before);
 const out=await service.turn(await request(service));const player=out.entities.find(e=>e.id===out.player_id)!;
 expect(player.components.location.location_id).toBe('station');expect(out.time.minute-before.runtime.time.minute).toBe(18);
 expect(player.components.wallet).toEqual(before.entities.find(e=>e.id===out.player_id)!.components.wallet);expect(player.components.routine.active).toBe(false);
 expect((player.components.routine.history as any[])[0].patches).toEqual([]);
});
it('rejects teleport and budget bypass before any change',async()=>{
 const {service,store}=await setup(r=>({...r,visits:['unknown_location']}));const before=await store.read();await expect(service.turn(await request(service))).rejects.toThrow('路线');expect(await store.read()).toEqual(before);
});
it('condition deltas update canonical values with an aggregate bound',async()=>{
 const {service,store}=await setup(r=>({...r,patches:[{op:'condition_delta',key:'stamina',target_id:null,delta:-5,reason:'两小时工作消耗体力'}]}));const s=await service.current();s.entities.find(e=>e.id==='player')!.components.condition={hp:100,stamina:76,stress:7};await store.write(s);const out=await service.turn(await request(service));expect(out.entities.find(e=>e.id==='player')!.components.condition.stamina).toBe(71);
});

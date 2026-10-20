import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import type {SavePackage} from '../src/core/schema.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';

const specification=JSON.parse(await readFile(new URL('../docs/fixed-world72-scenarios.v1.json',import.meta.url),'utf8')) as {
  hours:number;checkpoint_minutes:number;restart_after_hours:number[];worlds:{id:'trade'|'relations'|'continuity'}[]};
type World=typeof specification.worlds[number]['id'];
const npcIds=['npc_lin','npc_qiao','npc_mei'];
const entity=(save:SavePackage,id:string)=>save.entities.find(e=>e.id===id)!;
const minute=(save:SavePackage)=>save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
const credit=(save:SavePackage)=>Number((entity(save,'player').components.wallet.balances as Record<string,number>).credit);
const noAction={kind:'no_action',speech:null,vote_target:null,intent:'保留本人已登记的目标与计划',proposed_action:null,
  evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'按已有计划继续',social_response:null};
const routinePlan={version:1,blocks:[{id:'shift',weekdays:[1,2,3,4,5,6,7],start_minute:540,activity_id:'shift',candidate_ids:[]}],
  interrupt_policy:[],clarification:null};

function seed(kind:World){
  const world=structuredClone(demo);world.events=[];world.runtime.time={day:1,minute:540};
  const third=structuredClone(world.entities.find(e=>e.id==='npc_lin')!);third.id='npc_mei';third.components.identity.name='梅青';world.entities.push(third);
  for(const id of npcIds)world.entities.find(e=>e.id===id)!.components.location={location_id:kind==='continuity'?'market':'square'};
  if(kind==='trade')world.entities.find(e=>e.id==='npc_qiao')!.components.location={location_id:'station'};
  world.entities.find(e=>e.id==='player')!.components.location={location_id:kind==='relations'?'station':'square'};
  if(kind!=='trade'){
    world.enabled_modules=world.enabled_modules.filter(id=>id!=='commerce');world.entities=world.entities.filter(e=>e.id!=='corner_shop');
  }
  if(kind==='relations')world.ruleset.relationship_dimensions={familiarity:{min:0,max:100,initial:0,event_deltas:{contact:1}}};
  if(kind==='continuity'){
    world.calendar={version:1,anchor_day:1,anchor_month:1,anchor_date:1,anchor_weekday:1,month_lengths:[31,28,31,30,31,30,31,31,30,31,30,31],source:'固定长期场景的明确日历'};
    world.routine_rules={version:1,activities:[{id:'shift',label:'一小时登记工作',kind:'work',duration:60,location_id:'square',mode:'local',
      effects:[{op:'wallet_delta',key:'credit',target_id:null,delta:2,reason:'明确的一小时登记工资'}],source:'author-defined fixed wage rule'}]};
    world.background_event_policy={enabled:true,target_active_incidents:2,max_dormant_incidents:4,minimum_gap_minutes:180,replenishment:false};
    world.background_incidents=Array.from({length:4},(_,i)=>({id:`watch_${i+1}`,title:'远处岗位登记',summary:'既有值班的远处变化',source:'WORLD_PACKAGE' as const,
      created_at:{day:1,minute:540},earliest_activation:{day:Math.min(3,i+1),minute:600},latest_activation:null,activation_flags:[],activation_chance:1,
      participants:['npc_lin'],locations:['station'],stages:[
        {id:'start',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_lin',effects:[{kind:'set_flag' as const,flag:`watch_${i+1}_started`}],exposures:[],terminal:'none' as const},
        {id:'finish',earliest_after_minutes:120,latest_after_minutes:null,required_flags:i===3?['never_authorized']:[],actor_id:'npc_lin',
          effects:[{kind:'set_flag' as const,flag:`watch_${i+1}_finished`}],exposures:[{id:'notice',channel:'public_notice' as const,location_id:'station',npc_id:null,
            text:'REMOTE_WATCH_NOTICE',interrupt:false,open_loop_label:null}],terminal:'resolved' as const}]}));
  }
  const save=newSave(world);save.npc_agent_state={};
  for(const [index,id] of npcIds.entries()){
    const state=emptyNpcAgentState();state.last_daily_at={...save.runtime.time};state.last_autonomous_at={...save.runtime.time};
    state.private_facts=[{id:'own_secret',proposition:`PRIVATE_WORLD_${kind}_${id}`,source_ref:null}];
    state.goals=[{id:'long_goal',description:kind==='trade'?'长期维护本人的补给与工作':kind==='relations'?'长期维持与两位邻居的来往':'长期维护岗位交接与生活安排',
      horizon:'long',status:'active',origin:'world_creation',priority:5}];
    state.plans=Array.from({length:1},(_,day)=>({id:`day_${day+1}`,goal_id:'long_goal',intention:'本人的已登记日程',status:'active' as const,
      execution:{steps:kind==='relations'?[
        {type:'TALK' as const,target_id:npcIds[(index+1)%3],description:'核对当日安排',duration_minutes:null,speech:'按已有安排继续今天的事务。'},
        {type:'HOLD' as const,target_id:null,description:'进行本人登记工作',duration_minutes:30,speech:null},
        {type:'TALK' as const,target_id:npcIds[(index+2)%3],description:'核对另一位邻居的安排',duration_minutes:null,speech:'按已有安排继续今天的事务。'},
        {type:'HOLD' as const,target_id:null,description:'在原地休息',duration_minutes:30,speech:null},
        {type:'INSPECT' as const,target_id:null,description:'观察本人所在场景',duration_minutes:null,speech:null},
        {type:'HOLD' as const,target_id:null,description:'在原地结束当日安排',duration_minutes:60,speech:null}]:[
        {type:'MOVE' as const,target_id:'station',description:'沿登记路线前往岗位',duration_minutes:null,speech:null},
        {type:'HOLD' as const,target_id:null,description:'进行本人登记工作',duration_minutes:120,speech:null},
        {type:'MOVE' as const,target_id:'market',description:'沿登记路线前往商店区域',duration_minutes:null,speech:null},
        {type:'HOLD' as const,target_id:null,description:'在原地休息',duration_minutes:30,speech:null},
        {type:'MOVE' as const,target_id:'square',description:'沿登记路线返回广场',duration_minutes:null,speech:null},
        {type:'HOLD' as const,target_id:null,description:'在原地结束当日安排',duration_minutes:180,speech:null}],
        cursor:0,not_before:{day:day+1,minute:540},condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}}));
    save.npc_agent_state[id]=state;
  }
  save.npc_daily_last_at={...save.runtime.time};save.npc_autonomy_last_at={...save.runtime.time};return validateSave(save);
}

it.each(specification.worlds.map(world=>world.id))('fixed %s structure:72h exact authority, scheduled work, disk restart and request replay',async kind=>{
  const directory=await mkdtemp(join(tmpdir(),'agf-world72-')),started=performance.now();
  let aiCalls=0,initialAuthority:SavePackage,service:GameService,store=new JsonStore(directory);
  const makeAi=()=>new AIRuntime({name:'fixed-world72-offline',generate:async request=>{
    aiCalls++;
    if(request.role==='npc_decision'){
      const context=JSON.parse(request.prompt.split('\n\n').at(-1)!).context;
      const last=Math.max(...context.objective_ids.plans.map((id:string)=>Number(id.replace('day_',''))));
      if(context.active_plans.length||last>=3)return {data:noAction};
      return {data:{...noAction,plan_proposals:[{id:`day_${last+1}`,goal_id:'long_goal',intention:'延续本人下一日的已登记安排',
        steps:initialAuthority.npc_agent_state![context.npc_id].plans[0].execution!.steps,not_before:{day:last+1,minute:540}}]}};
    }
    if(request.role==='routine_compiler')return {data:routinePlan};
    if(request.role==='narrator')throw new ProviderError('refusal','offline fixture','固定长期场景的描写降级控制');
    throw Error('Unexpected fixed-world72 generation '+request.role);
  }});
  try{
    initialAuthority=seed(kind);await store.write(initialAuthority);service=new GameService(store,makeAi(),initialAuthority.definition);
    let current=await service.current();const initial=structuredClone(current),seenReceipts=new Map<string,string>(),cursors=new Map<string,number>();
    const request=(action:{type:string;target_id?:string;parameters?:Record<string,unknown>})=>({game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID(),action});
    for(const action of [{type:'MOVE',target_id:'missing_place'},{type:'TALK',target_id:kind==='trade'?'npc_qiao':'npc_lin'}]){
      const before=structuredClone(current);await expect(service.turn(request(action))).rejects.toThrow();current=await service.current();
      expect(current.runtime.time).toEqual(before.runtime.time);expect(current.entities).toEqual(before.entities);expect(current.resolution_receipts).toEqual(before.resolution_receipts);
    }
    let previous:Parameters<GameService['turn']>[0]|undefined,previousResult:Awaited<ReturnType<GameService['turn']>>|undefined;
    const repeatLast=async()=>{
      const bytes=await readFile(join(directory,'current.json')),calls=aiCalls;
      expect(await service.turn(previous!)).toEqual(previousResult);expect(aiCalls).toBe(calls);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
    };
    const turn=async(action:{type:string;target_id?:string;parameters?:Record<string,unknown>},replay=false)=>{
      previous=request(action);previousResult=await service.turn(previous);current=await service.current();
      if(replay)await repeatLast();
    };
    for(let hour=0;hour<specification.hours;hour++){
      const target=minute(initial)+(hour+1)*specification.checkpoint_minutes;
      if(hour%24===0){
        if(kind==='trade'){
          if(entity(current,'player').components.location?.location_id!=='market')await turn({type:'MOVE',target_id:'market'},true);
          await turn({type:'BUY',target_id:'corner_shop',parameters:{item_id:'bread',quantity:1}},true);
        }else if(kind==='relations')await turn(hour===0?{type:'MOVE',target_id:'square'}:{type:'TALK',target_id:'npc_lin',parameters:{topic:'核对既有安排'}},true);
        else await turn({type:'START_ROUTINE',parameters:{label:'固定登记工作',pattern:'每天上午九点在广场进行一小时登记工作',max_minutes:60}},true);
      }
      if(minute(current)<target)await turn({type:'WAIT',parameters:{minutes:target-minute(current)}});
      expect(minute(current)).toBe(target);
      expect(JSON.stringify(publicView(current))).not.toContain('PRIVATE_WORLD_');expect(JSON.stringify(current.last_turn)).not.toContain('REMOTE_WATCH_NOTICE');
      const receiptIds=(current.resolution_receipts??[]).map(r=>r.request_id);expect(new Set(receiptIds).size).toBe(receiptIds.length);
      for(const receipt of current.resolution_receipts??[]){
        const encoded=JSON.stringify(receipt);if(seenReceipts.has(receipt.request_id))expect(encoded).toBe(seenReceipts.get(receipt.request_id));seenReceipts.set(receipt.request_id,encoded);
      }
      for(const id of npcIds){
        const state=current.npc_agent_state![id];expect(state.goals).toEqual(initial.npc_agent_state![id].goals);
        for(const plan of state.plans){
          const key=`${id}:${plan.id}`,cursor=plan.execution!.cursor;expect(cursor).toBeGreaterThanOrEqual(cursors.get(key)??0);cursors.set(key,cursor);
          if((plan.execution!.not_before!.day*1440+540)>minute(current))expect(cursor).toBe(0);
        }
      }
      if((hour+1)%12===0){
        await repeatLast();process.stdout.write('FIXED_WORLD72_CHECKPOINT '+JSON.stringify({world:kind,hours:hour+1,elapsed_ms:Math.round(performance.now()-started)})+'\n');
      }
      if(specification.restart_after_hours.includes(hour+1)){
        const image=structuredClone(current),bytes=await readFile(join(directory,'current.json')),calls=aiCalls;
        store=new JsonStore(directory);service=new GameService(store,makeAi(),initial.definition);current=await service.current();
        expect(current).toEqual(image);expect(await service.turn(previous!)).toEqual(previousResult);expect(aiCalls).toBe(calls);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
      }
    }
    for(const id of npcIds)expect(current.npc_agent_state![id].plans.map(p=>({status:p.status,cursor:p.execution!.cursor}))).toEqual(Array.from({length:3},()=>({status:'completed',cursor:6})));
    expect(entity(current,'player').components.condition).toEqual(entity(initial,'player').components.condition);
    if(kind==='trade'){
      expect(credit(current)).toBe(76);expect(entity(current,'player').components.inventory.items).toMatchObject({bread:3});expect(entity(current,'corner_shop').components.shop.stock).toMatchObject({bread:7});
    }else if(kind==='relations'){
      for(const id of npcIds)for(const other of npcIds.filter(npc=>npc!==id))expect((entity(current,id).components.relationships.entries as Record<string,Record<string,number>>)[other].familiarity).toBe(6);
      expect(npcIds.every(id=>current.npc_agent_state![id].memories.some(m=>m.kind==='heard'))).toBe(true);
    }else{
      expect(credit(current)).toBe(106);expect(current.background_state?.incidents.filter(i=>i.status==='resolved')).toHaveLength(3);
      expect(current.background_state?.incidents.find(i=>i.id==='watch_4')?.status).not.toBe('resolved');expect(current.background_state?.exposure_log).toHaveLength(0);
      expect(current.gm_state.flags.watch_4_finished).toBeUndefined();
    }
    process.stdout.write('FIXED_WORLD72_METRICS '+JSON.stringify({world:kind,hours:specification.hours,restarts:specification.restart_after_hours.length,seen_receipts:seenReceipts.size,
      npc_receipts:[...seenReceipts.values()].map(raw=>JSON.parse(raw)).filter(r=>npcIds.includes(r.actor_id)).length,offline_calls:aiCalls,real_provider_calls:0,duration_ms:Math.round(performance.now()-started)})+'\n');
  }finally{await rm(directory,{recursive:true,force:true});}
},900000);

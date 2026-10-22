import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService,requestSchema} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan,localCompoundSteps} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
const narrative=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(narrativeWorldKinds.flatMap(kind=>(['normal','shortage','interrupted','atomic','inferred_atomic'] as const).map(boundary=>({kind,boundary}))))(
 'keeps actual pickup/consume sequence and unexecuted tail consistent in $kind / $boundary',async({kind,boundary})=>{
 const {save}=await consumptionWorld(kind),actor=save.entities.find(e=>e.id==='player')!,item=save.entities.find(e=>e.id==='qa_bread')!;
 delete (actor.components.inventory!.items as Record<string,number>).qa_bread;item.components.item!.stackable=false;item.components.location={location_id:actor.components.location!.location_id};
 if(boundary==='interrupted'){
  actor.components.opportunities={entries:{meal_meeting:{status:'accepted',title:'已接受的会面'}}};
  save.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'meal_meeting',label:'已接受的会面',at:save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute+2,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 const directory=await mkdtemp(join(tmpdir(),'agf-consume-plan-'));try{
  const store=new JsonStore(directory);await store.write(save);const ai=new AIRuntime({name:'offline-consumption-plan',generate:async()=>{throw new ProviderError('refusal','offline-only','fixed refusal');}});
  const original=ai.interpret.bind(ai);vi.spyOn(ai,'interpret').mockImplementation(async(current,text)=>text==='拿起面包'?{type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'held'}}:original(current,text));
  if(boundary!=='atomic'&&boundary!=='inferred_atomic')vi.spyOn(ai,'narrate').mockImplementation(async(_current,action)=>narrative(action.type==='MOVE_ITEM'?'你拿起了面包。':action.type==='CONSUME_ITEM'?'你吃掉了一份面包。':'你在原处停留了一分钟。'));
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const atomic=boundary==='atomic'||boundary==='inferred_atomic';
  const steps=atomic?['拿起面包','吃掉一份']:['拿起面包',boundary==='shortage'?'吃掉两份面包':'吃掉一份','等1分钟'];
  const goals:GoalInput[]=steps.map((text,index)=>({goal_id:'step'+index,type:'WORLD_ACTION',normalized_goal:text,depends_on:index?['step'+(index-1)]:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}));
  let plan=validatePlan({goals});
  if(boundary==='inferred_atomic'){
   plan=validatePlan({goals:[{...goals[0],normalized_goal:steps.join('，然后')}]});
   const inferred=localCompoundSteps(service.project(before),steps.join('，然后'),plan);
   expect(inferred).toEqual(steps);plan.local_compound={steps:inferred!};
  }else if(atomic)plan.local_compound={steps};
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，然后')};
  const turns=vi.spyOn(service,'turn'),response=await executePlan(service,body,plan),after=await service.current();
  const receipts=after.resolution_receipts!.filter(r=>!before.resolution_receipts?.some(old=>old.request_id===r.request_id));
  await writeFile(`.agent-runtime/codex/consumption-plan-${run}-${kind}-${boundary}.json`,JSON.stringify({body,before,response,after,receipts,submitted_turns:turns.mock.calls.map(args=>args[0])},null,2));
  expect(receipts.every(r=>r.commit_status==='committed')).toBe(true);
  if(boundary==='normal'||atomic){
   expect(response.plan?.status).toBe('completed');expect(quantity(after)).toBe(0);
   expect(receipts.filter(r=>r.consumption?.status==='completed')).toHaveLength(1);
  }else{
   expect(response.plan?.goals[2].status).toBe('skipped');expect(response.plan?.goals[1].status).not.toBe('completed');expect(quantity(after)).toBe(1);
   if(boundary==='interrupted'){
    expect(receipts.find(r=>r.consumption)?.consumption).toMatchObject({status:'interrupted',consumed_quantity:0,after_quantity:1});
    expect(after.last_turn!.narrative).toMatch(/尚未|还没|物品数量没有减少/);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+2);
   }else expect(receipts).toHaveLength(1);
  }
  const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);
  for(const args of turns.mock.calls){
   // Failed/uncommitted attempts are not replayed as completed operations.
   if(after.runtime.receipts.some(r=>r.id===requestSchema.parse(args[0]).request_id))await fresh.turn(...args);
  }
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
  if(boundary==='shortage'){
   await fresh.turn({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID(),action:{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}}});expect(quantity(await fresh.current())).toBe(0);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
},90000);

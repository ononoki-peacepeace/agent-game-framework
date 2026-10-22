import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
it.each(narrativeWorldKinds.flatMap(kind=>[false,true].map(fallback=>({kind,fallback}))))('retains event-time item operations after final depletion in $kind / fallback=$fallback',async({kind,fallback})=>{
 const {save}=await consumptionWorld(kind),actor=save.entities.find(e=>e.id==='player')!,bread=save.entities.find(e=>e.id==='qa_bread')!,here=actor.components.location!.location_id;
 delete (actor.components.inventory!.items as Record<string,number>).qa_bread;bread.components.location={location_id:here};bread.components.item!.stackable=false;
 save.entities.push({id:'qa_box',type:'item',components:{identity:{name:'木盒',description:'已打开的容器',avatar_id:null},location:{location_id:here},item:{weight:1,stackable:false,container:true},discovery:{known_to_player:true}}});
 const directory=await mkdtemp(join(tmpdir(),'agf-item-event-prose-'));try{
  const store=new JsonStore(directory);await store.write(save);const prompts:Record<string,unknown>[]=[];
  const text='你拿起面包，将它放进木盒，又从盒里取出。随后你吃掉了一份面包。';
  const ai=new AIRuntime({name:'offline-event-prose',generate:async request=>{
   if(request.role==='narrator'){prompts.push(JSON.parse(request.prompt.slice(request.prompt.indexOf('{'))));if(fallback)throw new ProviderError('refusal','offline-only','fixed refusal');return {data:{narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};}
   throw new ProviderError('refusal','offline-only','No real model');
  }});
  const original=ai.interpret.bind(ai);vi.spyOn(ai,'interpret').mockImplementation(async(current,input)=>input==='拿起面包'||input==='取出面包'?{type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'held'}}:input==='把面包放进木盒'?{type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'scene_container',container_id:'qa_box'}}:original(current,input));
  const service=new GameService(store,ai,save.definition),before=await service.current(),steps=['拿起面包','把面包放进木盒','取出面包','吃掉一份面包'];
  const goals:GoalInput[]=steps.map((normalized_goal,i)=>({goal_id:'step'+i,type:'WORLD_ACTION',normalized_goal,depends_on:i?['step'+(i-1)]:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}));
  const plan=validatePlan({goals});plan.local_compound={steps};const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，再')};
  const stage=vi.spyOn(store,'writePending'),calls=vi.spyOn(service,'turn'),response=await executePlan(service,body,plan),after=await service.current();
  const receipts=after.resolution_receipts!.filter(r=>!before.resolution_receipts?.some(old=>old.request_id===r.request_id));
  await writeFile(`.agent-runtime/codex/item-event-prose-${run}-${kind}-${fallback}.json`,JSON.stringify({body,before,response,after,receipts,prompts,prepared:stage.mock.calls.map(args=>args[0])},null,2));
  expect(response.plan!.status).toBe('completed');expect(quantity(after)).toBe(0);expect(quantity(after,'qa_other_bread','npc_lin')).toBe(2);expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute).toBe(before.runtime.time.minute+5);
  expect(receipts.filter(r=>r.consumption)).toHaveLength(1);expect(receipts.every(r=>r.commit_status==='committed')).toBe(true);
  expect(stage.mock.calls[0][0].narration_item_states!.map(state=>state.items?.qa_bread??0)).toEqual([1,0,1,0]);
  expect(prompts.at(-1)?.resolution_receipt).toMatchObject({compound_steps:[
   {semantic_action:'MOVE_ITEM',item_operation:{kind:'move',item_id:'qa_bread',destination:'held',from_container_id:null}},
   {semantic_action:'MOVE_ITEM',item_operation:{kind:'move',destination:'scene_container',container_id:'qa_box'}},
   {semantic_action:'MOVE_ITEM',item_operation:{kind:'move',destination:'held',from_container_id:'qa_box'}},
   {semantic_action:'CONSUME_ITEM',consumption:{consumed_quantity:1,after_quantity:0}}]});
  const story=after.last_turn!.narrative;expect(story).not.toMatch(/物品位置已更新|已登记物品的位置|inventory/);
  expect(story).toMatch(/拿起|拿在手中/);expect(story).toMatch(/放进.*木盒/);expect(story).toMatch(/取出/);expect(story).toMatch(/吃掉/);
  expect(story.indexOf('放进')).toBeLessThan(story.indexOf('取出'));expect(story.indexOf('取出')).toBeLessThan(story.indexOf('吃掉'));
  const bytes=await readFile(join(directory,'current.json')),metrics=ai.metrics.requests,fresh=new GameService(new JsonStore(directory),ai,save.definition);
  await fresh.turn(calls.mock.calls[0][0]);expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(metrics);
 }finally{await rm(directory,{recursive:true,force:true});}
},150000);

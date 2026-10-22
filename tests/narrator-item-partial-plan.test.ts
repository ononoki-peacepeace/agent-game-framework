import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
afterEach(()=>vi.restoreAllMocks());
it.each(narrativeWorldKinds)('keeps the settled pickup while refusing sealed storage and skipping transfer in %s',async kind=>{
 const {save}=await prepareNarrativeWorld(kind),directory=await mkdtemp(join(tmpdir(),'agf-item-partial-'));
 const here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 save.entities.push({id:'qa_closed',type:'item',components:{identity:{name:'封盒',description:'已密封容器',avatar_id:null},item:{weight:1,stackable:false,container:true,tags:['sealed']},location:{location_id:here},discovery:{known_to_player:true}}});
 try{
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'offline-partial-items',generate:async()=>{throw Error('Unexpected generation');}});
  const steps=['拿起纸片','放进封盒','交给林舟'];
  const interpret=vi.spyOn(ai,'interpret').mockImplementation(async(_save,input)=>input===steps[0]?{type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'held'}}:input===steps[1]?{type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'scene_container',container_id:'qa_closed'}}:{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_paper'}});
  const narrate=vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline-partial-items','固定拒绝'));
  const service=new GameService(store,ai,save.definition),before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，再')};
  const goals:GoalInput[]=steps.map((text,index)=>({goal_id:'step'+index,type:'WORLD_ACTION',normalized_goal:text,depends_on:index?['step'+(index-1)]:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}));
  const response=await executePlan(service,body,validatePlan({goals})),after=await service.current();
  expect(response.results?.map(result=>result.status)).toEqual(['completed','blocked','skipped']);expect(interpret).toHaveBeenCalledTimes(2);expect(narrate).toHaveBeenCalledOnce();
  expect(response.message).toContain('尚未执行');expect(response.message).toContain('交给林舟');
  const receipts=after.resolution_receipts!.filter(receipt=>!before.resolution_receipts?.some(old=>old.request_id===receipt.request_id));expect(receipts).toHaveLength(1);
  expect(after.entities.find(e=>e.id==='player')!.components.inventory!.items).toMatchObject({qa_paper:1});expect(after.entities.find(e=>e.id==='qa_paper')!.components.item!.container_id).toBeUndefined();
  const narrative={narrative:'你拿着纸片。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
  expect(()=>validateResolvedNarrative(receipts[0],narrative,false,undefined,after)).not.toThrow();
  const bytes=await readFile(join(directory,'current.json'));const fresh=new GameService(new JsonStore(directory),ai,save.definition);
  await fresh.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:receipts[0].request_id,input:steps[0]});
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(interpret).toHaveBeenCalledTimes(2);expect(narrate).toHaveBeenCalledOnce();
 }finally{await rm(directory,{recursive:true,force:true});}
},30000);

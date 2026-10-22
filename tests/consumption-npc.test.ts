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
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
it.each(narrativeWorldKinds)('admits an NPC own consumption decision after real transfer and replays one atomic commit in %s',async kind=>{
 const {save}=await consumptionWorld(kind);save.entities.push({id:'qa_roll',type:'item',components:{identity:{name:'面包卷',description:'世界已定义食物',avatar_id:null},item:{weight:.1,stackable:false,consumable:{method:'eat',minutes:2}}}});
 (save.entities.find(e=>e.id==='player')!.components.inventory!.items as Record<string,number>).qa_roll=1;
 const directory=await mkdtemp(join(tmpdir(),'agf-consume-npc-'));try{
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'offline-npc-consumption',generate:async()=>{throw new ProviderError('refusal','offline-only','No real provider');}});
  const decide=vi.spyOn(ai,'npcDecision').mockImplementation(async(_profile,context)=>{
   const ctx=context as {npc_id:string};const acted=ctx.npc_id==='npc_lin';
   return {kind:acted?'proposed_action':'no_action',speech:null,vote_target:null,intent:'消耗本人取得的世界食物',proposed_action:acted?{type:'CONSUME_ITEM',target_id:'qa_roll',reason:'按已有规则吃一份',quantity:1}:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'固定离线NPC本人的结构化决定',social_response:null};
  });
  let service=new GameService(store,ai,save.definition),before=await service.current();
  await service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_roll'}}});
  before=await service.current();expect(quantity(before,'qa_roll','npc_lin')).toBe(1);
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:180}}};
  const response=await service.turn(body),after=await service.current(),receipt=after.resolution_receipts!.find(r=>r.actor_id==='npc_lin'&&r.consumption?.item_id==='qa_roll');
  await writeFile(`.agent-runtime/codex/consumption-npc-${run}-${kind}.json`,JSON.stringify({body,before,after,response,receipt,decision_calls:decide.mock.calls},null,2));
  expect(receipt).toMatchObject({semantic_action:'CONSUME_ITEM',commit_status:'committed',consumption:{consumed_quantity:1,after_quantity:0}});
  expect(quantity(after,'qa_roll','npc_lin')).toBe(0);expect(quantity(after,'qa_other_bread','npc_lin')).toBe(2);
  expect(after.runtime.time.minute+after.runtime.time.day*after.definition.ruleset.minutes_per_day).toBe(before.runtime.time.minute+before.runtime.time.day*before.definition.ruleset.minutes_per_day+180);
  const bytes=await readFile(join(directory,'current.json')),calls=decide.mock.calls.length,metrics=ai.metrics.requests;
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);expect(await fresh.turn(body)).toEqual(response);
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(decide).toHaveBeenCalledTimes(calls);expect(ai.metrics.requests).toBe(metrics);
 }finally{await rm(directory,{recursive:true,force:true});}
},90000);

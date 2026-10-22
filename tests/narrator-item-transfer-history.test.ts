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
it.each(narrativeWorldKinds.flatMap(kind=>[false,true].map(fallback=>({kind,fallback}))))('retains a completed handover after NPC depletion in $kind / fallback=$fallback',async({kind,fallback})=>{
 const {save}=await consumptionWorld(kind);
 save.entities.push({id:'qa_roll',type:'item',components:{identity:{name:'面包卷',description:'世界声明食物',avatar_id:null},item:{weight:.1,stackable:false,consumable:{method:'eat',minutes:2}}}});
 (save.entities.find(e=>e.id==='player')!.components.inventory!.items as Record<string,number>).qa_roll=1;
 const directory=await mkdtemp(join(tmpdir(),'agf-item-transfer-history-'));
 try{
  const store=new JsonStore(directory);await store.write(save);
  const text='你把面包卷交给了林舟，在原地等了180分钟。林舟吃掉了一份面包卷。';
  const ai=new AIRuntime({name:'offline-transfer-history',generate:async request=>{
   if(request.role==='narrator'&&!fallback)return {data:{narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};
   throw new ProviderError('refusal','offline-only','fixed refusal');
  }});
  const original=ai.interpret.bind(ai);vi.spyOn(ai,'interpret').mockImplementation(async(current,input)=>input==='把面包卷交给林舟'?{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_roll'}}:original(current,input));
  vi.spyOn(ai,'npcDecision').mockImplementation(async(_profile,raw)=>{const ctx=raw as {npc_id:string},acted=ctx.npc_id==='npc_lin';
   return {kind:acted?'proposed_action':'no_action',speech:null,vote_target:null,intent:'消耗本人收到的食物',proposed_action:acted?{type:'CONSUME_ITEM',target_id:'qa_roll',quantity:1,reason:'依世界消耗规则'}:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'固定离线本人决定',social_response:null};
  });
  const service=new GameService(store,ai,save.definition),before=await service.current(),steps=['把面包卷交给林舟','等180分钟'];
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，然后')};
  const response=await service.turn(body,undefined,undefined,undefined,false,undefined,steps),after=await service.current();
  const receipts=after.resolution_receipts!.filter(r=>!before.resolution_receipts?.some(old=>old.request_id===r.request_id));
  await writeFile(`.agent-runtime/codex/item-transfer-history-${run}-${kind}-${fallback}.json`,JSON.stringify({body,before,response,after,receipts},null,2));
  expect(quantity(after,'qa_roll')).toBe(0);expect(quantity(after,'qa_roll','npc_lin')).toBe(0);expect(quantity(after)).toBe(3);expect(quantity(after,'qa_other_bread','npc_lin')).toBe(2);
  expect(receipts.find(r=>r.semantic_action==='TRANSFER_ITEM')).toMatchObject({commit_status:'committed',item_operation:{kind:'transfer',item_id:'qa_roll',recipient_id:'npc_lin'}});
  expect(receipts.find(r=>r.consumption?.item_id==='qa_roll')).toMatchObject({commit_status:'committed',consumption:{before_quantity:1,after_quantity:0,consumed_quantity:1}});
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute).toBe(before.runtime.time.minute+181);
  expect(after.last_turn!.presentation!.status).toBe(fallback?'degraded':'normal');
  expect(after.last_turn!.narrative).toContain('你把面包卷交给了林舟');expect(after.last_turn!.narrative).toMatch(/林舟吃掉了[一1]份面包卷/);
  expect(after.last_turn!.narrative).not.toMatch(/物品已交给当前在场的接收者|林舟仍然持有/);
  const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  await new GameService(new JsonStore(directory),ai,save.definition).turn(body);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
},150000);

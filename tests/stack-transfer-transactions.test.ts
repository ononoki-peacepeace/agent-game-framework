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
import type {Shop,Wallet} from '../src/modules/commerce.js';
import type {SavePackage} from '../src/core/schema.js';
import * as core from '../src/core/runtime.js';
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
const minutes=(save:SavePackage)=>save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
const units=(save:SavePackage)=>save.entities.reduce((sum,e)=>sum+Number((e.components.inventory?.items as Record<string,number>|undefined)?.qa_bread??0)+Number((e.components.shop as Shop|undefined)?.stock.qa_bread??0),0);
const balance=(save:SavePackage,id:string,currency:string)=>Number((save.entities.find(e=>e.id===id)!.components.wallet as Wallet).balances[currency]??0);
it.each(narrativeWorldKinds.flatMap(kind=>(['normal','before','after'] as const).map(fault=>({kind,fault}))))('keeps same-ID transfer/consumption/follow-up authoritative through $fault commit boundary in $kind',async({kind,fault})=>{
 const {save}=await consumptionWorld(kind),here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 for(const entities of [save.entities,save.definition.entities]){
  (entities.find(e=>e.id==='player')!.components.inventory!.items as Record<string,number>).qa_bread=1;
  (entities.find(e=>e.id==='npc_lin')!.components.inventory!.items as Record<string,number>).qa_bread=2;
  const merchant=entities.find(e=>e.components.shop);if(merchant){const shop=merchant.components.shop as Shop;
   merchant.components.location={location_id:here};shop.stock.qa_bread=2;shop.prices.qa_bread={buy:1,sell:1};}
 }
 const directory=await mkdtemp(join(tmpdir(),'agf-stack-transfer-'));
 try{
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'offline-stack-transfer',generate:async()=>{throw new ProviderError('refusal','offline-only','fixed refusal');}});
  let npcDecisionStage:'consume'|'finish'='consume';
  const decide=vi.spyOn(ai,'npcDecision').mockImplementation(async(_profile,raw)=>{
   const ctx=raw as {npc_id:string},acted=ctx.npc_id==='npc_lin';return {kind:acted?'proposed_action':'no_action',speech:null,vote_target:null,intent:npcDecisionStage==='consume'?'按世界规则消耗本人持有的两份食物':'按世界规则消耗本人剩余的一份食物',proposed_action:acted?{type:'CONSUME_ITEM',target_id:'qa_bread',quantity:npcDecisionStage==='consume'?2:1,reason:npcDecisionStage==='consume'?'本人现有食物':'本人剩余的一份食物'}:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'固定离线本人决定',social_response:null};
  });
  const service=new GameService(store,ai,save.definition),before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_bread'}}};
  const originalBytes=await readFile(join(directory,'current.json')),write=store.write.bind(store);let injected=false;
  store.write=async(candidate,slot)=>{
   if(fault!=='normal'&&!injected&&candidate.runtime.receipts.some(r=>r.id===body.request_id)){
    injected=true;if(fault==='after')await write(candidate,slot);throw Error('fixed stack transfer write boundary');
   }return write(candidate,slot);
  };
  if(fault==='normal')await service.turn(body);else{
   await expect(service.turn(body)).rejects.toThrow('fixed stack transfer write boundary');expect(injected).toBe(true);
   if(fault==='before')expect(await readFile(join(directory,'current.json'))).toEqual(originalBytes);
  }
  const pending=await store.readPending(body.request_id),calls=decide.mock.calls.length,execute=vi.spyOn(core,'executeAction');
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);await fresh.turn(body);
  const transferred=await fresh.current();expect(execute).not.toHaveBeenCalled();expect(decide).toHaveBeenCalledTimes(calls);
  expect(quantity(transferred)).toBe(0);expect(quantity(transferred,'qa_bread','npc_lin')).toBe(3);expect(units(transferred)).toBe(units(before));
  expect(transferred.state_revision).toBe(before.state_revision+1);expect(minutes(transferred)-minutes(before)).toBe(1);
  expect(transferred.last_turn!.narrative).toBe('你把面包交给了林舟。');expect(transferred.last_turn!.presentation!.status).toBe('degraded');
  const transferBytes=await readFile(join(directory,'current.json'));await new GameService(new JsonStore(directory),ai,save.definition).turn(body);
  expect(await readFile(join(directory,'current.json'))).toEqual(transferBytes);expect(execute).not.toHaveBeenCalled();execute.mockRestore();
  const wait={game_id:transferred.game_id,expected_revision:transferred.state_revision,request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:180}}};
  await fresh.turn(wait);const consumed=await fresh.current(),npcReceipt=consumed.resolution_receipts!.find(r=>r.actor_id==='npc_lin'&&r.consumption?.item_id==='qa_bread');
  expect(npcReceipt).toMatchObject({commit_status:'committed',consumption:{before_quantity:3,consumed_quantity:2,after_quantity:1}});
  expect(quantity(consumed,'qa_bread','npc_lin')).toBe(1);expect(units(consumed)).toBe(units(before)-2);expect(quantity(consumed)).toBe(0);expect(consumed.last_turn!.narrative).toContain('林舟吃掉了2份面包。');
  const npcBytes=await readFile(join(directory,'current.json')),decisionCount=decide.mock.calls.length;
  await new GameService(new JsonStore(directory),ai,save.definition).turn(wait);expect(await readFile(join(directory,'current.json'))).toEqual(npcBytes);expect(decide).toHaveBeenCalledTimes(decisionCount);
  const merchant=consumed.entities.find(e=>e.components.shop),followupRequests:unknown[]=[];
  let after:SavePackage,finalCommittedRequest:unknown,expectedElapsed:number,expectedRevisions:number;
  if(merchant){
   const buy={game_id:consumed.game_id,expected_revision:consumed.state_revision,request_id:randomUUID(),action:{type:'BUY',target_id:merchant.id,parameters:{item_id:'qa_bread',quantity:1}}};
   await fresh.turn(buy);const bought=await fresh.current();expect(quantity(bought)).toBe(1);expect(quantity(bought,'qa_bread','npc_lin')).toBe(1);
   expect((bought.entities.find(e=>e.id===merchant.id)!.components.shop as Shop).stock.qa_bread).toBe(1);
   const sell={game_id:bought.game_id,expected_revision:bought.state_revision,request_id:randomUUID(),action:{type:'SELL',target_id:merchant.id,parameters:{item_id:'qa_bread',quantity:1}}};
   await fresh.turn(sell);const sold=await fresh.current();expect(quantity(sold)).toBe(0);expect(quantity(sold,'qa_bread','npc_lin')).toBe(1);
   const rebuy={...buy,expected_revision:sold.state_revision,request_id:randomUUID()};await fresh.turn(rebuy);const ready=await fresh.current();expect(quantity(ready)).toBe(1);
   const own={game_id:ready.game_id,expected_revision:ready.state_revision,request_id:randomUUID(),input:'吃掉一份面包'};
   await fresh.turn(own);after=await fresh.current();finalCommittedRequest=own;followupRequests.push(buy,sell,rebuy,own);
   const currency=(merchant.components.shop as Shop).currency_id;expect(balance(after,'player',currency)).toBe(balance(before,'player',currency)-1);expect(balance(after,merchant.id,currency)).toBe(balance(before,merchant.id,currency)+1);
   expectedElapsed=1+180+3*save.definition.ruleset.trade_minutes+2;expectedRevisions=6;
  }else{
   // Preserve both original non-commerce worlds. Their next legal operation is
   // the NPC's own consumption, not a fabricated shop or a player asset grant.
   const denied={game_id:consumed.game_id,expected_revision:consumed.state_revision,request_id:randomUUID(),action:{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}}};
   const deniedBytes=await readFile(join(directory,'current.json'));await expect(fresh.turn(denied)).rejects.toThrow();expect(await readFile(join(directory,'current.json'))).toEqual(deniedBytes);followupRequests.push(denied);
   npcDecisionStage='finish';let current=consumed,waits=0,lastWait:unknown;
   while(quantity(current,'qa_bread','npc_lin')===1&&waits<4){
    const nextWait={...wait,expected_revision:current.state_revision,request_id:randomUUID()};await fresh.turn(nextWait);waits++;current=await fresh.current();followupRequests.push(nextWait);lastWait=nextWait;
    expect(quantity(current)).toBe(0);expect([0,1]).toContain(quantity(current,'qa_bread','npc_lin'));
    const bytes=await readFile(join(directory,'current.json')),count=decide.mock.calls.length;await new GameService(new JsonStore(directory),ai,save.definition).turn(nextWait);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(decide).toHaveBeenCalledTimes(count);
   }
   await writeFile(`.agent-runtime/codex/stack-transfer-finish-${run}-${kind}-${fault}.json`,JSON.stringify({consumed,current,followupRequests,decisions:decide.mock.calls},null,2));
   expect(quantity(current,'qa_bread','npc_lin')).toBe(0);expect(current.resolution_receipts!.some(r=>r.actor_id==='npc_lin'&&r.consumption?.item_id==='qa_bread'&&r.consumption.before_quantity===1&&r.consumption.consumed_quantity===1&&r.consumption.after_quantity===0&&r.commit_status==='committed')).toBe(true);
   after=current;finalCommittedRequest=lastWait;expectedElapsed=1+180+waits*180;expectedRevisions=2+waits;
  }
  expect(quantity(after)).toBe(0);expect(quantity(after,'qa_bread','npc_lin')).toBe(merchant?1:0);expect(quantity(after,'qa_other_bread','npc_lin')).toBe(2);
  expect(units(after)).toBe(units(before)-3);expect(minutes(after)-minutes(before)).toBe(expectedElapsed);expect(after.state_revision).toBe(before.state_revision+expectedRevisions);
  const finalBytes=await readFile(join(directory,'current.json')),metric=ai.metrics.requests;await new GameService(new JsonStore(directory),ai,save.definition).turn(finalCommittedRequest);
  expect(await readFile(join(directory,'current.json'))).toEqual(finalBytes);expect(ai.metrics.requests).toBe(metric);
  await writeFile(`.agent-runtime/codex/stack-transfer-transaction-${run}-${kind}-${fault}.json`,JSON.stringify({body,wait,followupRequests,before,pending,transferred,consumed,after,npcReceipt,original_bytes_sha256:(await import('node:crypto')).createHash('sha256').update(originalBytes).digest('hex')},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},180000);

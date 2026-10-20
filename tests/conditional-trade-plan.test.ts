import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {publicView} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import type {SavePackage} from '../src/core/schema.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
const player=(s:SavePackage)=>s.entities.find(e=>e.id==='player')!;
const wallet=(s:SavePackage)=>player(s).components.wallet as {balances:Record<string,number>};
const stock=(s:SavePackage)=>(s.entities.find(e=>e.id==='corner_shop')!.components.shop as {stock:Record<string,number>}).stock;
const itemCount=(s:SavePackage)=>(player(s).components.inventory as {items:Record<string,number>}).items.bread??0;
const goal=(id:string,type:GoalInput['type'],text:string,extra:Partial<GoalInput>={}):GoalInput=>({goal_id:id,type,normalized_goal:text,
 depends_on:[],target_entities:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},...extra});
async function setup(knowledge:'familiar'|'unfamiliar'|'unknown',branch:'then'|'else'='then',issue?:'funds'|'route'|'quantity'|'product'){
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 player(before).components.location={location_id:'square'};const lin=before.entities.find(e=>e.id==='npc_lin')!;
 lin.components.location={location_id:'square'};
 player(before).components.relationships={entries:knowledge==='unknown'?{}:{npc_lin:{familiarity:knowledge==='familiar'?60:0}}};
 if(issue==='funds')wallet(before).balances.credit=0;if(issue==='route')before.definition.map!.routes=[];
 const input=(branch==='then'?'如果我和林舟比较熟，就去街角商店买一份面包':'如果我和林舟不熟，就去街角商店买一份面包').replace('买一份面包',issue==='product'?'买点东西':'买一份面包');
 const goals=[goal('condition','CONDITIONAL_INTENT','判断我和林舟是否熟悉',{condition:{kind:'familiar',entity_id:'npc_lin',description:'我和林舟比较熟'}}),
  goal('move','WORLD_ACTION','去街角商店',{operation_hint:'move',referent:'街角商店',depends_on:['condition'],branch}),
  goal('buy','WORLD_ACTION',issue==='product'?'买点东西':'购买一份面包',{
   operation_hint:'purchase',referent:issue==='product'?'商品':'面包',depends_on:['move'],...(issue==='quantity'?{quantity:2}:{})})];
 const plan=compileGoalContract(publicView(before),validatePlan({goals}),{kind:'manual',text:input});await f.store.write(before);
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
 const interpret=vi.spyOn(f.ai,'interpret').mockRejectedValue(new Error('Typed trade must use Core candidates, not model action hints'));
 const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 return {...f,before,plan,body,interpret};
}
it.each([{knowledge:'familiar',branch:'then'},{knowledge:'unfamiliar',branch:'else'}] as const)(
 'settles conditional MOVE then BUY for $knowledge/$branch using actual post-arrival stock',async({knowledge,branch})=>{
 const f=await setup(knowledge,branch),result=await executePlan(f.service,f.body,f.plan),after=await f.service.current();
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed','completed','completed']);
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['MOVE','BUY']);
 expect(itemCount(after)-itemCount(f.before)).toBe(1);expect(stock(f.before).bread-stock(after).bread).toBe(1);
 expect(wallet(f.before).balances.credit-wallet(after).balances.credit).toBe(8);expect(f.interpret).not.toHaveBeenCalled();
});
it.each([{knowledge:'unfamiliar',branch:'then',tail:['skipped','skipped']},{knowledge:'familiar',branch:'else',tail:['skipped','skipped']},
 {knowledge:'unknown',branch:'then',tail:['unresolved','skipped']}] as const)(
 'evaluates $knowledge/$branch before any preparation instead of vetoing the whole purchase',async({knowledge,branch,tail})=>{
 const f=await setup(knowledge,branch),result=await executePlan(f.service,f.body,f.plan);
 expect(result.plan?.goals.map(g=>g.status)).toEqual(['completed',...tail]);expect(await f.store.read()).toEqual(f.before);
 expect(f.interpret).not.toHaveBeenCalled();
});
it.each(['funds','route'] as const)('preserves world refusal for conditional trade with %s unavailable',async issue=>{
 const f=await setup('familiar','then',issue),result=await executePlan(f.service,f.body,f.plan),after=await f.service.current();
 expect(result.outcome.type).toBe('game');expect(result.plan?.goals.at(-1)?.status).not.toBe('completed');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)??[]).toEqual(issue==='funds'?['MOVE']:[]);
 expect(itemCount(after)).toBe(itemCount(f.before));expect(stock(after)).toEqual(stock(f.before));expect(wallet(after)).toEqual(wallet(f.before));
 expect(f.interpret).not.toHaveBeenCalled();
});
it('does not defer conflicting quantity into an increased purchase',async()=>{
 const f=await setup('familiar','then','quantity');await executePlan(f.service,f.body,f.plan);expect(await f.store.read()).toEqual(f.before);
 expect(f.interpret).not.toHaveBeenCalled();
});
it('may arrive at the requested shop but never guesses an open product choice',async()=>{
 const f=await setup('familiar','then','product'),result=await executePlan(f.service,f.body,f.plan),after=await f.service.current();
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['MOVE']);
 expect(result.plan?.goals.at(-1)?.status).toBe('unresolved');expect(itemCount(after)).toBe(0);
 expect(wallet(after)).toEqual(wallet(f.before));expect(stock(after)).toEqual(stock(f.before));expect(f.interpret).not.toHaveBeenCalled();
});
it('keeps actual MOVE and a typed technical failure when conditional BUY fails',async()=>{
 const f=await setup('familiar'),turn=f.service.turn.bind(f.service);
 vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
  if((args[0] as {action?:{type:string}}).action?.type==='BUY')throw new ProviderError('timeout','offline fixture','购买技术故障');return turn(...args);
 });
 const result=await executePlan(f.service,f.body,f.plan),after=await f.service.current();
 expect(result.outcome.type).toBe('engine_failure');expect(result.canonical_changes).toContain('world_action:move');
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['MOVE']);
 expect(itemCount(after)).toBe(0);expect(wallet(after)).toEqual(wallet(f.before));expect(stock(after)).toEqual(stock(f.before));
 if(result.outcome.type==='engine_failure')expect(result.outcome.receipt_ids.length).toBeGreaterThan(0);
});

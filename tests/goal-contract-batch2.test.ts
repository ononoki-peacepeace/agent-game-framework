import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {discoverContractCandidates,executeContractStep,observePresence,recordContractStep,
  contractPlanCompleted,verifyContractCompletion,runContractPlan} from '../src/agent/affordances.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import type {SavePackage} from '../src/core/schema.js';

const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const narration={narrative:'你完成了眼前的行动。',speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
function step(goal_id:string,type:GoalInput['type'],normalized_goal:string,operation_hint:NonNullable<GoalInput['operation_hint']>,
  referent:string,depends_on:string[]=[]):GoalInput{return {goal_id,type,normalized_goal,operation_hint,referent,depends_on,
    condition:null,branch:null,temporal_scope:temporal,target_entities:[]};}
async function setup(){const f=await sparseSetup();vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);return f;}
function compiled(save:SavePackage,goals:GoalInput[]){
  return compileGoalContract(publicView(save),validatePlan({goals}),{kind:'manual',text:goals.map(g=>g.normalized_goal).join('，')});
}

describe('program-owned affordance and completion evidence',()=>{
  it('uses registered MOVE and committed position evidence without completing dependent goals',async()=>{
    const f=await setup(),before=await f.service.current(),plan=compiled(before,[
      step('g1','WORLD_ACTION','去街角商店','move','街角商店'),
      step('g2','WORLD_ACTION','购买面包','purchase','面包',['g1'])]);
    const goal=plan.goals[0],candidates=discoverContractCandidates(before,publicView(before),goal);
    expect(candidates).toHaveLength(1);expect(candidates[0].action?.type).toBe('MOVE');
    const result=await executeContractStep(f.service,before,goal,randomUUID());
    expect(result.status).toBe('completed');
    expect(result.candidate.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('market');
    const next=recordContractStep(plan,'g1',result);
    expect(next.goals.map(g=>g.status)).toEqual(['completed','pending']);
    expect(contractPlanCompleted(next)).toBe(false);
  });

  it('BUY requires a real trade receipt and matching wallet, inventory and stock deltas',async()=>{
    const f=await setup(),before=await f.service.current(),player=before.entities.find(e=>e.id==='player')!;
    player.components.location={location_id:'market'};await f.store.write(before);
    const plan=compiled(before,[step('buy','WORLD_ACTION','购买面包','purchase','面包')]);
    const choices=discoverContractCandidates(before,publicView(before),plan.goals[0]);
    expect(choices.map(c=>c.id)).toEqual(['BUY:corner_shop:bread']);
    const requestId=randomUUID(),result=await executeContractStep(f.service,before,plan.goals[0],requestId,
      undefined,undefined,plan.contract!.original_intent);
    expect(result.status).toBe('completed');
    expect(result.candidate.resolution_receipts?.find(r=>r.request_id===requestId)).toMatchObject({semantic_action:'BUY',commit_status:'committed'});
    const tampered=structuredClone(result.candidate);
    (tampered.entities.find(e=>e.id==='corner_shop')!.components.shop as {stock:Record<string,number>}).stock.bread++;
    expect(verifyContractCompletion(before,tampered,plan.goals[0],choices[0],requestId)).toBe(false);
  });

  it('never buys when product selection is open, and rejects an invented candidate id',async()=>{
    const f=await setup(),before=await f.service.current();before.entities.find(e=>e.id==='player')!.components.location={location_id:'market'};
    await f.store.write(before);
    const goal=compiled(before,[step('buy','WORLD_ACTION','买点东西','purchase','商品')]).goals[0];
    const pending=await executeContractStep(f.service,before,goal,randomUUID());
    expect(pending.status).toBe('waiting_for_player');
    const modelChoice=await executeContractStep(f.service,before,goal,randomUUID(),
      {candidate_id:'BUY:corner_shop:bread',source:'model'});
    expect(modelChoice.status).toBe('waiting_for_player');
    const invalid=await executeContractStep(f.service,before,goal,randomUUID(),{candidate_id:'BUY:invented:item',source:'model'});
    expect(invalid.status).toBe('blocked');
    expect(await f.service.current()).toEqual(before);
  });

  it('does not substitute a different product or a model-invented quantity',async()=>{
    const f=await setup(),before=await f.service.current();before.entities.find(e=>e.id==='player')!.components.location={location_id:'market'};
    const shop=before.entities.find(e=>e.id==='corner_shop')!.components.shop as {stock:Record<string,number>};
    shop.stock={water:3};await f.store.write(before);
    const missing=compiled(before,[step('buy','WORLD_ACTION','购买面包','purchase','面包')]).goals[0];
    expect((await executeContractStep(f.service,before,missing,randomUUID())).status).toBe('blocked');
    const wrong=step('buy','WORLD_ACTION','购买两份饮用水','purchase','饮用水');wrong.quantity=3;
    const conflicting=compiled(before,[wrong]).goals[0];
    expect(conflicting.contract?.availability).toBe('needs_binding');
    expect((await executeContractStep(f.service,before,conflicting,randomUUID())).status).toBe('waiting_for_player');
    const chinese=compiled(before,[step('many','WORLD_ACTION','购买二十瓶饮用水','purchase','饮用水')]).goals[0];
    expect(chinese.contract?.completion).toMatchObject({quantity:20});
    const unsupported=compiled(before,[step('many','WORLD_ACTION','购买一百瓶饮用水','purchase','饮用水')]).goals[0];
    expect(unsupported.contract?.availability).toBe('needs_binding');
    expect(await f.service.current()).toEqual(before);
  });

  it('insufficient funds and out of stock cannot become purchased evidence',async()=>{
    for(const failure of ['funds','stock']){
      const f=await setup(),before=await f.service.current();before.entities.find(e=>e.id==='player')!.components.location={location_id:'market'};
      if(failure==='funds')(before.entities.find(e=>e.id==='player')!.components.wallet as {balances:Record<string,number>}).balances.credit=0;
      else (before.entities.find(e=>e.id==='corner_shop')!.components.shop as {stock:Record<string,number>}).stock.bread=0;
      await f.store.write(before);
      const goal=compiled(before,[step('buy','WORLD_ACTION','购买面包','purchase','面包')]).goals[0];
      const result=await executeContractStep(f.service,before,goal,randomUUID(),undefined,undefined,'购买面包');
      expect(result.status).toBe('blocked');
      expect((await f.service.current()).state_revision).toBe(before.state_revision);
    }
  });

  it('observes present, authoritative absent, and unknown without mutation',async()=>{
    const f=await setup(),before=await f.service.current();
    for(const [location,expected] of [['square','present'],['market','absent'],[null,'unknown']] as const){
      const save=structuredClone(before),npc=save.entities.find(e=>e.id==='npc_lin')!;
      if(location)npc.components.location={location_id:location};else delete npc.components.location;
      await f.store.write(save);
      const goal=compiled(save,[step('observe','WORLD_QUERY','确认林舟在不在','presence_query','林舟')]).goals[0];
      const result=await executeContractStep(f.service,save,goal,randomUUID());
      expect(result.observation?.value).toBe(expected);
      expect(result.status).toBe(expected==='unknown'?'unknown':'completed');
      expect((await f.service.current()).state_revision).toBe(save.state_revision);
    }
  });

  it('uses registered TALK with a uniquely bound public name and role title',async()=>{
    const f=await setup(),before=await f.service.current(),npc=before.entities.find(e=>e.id==='npc_lin')!;
    npc.components.identity.name='名仓亘';npc.components.character!.role='店长';await f.store.write(before);
    const goal=compiled(before,[step('talk','WORLD_SPEECH','向名仓店长问好','talk','名仓店长')]).goals[0];
    expect(goal.contract?.completion).toEqual({kind:'conversation_attempted',person_id:'npc_lin'});
    const result=await executeContractStep(f.service,before,goal,randomUUID());
    expect(result.status).toBe('completed');
    expect(result.candidate.resolution_receipts?.at(-1)).toMatchObject({semantic_action:'TALK',target_id:'npc_lin'});
  });

  it('keeps Generic Activity on the existing Freeform path and requires its typed receipt',async()=>{
    const f=await setup(),before=await f.service.current();
    vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'候选',minutes:2,target_id:null,facts:[],relationship:null,
      item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
      resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'活动',stages:[],evidence_ids:[]}});
    const goal=compiled(before,[step('activity','WORLD_ACTION','伸个懒腰','activity','自身')]).goals[0];
    const result=await executeContractStep(f.service,before,goal,randomUUID());
    expect(result.status).toBe('completed');
    expect(result.candidate.resolution_receipts?.at(-1)?.activity).toMatchObject({description:'伸个懒腰',occurred:true});
    const fabricated=structuredClone(result.candidate),receipt=fabricated.resolution_receipts?.at(-1);
    if(receipt)delete receipt.activity;
    expect(verifyContractCompletion(before,fabricated,goal,discoverContractCandidates(before,publicView(before),goal)[0],
      result.evidence_request_id!)).toBe(false);
  });

  it('a stale source revision cannot run a selected action or mutate state',async()=>{
    const f=await setup(),before=await f.service.current(),goal=compiled(before,[step('move','WORLD_ACTION','去街角商店','move','街角商店')]).goals[0];
    const newer=structuredClone(before);newer.state_revision++;await f.store.write(newer);
    const result=await executeContractStep(f.service,before,goal,randomUUID(),{candidate_id:'MOVE:market',source:'model'});
    expect(result.status).toBe('blocked');
    expect(await f.service.current()).toEqual(newer);
  });

  it('a model done, missing receipt or five-step budget cannot certify a contract',async()=>{
    const f=await setup(),save=await f.service.current(),plan=compiled(save,[step('g1','WORLD_ACTION','前往街角商店','move','街角商店')]);
    plan.goals[0].status='completed';
    expect(contractPlanCompleted(plan)).toBe(false);
    plan.goals[0].contract!.evidence_refs.push({request_id:null,observed_revision:null});
    expect(contractPlanCompleted(plan)).toBe(false);
  });

  it('manual and Choice contracts use the same isolated runner and completion checks',async()=>{
    for(const source of ['manual','choice'] as const){
      const f=await setup(),save=await f.service.current(),goals=[
        step('g1','WORLD_ACTION','前往街角商店','move','街角商店'),
        step('g2','WORLD_ACTION','购买面包','purchase','面包',['g1']),
        step('g3','WORLD_QUERY','确认乔宁是否在店里','presence_query','乔宁',['g1'])];
      const plan=compileGoalContract(publicView(save),validatePlan({goals}),{kind:source,text:'前往街角商店，购买面包，顺便确认乔宁是否在店里',
        ...(source==='choice'?{offerId:randomUUID()}:{})});
      const outcome=await runContractPlan(f.service,save,plan);
      expect(outcome.plan.status).toBe('completed');
      expect(outcome.plan.goals.map(goal=>goal.status)).toEqual(['completed','completed','completed']);
      expect(outcome.plan.goals[1].contract?.completion).toMatchObject({shop_id:'corner_shop',item_id:'bread',quantity:1});
      expect(outcome.plan.goals[2].result?.observation).toMatchObject({value:'present',source:'public_location'});
      expect(outcome.save.state_revision).toBe(save.state_revision+2);
      expect(contractPlanCompleted(outcome.plan)).toBe(true);
    }
  });

  it('after MOVE an unspecified product waits for the player and preserves the other goal',async()=>{
    const f=await setup(),save=await f.service.current(),plan=compiled(save,[
      step('g1','WORLD_ACTION','前往街角商店','move','街角商店'),
      step('g2','WORLD_ACTION','买点商品','purchase','商品',['g1']),
      step('g3','WORLD_QUERY','确认乔宁是否在店里','presence_query','乔宁',['g1'])]);
    const outcome=await runContractPlan(f.service,save,plan);
    expect(outcome.plan.status).toBe('waiting_for_player');
    expect(outcome.plan.goals.map(goal=>goal.status)).toEqual(['completed','waiting_for_player','completed']);
    expect(outcome.save.state_revision).toBe(save.state_revision+1);
    expect(contractPlanCompleted(outcome.plan)).toBe(false);
  });

  it('a five-step cap reports unfinished work rather than success',async()=>{
    const f=await setup(),save=await f.service.current(),goals=Array.from({length:6},(_,index)=>
      step(`g${index+1}`,'WORLD_QUERY','确认林舟在不在','presence_query','林舟',index?[`g${index}`]:[]));
    const plan=compiled(save,goals),outcome=await runContractPlan(f.service,save,plan);
    expect(outcome.plan.status).toBe('partial');
    expect(outcome.plan.goals.at(-1)?.status).toBe('pending');
    expect(outcome.reason).toContain('行动预算');
    expect(outcome.save.state_revision).toBe(save.state_revision);
  });
});

import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {GameError} from '../src/core/schema.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseSetup,sparseWorld} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {makeCompiledChoiceOffers} from '../src/core/choice-offer.js';
import {contractStepRequestId,executeContractStep} from '../src/agent/affordances.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

const input='去街角商店买点吃的，顺便看看乔宁在不在。';
const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const step=(goal_id:string,normalized_goal:string,operation_hint:NonNullable<GoalInput['operation_hint']>,
  referent:string|null,depends_on:string[]=[]):GoalInput=>({goal_id,type:operation_hint==='presence_query'?'WORLD_QUERY':'WORLD_ACTION',
    normalized_goal,operation_hint,referent,depends_on,condition:null,branch:null,temporal_scope:temporal,target_entities:[]});
const proposal=()=>({goals:[step('move','前往街角商店','move','街角商店'),
  step('buy','买点吃的','purchase','面包',['move']),
  step('observe','确认乔宁是否在场','presence_query','乔宁',['move'])]});
const narration={narrative:'你沿着已知路线来到商店。',speaker:null,dialogue:null,choices:[],
  context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
const actor=(save:Awaited<ReturnType<GameService['current']>>)=>save.entities.find(e=>e.id===save.player_state.entity_id)!;

describe('QA-29 Choice validation and QA-30 purchase authorization',()=>{
  it('missing referents remain unbound without constructing an empty schema mention',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const plan=compileGoalContract(publicView(save),validatePlan({goals:[
      step('move','前往某地','move',null),step('buy','买点东西','purchase',null),
      step('observe','看看某人在不在','presence_query',null),step('talk','与某人说话','talk',null)]}),
      {kind:'manual',text:'前往某地，顺便买点东西，然后看看某人在不在。'});
    expect(plan.goals.map(goal=>goal.contract?.bindings)).toEqual([[],[],[],[]]);
    expect(plan.goals.map(goal=>goal.contract?.availability)).toEqual([
      'needs_binding','runtime_gap','needs_binding','needs_binding']);
    expect(plan.goals.map(goal=>goal.contract?.completion.kind)).toEqual([
      'location_at','purchase','presence_observed','conversation_attempted']);
  });

  it('one invalid Choice is skipped while other independently compiled offers remain',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const plan=vi.spyOn(f.ai,'planGoals').mockImplementation(async(_view,text)=>{
      if(text.includes('未确定'))throw Error('invalid optional choice plan');
      return {goals:[step('activity',text,'activity',null)]};
    });
    const choices=['伸个懒腰','先去未确定的地方，然后再做事','休息一会儿'];
    const offers=await makeCompiledChoiceOffers(save,choices,[],f.ai);
    expect(offers.map(offer=>offer.text)).toEqual(['伸个懒腰','休息一会儿']);
    expect(offers.every(offer=>offer.goal_contract)).toBe(true);
    expect(plan).toHaveBeenCalledTimes(3);
  });

  it('all invalid Choices cannot prevent a valid MOVE commit; a save error still propagates',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'narrate').mockResolvedValue({...narration,choices:['先看看，再决定','先休息，然后再考虑']});
    vi.spyOn(f.ai,'planGoals').mockRejectedValue(Error('optional choice unavailable'));
    const moved=await f.service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),action:{type:'MOVE',target_id:'market',parameters:{}}});
    expect(moved.last_turn?.choices).toEqual([]);
    expect(actor(await f.service.current()).components.location?.location_id).toBe('market');
    const after=await f.service.current();
    vi.spyOn(f.store,'write').mockRejectedValueOnce(Error('isolated save failure'));
    await expect(f.service.turn({game_id:after.game_id,expected_revision:after.state_revision,
      request_id:randomUUID(),action:{type:'MOVE',target_id:'square',parameters:{}}})).rejects.toThrow('isolated save failure');
    expect((await f.service.current()).state_revision).toBe(after.state_revision);
  });

  it('a persisted pending MOVE resumes once; model-suggested bread waits for player while observation continues',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-qa29-'));
    try{
      const ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unmocked provider call');}});
      vi.spyOn(ai,'planGoals').mockImplementation(async(_view,text)=>{
        if(text===input)return proposal();
        throw Error('invalid optional choice plan');
      });
      vi.spyOn(ai,'narrate').mockRejectedValueOnce(new ProviderError('network','temporary','temporarily unavailable'))
        .mockResolvedValue({...narration,choices:['先等等，然后再想']});
      const first=new GameService(new JsonStore(directory),ai,sparseWorld());await first.newGame();
      const before=await first.current(),funds=(actor(before).components.wallet as {balances:Record<string,number>}).balances.credit;
      const started=await handleAgentInput(first,{game_id:before.game_id,expected_revision:before.state_revision,
        request_id:randomUUID(),input});
      const pending=await first.current(),plan=pending.active_goal!.plan;
      const moveId=contractStepRequestId(plan.plan_id,'move',pending.state_revision);
      expect(started.message).toContain('服务暂时失败');
      expect(plan.goals.map(goal=>goal.status)).toEqual(['pending','pending','pending']);
      expect(actor(pending).components.location?.location_id).toBe('square');
      expect(await new JsonStore(directory).readPending(moveId)).not.toBeNull();

      const restarted=new GameService(new JsonStore(directory),ai,sparseWorld());
      const deterministic=new GameError('contract validation failure',503) as GameError&{retry_policy:'manual'};
      deterministic.retry_policy='manual';
      const interrupted=vi.spyOn(restarted,'turn').mockRejectedValueOnce(deterministic);
      const held=await handleAgentInput(restarted,{game_id:pending.game_id,expected_revision:pending.state_revision,
        request_id:randomUUID(),input:'继续目标'});
      expect(held.message).toContain('程序校验未通过');
      expect(held.message).not.toContain('可从当前持久目标安全重试');
      expect((await restarted.current()).state_revision).toBe(pending.state_revision);
      expect(await new JsonStore(directory).readPending(moveId)).not.toBeNull();
      interrupted.mockRestore();

      const resumed=await handleAgentInput(restarted,{game_id:pending.game_id,expected_revision:pending.state_revision,
        request_id:randomUUID(),input:'继续目标'});
      const waiting=await restarted.current();
      expect(resumed.plan?.goals.map(goal=>goal.status)).toEqual(['completed','waiting_for_player','completed']);
      expect(waiting.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
      expect(waiting.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(0);
      expect(await new JsonStore(directory).readPending(moveId)).toBeNull();
      expect((actor(waiting).components.wallet as {balances:Record<string,number>}).balances.credit).toBe(funds);
      expect(waiting.active_goal?.options.some(option=>option.candidate_id==='BUY:corner_shop:bread')).toBe(true);

      const chosen=await handleAgentInput(restarted,{game_id:waiting.game_id,expected_revision:waiting.state_revision,
        request_id:randomUUID(),input:'面包'});
      const bought=await restarted.current();
      expect(chosen.plan?.status).toBe('completed');
      expect(bought.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
      expect((actor(bought).components.inventory as {items:Record<string,number>}).items.bread).toBe(1);
      expect((actor(bought).components.wallet as {balances:Record<string,number>}).balances.credit).toBeLessThan(funds);
    }finally{await rm(directory,{recursive:true,force:true});}
  });

  it('an explicitly named product remains eligible for one verified BUY',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
    actor(save).components.location={location_id:'market'};await f.store.write(save);
    const original='在街角商店购买面包';
    const plan=compileGoalContract(publicView(save),validatePlan({goals:[
      step('buy','购买面包','purchase','面包')]}),{kind:'manual',text:original});
    const result=await executeContractStep(f.service,save,plan.goals[0],randomUUID(),undefined,undefined,original);
    expect(result.status).toBe('completed');
    expect(result.candidate.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
  });
});

import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseSetup,sparseWorld} from './sparse-fixture.js';
import {handleAgentInput,handleChoiceInput,executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {makeCompiledChoiceOffers} from '../src/core/choice-offer.js';
import {committedGoalEvidence} from '../src/agent/affordances.js';
import {validateSave} from '../src/core/state.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

const input='去街角商店买点吃的，顺便看看乔宁在不在。';
const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const goal=(id:string,type:GoalInput['type'],text:string,hint:NonNullable<GoalInput['operation_hint']>,referent:string,depends_on:string[]=[]):GoalInput=>
  ({goal_id:id,type,normalized_goal:text,operation_hint:hint,referent,depends_on,
    condition:null,branch:null,temporal_scope:temporal,target_entities:[]});
const proposal=()=>({goals:[goal('move','WORLD_ACTION','前往街角商店','move','街角商店'),
  goal('buy','WORLD_ACTION','购买食物','purchase','食物',['move']),
  goal('observe','WORLD_QUERY','确认乔宁是否在店里','presence_query','乔宁',['move'])]});
const narration={narrative:'你沿着已知路线继续行动。',speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
async function memory(){
  const f=await sparseSetup();vi.spyOn(f.ai,'planGoals').mockResolvedValue(proposal());
  vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
  return f;
}
async function launch(service:GameService){const save=await service.current();
  return handleAgentInput(service,{request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input});}
const actor=(save:Awaited<ReturnType<GameService['current']>>)=>save.entities.find(entity=>entity.id===save.player_state.entity_id)!;

describe('persistent multi-step goal coordination',()=>{
  it('parks an old waiting goal for a new independent sequence and can resume it without replaying MOVE',async()=>{
    const f=await memory();await launch(f.service);
    const waiting=await f.service.current(),oldId=waiting.active_goal!.plan.plan_id;
    const input='去河岸车站，再回到中央广场';
    const plan=compileGoalContract(f.service.project(waiting),validatePlan({goals:[
      goal('station','WORLD_ACTION','前往河岸车站','move','河岸车站'),
      goal('square','WORLD_ACTION','返回中央广场','move','中央广场',['station'])]}),
      {kind:'manual',text:input});
    const result=await executePlan(f.service,{request_id:randomUUID(),game_id:waiting.game_id,
      expected_revision:waiting.state_revision,input},plan);
    const after=await f.service.current();
    expect(result.plan?.status).toBe('completed');
    expect(after.paused_goals?.at(-1)?.plan.plan_id).toBe(oldId);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(3);
    const resumed=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:after.game_id,
      expected_revision:after.state_revision,input:'恢复之前目标'});
    expect(resumed.plan_id).toBe(oldId);
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(3);
  });
  it('atomically saves MOVE evidence and resumes BUY after a real JsonStore restart',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-goal-batch3-'));
    try{
      const store=new JsonStore(directory),ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unmocked model call');}});
      vi.spyOn(ai,'planGoals').mockResolvedValue(proposal());vi.spyOn(ai,'narrate').mockResolvedValue(narration);
      const first=new GameService(store,ai,sparseWorld());await first.newGame();
      const started=await launch(first),afterMove=await first.current();
      expect(started.plan?.goals.map(goal=>goal.status)).toEqual(['completed','waiting_for_player','completed']);
      expect(started.plan?.status).toBe('waiting_for_player');
      expect(started.presentation).toBe('handoff');
      expect(started.message).toContain('已完成：');
      expect(started.message).toContain('尚未完成：');
      expect(started.message).toContain('需要你决定：');
      expect(started.message).toContain('可选择：');
      expect(afterMove.active_goal?.plan.goals.map(goal=>goal.status)).toEqual(['completed','waiting_for_player','completed']);
      expect(afterMove.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
      const restarted=new GameService(new JsonStore(directory),ai,sparseWorld()),saved=await restarted.current();
      expect(saved.active_goal?.plan.goals[0].contract?.evidence_refs[0].request_id).toBeTruthy();
      const finished=await handleAgentInput(restarted,{request_id:randomUUID(),game_id:saved.game_id,
        expected_revision:saved.state_revision,input:'面包'}),after=await restarted.current();
      expect(finished.plan?.status).toBe('completed');
      expect(finished.message).toBe(after.last_turn?.narrative);
      expect(finished.message).not.toContain('temporary narrator interruption');
      expect(finished.message).not.toContain('尚未完成：');
      expect(after.active_goal?.plan.goals.map(goal=>goal.status)).toEqual(['completed','completed','completed']);
      expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
      expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
      expect((actor(after).components.inventory as {items:Record<string,number>}).items.bread).toBe(1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });

  it('a pre-commit interruption reuses the persisted pending candidate after restart',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-goal-pending-'));
    try{
      const store=new JsonStore(directory),ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unmocked model call');}});
      vi.spyOn(ai,'planGoals').mockResolvedValue(proposal());
      vi.spyOn(ai,'narrate').mockRejectedValueOnce(Error('temporary narrator interruption')).mockResolvedValue(narration);
      const first=new GameService(store,ai,sparseWorld());await first.newGame();
      const attempt=await launch(first),before=await first.current();
      expect(attempt.plan?.goals[0].status).toBe('pending');
      expect(actor(before).components.location?.location_id).toBe('square');
      expect(before.active_goal?.plan.goals[0].status).toBe('pending');
      expect(before.resolution_receipts?.some(receipt=>receipt.semantic_action==='MOVE')).not.toBe(true);
      const restarted=new GameService(new JsonStore(directory),ai,sparseWorld());
      const resumed=await handleAgentInput(restarted,{request_id:randomUUID(),game_id:before.game_id,
        expected_revision:before.state_revision,input:'继续目标'}),after=await restarted.current();
      expect(resumed.plan?.goals[0].status).toBe('completed');
      expect(actor(after).components.location?.location_id).toBe('market');
      expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });

  it('a valid Choice uses its saved graph and reaches the same waiting state',async()=>{
    const f=await memory(),save=await f.service.current();
    const offers=await makeCompiledChoiceOffers(save,[input],[],f.ai);
    const compiledCalls=vi.mocked(f.ai.planGoals).mock.calls.length;
    expect(offers).toHaveLength(1);expect(offers[0].availability_at_generation).not.toBe('UNSUPPORTED');
    save.last_turn={narrative:'你还在广场。',speaker:null,dialogue:null,choices:[input],choice_offers:offers,context_actions:[]};
    await f.store.write(save);
    const result=await handleChoiceInput(f.service,{request_id:randomUUID(),game_id:save.game_id,
      expected_revision:save.state_revision,input},offers[0].id);
    expect(result.plan?.contract?.source).toBe('choice');
    expect(result.plan?.status).toBe('waiting_for_player');
    expect(result.presentation).toBe('handoff');
    expect((await f.service.current()).active_goal?.plan.goals[0].status).toBe('completed');
    expect(vi.mocked(f.ai.planGoals).mock.calls.length).toBe(compiledCalls);
  });

  it('stock changing while waiting invalidates the old product option without charging',async()=>{
    const f=await memory();await launch(f.service);const waiting=await f.service.current();
    const funds=(actor(waiting).components.wallet as {balances:Record<string,number>}).balances.credit;
    await f.service.agentTransaction({game_id:waiting.game_id,expected_revision:waiting.state_revision,request_id:randomUUID()},
      {test_stock_change:true},save=>{(save.entities.find(entity=>entity.id==='corner_shop')!.components.shop as
        {stock:Record<string,number>}).stock.bread=0;});
    const changed=await f.service.current();
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:changed.game_id,
      expected_revision:changed.state_revision,input:'面包'});
    const after=await f.service.current();
    expect(result.plan?.goals.find(goal=>goal.goal_id==='buy')?.status).toBe('blocked');
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    expect(result.presentation).toBe('assistant');
    expect(result.message).toContain('所选行动不在当前合法候选中');
    expect(result.message).not.toContain('移动至 街角商店，用时');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(0);
    expect((actor(after).components.wallet as {balances:Record<string,number>}).balances.credit).toBe(funds);
  });

  it('a duplicated original request reports persisted progress and does not move twice',async()=>{
    const f=await memory(),save=await f.service.current(),request_id=randomUUID();
    await handleAgentInput(f.service,{request_id,game_id:save.game_id,expected_revision:save.state_revision,input});
    const retry=await handleAgentInput(f.service,{request_id,game_id:save.game_id,expected_revision:save.state_revision,input});
    expect(retry.plan?.goals[0].status).toBe('completed');
    expect(retry.message).toContain('已完成：');
    expect(retry.message).toContain('尚未完成：');
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
  });

  it('BUY committed before a lost response is recovered from the same save image',async()=>{
    const f=await memory();await launch(f.service);const waiting=await f.service.current();
    const funds=(actor(waiting).components.wallet as {balances:Record<string,number>}).balances.credit;
    const original=f.service.turn.bind(f.service);
    vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
      const response=await original(...args);
      if((args[0] as {action?:{type:string}}).action?.type==='BUY')throw Error('response lost after commit');
      return response;
    });
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:waiting.game_id,
      expected_revision:waiting.state_revision,input:'面包'}),after=await f.service.current();
    expect(result.plan?.status).toBe('completed');
    expect(result.message).toBe(after.last_turn?.narrative);
    expect(result.message).not.toContain('response lost after commit');
    expect(result.message).not.toContain('尚未完成：');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
    expect((actor(after).components.inventory as {items:Record<string,number>}).items.bread).toBe(1);
    expect((actor(after).components.wallet as {balances:Record<string,number>}).balances.credit).toBeLessThan(funds);
  });

  it('two concurrent replies at one revision cannot purchase twice',async()=>{
    const f=await memory();await launch(f.service);const waiting=await f.service.current();
    const replies=await Promise.allSettled([0,1].map(()=>handleAgentInput(f.service,{request_id:randomUUID(),
      game_id:waiting.game_id,expected_revision:waiting.state_revision,input:'面包'})));
    expect(replies.some(reply=>reply.status==='fulfilled')).toBe(true);
    const after=await f.service.current();
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
    expect((actor(after).components.inventory as {items:Record<string,number>}).items.bread).toBe(1);
  });

  it('authoritative absence completes observation, unknown does not, and unrelated BUY failure leaves the observation intact',async()=>{
    for(const known of [true,false]){
      const f=await memory(),before=await f.service.current(),npc=before.entities.find(entity=>entity.id==='npc_qiao')!;
      if(known)npc.components.location={location_id:'square'};else delete npc.components.location;
      (before.entities.find(entity=>entity.id==='corner_shop')!.components.shop as {stock:Record<string,number>}).stock={};
      await f.store.write(before);
      const outcome=await launch(f.service),after=await f.service.current();
      expect(outcome.plan?.goals.find(goal=>goal.goal_id==='buy')?.status).toBe('blocked');
      expect(outcome.plan?.goals.find(goal=>goal.goal_id==='observe')?.status).toBe(known?'completed':'blocked');
      expect(outcome.plan?.goals.find(goal=>goal.goal_id==='observe')?.result?.observation?.value)
        .toBe(known?'absent':'unknown');
      expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(0);
      expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='TALK')).toHaveLength(0);
    }
  });

  it('a product choice pauses only BUY while an independent absent presence query completes',async()=>{
    const f=await memory(),before=await f.service.current();
    before.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};
    await f.store.write(before);
    const result=await launch(f.service),after=await f.service.current();
    expect(result.plan?.goals.map(entry=>entry.status)).toEqual(['completed','waiting_for_player','completed']);
    expect(result.plan?.goals[2].result?.observation?.value).toBe('absent');
    expect(result.message).toContain('（不在场）');
    expect(result.presentation).toBe('handoff');
    expect(after.active_goal?.options.length).toBeGreaterThan(0);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(0);
  });

  it('a real unavailable action is a world outcome rather than an engine error',async()=>{
    const f=await memory(),before=await f.service.current();
    (before.entities.find(entity=>entity.id==='corner_shop')!.components.shop as
      {stock:Record<string,number>}).stock={};
    await f.store.write(before);
    const result=await launch(f.service);
    expect(result.plan?.status).toBe('blocked');
    expect(result.presentation).toBe('assistant');
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    expect(result.story).toBe((await f.service.current()).last_turn?.narrative);
    expect(result.message).toContain('当前世界没有可用于这个步骤');
    expect(result.message).not.toContain('后续目标仍未发生');
    expect(result.message).not.toMatch(/capability|runtime_gap|schema/);
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(0);
  });

  it('a pre-commit step failure reports failure without claiming a completed action',async()=>{
    const f=await memory(),before=await f.service.current();
    vi.spyOn(f.service,'turn').mockRejectedValueOnce(Error('simulated pre-commit failure'));
    const result=await launch(f.service),after=await f.service.current();
    expect(result.plan?.status).toBe('blocked');
    expect(result.presentation).toBe('failure');
    expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure'});
    expect(result.message).not.toContain('simulated pre-commit failure');
    expect(result.message).not.toContain('已完成：');
    expect(after.resolution_receipts??[]).toHaveLength(0);
    expect(after.runtime.time).toEqual(before.runtime.time);
  });

  it('a binding clarification without a committed action reports only unfinished work',async()=>{
    const f=await memory(),before=await f.service.current();
    actor(before).components.location={location_id:'market'};
    await f.store.write(before);
    vi.mocked(f.ai.planGoals).mockResolvedValue({goals:[goal('buy','WORLD_ACTION','买点吃的','purchase','食物')]});
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'买点吃的'}),after=await f.service.current();
    expect(result.plan?.status).toBe('waiting_for_player');
    expect(result.message).toContain('尚未完成：');
    expect(result.message).toContain('需要你决定：');
    expect(result.message).not.toContain('已完成：');
    expect(after.resolution_receipts??[]).toHaveLength(0);
    expect(after.runtime.time).toEqual(before.runtime.time);
  });

  it('cancel preserves committed MOVE and terminates only remaining goals',async()=>{
    const f=await memory();await launch(f.service);const waiting=await f.service.current();
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:waiting.game_id,
      expected_revision:waiting.state_revision,input:'取消当前目标'}),after=await f.service.current();
    expect(result.plan?.status).toBe('failed');
    expect(actor(after).components.location?.location_id).toBe('market');
    expect(after.active_goal?.plan.goals[0].status).toBe('completed');
    expect(after.active_goal?.plan.goals[1].status).toBe('blocked');
  });

  it('Undo removes a world step and its active-goal evidence together',async()=>{
    const f=await memory();await launch(f.service);
    const prior=(await f.service.current()).active_goal!.plan.goals[0];
    for(let count=0;count<6;count++){
      const save=await f.service.current();if(actor(save).components.location?.location_id==='square')break;
      await f.service.undo({request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision});
    }
    const undone=await f.service.current();
    expect(actor(undone).components.location?.location_id).toBe('square');
    expect(undone.resolution_receipts?.some(receipt=>receipt.semantic_action==='MOVE')).not.toBe(true);
    expect(committedGoalEvidence(undone,prior)).toBe(false);
  });

  it('five-step budget persists an unfinished graph and a later request resumes its sixth query',async()=>{
    const f=await memory(),before=await f.service.current();
    vi.mocked(f.ai.planGoals).mockResolvedValue({goals:Array.from({length:6},(_,index)=>
      goal(`q${index+1}`,'WORLD_QUERY','确认林舟在不在','presence_query','林舟',index?[`q${index}`]:[]))});
    const started=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input:'确认林舟在场，顺便继续逐项确认。'});
    const paused=await f.service.current();
    expect(started.plan?.status).toBe('partial');
    expect(paused.active_goal?.plan.goals.map(entry=>entry.status)).toEqual([
      'completed','completed','completed','completed','completed','pending']);
    const resumed=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:paused.game_id,
      expected_revision:paused.state_revision,input:'继续目标'});
    expect(resumed.plan?.status).toBe('completed');
    expect((await f.service.current()).runtime.time).toEqual(before.runtime.time);
  });

  it('an unrelated read-only action leaves the waiting goal visible, while an old-revision reply is rejected',async()=>{
    const f=await memory();await launch(f.service);const waiting=await f.service.current();
    const unrelated=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:waiting.game_id,
      expected_revision:waiting.state_revision,input:'我现在在哪？'});
    expect(unrelated.message).toContain('街角商店');
    expect(unrelated.message).not.toContain('此前的连续目标仍保持暂停');
    const after=await f.service.current();
    expect(after.active_goal?.plan.status).toBe('waiting_for_player');
    await expect(handleAgentInput(f.service,{request_id:randomUUID(),game_id:after.game_id,
      expected_revision:after.state_revision-1,input:'面包'})).rejects.toThrow('状态已更新');
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(0);
  });

  it('old saves without active_goal remain valid and an underspecified compound plan never starts MOVE',async()=>{
    const f=await memory(),before=await f.service.current();
    expect(before.active_goal).toBeUndefined();expect(()=>validateSave(before)).not.toThrow();
    vi.mocked(f.ai.planGoals).mockResolvedValue({goals:[goal('one','WORLD_GOAL','前往街角商店','other','街角商店')]});
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input});
    expect(result.plan?.status).toBe('blocked');
    expect((await f.service.current()).state_revision).toBe(before.state_revision);
    expect((await f.service.current()).resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE') ?? []).toHaveLength(0);
  });
});

import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {createAgentPlan,validatePlan} from '../src/agent/planner.js';
import {compileGoalContract,sameGoalShape} from '../src/agent/goal-contract.js';
import {makeCompiledChoiceOffers,checkChoiceOffer} from '../src/core/choice-offer.js';
import {handleAgentInput} from '../src/agent/executor.js';
import type {GoalInput} from '../src/agent/plan-schema.js';

const input='去白马便利店买点吃的，顺便看看名仓店长在不在。';
const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const step=(goal_id:string,type:GoalInput['type'],normalized_goal:string,operation_hint:NonNullable<GoalInput['operation_hint']>,
  referent:string,depends_on:string[]=[]):GoalInput=>({goal_id,type,normalized_goal,operation_hint,referent,
    depends_on,condition:null,branch:null,temporal_scope:temporal,target_entities:['fabricated_model_id']});
const proposal=()=>({goals:[
  step('g1','WORLD_ACTION','前往白马便利店','move','白马便利店 雾见站前店'),
  step('g2','WORLD_ACTION','在便利店购买食物','purchase','食物',['g1']),
  step('g3','WORLD_QUERY','确认名仓店长是否在场','presence_query','名仓亘',['g1']),
]});

async function fixture(){
  const f=await sparseSetup(),save=await f.service.current();
  const destination=save.definition.map!.locations.find(place=>place.id==='station')!;
  destination.name='白马便利店 雾见站前店';
  const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  npc.components.identity.name='名仓亘';npc.components.character.role='店长';
  await f.store.write(save);
  vi.spyOn(f.ai,'planGoals').mockResolvedValue(proposal());
  return {...f,save,destinationId:destination.id,npcId:npc.id};
}

describe('shared multi-step goal contract, compilation only',()=>{
  it('manual and authored Choice retain equivalent dependency and completion graphs',async()=>{
    const f=await fixture(),view=publicView(f.save);
    const manual=compileGoalContract(view,await createAgentPlan(f.ai,view,input),{kind:'manual',text:input});
    const offers=await makeCompiledChoiceOffers(f.save,[input],[{index:0,intent_key:'visit',consequence_key:'shop_and_check',target_id:null}],f.ai);
    expect(offers).toHaveLength(1);
    const offer=offers[0],choice=offer.goal_contract!;
    expect(sameGoalShape(choice)).toEqual(sameGoalShape(manual));
    expect(manual.contract).toMatchObject({source:'manual',original_intent:input,execution_mode:'staged',source_revision:view.revision});
    expect(choice.contract).toMatchObject({source:'choice',original_intent:input,offer_id:offer.id,execution_mode:'staged'});
    expect(choice.dependencies).toEqual([{from:'g1',to:'g2'},{from:'g1',to:'g3'}]);
    expect(choice.goals.map(goal=>goal.contract?.completion.kind)).toEqual(['location_at','purchase','presence_observed']);
    expect(choice.goals[0].contract?.completion).toEqual({kind:'location_at',destination_id:f.destinationId});
    expect(choice.goals[1].contract?.completion).toEqual({kind:'purchase',shop_id:null,item_id:null,quantity:1});
    expect(choice.goals[2].contract?.completion).toEqual({kind:'presence_observed',person_id:f.npcId,location_id:null});
    expect(choice.goals.map(goal=>goal.status)).toEqual(['pending','pending','pending']);
    expect(choice.goals.every(goal=>goal.contract?.evidence_refs.length===0)).toBe(true);
    expect(choice.goals[0].target_entities).toEqual([]);
    expect(choice.goals[2].target_entities).toEqual([f.npcId]);
    expect(JSON.stringify(choice)).not.toContain('fabricated_model_id');
    expect(offer.availability_at_generation).toBe('CONDITIONALLY_EXECUTABLE');
  });

  it('compiled staged Choice is preserved and rebound without running its actions at selection time',async()=>{
    const f=await fixture(),offers=await makeCompiledChoiceOffers(f.save,[input],[],f.ai);
    f.save.last_turn={narrative:'测试场景',speaker:null,dialogue:null,choices:[],choice_offers:offers,context_actions:[]};
    await f.store.write(f.save);
    expect(checkChoiceOffer(f.save,offers[0]).goals.map(goal=>goal.contract?.completion.kind))
      .toEqual(['location_at','purchase','presence_observed']);
    expect((await f.service.current()).state_revision).toBe(f.save.state_revision);
  });

  it('manual compound goal does not commit any step if the first candidate fails validation',async()=>{
    const f=await fixture(),turn=vi.spyOn(f.service,'turn');
    const result=await handleAgentInput(f.service,{input,request_id:randomUUID(),game_id:f.save.game_id,expected_revision:f.save.state_revision});
    expect(result.plan?.status).toBe('pending');
    expect(result.plan?.goals.map(goal=>goal.contract?.completion.kind)).toEqual(['location_at','purchase','presence_observed']);
    expect(turn).toHaveBeenCalledTimes(1);
    const after=await f.service.current();
    expect(after.runtime.time).toEqual(f.save.runtime.time);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location)
      .toEqual(f.save.entities.find(entity=>entity.id===f.save.player_state.entity_id)?.components.location);
    expect(after.active_goal?.plan.goals[0].status).toBe('pending');
  });

  it('a model that compresses the compound request into one MOVE hint cannot claim the whole goal',async()=>{
    const f=await fixture(),view=publicView(f.save),compressed=validatePlan({goals:[
      step('g1','WORLD_ACTION','前往白马便利店','move','白马便利店 雾见站前店')]});
    const contract=compileGoalContract(view,compressed,{kind:'manual',text:input});
    expect(contract.contract?.execution_availability).toBe('runtime_gap');
    expect(contract.contract?.execution_mode).toBe('staged');
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[step('g1','WORLD_ACTION','前往白马便利店','move','白马便利店 雾见站前店')]});
    const offered=await makeCompiledChoiceOffers(f.save,[input],[],f.ai);
    expect(offered[0].availability_at_generation).toBe('UNSUPPORTED');
    expect(offered[0].goal_contract?.contract?.original_intent).toBe(input);
  });

  it('an ambiguous or unknown label never becomes a model-selected canonical binding',async()=>{
    const f=await fixture(),view=publicView(f.save);
    const duplicate={...view.locations.find(place=>place.id===f.destinationId)!,id:'another_shop'};
    view.locations.push(duplicate);
    const ambiguous=compileGoalContract(view,validatePlan(proposal()),{kind:'manual',text:input});
    expect(ambiguous.goals[0].contract?.bindings[0]).toMatchObject({entity_id:null,status:'ambiguous'});
    const unknown=validatePlan({goals:[step('g1','WORLD_QUERY','确认不在公开状态的人物','presence_query','不存在的人')]});
    expect(compileGoalContract(view,unknown,{kind:'manual',text:'确认不在公开状态的人物'}).goals[0].contract?.bindings[0])
      .toMatchObject({entity_id:null,status:'unresolved'});
    expect(ambiguous.goals.every(goal=>goal.status==='pending')).toBe(true);
  });

  it('activity evidence requirement stays distinct from purchase and observation',async()=>{
    const f=await fixture(),view=publicView(f.save);
    const plan=validatePlan({goals:[step('a','WORLD_ACTION','整理一会儿房间','activity','房间')]});
    const contract=compileGoalContract(view,plan,{kind:'manual',text:'整理一会儿房间'});
    expect(contract.goals[0].contract?.completion).toEqual({kind:'activity_occurred'});
    expect(contract.goals[0].contract?.evidence_refs).toEqual([]);
  });
});

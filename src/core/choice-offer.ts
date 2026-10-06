import {randomUUID} from 'node:crypto';
import type {ChoiceOffer,SavePackage} from './schema.js';
import {GameError} from './schema.js';
import {publicView} from './state.js';
import {classifyChoiceExecution} from './choice-availability.js';
import type {ChoiceMeaning} from '../ai/choice-diversity.js';
import {fastPlan,localCompoundSteps,validatePlan} from '../agent/planner.js';
import {createAgentPlan} from '../agent/planner.js';
import {compileGoalContract,hasMultipleClauses} from '../agent/goal-contract.js';
import type {AgentPlan} from '../agent/plan-schema.js';
import type {AIRuntime} from '../ai/runtime.js';
import {canExecuteContractPlan,discoverContractCandidates} from '../agent/affordances.js';
import {evaluateWorldPrerequisites} from './prerequisites.js';
import {activityRequirement} from './freeform.js';
import {observe} from '../observability/index.js';
import {z} from 'zod';

function mentionAvailability(save:SavePackage,name:string){
  const view=publicView(save),entities=view.entities.filter(entity=>entity.components.identity?.name===name);
  const locations=view.locations.filter(location=>location.name===name);
  if(entities.length+locations.length!==1)return 'NOT_EXECUTABLE';
  return entities.length?entities[0].components.item?
    evaluateWorldPrerequisites(save,{requirements:[{kind:'item_accessible',subject_id:entities[0].id}]}).status:
    evaluateWorldPrerequisites(save,{target_id:entities[0].id}).status:
    evaluateWorldPrerequisites(save,{requirements:[{kind:'destination_reachable',subject_id:locations[0].id}]}).status;
}

/** Persist hints, never model-selected IDs or generation-time bindings. */
export function makeChoiceOffers(save:SavePackage,choices:string[],meanings:ChoiceMeaning[]=[]):ChoiceOffer[]{
  const view=publicView(save),byIndex=new Map(meanings.map(item=>[item.index,item]));
  return choices.flatMap((choice,index)=>{
    const meaning=byIndex.get(index);
    const availability=classifyChoiceExecution(save,choice,meaning);
    if(availability==='NOT_EXECUTABLE')return [];
    const publicNames=[...view.entities.filter(entity=>entity.id!==view.player_id).map(entity=>String(entity.components.identity?.name??'')),
      ...view.locations.map(location=>location.name)].filter(name=>name.length>=2&&choice.includes(name));
    const targetMentions=[...new Set(publicNames)].filter(name=>!publicNames.some(other=>other!==name&&other.includes(name)));
    if(targetMentions.length>3||targetMentions.some(name=>mentionAvailability(save,name)==='NOT_EXECUTABLE'))return [];
    const fast=fastPlan(view,choice);
    const speechTargets=targetMentions.filter(name=>view.entities.some(entity=>
      entity.components.character&&entity.components.identity?.name===name));
    const actionKind=fast?.goals.length===1&&fast.goals[0].type==='WORLD_SPEECH'&&speechTargets.length===1?
      'WORLD_SPEECH':'WORLD_ACTION';
    const plan=validatePlan({goals:[{goal_id:'choice_action',type:actionKind,normalized_goal:choice,
      depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]});
    const steps=actionKind==='WORLD_ACTION'?localCompoundSteps(view,choice,plan)??[]:[];
    const activity=activityRequirement(save,choice);
    return [{id:randomUUID(),text:choice,source_revision:save.state_revision,
      intent_key:meaning?.intent_key??'world_action',
      consequence_key:activity.kind==='mechanical'||actionKind!=='WORLD_ACTION'?
        (meaning?.consequence_key??choice.slice(0,80)):'activity_occurred',
      action_kind:actionKind,target_mentions:targetMentions,step_hints:steps,
      availability_at_generation:availability}];
  });
}

/** Authoring-side compilation shares the manual Planner; unsupported staged goals remain saved but hidden. */
export async function makeCompiledChoiceOffers(save:SavePackage,choices:string[],meanings:ChoiceMeaning[],ai:AIRuntime):Promise<ChoiceOffer[]>{
  const view=publicView(save),offers=makeChoiceOffers(save,choices,meanings.map(meaning=>({...meaning,target_id:null})));
  const legacyIds=new Set(offers.map(offer=>offer.id));
  // An offered cross-scene goal may mention a person reachable only after MOVE. Compile its full
  // graph before deciding whether that later target makes the offer unsafe.
  for(const [index,choice] of choices.entries())if(!offers.some(offer=>offer.text===choice)){
    const meaning=meanings.find(entry=>entry.index===index);
    offers.push({id:randomUUID(),text:choice,source_revision:save.state_revision,
      intent_key:meaning?.intent_key??'world_action',consequence_key:meaning?.consequence_key??choice.slice(0,80),
      action_kind:'WORLD_ACTION',target_mentions:[],step_hints:[],availability_at_generation:'CONDITIONALLY_EXECUTABLE'});
  }
  const compiled:ChoiceOffer[]=[];
  for(const [offerIndex,offer] of offers.entries()){
    // Only optional Choice planning/contract validation is isolated. The save, runtime and
    // already-settled turn are outside this boundary and must still fail normally.
    try{
    let plan:AgentPlan;
    try{plan=await createAgentPlan(ai,view,offer.text);}
    catch(error){
      // A failed semantic compile must never turn a multi-clause offer into an executable text-only guess.
      if(hasMultipleClauses(offer.text))throw error;
      plan=validatePlan({goals:[{goal_id:'choice_action',type:offer.action_kind,normalized_goal:offer.text,
        depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]});
    }
    if(offer.step_hints.length&&plan.goals.length===1&&plan.goals[0].type==='WORLD_ACTION')
      plan.local_compound={steps:[...offer.step_hints]};
    const contract=compileGoalContract(view,plan,{kind:'choice',text:offer.text,offerId:offer.id});
    const typed=canExecuteContractPlan(contract);
    const unsupported=!typed&&contract.contract?.execution_mode==='staged'&&contract.contract.execution_availability!=='ready'||
      contract.goals.some(goal=>goal.contract?.completion.kind==='location_at'&&goal.contract.availability!=='ready')||
      contract.goals.some(goal=>goal.contract?.completion.kind==='conversation_attempted'&&goal.contract.availability!=='ready')||
      typed&&contract.goals.some(goal=>['location_at','purchase','conversation_attempted','item_location'].includes(
        goal.contract?.completion.kind??'')&&goal.depends_on.length===0&&
        discoverContractCandidates(save,view,goal,offer.text).length===0);
    if(!legacyIds.has(offer.id)&&!typed&&!hasMultipleClauses(offer.text)&&
      classifyChoiceExecution(save,offer.text,meanings.find(entry=>entry.index===choices.indexOf(offer.text)))==='NOT_EXECUTABLE')
      continue;
    compiled.push({...offer,goal_contract:contract,
      availability_at_generation:unsupported?
        'UNSUPPORTED':offer.availability_at_generation});
    }catch(error){
      observe('warn','choice.offer.invalid',{module:'choice',metadata:{offer_id:offer.id,offer_index:offerIndex,
        reason:error instanceof Error?error.name:typeof error,
        issue_path:error instanceof z.ZodError?error.issues[0]?.path.join('.')??null:null}});
    }
  }
  return compiled;
}

/** Called at click time with the latest save. An old revision alone does not block execution. */
export function checkChoiceOffer(save:SavePackage,offer:ChoiceOffer){
  if(!save.last_turn?.choice_offers?.some(item=>item.id===offer.id))
    throw new GameError('这个选项已不在当前场景中，请查看最新选项。',409);
  if(offer.availability_at_generation==='UNSUPPORTED')
    throw new GameError('这个连续目标已记录，但当前执行器尚不能可靠完成，世界状态没有改变。',409);
  const view=publicView(save);
  if(offer.goal_contract&&canExecuteContractPlan(offer.goal_contract as AgentPlan)){
    const original=offer.goal_contract as AgentPlan;
    if(original.contract?.source!=='choice'||original.contract.original_intent!==offer.text||original.contract.offer_id!==offer.id)
      throw new GameError('选项目标契约与原始选项不一致，请刷新后重试。',409);
    const rebound=compileGoalContract(view,original,{kind:'choice',text:offer.text,offerId:offer.id});
    if(!canExecuteContractPlan(rebound)||original.goals.some((goal,index)=>goal.contract?.bindings.some((binding,bindingIndex)=>
      binding.status==='bound'&&(rebound.goals[index]?.contract?.bindings[bindingIndex]?.status!=='bound'||
        rebound.goals[index]?.contract?.bindings[bindingIndex]?.entity_id!==binding.entity_id))))
      throw new GameError('选项中的目标或可用能力已变化，请查看最新场景。',409);
    return rebound;
  }
  for(const name of offer.target_mentions){
    if(mentionAvailability(save,name)==='NOT_EXECUTABLE')throw new GameError('选项中的目标目前不可用，请查看最新场景。',409);
  }
  if(classifyChoiceExecution(save,offer.text)==='NOT_EXECUTABLE')
    throw new GameError('这个选项所需条件已变化，世界状态没有改变。',409);
  if(offer.goal_contract){
    const original=offer.goal_contract as AgentPlan;
    if(original.contract?.source!=='choice'||original.contract.original_intent!==offer.text||original.contract.offer_id!==offer.id)
      throw new GameError('选项目标契约与原始选项不一致，请刷新后重试。',409);
    const rebound=compileGoalContract(view,original,{kind:'choice',text:offer.text,offerId:offer.id});
    if(rebound.goals.some(goal=>goal.contract?.completion.kind==='location_at'&&goal.contract.availability!=='ready'))
      throw new GameError('目的地尚未能唯一确认，请查看最新场景。',409);
    if(original.goals.some((goal,index)=>goal.contract?.bindings.some((binding,bindingIndex)=>
      binding.status==='bound'&&(rebound.goals[index]?.contract?.bindings[bindingIndex]?.status!=='bound'||
        rebound.goals[index]?.contract?.bindings[bindingIndex]?.entity_id!==binding.entity_id))))
      throw new GameError('选项中的目标已变化，请查看最新场景。',409);
    if(rebound.contract?.execution_mode==='staged'&&rebound.contract.execution_availability!=='ready')
      throw new GameError('这个连续目标目前不能可靠执行，世界状态没有改变。',409);
    return rebound;
  }
  const speechTargets=offer.target_mentions.flatMap(name=>view.entities.filter(entity=>
    entity.components.character&&entity.components.identity?.name===name).map(entity=>entity.id));
  if(offer.action_kind==='WORLD_SPEECH'&&speechTargets.length!==1)
    throw new GameError('对话目标已变化，请重新选择。',409);
  const plan=validatePlan({goals:[{goal_id:'choice_action',type:offer.action_kind,normalized_goal:offer.text,
    depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},
    target_entities:offer.action_kind==='WORLD_SPEECH'?speechTargets:[]}]});
  if(offer.step_hints.length){
    const currentSteps=localCompoundSteps(view,offer.text,plan);
    if(!currentSteps||JSON.stringify(currentSteps)!==JSON.stringify(offer.step_hints))
      throw new GameError('这个连续行动的场景条件已变化，请重新选择。',409);
    plan.local_compound={steps:currentSteps};
  }
  return plan;
}

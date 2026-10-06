import type {SavePackage} from './schema.js';
import {activityRequirement,knownDestination,requiresCanonicalItemMutation,requestsItemRelocation} from './freeform.js';
import {publicView} from './state.js';
import type {ChoiceMeaning} from '../ai/choice-diversity.js';
import {evaluateWorldPrerequisites} from './prerequisites.js';
import {bindStorageAction} from './action-binding.js';
import {requiresPersistentProgress} from './completion-evidence.js';
import {resolveEntities} from '../agent/entities.js';

export type ChoiceExecution='EXECUTABLE'|'CONDITIONALLY_EXECUTABLE'|'NOT_EXECUTABLE';
export function classifyChoiceExecution(save:SavePackage,choice:string,meaning?:ChoiceMeaning,candidateNarrative=''):ChoiceExecution{
  // A choice is a promise that clicking can settle its stated outcome. Time/activity is not
  // evidence for a quantified or final milestone, so do not offer one without a contract.
  if(requiresPersistentProgress(choice))return 'NOT_EXECUTABLE';
  if(!activityRequirement(save,choice).available)return 'NOT_EXECUTABLE';
  const view=publicView(save);
  if(requiresCanonicalItemMutation(choice)&&!requestsItemRelocation(choice)){
    const items=resolveEntities(view,choice).matches.filter(entity=>Boolean(entity.components.item));
    if(items.length!==1||evaluateWorldPrerequisites(save,{requirements:[{kind:'item_accessible',subject_id:items[0].id}]}).status!=='EXECUTABLE')
      return 'NOT_EXECUTABLE';
  }
  if(requestsItemRelocation(choice)){
    if(!bindStorageAction(save,choice).usableForAction)return 'NOT_EXECUTABLE';
  }
  const named=knownDestination(save,choice);
  const semanticPlace=meaning?.target_id&&/去|到|前往|走向|进入|移动/.test(choice)?view.locations.find(place=>place.id===meaning.target_id):undefined;
  const destination=named??semanticPlace;
  if(destination){
    const result=evaluateWorldPrerequisites(save,{requirements:[{kind:'destination_reachable',subject_id:destination.id}]});
    return result.status;
  }
  if(meaning?.target_id){
    if(view.locations.some(place=>place.id===meaning.target_id))return 'CONDITIONALLY_EXECUTABLE';
    return evaluateWorldPrerequisites(save,{target_id:meaning.target_id}).status;
  }
  return 'CONDITIONALLY_EXECUTABLE';
}

/** Resolve obvious route/target prerequisites against the same canonical view the executor uses. */
export function executableChoiceIndices(save:SavePackage,choices:string[],meanings:ChoiceMeaning[]=[],candidateNarrative=''){
  const byIndex=new Map(meanings.map(meaning=>[meaning.index,meaning]));
  return choices.flatMap((choice,index)=>classifyChoiceExecution(save,choice,byIndex.get(index),candidateNarrative)==='NOT_EXECUTABLE'?[]:[index]);
}
export function executableChoices(save:SavePackage,choices:string[],meanings:ChoiceMeaning[]=[],candidateNarrative=''){
  const allowed=new Set(executableChoiceIndices(save,choices,meanings,candidateNarrative));return choices.filter((_,index)=>allowed.has(index));
}

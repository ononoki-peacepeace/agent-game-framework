import type {SavePackage} from './schema.js';

/** A quantified or formal milestone is durable progress, not merely time spent on an activity. */
export const persistentProgressPattern=/(?:第\s*)?(?:[0-9零一二两三四五六七八九十]+|上|下|这)(?:一|整)?(?:页|章|节|题|段).{0,24}(?:写完|做完|读完|完成)|(?:写完|做完|读完|完成).{0,24}(?:第\s*)?(?:[0-9零一二两三四五六七八九十]+|上|下|这)(?:一|整)?(?:页|章|节|题|段)|(?:全部|整份|整个).{0,24}(?:写完|做完|读完|完成)|(?:写完|做完|读完|完成).{0,24}(?:全部|整份|整个)|(?:正式任务|任务目标).{0,24}(?:完成|做完)/;
export const requiresPersistentProgress=(input:string)=>persistentProgressPattern.test(input);

export function progressChanges(before:SavePackage,after:SavePackage){
  return Object.entries(after.task_progress??{}).flatMap(([key,value])=>{
    const previous=before.task_progress?.[key]??0;
    return Number.isInteger(value)&&value>previous?[{key,before:previous,after:value}]:[];
  }).slice(0,12);
}

/** This evidence records an occurred activity, never an object or task-state mutation. */
export function activityEvidence(save:SavePackage,input:string,minutes:number){
  const actor=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const location=actor?.components.location?.location_id;
  return {description:input.trim().slice(0,300),location_id:typeof location==='string'?location:null,
    duration_minutes:minutes,occurred:true as const};
}

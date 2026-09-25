import type {Action,SavePackage} from './schema.js';
// Only authored mechanical rules supply completion evidence. Text, acknowledgements and LLM claims do not.
export function settleTaskObjectives(save:SavePackage,action:Action){
  const player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
  const now=save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
  for(const rule of save.definition.task_rules??[]){
    const book=player.components[rule.book] as {entries?:Record<string,{status:string}>}|undefined,record=book?.entries?.[rule.task_id];
    if(!record||record.status!=='accepted'||now<rule.start_at||now>rule.end_at||player.components.location.location_id!==rule.location_id)continue;
    const progress=(save.task_progress??={}),index=progress[rule.task_id]??0,step=rule.steps[index];
    if(!step||step.action!==action.type||(step.target_id&&step.target_id!==action.target_id)||action.time_cost<step.minimum_minutes)continue;
    progress[rule.task_id]=index+1;
    if(index+1===rule.steps.length){record.status='completed';const scheduled=save.routine_meta?.scheduled_tasks.find(t=>t.id===rule.task_id);if(scheduled){scheduled.status='completed';scheduled.resolved=true;}}
  }
}

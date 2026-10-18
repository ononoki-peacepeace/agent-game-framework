import type {AgentResult} from '../agent/contracts.js';
import type {PublicView} from '../shared/contracts.js';

export interface AgentPresentation {
  storyOverride: {revision:number;text:string}|null;
  agentReply: {intent:string;message:string;appearance?:'handoff'|'failure'}|null;
  goalProgress: {completed:string[];unfinished:string[];reason:string|null}|null;
}

function visibleStep(step:string,view:PublicView|null|undefined){
  if(step==='scene_interaction'){
    const id=view?.interaction_context?.target_entity_id;
    const name=view?.entities.find(entity=>entity.id===id)?.components.identity?.name;
    return name?`与${name}交谈`:'与在场人物交谈';
  }
  // Outcome step IDs are structured metadata. An unknown internal code has no safe public label.
  if(/^[a-z][a-z_]*$/.test(step))return null;
  return step.trim()||null;
}

/** Choose one visible outlet for a result; a stale last_turn is not a new story. */
export function agentPresentation(previous:PublicView|null,result:AgentResult,
  systemHandoff=false):AgentPresentation{
  const empty:AgentPresentation={storyOverride:null,agentReply:null,goalProgress:null};
  const message=result.message.trim();
  if(!message||systemHandoff)return empty;
  const next=result.view;
  // A new committed turn may legitimately use the same prose as the previous turn.
  // Its revision still makes it the story for this response, not assistant feedback.
  const freshNarrative=Boolean(next?.last_turn?.narrative?.trim())&&
    (next?.revision!==previous?.revision||next?.last_turn?.narrative!==previous?.last_turn?.narrative);
  const engineFailure=result.outcome?.type==='engine_failure';
  // A state poll may reach the committed revision before the input response. In that case
  // the story is already on screen, even though comparing two views calls it "stale".
  const committedStoryAlreadyVisible=result.presentation==='story'&&result.outcome?.type==='game'&&
    result.outcome.receipt_ids.length>0&&result.outcome.revision===next?.revision&&
    Boolean(next?.last_turn?.narrative?.trim())&&message===next?.last_turn?.narrative?.trim();
  const goals=result.plan?.goals??[];
  const completed=goals.filter(goal=>goal.status==='completed').map(goal=>goal.normalized_goal);
  const remaining=goals.filter(goal=>goal.status!=='completed'&&goal.status!=='skipped');
  const planProgress=completed.length&&remaining.length?{
    completed,unfinished:remaining.map(goal=>goal.normalized_goal),
    reason:remaining.find(goal=>goal.status==='blocked'&&goal.result?.summary)?.result?.summary??null,
  }:null;
  const outcomeSteps=result.outcome?.type==='game'&&result.outcome.stage!=='natural_scene'?
    result.outcome.completed_steps.map(step=>visibleStep(step,next)).filter((step):step is string=>Boolean(step)):[];
  const outcomeProgress=!planProgress&&result.outcome?.type==='game'&&
    result.outcome.kind==='partial_progress'&&outcomeSteps.length?{
      completed:outcomeSteps,unfinished:[],reason:null}:null;
  const openGoalSteps=!planProgress&&goals.some(goal=>goal.type==='WORLD_GOAL')?
    goals.filter(goal=>goal.type==='WORLD_GOAL'&&goal.status==='completed')
      .map(goal=>result.results?.find(entry=>entry.goal_id===goal.goal_id)?.summary?.trim())
      .filter((value):value is string=>Boolean(value)):[];
  const goalProgress=planProgress??(openGoalSteps.length?{completed:openGoalSteps,
    unfinished:[],reason:null}:null)??outcomeProgress;
  if(engineFailure&&next&&result.outcome?.type==='engine_failure'&&
    result.outcome.revision===next.revision&&
    (result.outcome.receipt_ids.length>0||result.outcome.committed_steps.length>0)){
    const story=result.story?.trim();
    if(story){
      return {storyOverride:story!==next.last_turn?.narrative?.trim()?{revision:next.revision,text:story}:null,
        agentReply:{intent:result.intent,message:result.message,appearance:'failure'},goalProgress};
    }
  }
  if(!engineFailure&&result.presentation==='story'&&next){
    if(committedStoryAlreadyVisible&&!freshNarrative)return {storyOverride:null,agentReply:null,goalProgress};
    if(freshNarrative){
      // Only an explicitly assembled sequence of Narrator turns may override the latest committed turn.
      const story=result.story?.trim();
      const factualReply=goals.filter(goal=>goal.status==='completed'&&
        !['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL'].includes(goal.type))
        .map(goal=>result.results?.find(entry=>entry.goal_id===goal.goal_id)?.summary?.trim())
        .filter((value):value is string=>Boolean(value)&&value!==story&&value!==next.last_turn?.narrative);
      return {storyOverride:story&&!next.last_turn?.scene_beats?.length&&story!==next.last_turn?.narrative?
        {revision:next.revision,text:story}:null,
        agentReply:factualReply.length?{intent:result.intent,message:[...new Set(factualReply)].join('\n')}:null,goalProgress};
    }
  }
  return {storyOverride:null,goalProgress,agentReply:{intent:result.intent,message:result.message,
    appearance:engineFailure?'failure':result.presentation==='handoff'?'handoff':undefined}};
}

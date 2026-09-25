import {assert,type SavePackage} from '../core/schema.js';
import {executeAction} from '../core/runtime.js';
import {validateSave} from '../core/state.js';
import {absoluteTime,dateAt} from './calendar.js';
import {routinePlanSchema,windowDurationLabel,windowLabel,type ActivityRule,type ScheduledTask} from './schema.js';
import {settleRoutine,applyLifePatches} from '../server/routine-controller.js';
import type {AIRuntime} from '../ai/runtime.js';
import type {RoutineResult} from '../ai/routine.js';
import {observe} from '../observability/index.js';
export const routineOf=(s:SavePackage)=>s.entities.find(e=>e.id===s.player_state.entity_id)!.components.routine;
function pause(s:SavePackage,reason:string){const r=routineOf(s);r.active=false;r.interrupted=true;r.status='interrupted';r.last_interrupt=reason;s.last_turn={narrative:reason,speaker:null,dialogue:null,choices:[],context_actions:[]};return validateSave(s);}
function wait(s:SavePackage,minutes:number){if(!minutes)return s;const original=s.definition.ruleset.max_wait_minutes;s.definition.ruleset.max_wait_minutes=Math.max(original,minutes);const next=executeAction(s,{type:'WAIT',parameters:{minutes}},'local-routine','player',undefined,undefined,false).save;next.definition.ruleset.max_wait_minutes=original;return next;}
function pathTo(s:SavePackage,target:string){
 const start=String(s.entities.find(e=>e.id===s.player_state.entity_id)!.components.location.location_id);if(start===target)return [];
 const routes=[...(s.definition.map?.routes??[]),...s.map_state.dynamic_routes].filter(r=>r.conditions.every(c=>s.gm_state.flags[c.flag]===c.equals)&&s.map_state.known_location_ids.includes(r.to));
 if(!routes.length)return [];
 const queue=[{id:start,path:[] as typeof routes,cost:0}],visited=new Set<string>();
 while(queue.length){queue.sort((a,b)=>a.cost-b.cost);const n=queue.shift()!;if(n.id===target)return n.path;if(visited.has(n.id))continue;visited.add(n.id);for(const r of routes.filter(r=>r.from===n.id))queue.push({id:r.to,path:[...n.path,r],cost:n.cost+r.travel_minutes});}
 throw Error('日程目的地没有可通行的已知路线，请手动处理');
}
// Accepted commitments are hard schedule constraints covering a window (morning / half-day / exact minutes…).
export interface TaskWindow {task:ScheduledTask;start:number;end:number}
export function taskWindows(s:SavePackage):TaskWindow[]{
 const minutesPerDay=s.definition.ruleset.minutes_per_day;
 return (s.routine_meta?.scheduled_tasks??[])
  .filter(task=>!task.resolved&&task.status==='accepted')
  .map(task=>({task,start:task.at,end:Math.max(task.end_at??task.at+1,task.at+1)}))
  .sort((a,b)=>a.start-b.start);
}
export function taskWindowText(task:ScheduledTask){
 return `${windowLabel[task.window]}${task.duration_label?`（${task.duration_label}）`:''}`;
}
function appendLocal(s:SavePackage,start:SavePackage['runtime']['time'],summary:string,rule?:ActivityRule,patches:RoutineResult['patches']=[]){const r=routineOf(s);const minutes=(s.runtime.time.day-start.day)*1440+s.runtime.time.minute-start.minute;r.elapsed_minutes=Number(r.elapsed_minutes??0)+minutes;r.cycles=Number(r.cycles??0)+1;
 const kind=rule?.kind==='social'?'social':rule?.kind==='work'?'work':rule?.kind==='training'?'training':rule?.kind==='course'||rule?.kind==='study'?'course':'rest';
 r.history=[...(Array.isArray(r.history)?r.history:[]),{start,end:s.runtime.time,summary,activities:[{kind,summary,participants:[s.player_state.entity_id]}],patches,random_results:[],interrupt:!!r.interrupted,interrupt_reason:r.last_interrupt??null}].slice(-30);
 s.last_turn={narrative:summary,speaker:null,dialogue:null,choices:[],context_actions:[]};return validateSave(s);
}
export async function sparseStep(input:SavePackage,ai:AIRuntime,horizon:number,signal?:AbortSignal,onPhase?:(phase:string)=>void){
 let s=structuredClone(input);signal?.throwIfAborted();assert(s.calendar,'日历映射待确认，生活模拟未推进');assert(!s.routine_meta?.calendar_issue,s.routine_meta?.calendar_issue??'日历待确认');
 const r=routineOf(s),plan=routinePlanSchema.parse(r.plan);assert(!plan.clarification,plan.clarification??'计划需要澄清');
 const now=absoluteTime(s),minutesPerDay=s.definition.ruleset.minutes_per_day,windows=taskWindows(s);
 const active=windows.find(w=>now>=w.start&&now<w.end);
 if(active)return pause(s,`已到已接受安排的固定时间：${active.task.label}（${taskWindowText(active.task)}）。请先处理它，或明确取消这项安排。`);
 const nextWindow=windows.find(w=>w.start>now),hard=nextWindow?.task;
 const limit=Math.min(horizon,nextWindow?.start??Infinity,(s.runtime.time.day+1)*minutesPerDay);if(now>=limit)return s;
 const rules=s.definition.routine_rules?.activities??[],completed=Array.isArray(r.completed_blocks)?r.completed_blocks as string[]:[];
 const slots=[] as {key:string;start:number;end:number;rule:ActivityRule;candidate_ids:string[]}[];
 for(let day=s.runtime.time.day-1;day<=s.runtime.time.day+7;day++)for(const block of plan.blocks){if(day<0||!block.weekdays.includes(dateAt(s.calendar,day).weekday))continue;const rule=rules.find(x=>x.id===block.activity_id);assert(rule,'活动规则已丢失，请重新编译计划');const start=day*1440+block.start_minute,end=start+rule.duration,key=day+':'+block.id;if(end>now&&!completed.includes(key))slots.push({key,start,end,rule,candidate_ids:block.candidate_ids});}
 slots.sort((a,b)=>a.start-b.start);const slot=slots[0];if(!slot)return pause(s,'未来一周没有可执行的固定安排，请调整生活计划。');
 r.next_arrangement=slot.rule.label;onPhase?.('local');
 const startTime=structuredClone(s.runtime.time);const travel=slot.rule.location_id?pathTo(s,slot.rule.location_id):[];const travelCost=travel.reduce((n,x)=>n+x.travel_minutes,0);
 const departure=slot.start-travelCost;
 const weekday=dateAt(s.calendar,s.runtime.time.day).weekday,branch=now<departure?'wait_until_departure':travel.length?'travel':now<slot.start?'wait_until_start':slot.rule.mode==='ai'?'ai_event':'local_activity';
 const reasons=[`星期${weekday}命中计划块 ${slot.key}`,`活动规则 ${slot.rule.id} 来自世界定义`,hard?`已接受安排 ${hard.label}（${taskWindowText(hard)}）构成硬边界`:'当前没有更早的已接受安排'];
 reasons.push(travel.length?`需要移动 ${travelCost} 分钟前往 ${slot.rule.location_id}`:'无需移动，就在当前地点');
 // Routine trace: why this activity was selected, and whether an AI call was needed at all.
 observe('info','routine.scheduler.local_activity',{module:'routine',revision:s.state_revision,metadata:{selected:slot.rule.id,label:slot.rule.label,kind:slot.rule.kind,ai_call:branch==='ai_event',branch,slot:slot.key,start_minute:slot.start,end_minute:slot.end,due_in_minutes:slot.start-now,travel_minutes:travelCost,hard_window:hard?{id:hard.id,label:hard.label,window:hard.window,at:hard.at,end_at:hard.end_at??null}:null,reasons}});

 if(now<departure){const end=Math.min(departure,limit,now+1440);s=wait(s,end-now);return appendLocal(s,startTime,'按计划休息，等待下一项安排：'+slot.rule.label);}
 if(travel.length){const edge=travel[0];if(now+edge.travel_minutes>limit){if(limit>now)s=wait(s,limit-now);return hard&&limit===nextWindow!.start?pause(s,`已接受安排即将开始，停止普通行程：${hard.label}（${taskWindowText(hard)}）。`):appendLocal(s,startTime,'本批生活暂停在出发前。');}
 s=executeAction(s,{type:'MOVE',target_id:edge.to},'routine-move','player',undefined,undefined,false).save;return appendLocal(s,startTime,'按既定路线前往'+([...(s.definition.map?.locations??[]),...s.map_state.dynamic_locations].find(l=>l.id===edge.to)?.name??'目的地')+'。');}
 if(now<slot.start){s=wait(s,Math.min(slot.start,limit)-now);return appendLocal(s,startTime,'等待'+slot.rule.label+'开始。');}
 if(slot.rule.mode==='ai'){
   if(slot.end>limit)return hard&&limit===nextWindow!.start?pause(s,`已接受安排临近，开放活动暂不开始：${hard.label}（${taskWindowText(hard)}）。`):pause(s,'本批剩余时间不足以处理开放事件，可继续下一批。');
   onPhase?.('ai');
   const allowed=new Set(slot.candidate_ids);const actorLocation=s.entities.find(e=>e.id===s.player_state.entity_id)!.components.location.location_id;
   const candidates=s.entities.filter(e=>e.id!==s.player_state.entity_id&&e.components.character&&(!allowed.size||allowed.has(e.id))&&e.components.location?.location_id===actorLocation).map(e=>e.id);
   if(slot.rule.kind==='social'&&!candidates.length)return pause(s,'当前没有可参加这次社交的人物，请调整时间或地点。');
   s=await settleRoutine(s,ai,slot.end-now,(candidate,max,random,planned)=>ai.sparseEvent(candidate,max,slot.rule.id,signal,random,planned,slot.rule.kind==='social'?candidates:undefined));signal?.throwIfAborted();
   routineOf(s).completed_blocks=[...completed,slot.key].slice(-300);return s;
 }
 const end=Math.min(slot.end,limit);const duration=end-now;s=wait(s,duration);
 const progress=r.block_progress as {key:string;minutes:number}|undefined;const accrued=(progress?.key===slot.key?progress.minutes:0)+duration;routineOf(s).block_progress={key:slot.key,minutes:accrued};
 if(!routineOf(s).interrupted && end===slot.end){
   const player=s.entities.find(e=>e.id===s.player_state.entity_id)!;
   // Recovery saturates; all other numeric permissions use the same validator as sparse AI.
   // A world that never tracked condition simply skips those effects instead of failing the whole batch.
   const conditionTracked=Boolean(player.components.condition);
   const applicable=slot.rule.effects.filter(p=>p.op!=='condition_delta'||conditionTracked);
   if(applicable.length!==slot.rule.effects.length)observe('warn','routine.effect.skipped',{module:'routine',revision:s.state_revision,metadata:{activity:slot.rule.id,skipped:slot.rule.effects.length-applicable.length,reason:'玩家还没有 condition 组件，条件类收益未结算'}});
   const effects=applicable.map(p=>{let delta=p.delta;if(accrued<slot.rule.duration)delta=slot.rule.kind==='work'?0:Math.trunc(delta*accrued/slot.rule.duration);if(p.op==='condition_delta'&&player.components.condition){const value=Number(player.components.condition[p.key]);delta=Math.max(-value,Math.min(100-value,delta));}return {...p,delta};}).filter(p=>p.delta!==0);
   const dummy={patches:effects} as RoutineResult;applyLifePatches(s,dummy);routineOf(s).completed_blocks=[...completed,slot.key].slice(-300);

   delete routineOf(s).block_progress;s=appendLocal(s,startTime,slot.rule.label+'已完成。',slot.rule,effects);
 }else s=appendLocal(s,startTime,slot.rule.label+'进行至当前安全边界，未发放整项收益。',slot.rule);
 const reachedWindow=windows.find(w=>absoluteTime(s)>=w.start&&absoluteTime(s)<w.end);
 if(reachedWindow)return pause(s,`已到已接受安排的固定时间：${reachedWindow.task.label}（${taskWindowText(reachedWindow.task)}）。请先处理它，或明确取消这项安排。`);
 return validateSave(s);
}

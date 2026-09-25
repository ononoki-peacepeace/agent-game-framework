import {useState} from 'react';
import type {PanelProps} from './panels.js';
import {playerOf} from './panels.js';
import {windowLabel} from '../routine/schema.js';
import {dateAt} from '../routine/calendar.js';
import type {RoutinePlan} from '../routine/schema.js';

const phases:Record<string,string>={queued:'等待执行',waiting_for_safe_handoff:'等待安全交接',compiling:'正在编译',running_local:'本地推进中',waiting_for_ai:'正在请求 AI',validating:'校验中',committing:'正在提交',idle:''};
const states:Record<string,string>={queued:'等待执行',running:'运行中',paused:'已暂停',interrupted:'已中断',failed:'本次处理失败',completed:'本批完成',cancelled:'已暂停'};
export function RoutinePlanPanel({view,act,busy,routineJob,pauseRoutine,onOpenLogs,configureCalendar}:PanelProps){
  const r=playerOf(view).components.routine as {pattern?:string;label?:string;plan?:RoutinePlan;supplements?:string[];history?:{summary:string}[]};
  const configured=!!r?.pattern&&r.pattern!=='未设置';
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState('');
  const [month,setMonth]=useState(''),[day,setDay]=useState(''),[weekday,setWeekday]=useState(''),[error,setError]=useState('');
  const running=!!routineJob&&['queued','running'].includes(routineJob.status);
  const visibleJob=configured&&routineJob&&(running||routineJob.last_revision>=view.revision)?routineJob:null;
  const planState=!configured?'未设置':running&&routineJob?.phase==='compiling'?'正在编译':r.plan?.clarification?'需要补充信息':r.plan?'已编译':'已保存';
  const edit=()=>{setDraft(configured?[r.pattern,...(r.supplements??[])].join('\n'):'');setEditing(true);};
  return <div className="routine-panel-compose">
    <strong>生活计划：{planState}</strong>
    {!configured&&<p>尚未设置生活模式。你可以保存一套长期生活安排；不设置也可以正常逐回合游戏。</p>}
    <p>后台任务：{visibleJob?states[visibleJob.status]:'无后台任务'}</p>
    {visibleJob&&<><p>当前阶段：{phases[visibleJob.phase]||states[visibleJob.status]}</p><p>{visibleJob.message}</p>{visibleJob.last_ai&&<small>最近一次 AI：{visibleJob.last_ai.provider} / {visibleJob.last_ai.status==='ok'?'成功':'失败'} / {(visibleJob.last_ai.duration_ms/1000).toFixed(1)}s</small>}</>}
    {running&&<button onClick={pauseRoutine}>请求安全暂停</button>}
    {visibleJob?.status==='failed'&&<p>已提交的生活仍保留；失败段未提交。请在左侧输入继续日常重试。<button className="quiet" onClick={onOpenLogs}>查看日志</button></p>}
    {configured&&<><p style={{whiteSpace:'pre-wrap'}}>{r.pattern}</p>{r.supplements?.map((s,i)=><p key={i}>{s}</p>)}<p>当前时间：{view.time_label}</p></>}
    {r?.plan?.clarification&&<p className="routine-interrupt">需要补充信息：{r.plan.clarification}</p>}
    {!!r?.plan?.blocks.length&&<details><summary>编译后的安排</summary><ul>{r.plan.blocks.map(b=><li key={b.id}>{view.routine_activities?.find(a=>a.id===b.activity_id)?.label??'已登记活动'} · 周{b.weekdays.join('/')} · 内部执行参考 {Math.floor(b.start_minute/60)}:{String(b.start_minute%60).padStart(2,'0')}</li>)}</ul></details>}
    {!!r?.plan?.applied_assumptions.length&&<details><summary>自动补全推断</summary><ul>{r.plan.applied_assumptions.map((s,i)=><li key={i}>{s}</li>)}</ul></details>}
    {!editing?<div className="button-row"><button disabled={busy||running} onClick={edit}>{configured?'编辑计划':'创建计划'}</button>{configured&&<button className="quiet" disabled={busy||running} onClick={()=>act({type:'CLEAR_ROUTINE',parameters:{}})}>清除计划</button>}</div>:<div><textarea aria-label="生活规则" value={draft} maxLength={3000} onChange={e=>setDraft(e.target.value)}/><div className="button-row"><button disabled={busy||running||!draft.trim()} onClick={()=>{act({type:'SAVE_ROUTINE',parameters:{label:r?.label&&r.label!=='未设置'?r.label:'生活计划',pattern:draft.trim()}});setEditing(false);}}>保存计划</button><button className="quiet" onClick={()=>setEditing(false)}>取消编辑</button></div></div>}
    <small>保存只更新长期计划，不推进世界。在左侧输入“继续按现在的生活计划生活”才会开始后台推进。</small>
    {view.calendar_issue&&<div className="routine-interrupt"><p>{view.calendar_issue}</p><p>建立当前日期映射，采用非闰年公历月长，不回算历史。</p><input aria-label="当前月份" placeholder="月" value={month} onChange={e=>setMonth(e.target.value)}/><input aria-label="当前日期" placeholder="日" value={day} onChange={e=>setDay(e.target.value)}/><input aria-label="当前星期" placeholder="星期 1–7" value={weekday} onChange={e=>setWeekday(e.target.value)}/><button disabled={running||!month||!day||!weekday} onClick={()=>void configureCalendar?.({version:1,anchor_day:view.time.day,anchor_month:Number(month),anchor_date:Number(day),anchor_weekday:Number(weekday),month_lengths:[31,28,31,30,31,30,31,31,30,31,30,31],source:'玩家确认当前日期'}).catch(e=>setError(e.message))}>确认日期映射</button>{error&&<p>{error}</p>}</div>}
    {view.scheduled_tasks?.filter(t=>!t.resolved&&t.status==='accepted').map(t=>{const date=view.calendar?dateAt(view.calendar,Math.floor(t.at/view.minutes_per_day)):null;return <article className="routine-commitment" key={t.id}><strong>{t.label}</strong><p>已接受</p><p>{date?`${date.month}月${date.day}日 周${'一二三四五六日'[date.weekday-1]}`:'日期待确认'} {windowLabel[t.window]}</p><small>时长：{t.duration_label??'待确认'} · 已为该任务预留时间</small><p>完成情况由任务规则判定。</p></article>;})}
    {!!r?.history?.length&&<details><summary>最近自动完成</summary>{r.history.slice(-4).map((h,i)=><p key={i}>{h.summary}</p>)}</details>}
  </div>;
}

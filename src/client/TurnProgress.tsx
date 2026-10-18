import {useEffect,useRef,useState} from 'react';
import type {InputStatus} from './input-recovery.js';
import {estimateTurnProgress,observedPhases,phaseBand,progressProfileFor,PHASE_LABELS} from './turn-progress.js';

export type TurnProgressState={requestId:string;gameId:string;path:'input'|'action';
  state:'running'|'completed'|'failed'|'partial'|'unknown';
  phase:NonNullable<InputStatus<unknown>['phase']>|'submitted';history:string[];committedRevision:number|null};

/**
 * The estimate is time-driven inside a stage, so it needs a clock tick while the request runs; nothing here talks to
 * the server, changes the world or triggers another model call.
 */
const TICK_MS=500;

/**
 * Only server-observed stages are listed, and the card is a fixed-height summary: the detail list lives in a panel
 * anchored below the card so expanding it can never move the header row or grow upward.
 */
export function TurnProgress({value,defaultOpen=false}:{value:TurnProgressState|null;defaultOpen?:boolean}){
  const phaseClock=useRef<{stamp:string;at:number}|null>(null);
  // The estimate must never travel backwards, including when an out-of-order status poll reports an older stage.
  const peak=useRef<{requestId:string;percent:number}>({requestId:'',percent:0});
  const [open,setOpen]=useState(defaultOpen);
  const [,bumpTick]=useState(0);
  const stamp=value?`${value.requestId}:${value.phase}`:'';
  useEffect(()=>{
    if(!value)return;
    if(phaseClock.current?.stamp!==stamp)phaseClock.current={stamp,at:Date.now()};
  },[stamp,Boolean(value)]);
  const running=value?.state==='running';
  useEffect(()=>{
    if(!running)return undefined;
    const timer=window.setInterval(()=>bumpTick(previous=>previous+1),TICK_MS);
    return()=>window.clearInterval(timer);
  },[running]);
  if(!value)return null;
  const now=Date.now();
  const phaseStartedAt=phaseClock.current?.stamp===stamp?phaseClock.current.at:now;
  const estimate=estimateTurnProgress({phase:value.phase,state:value.state,phaseStartedAt,now,
    profile:progressProfileFor(value.path)});
  if(peak.current.requestId!==value.requestId)peak.current={requestId:value.requestId,percent:0};
  const percent=Math.max(peak.current.percent,estimate);
  peak.current.percent=percent;
  const shown=Math.round(percent);
  const title=running?'正在处理':value.state==='completed'?'已完成':
    value.state==='partial'?'部分完成':value.state==='unknown'?'结果待确认':'失败';
  const stages=observedPhases(value.history,value.phase);
  const valueText=running?`估算进度 ${shown}%，正在${phaseBand(value.phase,progressProfileFor(value.path)).label}`:
    (value.state==='completed'||value.state==='partial')?title:`${title}，估算进度 ${shown}%`;
  return <aside className={`turn-progress ${value.state}`} aria-label="本次请求进度" role="status"
    title="估算进度，不代表精确完成度">
    <div className="turn-progress-top">
      <strong>{title}</strong>
      <span className="turn-progress-percent">{shown}%<small>估算进度</small></span>
    </div>
    <div className="turn-progress-track" role="progressbar" aria-label={title}
      aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={shown} aria-valuetext={valueText}>
      <span style={{width:`${shown}%`}}/>
    </div>
    <details className="turn-progress-details" open={open}
      onToggle={event=>setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{open?'收起详情':'展开详情'}</summary>
      <div className="turn-progress-panel"><ol>
        {stages.map((phase,index)=><li key={phase} className={phase===value.phase?'current':''}>
          {PHASE_LABELS[phase]}
          {running?phase===value.phase?' · 等待中':' · 已经过':' · 已经过'}
        </li>)}
        {!running&&<li>{title}{value.committedRevision!==null?` · 已提交 REV ${value.committedRevision}`:''}</li>}
      </ol></div>
    </details>
  </aside>;
}

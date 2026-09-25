import {useState} from 'react';
import type {PublicView} from '../shared/contracts.js';

export const historyRestoreConfirmation='回到这里后，之后发生的世界状态将不再作为当前历史。继续？';

function timeLabel(time:{day:number;minute:number}){
  const hour=Math.floor(time.minute/60)%24,minute=time.minute%60;
  return `第 ${time.day} 天 ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

export function WorldHistory({view,busy,onRestore}:{view:PublicView;busy:boolean;onRestore:(turnId:string)=>void}){
  const [open,setOpen]=useState(false),history=[...(view.world_history??[])].reverse();
  if(!history.length)return null;
  return <div className="world-history">
    <button type="button" className="quiet" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>历史 / 回溯</button>
    {open&&<div className="world-history-popover" role="dialog" aria-label="世界历史">
      <div className="world-history-title"><strong>最近的世界历程</strong><button type="button" className="quiet" onClick={()=>setOpen(false)}>关闭</button></div>
      <ol>{history.map(entry=><li key={entry.turn_id} className={entry.current?'current':''}>
        <div><time>{timeLabel(entry.time)}</time><span>{entry.label}</span></div>
        {entry.current?<small>当前</small>:<button type="button" className="quiet" disabled={busy} onClick={()=>{if(window.confirm(historyRestoreConfirmation))onRestore(entry.turn_id)}}>回到这里</button>}
      </li>)}</ol>
    </div>}
  </div>;
}

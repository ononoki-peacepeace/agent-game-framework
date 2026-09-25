import {useState,type ReactNode} from 'react';

export interface CurrentWorldSummary {title:string;location?:string;revision:number}

/** The launcher is a four-entry workspace. World creation is mounted only after its entry is chosen. */
export function LauncherToolbar({engineLabel,busy,current,onContinue,onImportSave,onOpenProvider,children}:{
  engineLabel?:string;busy:boolean;current?:CurrentWorldSummary|null;onContinue?:()=>void;onImportSave:()=>void;onOpenProvider:()=>void;children?:ReactNode;
}){
  const [creating,setCreating]=useState(false);
  if(creating)return <section className="launcher-create-workspace"><button type="button" className="quiet launcher-back" disabled={busy} onClick={()=>setCreating(false)}>← 返回启动页</button>{children}</section>;
  return <div className="launcher-grid launcher-primary-grid" aria-label="启动工作区">
    <article className="launch-card continue-card"><small>CURRENT WORLD</small><h2>当前世界</h2>{current?<><strong>{current.title}</strong><div className="launch-meta"><span>{current.location||'当前位置'}</span><span>第 {current.revision} 回合</span></div></>:<p>还没有载入世界。</p>}<button type="button" disabled={busy||!current} onClick={()=>onContinue?.()}>继续当前世界</button></article>
    <article className="launch-card create-card"><small>NEW WORLD</small><h2>创建新世界</h2><p>从模板、AI 灵感或自己的描述开始。</p><button type="button" disabled={busy} onClick={()=>setCreating(true)}>创建新世界</button></article>
    <article className="launch-card"><small>SAVE / PACKAGE</small><h2>读取存档</h2><p>载入 Save Package 或 World Package。</p><button type="button" className="quiet" disabled={busy} onClick={()=>onImportSave()}>选择存档</button></article>
    <article className="launch-card provider-card"><small>MODEL / API</small><h2>模型 / API</h2><p>当前：{engineLabel||'尚未连接'}</p><button type="button" className="quiet" disabled={busy} onClick={()=>onOpenProvider()}>切换模型 / API</button></article>
  </div>;
}

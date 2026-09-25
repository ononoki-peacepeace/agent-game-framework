import { useState } from 'react';
import type { PanelProps } from './panels.js';
import {ExtensionPanel} from './ExtensionPanel.js';
import { DevelopmentPanel } from './DevelopmentPanel.js';
import { request } from './api.js';
import type { PublicView } from '../shared/contracts.js';

type SystemResult = { session?:import('../system/session.js').SystemSession; category: string; tool_id: string | null; side_effect_level: string; needs_confirmation: boolean; message: string; directive?: { kind: string } & Record<string, unknown>; advanced?: Record<string, unknown> };

/**
 * System (out-of-game) surface: talk to the framework itself.
 * Nothing typed here is a character action, and nothing here advances world time.
 * The tool registry stays internal — this page only shows the request, its state and the reply.
 */
export function SystemPanel({ view, onView, onOpenLogs, onExport, onOpenCharacterCrop, busy, act }: PanelProps) {
  const [input,setInput]=useState(''),[result,setResult]=useState<SystemResult|null>(null),[error,setError]=useState(''),[sending,setSending]=useState(false),[devRequest,setDevRequest]=useState<string|null>(null),[taskId,setTaskId]=useState<string|null>(null);
  async function send(confirmed=false){
    const text=input.trim(); if(!text||sending)return;
    setSending(true);setError('');
    try{
      const next=await request<SystemResult>('system',{input:text,confirmed,...(taskId?{development_task_id:taskId}:{}),...(result?.session&&['waiting_for_clarification','waiting_for_confirmation'].includes(result.session.status)?{session_id:result.session.session_id}:{})});
      setResult(next);
      if(next.directive?.kind==='export_save')onExport?.();
      if(next.directive?.kind==='open_crop_editor'&&typeof next.directive.entity_id==='string')onOpenCharacterCrop?.(next.directive.entity_id);
      if(next.directive?.kind==='extension_development'){setDevRequest(String(next.directive.request??text));setTaskId(String(next.directive.task_id??''));}
      if(next.tool_id&&next.tool_id.startsWith('module.')&&!next.needs_confirmation)onView?.(await request<PublicView>('state'));
    }catch(e){setError((e as Error).message);}
    finally{setSending(false);}
  }
  return <div className="system-panel">
    <p className="system-intro">在这里和游戏系统讨论游戏本身：界面反馈、开关功能模块、处理人物图片。这里的内容不会被当作角色行动，也不会推进世界时间。</p>
    <label className="system-input">你想让系统做什么？<textarea aria-label="系统请求" value={input} maxLength={2000} onChange={e=>setInput(e.target.value)} placeholder="输入你对游戏本身的要求……" disabled={sending}/></label>
    <div className="button-row compact"><button disabled={sending||!input.trim()} onClick={()=>void send(false)}>{sending?'处理中…':'发送'}</button>{result?.needs_confirmation&&<button className="quiet" disabled={sending} onClick={()=>void send(true)}>确认执行</button>}</div>
    {error&&<p role="alert" className="system-error">{error}</p>}
    {result&&<article className={`system-result ${result.needs_confirmation?'pending':''}`}><strong>{result.needs_confirmation?'等待确认':result.category==='IN_WORLD_INPUT'?'这是游戏内操作':'系统回复'}</strong><p>{result.message}</p></article>}
    <DevelopmentPanel view={view} onView={onView} taskId={taskId} onSelect={setTaskId}/>
    {taskId&&<button className="quiet" onClick={()=>{setTaskId(null);setResult(null);}}>结束当前开发对话</button>}
    <details><summary>已安装功能</summary><ExtensionPanel view={view} intent={null} onView={v=>onView?.(v)} showDevelopment={false}/></details>
    <details className="system-advanced">
      <summary>高级 / 开发详情</summary>
      <p>当前请求：{result?.category??'（还没有请求）'} · 状态：{sending?'处理中':result?.session?.status??(result?.needs_confirmation?'等待你的确认':'空闲')}</p>
      <p>权限提示：查看类请求不会修改世界；只有你确认后的功能调整、图片设置或功能准备才会写入本机存档。</p>
      <button type="button" className="quiet" onClick={()=>void onOpenLogs?.()}>打开日志面板</button>
    </details>
  </div>;
}

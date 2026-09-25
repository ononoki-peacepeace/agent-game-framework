import { useEffect, useState } from 'react';

import type { PanelProps } from './panels.js';
import {ExtensionPanel} from './ExtensionPanel.js';
import { DevelopmentPanel } from './DevelopmentPanel.js';
import { request,clientRequestId } from './api.js';
import { clearSystemError, initialSystemInput, submitFailed, submitStarted, submitSucceeded, type SystemInputState } from './system-input.js';
import { behaviorSummary, type BehaviorRule } from '../ai/behavior.js';


import type { PublicView } from '../shared/contracts.js';

type SystemUnderstandingView = { understood?: string[]; unresolved?: {field:string;why:string}[]; likely_workflow?: string } | null;
type SystemResult = {
  session?:import('../system/session.js').SystemSession; category: string; tool_id: string | null; side_effect_level: string; needs_confirmation: boolean;
  view?:PublicView; message: string; directive?: { kind: string } & Record<string, unknown>; advanced?: Record<string, unknown>;
  clarification?: string | null; workflow?: string | null; pending_field?: string | null; expression?: 'model' | 'template'; understanding?: SystemUnderstandingView;
};

/**
 * System (out-of-game) surface: one natural-language entry for the framework itself.
 * The shared gate may hand explicit world intent to the world engine. Specialised workspaces
 * (development task, character assets, style configuration) are opened *by the Agent workflow*, not by a
 * second input box; internal categories stay inside the advanced fold.
 */
export function SystemPanel({ handoff, view, onView, onOpenLogs, onExport, onOpenCharacterCrop, busy, act }: PanelProps & {handoff?:{input:string;result:SystemResult}|null}) {
  const [behavior,setBehavior]=useState<BehaviorRule[]>([]);
  const [composer,setComposer]=useState<SystemInputState>(initialSystemInput),[result,setResult]=useState<SystemResult|null>(null),[sending,setSending]=useState(false),[devRequest,setDevRequest]=useState<string|null>(null),[taskId,setTaskId]=useState<string|null>(null),[devOpen,setDevOpen]=useState(false);
  const input=composer.value,error=composer.error,setInput=(value:string)=>setComposer(state=>submitStarted(state,value));
  // The System surface is the only place the style configuration is summarised; the assistant body never shows it.
  useEffect(()=>{void (async()=>{try{setBehavior(await request<BehaviorRule[]>('system/behavior'));}catch{/* no world loaded yet */}})();},[]);
  // A handed-off request was already executed by the other input box: show its result, but never put the text
  // back into this composer, otherwise a successfully consumed request looks unsent.
  useEffect(()=>{if(!handoff)return;setResult(handoff.result);const d=handoff.result.directive;if(d?.kind==='extension_development'){setDevRequest(String(d.request??handoff.input));setTaskId(String(d.task_id??''));setDevOpen(true);}if(d?.kind==='open_crop_editor'&&typeof d.entity_id==='string')onOpenCharacterCrop?.(d.entity_id);},[handoff]);
  async function send(confirmed=false,direct?:string){
    const text=(direct??input).trim(); if(!text||sending)return;
    setSending(true);setComposer(state=>direct?submitStarted(state,text):clearSystemError(state));
    try{
      const sessionId=result?.session?.session_id;
      const next=await request<SystemResult>('system',{input:text,confirmed,request_id:clientRequestId(),game_id:view.game_id,expected_revision:view.revision,...(taskId?{development_task_id:taskId}:{}),...(sessionId&&['waiting_for_clarification','waiting_for_confirmation'].includes(result!.session!.status)?{session_id:sessionId}:{})});

      if(next.view)onView?.(next.view);
      setResult(next);setComposer(state=>submitSucceeded(state));
      if(Array.isArray(next.advanced?.behavior))setBehavior(next.advanced.behavior as BehaviorRule[]);
      if(next.directive?.kind==='export_save')onExport?.();
      if(next.directive?.kind==='open_crop_editor'&&typeof next.directive.entity_id==='string')onOpenCharacterCrop?.(next.directive.entity_id);
      if(next.directive?.kind==='extension_development'){setDevRequest(String(next.directive.request??text));setTaskId(String(next.directive.task_id??''));setDevOpen(true);}
      if(next.tool_id&&next.tool_id.startsWith('module.')&&!next.needs_confirmation)onView?.(await request<PublicView>('state'));
    }catch(e){setComposer(state=>submitFailed(state,(e as Error).message));}
    finally{setSending(false);}
  }
  const workflow=result?.workflow??null;
  const headline=result?.clarification?'需要你确认一项信息':workflow==='development_task'?'开发工作区':workflow==='media_asset'?'人物资源':workflow==='behavior_config'?'风格配置':workflow==='module_management'?'功能开关':workflow==='capability_question'?'能力说明':'系统回复';
  const mediaEntity=workflow==='media_asset'&&typeof result?.advanced?.entity_id==='string'?view.entities.find(entity=>entity.id===result.advanced!.entity_id):undefined;
  const devVisible=devOpen||Boolean(devRequest)||Boolean(taskId);
  return <div className="system-panel">

    <label className="system-input">你想让系统做什么？<textarea aria-label="系统请求" value={input} maxLength={2000} onChange={e=>setInput(e.target.value)} placeholder="例如：人物页显示好感度 / 故事写得更有文学性一点 / 关闭生活模式" disabled={sending}/></label>
    <div className="button-row compact"><button disabled={sending||!input.trim()} onClick={()=>void send(false)}>{sending?'处理中…':'发送'}</button>{result?.needs_confirmation&&<button className="quiet" disabled={sending} onClick={()=>void send(true)}>确认执行</button>}</div>
    {error&&<p role="alert" className="system-error">{error}</p>}
    {result&&<article className={`system-result ${result.needs_confirmation?'pending':''}`}><strong>{headline}</strong><p>{result.message}</p>
      {mediaEntity&&<p className="system-hint">{String(mediaEntity.components.identity?.name??mediaEntity.id)}：{Boolean((mediaEntity.components.visual_assets as {images?:Record<string,string>}|undefined)?.images?.fullbody)?'已有全身图，可以直接裁剪头像。':'还没有全身图，只能上传或接入图像生成能力。'}{result.advanced?.capability_gap?' 当前缺少能力：图像生成 Provider。':''}</p>}
      {mediaEntity&&Boolean((mediaEntity.components.visual_assets as {images?:Record<string,string>}|undefined)?.images?.fullbody)&&<div className="button-row compact"><button disabled={sending} onClick={()=>onOpenCharacterCrop?.(mediaEntity.id)}>打开头像裁剪</button></div>}
    </article>}
    {devVisible&&<DevelopmentPanel view={view} onView={onView} taskId={taskId} onSelect={setTaskId}/>}
    {devVisible&&<button className="quiet" onClick={()=>{setTaskId(null);setDevRequest(null);setDevOpen(false);setResult(null);}}>结束当前开发对话</button>}
    <details><summary>已安装功能</summary><ExtensionPanel view={view} intent={null} onView={v=>onView?.(v)} showDevelopment={false}/></details>
    <details className="system-advanced">
      <summary>高级 / 开发详情</summary>
      <p>当前请求：{result?.category??'（还没有请求）'} · 工作流：{workflow??'（未进入工作流）'} · 状态：{sending?'处理中':result?.session?.status??(result?.needs_confirmation?'等待你的确认':'空闲')}{result?.expression?` · 表达：${result.expression==='model'?'模型':'确定性文案'}`:''}</p>
      <p>待补充字段：{result?.pending_field??result?.session?.pending_field??'（无）'}</p>
      <p>查看不会改动世界；写入只在你确认后进行。</p>
      <p>当前风格配置：{behaviorSummary(behavior)}</p>
      {!!behavior.length&&<button type="button" className="quiet" disabled={sending} onClick={()=>void send(false,'恢复默认风格配置')}>恢复默认风格</button>}
      {!devVisible&&<button type="button" className="quiet" onClick={()=>setDevOpen(true)}>打开开发工作区</button>}
      <button type="button" className="quiet" onClick={()=>void onOpenLogs?.()}>打开日志面板</button>
      {result?.understanding&&<pre>{JSON.stringify(result.understanding,null,2)}</pre>}
    </details>
  </div>;
}

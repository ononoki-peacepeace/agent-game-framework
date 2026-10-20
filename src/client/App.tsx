import {focusPanelEntity} from './entity-focus.js';
import {npcPresentInView} from '../shared/interaction-context.js';
import {ExtensionPanel,type ExtensionIntent} from './ExtensionPanel.js';
import {SystemPanel} from './SystemPanel.js';
import {WorldLauncher,type CreationRoleplayConfig} from './WorldLauncher.js';
import type {PromptProfile} from './world-prompt-file.js';
import {validatedWorldPrompt} from './world-prompt-file.js';
import {LauncherToolbar} from './LauncherToolbar.js';
import {WorldHistory} from './WorldHistory.js';
import {SceneStory} from './SceneStory.js';
import type {AgentResult} from '../agent/contracts.js';
import {shouldAutoRetry} from './retry-policy.js';
import {agentPresentation} from './agent-presentation.js';
import {TurnProgress,type TurnProgressState} from './TurnProgress.js';
import {AUTO_DISMISS_MS,isTerminalTurnState} from './turn-progress.js';
import {recordActionDiagnostic} from './action-diagnostics.js';
import {InputStillRunning,InputStatusUnknown,awaitInputResult,clearPendingInput,readPendingInput,matchesPendingInput} from './input-recovery.js';

import {displayDiagnostic} from '../shared/display.js';
import type {RoutineJob} from '../routine/jobs.js';
import { useEffect, useRef, useState } from 'react';
import type { ActionInput, ContextActionSuggestion, Entity, PublicView } from '../shared/contracts.js';
import { request, session, inputRequestStatus, uploadAvatar as uploadAvatarFile, uploadVisualAsset as uploadVisualAssetFile } from './api.js';
import { Avatar, CharacterDetail, locationOf, nameOf, panelRegistry } from './panels.js';
import type {AvatarCropMetadata} from '../shared/avatar.js';
import { avatarFromFullbody } from './avatar-crop.js';
import {affordanceFamily,groupAffordances} from './affordances.js';
import {VoiceTranscriptSession,appendFinalSpeech,voicePreview,type SpeechResultEvent} from './voice-input.js';

type ProviderDescriptor = { id:string;label:string;note:string;requires_api_key:boolean;supports_base_url:boolean;default_model?:string };
type ProviderInfo = { provider:string;name?:string;model?:string|null;base_url?:string|null;api_key_configured?:boolean;persisted?:boolean;saved_provider?:string|null };
type ProviderResponse = { current:ProviderInfo|null;providers:ProviderDescriptor[] };
type CharacterImportPreview={preview_id:string;name:string;source_summary:string;location_name:string;
  preserved:string[];adapted:string[];rejected:string[];questions:string[];
  profile:{personality:string;speech_style:string;social_style:string;behavior_tendencies:string[]}};

function sceneSummary(raw: unknown) {
  const text=String(raw??'').trim(); if(!text)return '';
  if(text.startsWith('{')) try { const value=JSON.parse(text) as Record<string,unknown>; const parts:string[]=[]; if(typeof value.role==='string')parts.push(value.role); if(typeof value.current_relationship==='string')parts.push(value.current_relationship); if(Array.isArray(value.known_state))parts.push(...value.known_state.filter(x=>typeof x==='string').slice(0,2) as string[]); if(parts.length)return parts.join(' · ').slice(0,220); } catch {}
  return text.length>220?`${text.slice(0,219)}…`:text;
}
function SceneContext({ view, busy, onContextAction, onSuggestedAction, onSelectEntity, onConversationSelect }:{view:PublicView;busy:boolean;onContextAction:(action:string,target:Entity)=>void;onSuggestedAction:(suggestion:ContextActionSuggestion,target:Entity)=>void;onSelectEntity?:(entity:Entity)=>void;onConversationSelect:(target:Entity|null)=>void}) {
  const current=locationOf(view),[expanded,setExpanded]=useState<string[]>([]),[familyByEntity,setFamilyByEntity]=useState<Record<string,string>>({}),[sceneSuggestions,setSceneSuggestions]=useState<ContextActionSuggestion[]|null>(null);
  const entities=view.entities.filter(e=>e.id!==view.player_id&&e.components.location?.location_id===current&&e.components.identity);
  const suggestions=sceneSuggestions?.length?sceneSuggestions:view.last_turn?.context_actions??[];
  useEffect(()=>{let disposed=false;setSceneSuggestions(null);if(!entities.some(entity=>entity.components.character))return;void request<ContextActionSuggestion[]>('scene/affordances').then(items=>{if(!disposed)setSceneSuggestions(items);}).catch(()=>{});return()=>{disposed=true;};},[view.game_id,view.revision,current]);
  useEffect(()=>{setExpanded(ids=>ids.filter(id=>entities.some(entity=>entity.id===id)));},[current,entities.length]);
  if(!entities.length)return <section className="scene-context"><div className="context-title"><span>当前场景</span><small>没有已登记的关键人物或物体</small></div></section>;
  return <section className="scene-context"><div className="context-title"><span>当前场景</span><small>{entities.length} 个可关注对象</small></div><div className="context-list">{entities.map(entity=>{
    const actions=view.actions.filter(a=>['contextual','text'].includes(a.visibility)&&!!a.target_component&&!!entity.components[a.target_component]);
    const contextual=suggestions.filter(x=>x.target_id===entity.id),families=groupAffordances(actions,contextual,!entity.components.character),open=expanded.includes(entity.id),active=familyByEntity[entity.id]??null,selected=families.find(family=>family.id===active);
    const description=sceneSummary(entity.components.identity?.description);
    return <article className={`context-entity ${open?'expanded':''}`} key={entity.id}><div className="context-summary"><div className="context-identity">{Boolean(entity.components.identity?.avatar_id)&&<button type="button" className="context-avatar-button" title={entity.components.character?`查看 ${nameOf(entity)} 详情`:nameOf(entity)} onClick={()=>entity.components.character&&onSelectEntity?.(entity)}><Avatar entity={entity}/></button>}<div>{entity.components.character?<button type="button" className="name-link" onClick={()=>onSelectEntity?.(entity)}><strong>{nameOf(entity)}</strong></button>:<strong>{nameOf(entity)}</strong>}<small>{entity.components.character?'人物':entity.components.shop?'商店':entity.type}</small></div></div><button type="button" className="quiet" disabled={busy} onClick={()=>setExpanded(ids=>open?ids.filter(id=>id!==entity.id):[...ids,entity.id])}>{open?'收起':'查看操作'}</button></div>{open&&<div className="context-detail">{description&&<p>{description}</p>}{families.length>0?<><div className="affordance-families" aria-label={`${nameOf(entity)} 的行为类别`}>{families.map(family=><button type="button" key={family.id} className={active===family.id?'active':''} disabled={busy} onClick={()=>{const next=active===family.id?null:family;setFamilyByEntity(values=>({...values,[entity.id]:next?.id??''}));onConversationSelect(next?.items.some(item=>affordanceFamily(item.suggestion??item.action??{})==='communicate')?entity:null);}}>{family.label}</button>)}</div>{selected&&<div className="context-actions concrete-actions" aria-label={`${selected.label}的具体行动`}>{selected.items.map(item=><button type="button" className="quiet suggested-action" disabled={busy} key={item.key} onClick={()=>item.kind==='canonical'?onContextAction(item.action!.type,entity):onSuggestedAction(item.suggestion!,entity)}>{item.label}</button>)}<button type="button" className="quiet" onClick={()=>{onConversationSelect(selected.items.some(item=>affordanceFamily(item.suggestion??item.action??{})==='communicate')?entity:null);requestAnimationFrame(()=>document.getElementById('action')?.focus());}}>自己输入……</button></div>}</>:<small>当前没有场景建议；你仍可在下方自由描述行动。</small>}</div>}</article>;
  })}</div></section>;
}
export function App() {
  const [view,setView]=useState<PublicView|null>(null),[engine,setEngine]=useState(''),[serverVersion,setServerVersion]=useState<string|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[messageKind,setMessageKind]=useState<'success'|'info'|'error'>('info');
  const [extensionIntent,setExtensionIntent]=useState<ExtensionIntent|null>(null);
  const [mobilePage,setMobilePage]=useState<'game'|'panel'|'more'>('game');
  const [cropTarget,setCropTarget]=useState<string|null>(null);
  const [mediaBusy,setMediaBusy]=useState(false);
  const [routineJob,setRoutineJob]=useState<RoutineJob|null>(null),[agentReply,setAgentReply]=useState<{intent:string;message:string;appearance?:"handoff"|"failure"}|null>(null);
  const [storyOverride,setStoryOverride]=useState<{revision:number;text:string}|null>(null);
  const [goalProgress,setGoalProgress]=useState<{completed:string[];unfinished:string[];reason:string|null}|null>(null);
  const [turnProgress,setTurnProgress]=useState<TurnProgressState|null>(null);
  useEffect(()=>{setTurnProgress(previous=>previous&&previous.gameId!==view?.game_id?null:previous);},[view?.game_id]);
  useEffect(()=>{
    if(!turnProgress||!isTerminalTurnState(turnProgress.state))return;
    const requestId=turnProgress.requestId;
    const timer=window.setTimeout(()=>{
      setTurnProgress(previous=>previous&&previous.requestId===requestId?null:previous);
    },AUTO_DISMISS_MS);
    return()=>window.clearTimeout(timer);
  },[turnProgress?.requestId,turnProgress?.state]);
  const routineAuto=!!routineJob&&['queued','running'].includes(routineJob.status);
  const [tab,setTab]=useState('status'),[input,setInput]=useState(''),[voiceInterim,setVoiceInterim]=useState(''),[voiceStatus,setVoiceStatus]=useState<'idle'|'recording'|'finalizing'>('idle'),[entered,setEntered]=useState(false);
  const [providers,setProviders]=useState<ProviderResponse|null>(null),[providerOpen,setProviderOpen]=useState(false),[providerId,setProviderId]=useState('codex'),[providerKey,setProviderKey]=useState(''),[providerModel,setProviderModel]=useState(''),[providerBase,setProviderBase]=useState(''),[providerPersist,setProviderPersist]=useState(true);
  const [composeTarget,setComposeTarget]=useState<Entity|null>(null),[composeAction,setComposeAction]=useState<string|null>(null),[composeLabel,setComposeLabel]=useState(''),[listening,setListening]=useState(false),[selectedCharacterId,setSelectedCharacterId]=useState<string|null>(null);
  const [conversationTarget,setConversationTarget]=useState<Entity|null>(null);
  useEffect(()=>{
    if(!conversationTarget||!view)return;
    if(!npcPresentInView(view,conversationTarget.id))setConversationTarget(null);
    else setConversationTarget(view.entities.find(entity=>entity.id===conversationTarget.id)!);
  },[view?.game_id,view?.revision,conversationTarget?.id]);
  const jsonRef=useRef<HTMLInputElement>(null),actionRef=useRef<HTMLTextAreaElement>(null),sidebarScrollRef=useRef<HTMLDivElement>(null),storyRef=useRef<HTMLElement>(null),sidebarRef=useRef<HTMLElement>(null),pending=useRef<{path:'action'|'input';body:unknown}|null>(null),recognitionRef=useRef<{stop:()=>void;abort?:()=>void}|null>(null),voiceSessionRef=useRef<VoiceTranscriptSession|null>(null),voiceRunRef=useRef<{active:boolean;restarts:number}|null>(null),composingRef=useRef(false);

  const [systemHandoff,setSystemHandoff]=useState<{input:string;result:any}|null>(null);
  const [characterImportPreview,setCharacterImportPreview]=useState<CharacterImportPreview|null>(null);
  const [entityFocus,setEntityFocus]=useState<string|null>(null);
  const requestSequence=useRef(0),operationBusy=useRef(false),autoRetried=useRef(false);
  useEffect(()=>{
    if(!entityFocus)return;
    let card:HTMLElement|null=null,frame=0,tries=0;
    const focus=()=>{card=focusPanelEntity(sidebarRef.current,entityFocus);if(!card&&++tries<4)frame=requestAnimationFrame(focus);};
    frame=requestAnimationFrame(focus);
    return()=>{cancelAnimationFrame(frame);card?.classList.remove('entity-highlight');};
  },[entityFocus,tab,view?.game_id]);

  function clearMessage(){setMessage('');setMessageKind('info');}
  function showMessage(text:string,kind:'success'|'info'|'error'='success'){if(!text)return;const readable=displayDiagnostic(text,view?.entities??[],view?.locations??[]);if(readable.length>90&&kind!=='error'){setAgentReply({intent:'RESPONSE',message:readable});return;}setMessage(readable);setMessageKind(kind);}

  function cancelVoice(){voiceSessionRef.current?.end();voiceSessionRef.current=null;if(voiceRunRef.current)voiceRunRef.current.active=false;voiceRunRef.current=null;setVoiceStatus('idle');setVoiceInterim('');if(recognitionRef.current){if(recognitionRef.current.abort)recognitionRef.current.abort();else recognitionRef.current.stop();}recognitionRef.current=null;setListening(false);}
  useEffect(()=>()=>{voiceSessionRef.current?.end();if(recognitionRef.current){if(recognitionRef.current.abort)recognitionRef.current.abort();else recognitionRef.current.stop();}},[]);

  function syncProviderForm(p:ProviderResponse){setProviders(p);const current=p.current;if(current){setEngine(current.provider);setProviderId(current.provider);setProviderModel(current.model??'');setProviderBase(current.base_url??'');setProviderPersist(Boolean(current.persisted || !current.saved_provider));}}
  useEffect(()=>{void(async()=>{try{const s=await session();setEngine(s.engine);setServerVersion(s.runtime?.version??null);const p=await request<ProviderResponse>('ai/providers');syncProviderForm(p);setView(await request<PublicView|null>('state'));setReady(true);}catch(e){showMessage(String(e),'error');}})();},[]);
  useEffect(()=>{
    if(!ready||!view)return;
    const marker=readPendingInput();
    if(!marker)return;
    if(marker.game_id!==view.game_id){clearPendingInput(marker);pending.current=null;setBusy(false);operationBusy.current=false;return;}
    setBusy(true);operationBusy.current=true;
    setTurnProgress({requestId:marker.request_id,gameId:marker.game_id,path:'input',state:'running',
      phase:'interpreting',history:['interpreting'],committedRevision:null});
    let cancelled=false,retainMarker=false;
    const controller=new AbortController();
    const release=()=>{
      const latest=readPendingInput();if(latest&&(latest.request_id!==marker.request_id||latest.game_id!==marker.game_id))return;
      if((pending.current?.body as {request_id?:string}|undefined)?.request_id===marker.request_id)pending.current=null;
      operationBusy.current=false;setBusy(false);
    };
    const removed=()=>{if(!matchesPendingInput(marker)){controller.abort();release();
      setTurnProgress(previous=>previous?.requestId===marker.request_id?{...previous,state:'unknown'}:previous);}};
    window.addEventListener('herne:pending-input-changed',removed);
    const recover=async()=>{
      try{
        const result=await awaitInputResult(new Promise<AgentResult>(()=>{}),async()=>{
          if(!matchesPendingInput(marker))controller.abort();
          controller.signal.throwIfAborted();
          const status=await inputRequestStatus<AgentResult>(marker.game_id,marker.request_id,controller.signal);
          if(!matchesPendingInput(marker))controller.abort();
          controller.signal.throwIfAborted();
          setTurnProgress(previous=>previous?.requestId===marker.request_id?{...previous,
          phase:status.phase??previous.phase,history:status.phase_history?.length?status.phase_history:previous.history,
          committedRevision:status.committed_revision??previous.committedRevision}:previous);
          return status;
        },{requestTimeoutMs:0,pollMs:4000,maxRecoveryMs:Math.max(0,1_800_000-(Date.now()-(marker.started_at??Date.now()))),signal:controller.signal});
          if(cancelled)return;
          settleProgress(marker.request_id,result);
          const authoritative=await request<PublicView>('state').catch(()=>result.view??null);
          if(cancelled)return;
          if(authoritative&&authoritative.game_id!==marker.game_id)return;
          if(authoritative&&result.view&&authoritative.revision>result.view.revision){
            setView(authoritative);return;
          }
          if('ui_actions' in result){
            if(result.view)setView(result.view);
            const visible=agentPresentation(view,result,'system_handoff' in result);
            setStoryOverride(visible.storyOverride);setAgentReply(visible.agentReply);setGoalProgress(visible.goalProgress);
          }else setView(await request<PublicView>('state'));
      }catch(error){
        if(cancelled||controller.signal.aborted)return;
        retainMarker=error instanceof InputStillRunning;
        if(await synchronizeTechnicalFailure(error,requestSequence.current,marker.request_id,
          ()=>!cancelled&&!controller.signal.aborted))return;
        setTurnProgress(previous=>previous?.requestId===marker.request_id?{...previous,state:'unknown'}:previous);
        const latest=await request<PublicView>('state').catch(()=>null);
        if(cancelled)return;if(latest)setView(latest);
        showMessage(error instanceof InputStatusUnknown?
          '原请求记录不可恢复；已同步可读取的世界状态。无法确认是否完整结算，不会自动重放行动。':
          error instanceof InputStillRunning?'原请求尚无终态，已停止自动查询；请先核对世界状态，不要重复提交。':
          (error as Error).message,'error');
      }finally{
        if(!cancelled){window.removeEventListener('herne:pending-input-changed',removed);
          if(controller.signal.aborted)setTurnProgress(previous=>previous?.requestId===marker.request_id?{...previous,state:'unknown'}:previous);
          if(!retainMarker)clearPendingInput(marker);release();}
      }
    };
    void recover();return()=>{cancelled=true;controller.abort();window.removeEventListener('herne:pending-input-changed',removed);};
  },[ready,view?.game_id]);
  useEffect(()=>{if(!message||messageKind==='error')return;const timer=window.setTimeout(()=>clearMessage(),3500);return()=>window.clearTimeout(timer);},[message,messageKind]);
  useEffect(()=>{if(!ready)return;const sync=()=>void request<ProviderResponse>('ai/providers').then(p=>{setProviders(p);if(p.current){setEngine(p.current.provider);if(!providerOpen){setProviderId(p.current.provider);setProviderModel(p.current.model??'');setProviderBase(p.current.base_url??'');setProviderPersist(p.current.persisted??true);}}}).catch(()=>undefined);const timer=window.setInterval(sync,10000);const onFocus=()=>sync();const onVisibility=()=>{if(document.visibilityState==='visible')sync()};window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onVisibility);return()=>{window.clearInterval(timer);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onVisibility)};},[ready,providerOpen]);
  const engineLabel=engine==='deepseek'?'DeepSeek':engine==='codex'?'Codex':engine==='openai'?'OpenAI API':engine==='responses-compatible'?'兼容 API':engine==='mock'?'离线 Mock':engine||'AI';
  useEffect(()=>{
    if(turnProgress?.state!=='running'||turnProgress.path!=='input'||!turnProgress.requestId||!turnProgress.gameId)return;
    let disposed=false,inFlight=false;
    const poll=async()=>{
      if(inFlight)return;inFlight=true;
      try{
        const status=await inputRequestStatus<AgentResult>(turnProgress.gameId,turnProgress.requestId);
        if(disposed)return;
        setTurnProgress(previous=>{
          if(!previous||previous.requestId!==turnProgress.requestId||previous.state!=='running')return previous;
          const result=status.result;
          const partial=result?.outcome?.type==='game'&&result.outcome.kind==='partial_progress'||
            result?.outcome?.type==='engine_failure'&&result.outcome.committed_steps.length>0;
          const failed=result?.outcome?.type==='engine_failure';
          const state=status.state==='completed'?partial?'partial':failed?'failed':'completed':
            status.state==='failed'?'failed':status.state==='unknown'?'unknown':'running';
          return {...previous,state,phase:status.phase??previous.phase,
            history:status.phase_history?.length?status.phase_history:previous.history,
            committedRevision:status.committed_revision??previous.committedRevision};
        });
      }catch{/* The original request may still be running; a missed status poll is not a failure. */}
      finally{inFlight=false;}
    };
    void poll();const timer=window.setInterval(()=>void poll(),5000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[turnProgress?.requestId,turnProgress?.gameId,turnProgress?.state]);
  function settleProgress(requestId:string,result:AgentResult){
    setTurnProgress(previous=>{
      if(!previous||previous.requestId!==requestId)return previous;
      const partial=result.outcome?.type==='game'&&result.outcome.kind==='partial_progress'||
        result.outcome?.type==='engine_failure'&&result.outcome.committed_steps.length>0;
      return {...previous,state:partial?'partial':result.outcome?.type==='engine_failure'?'failed':'completed',
        committedRevision:result.outcome?.revision??previous.committedRevision};
    });
  }
  async function synchronizeTechnicalFailure(error:unknown,sequence:number,requestId?:string,
    isCurrent=()=>sequence===requestSequence.current){
    const outcome=(error as {payload?:{outcome?:AgentResult['outcome']}})?.payload?.outcome;
    if(outcome?.type!=='engine_failure')return false;
    const latest=await request<PublicView>('state').catch(()=>null);
    if(!isCurrent())return true;
    if(latest){setView(latest);setStoryOverride(null);pending.current=null;}
    setTurnProgress(previous=>previous&&previous.requestId===requestId?{...previous,
      state:outcome.receipt_ids.length||outcome.committed_steps.length?'partial':outcome.state_certain?'failed':'unknown',
      committedRevision:latest?.revision??outcome.revision??previous.committedRevision}:previous);
    showMessage((error as Error).message,'error');
    return true;
  }
  async function operate(path:string,body:unknown={},enterWorld=true){
    if(['input','action'].includes(path)){
      let unresolved:{game_id?:string}|null=null;
      try{unresolved=JSON.parse(sessionStorage.getItem('herne.pending.input')??'null');}catch{}
      if(unresolved?.game_id===(body as {game_id?:string})?.game_id){
        showMessage('上一请求的结算结果仍未确认；请先刷新状态查看，避免重复行动。','error');return false;
      }
    }
    if(operationBusy.current){recordActionDiagnostic('blocked',{path,reason:'operation_busy'});return false;}operationBusy.current=true;if(path==='input'||path==='action'){const active=body as {request_id?:string;game_id?:string};if(active.request_id&&active.game_id)setTurnProgress({requestId:active.request_id,gameId:active.game_id,path,state:'running',phase:path==='input'?'interpreting':'submitted',history:[path==='input'?'interpreting':'submitted'],committedRevision:null});}recordActionDiagnostic('submitted',{path,request_id:(body as {request_id?:string})?.request_id,revision:(body as {expected_revision?:number})?.expected_revision});const sequence=++requestSequence.current;const waitTimer=window.setTimeout(()=>{if(operationBusy.current&&sequence===requestSequence.current){recordActionDiagnostic('waiting',{path,request_id:(body as {request_id?:string})?.request_id,revision:(body as {expected_revision?:number})?.expected_revision});showMessage('行动仍在处理，结果返回前请不要重复提交。','info');}},25000);setEntityFocus(null);setBusy(true);clearMessage();setAgentReply(null);setGoalProgress(null);try{let next:PublicView|RoutineJob|ExtensionIntent|AgentResult;try{next=await request<PublicView|RoutineJob|ExtensionIntent|AgentResult>(path,body);}catch(firstError){const policy=(firstError as {payload?:{retry_policy?:string}}).payload?.retry_policy;if(!shouldAutoRetry(policy,autoRetried.current))throw firstError;autoRetried.current=true;recordActionDiagnostic('retry',{path,request_id:(body as {request_id?:string})?.request_id,reason:'revision_retry'});try{const latest=await request<PublicView>('state');if(sequence===requestSequence.current)setView(latest);const raw=(body&&typeof body==='object'?body:{}) as Record<string,unknown>;next=await request<PublicView|RoutineJob|ExtensionIntent|AgentResult>(path,{...raw,request_id:requestId(),game_id:latest.game_id,expected_revision:latest.revision});}finally{autoRetried.current=false;}}recordActionDiagnostic('response',{path,request_id:(body as {request_id?:string})?.request_id,revision:(next as {view?:{revision:number};revision?:number})?.view?.revision??(next as {revision?:number})?.revision});if(sequence!==requestSequence.current)return;if('ui_actions' in next){if(path==='input')settleProgress((body as {request_id:string}).request_id,next as AgentResult);const handoff='system_handoff' in next;if(handoff)setSystemHandoff((next as any).system_handoff);if(next.view)setView(next.view);const visible=agentPresentation(view,next,handoff);setStoryOverride(previous=>visible.storyOverride??(next.outcome?.type==='engine_failure'&&previous?.revision===next.view?.revision?previous:null));setAgentReply(visible.agentReply);setGoalProgress(visible.goalProgress);for(const action of next.ui_actions){if(action.kind==='open_panel')selectTab(action.panel);if((action.kind==='open_character_detail')&&'entity_id' in action){const target=(next.view??view)?.entities.find(entity=>entity.id===action.entity_id);if(target)openCharacter(target);}if(action.kind==='export_save')void exportFile();}const focus=next.ui_actions.find(a=>a.kind==='focus_entity');setEntityFocus(focus&&'entity_id' in focus?focus.entity_id:null);pending.current=null;return;}if('kind' in next){setExtensionIntent(next);setTab('extensions');setMobilePage('panel');pending.current=null;return;}if('job_id' in next){setRoutineJob(next);setTab('routine');pending.current=null;return;}let latest=next;if(['action','input'].includes(path)){try{latest=await request<PublicView>('state')}catch{/* action response is still authoritative enough for display */}}setView(latest);if(path==='action')setTurnProgress(previous=>previous&&previous.requestId===(body as {request_id?:string}).request_id?{...previous,state:'completed',committedRevision:latest.revision}:previous);const note=latest.notices.join(' ');if(note)showMessage(note,'success');pending.current=null;if(enterWorld)setEntered(true);if(['new','import','load'].includes(path)){const isRoutine=String((body as {action?:{type?:string}})?.action?.type??'').includes('ROUTINE');setTab(isRoutine?'routine':'status');setSelectedCharacterId(null);requestAnimationFrame(()=>sidebarScrollRef.current?.scrollTo({top:0,behavior:'smooth'}));}}catch(e){if(sequence!==requestSequence.current)return false;recordActionDiagnostic('error',{path,request_id:(body as {request_id?:string})?.request_id,reason:(e as Error).name});const text=(e as Error).message;if(await synchronizeTechnicalFailure(e,sequence,(body as {request_id?:string})?.request_id))return false;if(path==='input'||path==='action')setTurnProgress(previous=>previous&&previous.requestId===(body as {request_id?:string}).request_id?{...previous,state:e instanceof InputStillRunning||e instanceof InputStatusUnknown||path==='action'&&!(e as {payload?:unknown}).payload?'unknown':'failed'}:previous);if(e instanceof InputStillRunning||e instanceof InputStatusUnknown){if(e instanceof InputStatusUnknown){try{const authoritative=await request<PublicView>('state');if(sequence===requestSequence.current){setView(authoritative);pending.current=null;sessionStorage.removeItem('herne.pending.input');if(authoritative.revision>Number((body as {expected_revision?:number})?.expected_revision??-1))setStoryOverride(null);showMessage('已自动同步当前世界；服务端已无法确认原请求的确切终态，请核对当前故事与时间，避免重复提交。','error');}}catch{showMessage(text,'error');}}else showMessage(text,'error');return false;}if(/状态已更新|revision|版本.*更新/i.test(text)){try{const latest=await request<PublicView>('state');setView(latest);showMessage('状态已自动同步到最新版本。原请求没有自动重放，避免重复执行；需要时可点击“重试原请求”。','error');}catch{showMessage(text,'error')}}else showMessage(text,'error');return false;}finally{window.clearTimeout(waitTimer);recordActionDiagnostic('finished',{path,request_id:(body as {request_id?:string})?.request_id,reason:pending.current===null?'pending_cleared':'pending_retained'});if(sequence===requestSequence.current){operationBusy.current=false;setBusy(false)}}}
  async function extensionAct(extensionId:string,targetEntityId:string,actionType:string){
    if(!view||busy)return;
    setBusy(true);clearMessage();
    try{
      const next=await request<PublicView>(`extensions/${extensionId}/action`,{game_id:view.game_id,expected_revision:view.revision,request_id:requestId(),action:{type:actionType,target_entity_id:targetEntityId}});
      setView(next);
    }catch(e){showMessage((e as Error).message,'error');}
    finally{setBusy(false);}
  }  async function retryPending(){if(!pending.current||!view||busy)return;const original=pending.current;
    const raw=(original.body&&typeof original.body==='object'?original.body:{}) as Record<string,unknown>;
    if(original.path==='input'&&typeof raw.request_id==='string'&&typeof raw.game_id==='string'){
      try{const status=await inputRequestStatus<AgentResult>(raw.game_id,raw.request_id);
        if(status.state==='running'){showMessage('原请求仍在服务端处理，请等待结果；不会重复执行。','info');return;}
        if(status.state==='completed'&&status.result){const result=status.result;
          if(result.view)setView(result.view);
          if('ui_actions' in result){const visible=agentPresentation(view,result,'system_handoff' in result);
            setStoryOverride(visible.storyOverride);setAgentReply(visible.agentReply);setGoalProgress(visible.goalProgress);}
          pending.current=null;sessionStorage.removeItem('herne.pending.input');return;}
        if(status.state==='failed'){showMessage(status.error??'原请求未完成，请先刷新状态。','error');pending.current=null;sessionStorage.removeItem('herne.pending.input');return;}
        try{const authoritative=await request<PublicView>('state');setView(authoritative);
          pending.current=null;sessionStorage.removeItem('herne.pending.input');
          showMessage('请求记录不可用；已同步当前世界，请核对故事与时间后再决定下一步。','error');
        }catch{showMessage('请求记录不可用且暂时无法读取世界状态；请勿重复提交。','error');}
        return;
      }catch{showMessage('暂时无法查询原请求；请先刷新世界状态，避免重复结算。','error');return;}
    }
    const body={...raw,request_id:raw.request_id??requestId(),game_id:view.game_id,expected_revision:view.revision};
    pending.current={path:original.path,body};await operate(original.path,body);
  }
  function requestId(){
    const c=globalThis.crypto as Crypto|undefined;
    if(c?.randomUUID)return c.randomUUID();
    const bytes=new Uint8Array(16);
    if(c?.getRandomValues)c.getRandomValues(bytes); else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);
    bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  async function act(action?:ActionInput,text?:string,choiceOfferId?:string,legacyChoice=false){
    recordActionDiagnostic('submit_requested',{path:action?'action':'input',revision:view?.revision});
    if(!view||busy){recordActionDiagnostic('blocked',{path:action?'action':'input',revision:view?.revision,reason:!view?'no_view':'busy'});return;}
    if(pending.current?.path==='input'&&sessionStorage.getItem('herne.pending.input')){
      showMessage('原请求尚未确认终态；请先查看原请求，避免重复结算。','error');return;
    }
    if(voiceSessionRef.current)cancelVoice();
    if(action&&['START_ROUTINE','CONTINUE_ROUTINE'].includes(action.type)){
      try{const job=await request<RoutineJob>('routine/run',{request_id:requestId(),game_id:view.game_id,expected_revision:view.revision,action});setRoutineJob(job);setTab('routine');clearMessage();}catch(e){showMessage((e as Error).message,'error');}return;
    }
    try{
      const path:'action'|'input'=action?'action':'input';
      const body={request_id:requestId(),game_id:view.game_id,expected_revision:view.revision,...(action?{action}:{input:text}),
        ...(choiceOfferId?{choice_offer_id:choiceOfferId}:{}),...(legacyChoice?{legacy_choice:true}:{}),...(text&&conversationTarget?{interaction:{source:'npc_interaction' as const,target_id:conversationTarget.id,mode:'conversation' as const}}:{})};
      pending.current={path,body};
      const submitted=await operate(path,body);if(submitted===false)return;
      setInput('');setComposeTarget(null);setComposeAction(null);setComposeLabel('');
    }catch(e){showMessage(e instanceof Error?e.message:String(e),'error');}
  }
  useEffect(()=>{
    if(!ready)return;let disposed=false,inFlight=false;
    const poll=async()=>{if(inFlight)return;inFlight=true;try{const job=await request<RoutineJob|null>('routine/jobs');if(disposed)return;setRoutineJob(job);if(job){const next=await request<PublicView>('state');if(!disposed)setView(next);}}catch{/* Reconnect on the next short poll; never cancel server work on tab change. */}finally{inFlight=false;}};
    void poll();const timer=window.setInterval(()=>void poll(),1200);return()=>{disposed=true;window.clearInterval(timer);};
  },[ready]);
  async function pauseRoutine(){if(!routineJob)return;try{setRoutineJob(await request<RoutineJob>('routine/jobs/'+routineJob.job_id+'/cancel',{}));showMessage('已请求暂停，将在当前安全结算点停止。','info');}catch(e){showMessage((e as Error).message,'error');}}
  async function exportFile(){setBusy(true);clearMessage();try{const save=await request('export',{}),url=URL.createObjectURL(new Blob([JSON.stringify(save,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='agent-game-save.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);showMessage('存档已导出，包含完整世界与 GM 数据。','success');}catch(e){showMessage((e as Error).message,'error')}finally{setBusy(false)}}
  async function loadJson(file:File){if(file.size>2*1024*1024)throw new Error('JSON 不能超过 2 MB');await operate('import',JSON.parse(await file.text()));}
  async function createWorld(description:string,roleplay_config:CreationRoleplayConfig,promptProfile?:PromptProfile){const body:Record<string,unknown>={description:validatedWorldPrompt(description),roleplay_config};if(promptProfile)body.prompt_profile=promptProfile;await operate('new',body);}
  function selectConversation(target:Entity|null){
    if(target&&(!view||!npcPresentInView(view,target.id)))return;
    setConversationTarget(target?view!.entities.find(entity=>entity.id===target.id)!:null);
    setComposeAction(null);setComposeTarget(null);setComposeLabel('');setAgentReply(null);clearMessage();
  }
  function chooseContextAction(action:string,target:Entity){setConversationTarget(null);setComposeAction(action);setComposeTarget(target);setComposeLabel(view?.actions.find(a=>a.type===action)?.label??action);setInput('');const meta=view?.actions.find(a=>a.type===action);if(meta?.requires_text)setTimeout(()=>actionRef.current?.focus(),0);}
  function chooseSuggestedAction(suggestion:ContextActionSuggestion,target:Entity){
    if(target.components.character&&affordanceFamily(suggestion)==='communicate'){
      selectConversation(target);
    }else{
      setConversationTarget(null);setComposeAction('SOCIAL_INTERACT');setComposeTarget(target);setComposeLabel(suggestion.label);
    }
    setInput(suggestion.intent);setTimeout(()=>actionRef.current?.focus(),0);
  }
  async function uploadAvatar(entity:Entity,file:File,crop?:AvatarCropMetadata){if(!view||mediaBusy)return;setMediaBusy(true);clearMessage();try{const next=await uploadAvatarFile(entity.id,file,view.game_id,view.revision,crop);setView(next);showMessage(`已更新 ${nameOf(entity)} 的头像。图片保存在本机 data/assets/avatars，不调用 AI。`,'success');}catch(e){showMessage((e as Error).message,'error');throw e;}finally{setMediaBusy(false)}}
  async function clearAvatar(entity:Entity){if(!view||mediaBusy||!entity.components.identity?.avatar_id)return;if(!window.confirm(`移除 ${nameOf(entity)} 的头像并恢复为空白？\n\n全身图不会被删除。`))return;setMediaBusy(true);clearMessage();try{const next=await request<PublicView>(`avatar/${entity.id}/clear`,{game_id:view.game_id,expected_revision:view.revision});setView(next);showMessage(`已移除 ${nameOf(entity)} 的头像。`,'success');}catch(e){showMessage((e as Error).message,'error')}finally{setMediaBusy(false)}}
  async function uploadVisualAsset(entity:Entity,slot:string,file:File){if(!view||mediaBusy)return;setMediaBusy(true);clearMessage();try{const hadAvatar=Boolean(entity.components.identity?.avatar_id);let next=await uploadVisualAssetFile(entity.id,slot,file,view.game_id,view.revision);let autoAvatar=false;if(slot==='fullbody'&&!hadAvatar){try{const cropped=await avatarFromFullbody(file);next=await uploadAvatarFile(entity.id,cropped,next.game_id,next.revision);autoAvatar=true;}catch{/* fullbody upload succeeded; user can still upload a dedicated avatar manually */}}setView(next);showMessage(autoAvatar?`已更新 ${nameOf(entity)} 的全身图，并从图像上部中央自动生成头像；不满意时可以单独更换头像。`:`已更新 ${nameOf(entity)} 的${slot==='fullbody'?'全身图':'人物图片'}。图片仅保存在本机 data/assets/visuals，不调用 AI。`,'success');}catch(e){showMessage((e as Error).message,'error')}finally{setMediaBusy(false)}}
  async function editPersona(entity:Entity,persona:{personality:string;speech_style:string;verbal_habits:string}){if(!view)return;try{const next=await request<PublicView>(`characters/${entity.id}/persona`,{game_id:view.game_id,expected_revision:view.revision,request_id:requestId(),...persona});setView(next);showMessage(`已更新 ${nameOf(entity)} 的角色表现。`,'success');}catch(e){showMessage((e as Error).message,'error');throw e;}}
  function openCharacter(entity:Entity,forCrop=false){setCropTarget(forCrop?entity.id:null);setMobilePage('panel');setSelectedCharacterId(entity.id);requestAnimationFrame(()=>{sidebarScrollRef.current?.scrollTo({top:0,behavior:'smooth'});if(window.matchMedia('(max-width: 850px)').matches)sidebarRef.current?.scrollIntoView({behavior:'smooth',block:'start'});});}
  function selectTab(next:string){setEntityFocus(null);setMobilePage('panel');setSelectedCharacterId(null);setTab(next);requestAnimationFrame(()=>sidebarScrollRef.current?.scrollTo({top:0,behavior:'smooth'}));}
  async function importCharacterCard(file:File){if(!view||busy)return;if(file.size>2*1024*1024){showMessage('人物卡不能超过 2 MB。','error');return;}
    let card:unknown;const source=await file.text();try{card=JSON.parse(source)}catch{card=source;}
    await previewCharacterSource(card);}
  async function importCharacterText(source:string){let card:unknown;try{card=JSON.parse(source)}catch{card=source;}
    await previewCharacterSource(card);}
  async function previewCharacterSource(card:unknown){if(!view||busy)return;
    setBusy(true);clearMessage();try{setCharacterImportPreview(await request<CharacterImportPreview>('character-card/preview',
      {game_id:view.game_id,expected_revision:view.revision,card}));}
    catch(e){showMessage((e as Error).message,'error')}finally{setBusy(false)}}
  async function commitCharacterImport(){if(!view||!characterImportPreview||busy)return;setBusy(true);try{
    const next=await request<PublicView>('character-card/commit',{game_id:view.game_id,expected_revision:view.revision,
      preview_id:characterImportPreview.preview_id,request_id:requestId()});setView(next);setCharacterImportPreview(null);
    showMessage(next.notices.join(' '),'success');setTab('characters');
  }catch(e){showMessage((e as Error).message,'error')}finally{setBusy(false)}}
  async function cancelCharacterImport(){const preview=characterImportPreview;setCharacterImportPreview(null);
    if(preview)await request('character-card/cancel',{preview_id:preview.preview_id}).catch(()=>undefined);}
  function startVoice(){
    type RecognitionErrorEvent={error?:string};
    type RecognitionCtor = new()=>{lang:string;interimResults:boolean;continuous:boolean;start:()=>void;stop:()=>void;abort?:()=>void;onresult:((e:SpeechResultEvent)=>void)|null;onend:(()=>void)|null;onerror:((e:RecognitionErrorEvent)=>void)|null};
    const lanHttp=window.location.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(window.location.hostname);
    if(lanHttp||!window.isSecureContext){
      actionRef.current?.focus();
      showMessage('手机当前通过局域网 HTTP 访问。Chrome 会禁止网页语音识别/麦克风权限；请先用手机键盘自带的语音输入。网页语音按钮需要 HTTPS 后才能正常工作。','error');
      return;
    }
    const w=window as unknown as {SpeechRecognition?:RecognitionCtor;webkitSpeechRecognition?:RecognitionCtor};const Ctor=w.SpeechRecognition??w.webkitSpeechRecognition;
    if(!Ctor){actionRef.current?.focus();showMessage('当前浏览器没有提供网页语音识别。可以先使用手机键盘自带的麦克风输入。','error');return;}
    if(listening){
      // Explicit stop: keep whatever was already recognised and let the engine finalise the last segment.
      if(voiceRunRef.current)voiceRunRef.current.active=false;
      voiceSessionRef.current?.stop();recognitionRef.current?.stop();setVoiceStatus('finalizing');return;
    }
    // Recording is one explicit session: the first click starts it and the second click ends it. Chrome ends
    // recognition on its own after a short silence even with continuous=true, so while the player is still
    // recording we transparently start a fresh recogniser. A new VoiceTranscriptSession per recogniser keeps the
    // index bookkeeping valid (nothing is appended twice) and the committed text stays in the input box.
    const MAX_VOICE_RESTARTS=8;
    const run={active:true,restarts:0};voiceRunRef.current=run;
    const beginRecognition=()=>{
      const r=new Ctor(),voice=new VoiceTranscriptSession();
      r.lang='zh-CN';r.interimResults=true;r.continuous=true;
      r.onresult=e=>{if(voiceSessionRef.current!==voice)return;const update=voice.accept(e);
        if(update.finalText)setInput(value=>appendFinalSpeech(value,update.finalText,update.firstFinal));
        setVoiceInterim(update.interimText);setVoiceStatus('recording');};
      r.onend=()=>{
        if(voiceSessionRef.current!==voice)return;
        voice.end();
        if(run.active&&run.restarts<MAX_VOICE_RESTARTS){run.restarts+=1;beginRecognition();return;}
        voiceSessionRef.current=null;recognitionRef.current=null;voiceRunRef.current=null;
        setVoiceInterim('');setListening(false);setVoiceStatus('idle');
        if(run.active)showMessage('浏览器限制了单次语音时长，识别已自动结束。已识别的内容保留在输入框里；再点一次语音可以继续。','info');
      };
      r.onerror=e=>{if(voiceSessionRef.current!==voice)return;voice.end();run.active=false;voiceRunRef.current=null;
        voiceSessionRef.current=null;recognitionRef.current=null;setVoiceInterim('');setListening(false);setVoiceStatus('idle');
        const denied=e?.error==='not-allowed'||e?.error==='service-not-allowed';
        showMessage(denied?'浏览器没有授予语音识别权限。请检查站点麦克风权限，或使用手机键盘语音输入。':'语音识别没有完成，请重试或继续打字。','error');};
      voiceSessionRef.current=voice;recognitionRef.current=r;
      try{r.start();setVoiceStatus('recording');}
      catch(error){voice.end();run.active=false;voiceRunRef.current=null;voiceSessionRef.current=null;recognitionRef.current=null;
        setVoiceInterim('');setListening(false);setVoiceStatus('idle');showMessage(error instanceof Error?error.message:'语音识别启动失败。','error');}
    };
    setVoiceInterim('');setVoiceStatus('recording');setListening(true);
    beginRecognition();
  }
  async function applyProvider(){setBusy(true);clearMessage();try{const body:Record<string,unknown>={provider:providerId,persist:providerPersist};if(providerKey.trim())body.api_key=providerKey.trim();if(providerModel.trim())body.model=providerModel.trim();if(providerBase.trim())body.base_url=providerBase.trim();const info=await request<ProviderInfo>('ai/provider',body);setProviderKey('');const p=await request<ProviderResponse>('ai/providers');syncProviderForm(p);setProviderOpen(false);showMessage(`AI 已切换为 ${p.providers.find(x=>x.id===info.provider)?.label??info.provider}${info.persisted?'，并保存在这台电脑。':'，仅用于当前服务进程。'}`,'success');}catch(e){showMessage((e as Error).message,'error')}finally{setBusy(false)}}
  async function forgetProvider(){setBusy(true);clearMessage();try{await request<ProviderInfo>('ai/provider/forget',{});const p=await request<ProviderResponse>('ai/providers');syncProviderForm(p);showMessage('已删除本机保存的 AI Provider 配置；当前进程仍可继续使用，重启后将回到环境变量或默认设置。','success');}catch(e){showMessage((e as Error).message,'error')}finally{setBusy(false)}}
  const panels=view?.panels??[],isRenderablePanel=(panel:{id:string;extension_id?:string})=>Boolean(panelRegistry[panel.id]||panel.id==='saves'||panel.extension_id),mobilePrimary=panels.filter(p=>(p.mobile_group??'secondary')==='primary'&&isRenderablePanel(p)).slice(0,4),ActivePanel=panelRegistry[tab],activePanel=panels.find(panel=>panel.id===tab),location=view?.locations.find(l=>l.id===locationOf(view)),selectedProvider=providers?.providers.find(p=>p.id===providerId),selectedCharacter=view?.entities.find(e=>e.id===selectedCharacterId&&!!e.components.character);
  return <div className={turnProgress?"shell has-turn-progress":"shell"}>
    <header className="topbar compact-topbar"><button className="brand brand-button icon-brand" title="返回启动页" aria-label="返回启动页" onClick={()=>setEntered(false)}><span className="brand-mark">A</span><span className="brand-copy"><b>AGENT GAME</b><small>FRAMEWORK</small></span></button><div className="turn-progress-dock"><TurnProgress value={entered&&view?turnProgress:null}/></div><div className="header-right"><button className="engine engine-button" onClick={()=>setProviderOpen(true)}>{engineLabel} ▾</button><span className="version" title="当前后端报告的应用版本">{serverVersion?`v${serverVersion}`:'版本未报告'}</span></div></header>
    <main className={entered&&view?'play-main mobile-page-'+mobilePage:''}>
      {message&&<div role="alert" className={`notice-toast ${messageKind}`}><div className="notice-line"><span>{message}</span><button type="button" className="notice-close" aria-label="关闭提示" onClick={clearMessage}>×</button></div>{pending.current&&messageKind==='error'&&<div className="button-row compact"><button disabled={busy} onClick={()=>void retryPending()}>{pending.current.path==='input'?'查看原请求':'重试原请求'}</button><button disabled={busy} onClick={()=>void request<PublicView>('state').then(next=>{setView(next);showMessage('已刷新到最新状态。','info')})}>刷新状态</button></div>}</div>}
      {!ready?<section className="welcome"><h1>连接本地框架…</h1><p>请确认游戏服务已启动。</p></section>:!entered?<section className="launcher"><div className="launcher-heading"><span className="eyebrow">BLANK WORKSPACE</span><h1>载入、创建，或继续一个世界。</h1><p>世界、Prompt 与 AI Provider 相互独立。你可以用 Codex 会员模式，也可以切换 API。</p></div><LauncherToolbar engineLabel={engineLabel} busy={busy} current={view?{title:view.title,location:view.locations.find(l=>l.id===locationOf(view))?.name,revision:view.revision}:null} onContinue={()=>setEntered(true)} onImportSave={()=>jsonRef.current?.click()} onOpenProvider={()=>setProviderOpen(true)}><WorldLauncher busy={busy} onCreated={created=>{setView(created);setEntered(true);setTab('status');}} onCustom={createWorld}/></LauncherToolbar></section>:view?<><div className="game-layout"><section ref={storyRef} className="story-column"><div className="scene-heading"><div className="scene-heading-meta"><span>{view.title}</span><span>第 {view.time.day} 日 · {String(Math.floor(view.time.minute/60)).padStart(2,'0')}:{String(view.time.minute%60).padStart(2,'0')}</span><small>REV {view.revision}</small></div><span className="eyebrow">当前位置</span><h2>{[location?.name, view.entities.find(e=>e.id===view.player_id)?.components.scene_position?.label].filter(Boolean).join(' · ')||'当前场景'}</h2><p>{location?.description}</p></div><article className="story"><div className="story-label"><span>此刻的故事</span><div className="story-history-actions"><button className="quiet" disabled={busy||!view.can_undo} onClick={()=>{if(window.confirm('将恢复到上一回合执行前的世界状态。'))void operate('undo',{request_id:requestId(),game_id:view.game_id,expected_revision:view.revision});}}>↶ 撤回上一步</button><WorldHistory view={view} busy={busy} onRestore={turnId=>void operate(`history/${turnId}/restore`,{request_id:requestId(),game_id:view.game_id,expected_revision:view.revision})}/><span>{busy?'处理中…':'已自动保存'}</span></div></div><SceneStory view={view} override={storyOverride?.revision===view.revision?storyOverride.text:null} onSelectEntity={openCharacter}/>
{Boolean(view.last_turn?.choices.length)&&<div className="choices" aria-label="当前场景可选回应">{view.last_turn!.choices.map((choice,index)=>{const offer=view.last_turn?.choice_offers?.find(item=>item.text===choice);return <button key={offer?.id??`${index}:${choice}`} disabled={busy} onClick={()=>void act(undefined,choice,offer?.id,!offer)}><span>{index+1}</span>{choice}</button>;})}</div>}</article>{goalProgress&&<section className="goal-progress" aria-label="目标进度"><strong>目标进度</strong><p>本轮已发生：{goalProgress.completed.join("；")}</p>{goalProgress.unfinished.length>0&&<p>尚未完成：{goalProgress.unfinished.join("；")}</p>}{goalProgress.reason&&<p>{goalProgress.reason}</p>}</section>}{agentReply&&<div className={agentReply.appearance ? "agent-reply " + agentReply.appearance : "agent-reply"} role="status"><div className="agent-reply-head"><small>{agentReply.appearance==="failure"?"本次操作未完成":"游戏助手"}</small><button type="button" className="notice-close" aria-label="关闭回复" onClick={()=>setAgentReply(null)}>×</button></div><p>{agentReply.message}</p></div>}
        <SceneContext view={view} busy={busy} onContextAction={chooseContextAction} onSuggestedAction={chooseSuggestedAction} onSelectEntity={openCharacter} onConversationSelect={selectConversation}/>
        <form className="action-box" onSubmit={e=>{e.preventDefault();if(busy||operationBusy.current)return;const meta=composeAction?view.actions.find(a=>a.type===composeAction):undefined;if(composeAction&&composeTarget){if(meta?.requires_text&&!input.trim())return;const parameters:Record<string,unknown>={};if(meta?.requires_text)parameters[meta.text_parameter??'text']=input.trim();void act({type:composeAction,target_id:composeTarget.id,parameters});return;}if(!input.trim())return;void act(undefined,input)}}><div className="composer-head"><label htmlFor="action">{composeAction&&composeTarget?`待执行：${composeLabel || (view.actions.find(a=>a.type===composeAction)?.label ?? composeAction)} · ${nameOf(composeTarget)}`:conversationTarget?`正在与 ${nameOf(conversationTarget)} 交流`:'你想做什么，或想知道什么？'}</label>{(composeTarget||conversationTarget)&&<button type="button" className="text-button" onClick={()=>{cancelVoice();setComposeTarget(null);setComposeAction(null);setComposeLabel('');setConversationTarget(null);setInput('')}}>{conversationTarget?'退出交流':'取消当前动作'}</button>}</div><textarea ref={actionRef} id="action" value={input} onChange={e=>setInput(e.target.value)} onCompositionStart={()=>{composingRef.current=true}} onCompositionEnd={()=>{composingRef.current=false}} onKeyDown={e=>{if(e.key!=='Enter'||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey||e.nativeEvent.isComposing||composingRef.current||e.keyCode===229)return;e.preventDefault();if(!busy&&!operationBusy.current&&input.trim())e.currentTarget.form?.requestSubmit()}} maxLength={2000} placeholder={composeAction&&view.actions.find(a=>a.type===composeAction)?.requires_text?'补充这次行动的具体内容。':'可以描述角色行动，也可以直接问问题。例如：去找一位熟人；我和某个人现在是什么关系。'} disabled={busy}/>{voiceInterim&&<small className="voice-preview" role="status">临时识别：{voicePreview(input,voiceInterim)}</small>}<div className="action-footer"><span>{composeAction?'已选择动作；点击确认后才会真正执行':conversationTarget?`发给 ${nameOf(conversationTarget)}`:''}</span><div className="composer-buttons"><button type="button" className={`voice-button ${listening?'listening':''}`} disabled={busy} onClick={startVoice}>{listening?(voiceStatus==='recording'?'点击结束录音':'正在转写…'):'🎙 语音'}</button><button disabled={busy||(composeAction?!!view.actions.find(a=>a.type===composeAction)?.requires_text&&!input.trim():!input.trim())}>{busy?'请稍候…':composeAction?'确认并执行 →':'发送 →'}</button></div></div></form>
      </section><aside ref={sidebarRef} className="sidebar"><nav className="desktop-panel-nav" aria-label="世界面板">{panels.filter(isRenderablePanel).map(p=><button key={p.id} aria-label={p.label} className={tab===p.id?'active':''} onClick={()=>selectTab(p.id)}><span className="nav-glyph" aria-hidden="true">{p.icon??p.label.slice(0,1)}</span><span>{p.label}</span></button>)}</nav><div ref={sidebarScrollRef} className="sidebar-scroll"><section className={`panel ${selectedCharacter?'character-detail-panel':''}`}>{selectedCharacter?<CharacterDetail key={selectedCharacter.id+String(cropTarget)+view.revision} initialCropOpen={cropTarget===selectedCharacter.id} view={view} entity={selectedCharacter} busy={busy} act={a=>void act(a)} uploadAvatar={uploadAvatar} clearAvatar={clearAvatar} uploadVisualAsset={uploadVisualAsset} importCharacterCard={importCharacterCard} importCharacterText={importCharacterText} editPersona={editPersona} extensionAct={extensionAct} onClose={()=>setSelectedCharacterId(null)}/>:<><h2>{tab==='system'?'系统':tab==='saves'?'管理存档':panels.find(p=>p.id===tab)?.label}</h2>{activePanel?.extension_id?<ExtensionPanel view={view} intent={{kind:'extension_open',template:null,request:'',extension_id:activePanel.extension_id}} onView={setView} showDevelopment={false}/>:tab==='extensions'?<ExtensionPanel view={view} intent={extensionIntent} onView={setView}/>:tab==='system'?<SystemPanel handoff={systemHandoff} view={view} onView={setView} onOpenLogs={()=>selectTab('logs')} onExport={()=>void exportFile()} onOpenCharacterCrop={(id:string)=>{const target=view.entities.find(entity=>entity.id===id);if(target)openCharacter(target,true);}}
 busy={busy} act={()=>{}}/>:tab==='saves'?<div className="save-actions"><p>每次行动自动保存。手动存档保留一个可随时载入的检查点。</p><button disabled={busy} onClick={()=>void operate('save')}>保存检查点</button><button disabled={busy} onClick={()=>{if(window.confirm('载入将回到上次手动存档，继续？'))void operate('load')}}>载入检查点</button><button disabled={busy} onClick={()=>void exportFile()}>导出存档 JSON</button><button disabled={busy} onClick={()=>jsonRef.current?.click()}>导入 JSON</button><small>导出包含 GM 隐藏数据，适合备份或迁移。</small><button className="quiet" disabled={busy} onClick={()=>setEntered(false)}>返回启动页</button></div>:<>{ActivePanel?<ActivePanel view={view} busy={busy} routineAuto={routineAuto} routineJob={routineJob} pauseRoutine={()=>void pauseRoutine()} acknowledgeTask={async(id,outcome)=>{if(view)setView(await request<PublicView>('routine/tasks/'+id+'/acknowledge',{game_id:view.game_id,expected_revision:view.revision,outcome}));}} onOpenLogs={()=>selectTab('logs')} configureCalendar={async(calendar)=>{if(view){setView(await request<PublicView>('calendar',{calendar,game_id:view.game_id,expected_revision:view.revision,request_id:crypto.randomUUID()}));}}} act={a=>void act(a)} uploadAvatar={uploadAvatar} clearAvatar={clearAvatar} uploadVisualAsset={uploadVisualAsset} importCharacterCard={importCharacterCard} importCharacterText={importCharacterText} extensionAct={extensionAct} onSelectCharacter={openCharacter}/>:null}</>}</>}</section></div></aside></div><section className="mobile-more" aria-label="更多面板"><h2>世界与设置</h2><div>{panels.filter(isRenderablePanel).map(p=><button key={p.id} onClick={()=>selectTab(p.id)}>{p.label}</button>)}</div></section><nav className="mobile-nav" aria-label="手机快捷导航"><button type="button" onClick={()=>{setMobilePage("game");requestAnimationFrame(()=>storyRef.current?.scrollIntoView({block:"start"}));}}>游戏</button>{mobilePrimary.map(panel=><button type="button" key={panel.id} className={tab===panel.id?'active':''} onClick={()=>selectTab(panel.id)}>{panel.label}</button>)}<button type="button" onClick={()=>setMobilePage("more")}>更多</button></nav></>:<section className="welcome"><h1>没有已载入的世界。</h1><button onClick={()=>setEntered(false)}>返回启动页</button></section>}
      {characterImportPreview&&<div className="modal-backdrop"><section className="provider-modal" role="dialog" aria-modal="true" aria-label="人物卡导入预览">
        <div className="modal-title"><div><span className="eyebrow">CHARACTER IMPORT</span><h2>导入前预览：{characterImportPreview.name}</h2></div><button className="quiet" disabled={busy} onClick={()=>void cancelCharacterImport()}>取消</button></div>
        <p>来源：{characterImportPreview.source_summary} · 将加入：{characterImportPreview.location_name}</p>
        <p>人物核心：{characterImportPreview.profile.personality||'尚未提炼'}；语言：{characterImportPreview.profile.speech_style||'尚未提炼'}</p>
        <p>行为倾向：{characterImportPreview.profile.behavior_tendencies.join('；')||'尚未提炼'}</p>
        <h3>保留</h3><ul>{characterImportPreview.preserved.map((x,i)=><li key={i}>{x}</li>)}</ul>
        <h3>适配</h3><ul>{characterImportPreview.adapted.map((x,i)=><li key={i}>{x}</li>)}</ul>
        <h3>不导入</h3><ul>{characterImportPreview.rejected.map((x,i)=><li key={i}>{x}</li>)}</ul>
        {characterImportPreview.questions.length>0&&<><h3>需要确认</h3><ul>{characterImportPreview.questions.map((x,i)=><li key={i}>{x}</li>)}</ul></>}
        <p>确认仅创建当前世界兼容的人物资料；外部卡片不会改写世界规则、能力、既有人物关系或隐藏真相。可用 Undo 撤销。</p>
        <div className="provider-actions"><button disabled={busy} onClick={()=>void commitCharacterImport()}>确认导入</button><button className="quiet" disabled={busy} onClick={()=>void cancelCharacterImport()}>取消</button></div>
      </section></div>}      {providerOpen&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setProviderOpen(false)}}><section className="provider-modal"><div className="modal-title"><div><span className="eyebrow">AI PROVIDER</span><h2>选择模型来源</h2></div><button className="quiet" onClick={()=>setProviderOpen(false)}>关闭</button></div><div className="provider-options">{providers?.providers.map(p=><button key={p.id} className={`provider-option ${providerId===p.id?'selected':''}`} onClick={()=>{setProviderId(p.id);setProviderModel(p.default_model??'');setProviderBase('')}}><strong>{p.label}</strong><small>{p.note}</small></button>)}</div>{selectedProvider?.requires_api_key&&<label className="provider-field">API Key<input type="password" value={providerKey} onChange={e=>setProviderKey(e.target.value)} placeholder={providers?.current?.provider===providerId&&providers.current.api_key_configured?'已配置；留空继续使用当前 Key':'输入 API Key 或留空使用环境变量'}/><small>Key 永远不会从服务端返回到浏览器。{providers?.current?.provider===providerId&&providers.current.api_key_configured?' 当前服务端已有可用 Key。':''}</small></label>}<label className="provider-field">模型<input value={providerModel} onChange={e=>setProviderModel(e.target.value)} placeholder={selectedProvider?.default_model??'填写模型名'}/></label>{selectedProvider?.supports_base_url&&<label className="provider-field">Base URL<input value={providerBase} onChange={e=>setProviderBase(e.target.value)} placeholder="https://example.com/v1"/></label>}<label className="provider-save"><input type="checkbox" checked={providerPersist} onChange={e=>setProviderPersist(e.target.checked)}/><span><strong>保存在这台电脑</strong><small>保存到本机服务端 data/secrets；不进入存档、浏览器 storage 或 Git。手机和电脑连接同一服务时会共用此配置。</small></span></label><div className="provider-actions"><button disabled={busy} onClick={()=>void applyProvider()}>应用 Provider</button>{providers?.current?.saved_provider&&<button type="button" className="quiet" disabled={busy} onClick={()=>void forgetProvider()}>忘记本机保存</button>}</div><p className="provider-note">Codex 模式走 ChatGPT 登录态；API 模式走各自 API 额度。Provider 状态由服务器统一维护，其他已打开的手机/电脑页面会自动同步。</p></section></div>}
      <input ref={jsonRef} hidden type="file" accept=".json,application/json" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void loadJson(f).catch(err=>showMessage((err as Error).message,'error'))}}/>
    </main>{!(entered&&view)&&<footer>AGENT GAME FRAMEWORK <span>本地存档 · 行动驱动 · 持续世界</span></footer>}
  </div>;
}

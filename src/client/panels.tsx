import {endedTask,taskGroups} from './task-visibility.js';
import type {RoutineJob} from '../routine/jobs.js';
import type {Calendar} from '../routine/schema.js';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { request } from './api.js';
import {AvatarCropEditor} from './AvatarCropEditor.js';
import {SystemPanel} from './SystemPanel.js';
import {relationshipBadge, relationshipSummary} from '../shared/relationship.js';
import {genderLabel} from '../shared/gender.js';
import {ageLabel} from '../shared/age.js';
import {routePath} from '../core/map.js';
import {layoutMapEdges,mapNodePositions} from './map-graph.js';
export {visibleRouteEdges} from './map-graph.js';

import {RoutinePlanPanel} from './RoutinePlanPanel.js';
import type {AvatarCropMetadata} from '../shared/avatar.js';
import type { Entity, PublicLocation, PublicView, ActionInput } from '../shared/contracts.js';

export const nameOf = (entity?: Entity) => String(entity?.components.identity?.name ?? '未知人物');
export const playerOf = (view: PublicView) => view.entities.find(e => e.id === view.player_id)!;
export const locationOf = (view: PublicView) => String(playerOf(view).components.location?.location_id ?? '');
export interface PanelProps { onView?:(next:PublicView)=>void; onExport?:()=>void; onOpenCharacterCrop?:(entityId:string)=>void; acknowledgeTask?:(id:string,outcome:'completed'|'cancelled')=>Promise<void>;
routineJob?:RoutineJob|null; configureCalendar?:(calendar:Calendar)=>Promise<void>; routineAuto?: boolean; pauseRoutine?: () => void; onOpenLogs?:()=>void; view: PublicView; act: (action: ActionInput) => void; busy: boolean; uploadAvatar?: (entity: Entity, file: File, crop?:AvatarCropMetadata) => Promise<void>; clearAvatar?: (entity: Entity) => Promise<void>; uploadVisualAsset?: (entity: Entity, slot: string, file: File) => Promise<void>; importCharacterCard?: (file: File) => Promise<void>; importCharacterText?:(text:string)=>Promise<void>; onSelectCharacter?: (entity: Entity) => void; editPersona?:(entity:Entity,persona:{personality:string;speech_style:string;verbal_habits:string})=>Promise<void>; extensionAct?: (extensionId:string,targetEntityId:string,actionType:string)=>Promise<void> }
const numbers = (value: unknown) => (value ?? {}) as Record<string, number>;
const inventory = (e: Entity) => numbers(e.components.inventory?.items);
const relLabels: Record<string,string> = { familiarity:'熟悉度', trust:'信任', affection:'亲近', dependence:'依赖', protectiveness:'保护欲', suspicion:'怀疑', fear:'恐惧', respect:'尊重', romantic_interest:'恋爱倾向', leverage:'影响力' };
export function Avatar({ entity, className='' }: { entity: Entity; className?: string }) { const id=entity.components.identity?.avatar_id; const [failed,setFailed]=useState(false); useEffect(()=>setFailed(false),[id]); return id&&!failed ? <span className={`avatar has-image ${className}`.trim()}><img src={`/api/avatar/${String(id)}`} alt={`${nameOf(entity)}头像`} onError={()=>setFailed(true)}/></span> : <span className={`avatar ${className}`.trim()} aria-label={id?'头像加载失败':'无头像'}>{nameOf(entity).slice(0, 1)}</span>; }
function textSummary(raw: unknown, limit?: number) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let readable = text;
  if (text.startsWith('{')) try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof j.role === 'string') parts.push(j.role);
    if (typeof j.current_relationship === 'string') parts.push(j.current_relationship);
    if (Array.isArray(j.known_state)) parts.push(...j.known_state.filter(x => typeof x === 'string') as string[]);
    if (parts.length) readable = parts.join(' · ');
  } catch { /* plain text */ }
  if (!limit || readable.length <= limit) return readable;
  return `${readable.slice(0, limit - 1)}…`;
}
function readableSummaryLines(raw: unknown, entity?: Entity) {
  let text = textSummary(raw);
  if (!text) return [] as string[];
  const vitals=entity?.components.condition;
  if(vitals) for(const [key,label] of [['hp','HP'],['stamina','体力'],['stress','压力']]) {
    if(typeof vitals[key]==='number') text=text.replace(new RegExp(label+'\\s*\\d+(?:\\s*/\\s*\\d+)?','i'),label+' '+vitals[key]+'/100');
  }
  const condition = (entity?.components.condition ?? {}) as Record<string, unknown>;
  const numericMax = (key: string, fallback = 100) => {
    const value = Number(condition[key]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  };
  const staminaMax = numericMax('stamina_max');
  const stressMax = numericMax('stress_max');
  const base = text.split(/(?<=[。！？!?；;])\s*|\n+/).map(line => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const original of base) {
    let line = original.replace(/[。；;]$/, '').trim();
    if (!line) continue;
    const vitalLike = /(?:^|[，,])\s*(?:HP|体力|压力)\s*\d+/i.test(line);
    if (vitalLike && /HP\s*\d+|体力\s*\d+|压力\s*\d+/i.test(line)) {
      const parts = line.split(/[，,]/).map(x => x.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (let part of parts) {
          part = part.replace(/^(体力\s*\d+)(?!\d|\s*\/)/, `$1/${staminaMax}`);
          part = part.replace(/^(压力\s*\d+)(?!\d|\s*\/)/, `$1/${stressMax}`);
          part = part.replace(/^(HP\s*\d+)(?!\d|\s*\/)/i, '$1/100');
          out.push(part);
        }
        continue;
      }
      line = line.replace(/^(体力\s*\d+)(?!\d|\s*\/)/, `$1/${staminaMax}`);
      line = line.replace(/^(压力\s*\d+)(?!\d|\s*\/)/, `$1/${stressMax}`);
    }
    line = line.replace(/^(HP\s*\d+)(?!\d|\s*\/)/i, '$1/100');
    const stage = line.match(/^(阶段[:：].*?(?:周[一二三四五六日天]|星期[一二三四五六日天]))(.+)$/);
    if (stage) {
      out.push(stage[1].trim());
      if (stage[2].trim()) out.push(stage[2].trim());
      continue;
    }
    out.push(line);
  }
  return out;
}
function relationTone(value: number) {
  if (value >= 70) return '很高'; if (value >= 35) return '较高'; if (value >= 10) return '略高';
  if (value <= -70) return '很低'; if (value <= -35) return '较低'; if (value <= -10) return '略低'; return '一般';
}
function humanStatus(raw?: string) {
  if (!raw) return '';
  const known: Record<string,string> = {
    active:'进行中', accepted:'已接受', completed:'已完成', failed:'失败', cancelled:'已取消',
    purchased:'已获得', attended:'已参加', joined_active:'已加入', attending_active:'参与中',
    interest_only:'关注中', declined_due_to_schedule_conflict:'因时间冲突放弃', available:'可参与',
    dormant:'暂缓', open:'开放', pending:'待定',
    armed:'已待命', paused:'已安全暂停', disabled:'未启用', saved:'已保存（未启用）', waiting_for_safe_handoff:'等待安全交接'
  };
  return known[raw] ?? raw.replaceAll('_',' ');
}
function displayQuestTitle(id:string, entry:{title?:string;summary?:string;metadata?:Record<string,unknown>}) {
  const title = entry.title?.trim();
  if (title && !title.includes('_')) return title;
  const meta = entry.metadata ?? {};
  for (const key of ['title','name','task','type']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (title) return title.replaceAll('_',' ');
  return id.replaceAll('_',' ');
}

function visualImages(entity: Entity) {
  const visual = entity.components.visual_assets as undefined | { images?: Record<string, unknown> };
  return (visual?.images ?? {}) as Record<string, unknown>;
}

export function CharacterDetail({ view, entity, busy, uploadAvatar, clearAvatar, uploadVisualAsset, editPersona, extensionAct, onClose, initialCropOpen }: PanelProps & { entity: Entity; onClose?: () => void; initialCropOpen?:boolean }) {
  const role = String(entity.components.character?.role ?? '人物');
  const locationId = String(entity.components.location?.location_id ?? '');
  const location = view.locations.find(l => l.id === locationId);
  const images = visualImages(entity);
  const fullbodyId = typeof images.fullbody === 'string' ? images.fullbody : '';
  const [cropOpen,setCropOpen]=useState(Boolean(initialCropOpen));
  const card = entity.components.character_card as undefined | Record<string, unknown>;
  const [persona,setPersona]=useState({personality:String(entity.components.character?.personality??''),speech_style:String(entity.components.character?.speech_style??''),verbal_habits:String(entity.components.character?.verbal_habits??'')});
  const [personaSaving,setPersonaSaving]=useState(false);
  async function savePersona(next=persona){if(!editPersona||personaSaving)return;setPersonaSaving(true);try{await editPersona(entity,next);}finally{setPersonaSaving(false)}}
  const traits = Array.isArray(entity.components.character?.traits) ? entity.components.character?.traits as unknown[] : [];
  const relEntries = (playerOf(view).components.relationships?.entries ?? {}) as Record<string, Record<string, number>>;
  const relation = relEntries[entity.id];
  const description = textSummary(entity.components.identity?.description);
  const descriptionLines = readableSummaryLines(entity.components.identity?.description, entity);
  const extensionFields = ((entity.components.extension_fields?.entries ?? []) as import('../shared/contracts.js').ExtensionFieldProjection[]);
  return <div className="character-detail">
    <div className="character-detail-head">
      <button type="button" className="quiet character-back" onClick={onClose}>← 返回</button>
      <small>人物详情</small>
    </div>
    <div className="character-visual">
      {fullbodyId ? <img src={`/api/visual/${encodeURIComponent(fullbodyId)}`} alt={`${nameOf(entity)}全身图`}/> : <div className="character-visual-empty"><Avatar entity={entity} className="detail-avatar"/><span>尚未添加全身图</span></div>}
      {uploadVisualAsset&&<label className="visual-upload">{fullbodyId?'更换全身图':'上传全身图'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={ev=>{const f=ev.target.files?.[0];ev.target.value='';if(f)void uploadVisualAsset(entity,'fullbody',f)}}/></label>}
    </div>
    <div className="character-media-actions">
      {uploadVisualAsset&&<label className="button-like">{fullbodyId?'更换全身图':'上传全身图'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={ev=>{const f=ev.target.files?.[0];ev.target.value='';if(f)void uploadVisualAsset(entity,'fullbody',f)}}/></label>}
      {fullbodyId&&uploadAvatar&&<button type="button" className="quiet" disabled={busy} onClick={()=>setCropOpen(true)}>调整头像</button>}
      {clearAvatar&&Boolean(entity.components.identity?.avatar_id)&&<button type="button" className="text-button avatar-remove" disabled={busy} onClick={()=>void clearAvatar(entity)}>移除头像</button>}
    </div>
    {cropOpen&&fullbodyId&&uploadAvatar&&<AvatarCropEditor source={fullbodyId} initial={entity.components.visual_assets?.avatar_crop as AvatarCropMetadata|undefined} onCancel={()=>setCropOpen(false)} onSave={async(file,crop)=>{await uploadAvatar(entity,file,crop);setCropOpen(false);}}/>}

    <div className="character-detail-title">
      <div className="avatar-editor"><Avatar entity={entity}/><div className="avatar-editor-actions">{clearAvatar&&Boolean(entity.components.identity?.avatar_id)&&<button type="button" className="text-button avatar-remove" disabled={busy} onClick={()=>void clearAvatar(entity)}>移除头像</button>}</div></div>
      <div><h3>{nameOf(entity)}</h3><p>{role}</p><p className="character-gender">性别：{genderLabel(entity.components.identity?.gender)} · 年龄：{ageLabel(entity.components.identity?.age)}</p><small>{location?.name ?? '位置未知'}</small></div>
    </div>
    {description&&<section className="character-detail-section"><h4>已知信息</h4><div className="identity-summary-lines character-summary-lines">{descriptionLines.map((line,i)=><p className="identity-summary-line" key={`${entity.id}:detail:${i}:${line}`}>{line}</p>)}</div></section>}
    {traits.length>0&&<section className="character-detail-section"><h4>特征</h4><div className="chip-row">{traits.slice(0,12).map((x,i)=><span className="chip" key={`${String(x)}:${i}`}>{String(x)}</span>)}</div></section>}
    {extensionFields.length>0&&<section className="character-detail-section extension-character-fields" aria-label="扩展人物属性"><h4>人物属性</h4><div className="extension-field-grid">{extensionFields.map(field=><div className="extension-field" data-extension-field={`${field.extension_id}:${field.field_id}`} key={`${field.extension_id}:${field.field_id}`}><span>{field.label}</span><strong>{field.type==='flag'?(field.value?'是':'否'):String(field.value)}</strong>{field.actions.length>0&&<div className="button-row compact">{field.actions.map(action=><button type="button" className="quiet" disabled={busy||!extensionAct} key={action.id} onClick={()=>void extensionAct?.(field.extension_id,entity.id,action.id)}>{action.label}</button>)}</div>}</div>)}</div></section>}
    {relationshipSummary(view,entity).source!=='unknown'&&<section className="character-detail-section"><h4>与你的关系</h4><p>{relationshipSummary(view,entity).text}</p><div className="relation-bars">{Object.entries(relation??{}).map(([key,val])=><div className="relation-row" key={key}><span>{relLabels[key]??'关系指标'}</span><div className="relation-track"><i style={{width:`${Math.max(0,Math.min(100,(val+100)/2))}%`}}/></div><b>{val}</b></div>)}</div></section>}
    {card&&<section className="character-detail-section"><h4>角色卡资料</h4>{String(card.personality??'').trim()&&<p><b>性格：</b>{String(card.personality)}</p>}{String(card.scenario??'').trim()&&<p><b>场景：</b>{String(card.scenario)}</p>}{Array.isArray(card.tags)&&card.tags.length>0&&<div className="chip-row">{(card.tags as string[]).slice(0,12).map(tag=><span className="chip" key={tag}>{tag}</span>)}</div>}</section>}
    {entity.id!==view.player_id&&editPersona&&<section className="character-detail-section character-persona-editor" aria-label="角色表现"><h4>角色表现</h4><small>只影响这位人物的表达，不改变事实、关系或判定。</small>
      <label>性格提示<textarea aria-label="性格提示" maxLength={2000} value={persona.personality} onChange={event=>setPersona({...persona,personality:event.target.value})}/></label>
      <label>说话风格<textarea aria-label="说话风格" maxLength={2000} value={persona.speech_style} onChange={event=>setPersona({...persona,speech_style:event.target.value})}/></label>
      <label>语言习惯<textarea aria-label="语言习惯" maxLength={2000} value={persona.verbal_habits} onChange={event=>setPersona({...persona,verbal_habits:event.target.value})}/></label>
      <div className="button-row compact"><button type="button" disabled={busy||personaSaving} onClick={()=>void savePersona()}>保存角色表现</button><button type="button" className="quiet" disabled={busy||personaSaving} onClick={()=>{const empty={personality:'',speech_style:'',verbal_habits:''};setPersona(empty);void savePersona(empty);}}>恢复默认</button></div>
    </section>}
  </div>;
}

function Status({ view, uploadAvatar, clearAvatar, uploadVisualAsset, busy, onSelectCharacter }: PanelProps) {
  const player = playerOf(view), balances = numbers(player.components.wallet?.balances);
  const scenePosition=(player.components.scene_position as {label?:string}|undefined)?.label;
  const playerImages = visualImages(player);
  const playerFullbodyId = typeof playerImages.fullbody === 'string' ? playerImages.fullbody : '';
  const role = String(player.components.character?.role ?? '玩家角色');
  const attrs = numbers(player.components.attributes?.values), labels = (player.components.attributes?.labels ?? {}) as Record<string,string>;
  const traits = (player.components.traits?.entries ?? {}) as Record<string,{name?:string;status?:string}>;
  const hh=Math.floor(view.time.minute/60).toString().padStart(2,'0'), mm=(view.time.minute%60).toString().padStart(2,'0');
  return <div className="status-stack">
    <div className="world-status"><div><small>当前世界</small><strong>{view.title}</strong></div><div className="world-time"><span>第 {view.time.day} 天</span><b>{hh}:{mm}</b><small>第 {view.revision} 回合</small></div></div>
    <div className="status-hero"><div className="player-media"><div className="avatar-editor"><button type="button" className="avatar-open" title="查看自己的角色详情，可更换全身图或调整头像" onClick={()=>onSelectCharacter?.(player)}><Avatar entity={player}/></button>{clearAvatar&&Boolean(player.components.identity?.avatar_id)&&<button type="button" className="text-button avatar-remove" disabled={busy} onClick={()=>void clearAvatar(player)}>移除头像</button>}</div><div className="player-media-actions">{uploadVisualAsset&&<label className="avatar-upload">{playerFullbodyId?'更换全身图':'上传全身图'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void uploadVisualAsset(player,'fullbody',f)}}/></label>}</div></div><div className="player-summary"><button type="button" className="name-link" onClick={()=>onSelectCharacter?.(player)}><h3>{nameOf(player)}</h3></button><p className="player-role">{role}</p><div className="identity-summary-lines">{readableSummaryLines(player.components.identity?.description, player).map((line,i)=><small className="identity-summary-line" key={`${i}:${line}`}>{line}</small>)}</div></div></div>
    <div className="status-grid">
      {locationOf(view)&&<div className="mini-card"><span>地点</span><strong>{view.locations.find(l => l.id === locationOf(view))?.name ?? '未知'}</strong></div>}
      {scenePosition&&<div className="mini-card"><span>区域</span><strong>{scenePosition}</strong></div>}
      {Object.entries(balances).map(([key, amount]) => <div className="mini-card" key={key}><span>{view.currencies[key] ?? '货币'}</span><strong>{amount}</strong></div>)}
      {Object.entries(attrs).slice(0,6).map(([key,value]) => <div className="mini-card" key={key}><span>{labels[key] ?? '未命名属性'}</span><strong>{value}</strong></div>)}
    </div>
    {Object.keys(traits).length > 0 && <div className="chip-row">{Object.entries(traits).slice(0,8).map(([id,t]) => <span className="chip" key={id}>{t.name ?? '未命名特质'}{t.status && t.status !== 'active' ? ` · ${t.status}` : ''}</span>)}</div>}
  </div>;
}
function Characters({ view, uploadAvatar, clearAvatar, importCharacterCard, importCharacterText, busy, onSelectCharacter }: PanelProps) {
  const current = locationOf(view);
  const characters = view.entities.filter(e => e.components.character && e.id !== view.player_id);
  const [pastedCard,setPastedCard]=useState('');
  return <><div className="character-import"><div><strong>角色卡</strong><small>支持 Tavern/Character Card V1–V3、普通 JSON、文本或 Markdown；先预览世界适配，再确认导入。</small></div>{importCharacterCard&&<label className="file-button">导入人物卡<input type="file" accept=".json,.txt,.md,application/json,text/plain,text/markdown" disabled={busy} onChange={ev=>{const f=ev.target.files?.[0];ev.target.value='';if(f)void importCharacterCard(f)}}/></label>}{importCharacterText&&<details><summary>粘贴人物卡</summary><textarea aria-label="粘贴人物卡内容" value={pastedCard} onChange={e=>setPastedCard(e.target.value)} maxLength={100000} placeholder="首行写姓名，或粘贴 JSON / Markdown 人物卡"/><button type="button" disabled={busy||!pastedCard.trim()} onClick={()=>void importCharacterText(pastedCard)}>预览适配</button></details>}</div><div className="list">{characters.map(e => {
    const here = e.components.location?.location_id === current;
    const role = String(e.components.character?.role ?? '人物');
    const card = e.components.character_card as undefined|Record<string,unknown>;
    return <article className={`entity character-card ${here ? 'selected' : ''}`} key={e.id}><div className="person"><div className="avatar-editor compact-avatar"><button type="button" className="avatar-open" title={`查看 ${nameOf(e)} 详情`} onClick={()=>onSelectCharacter?.(e)}><Avatar entity={e}/></button>{clearAvatar&&Boolean(e.components.identity?.avatar_id)&&<button type="button" className="avatar-remove-icon" title="移除头像" aria-label={`移除 ${nameOf(e)} 的头像`} disabled={busy} onClick={()=>void clearAvatar(e)}>×</button>}</div><div><button type="button" className="name-link" onClick={()=>onSelectCharacter?.(e)}><h3>{nameOf(e)}</h3></button><small>{role} · {here ? '当前在场' : view.locations.find(l => l.id === e.components.location?.location_id)?.name ?? '位置未知'}{relationshipBadge(view,e) ? ` · ${relationshipBadge(view,e)}` : ''}{card ? ` · CC${String(card.source_spec ?? '').replace('v','')}` : ''}</small></div></div>
      {readableSummaryLines(e.components.identity?.description, e).length > 0 && <div className="identity-summary-lines character-summary-lines">{readableSummaryLines(e.components.identity?.description, e).map((line,i)=><p className="identity-summary-line" key={`${e.id}:${i}:${line}`}>{line}</p>)}</div>}
      {card&&<details className="card-details"><summary>角色卡资料</summary>{String(card.personality??'').trim()&&<p><b>性格</b>{String(card.personality)}</p>}{String(card.scenario??'').trim()&&<p><b>场景设定</b>{String(card.scenario)}</p>}{Array.isArray(card.tags)&&card.tags.length>0&&<div className="chip-row">{(card.tags as string[]).slice(0,12).map(tag=><span className="chip" key={tag}>{tag}</span>)}</div>}</details>}
    </article>;
  })}</div></>;
}
function Relationships({ view }: PanelProps) {
 const entries=view.entities.filter(e=>e.id!==view.player_id&&e.components.character).map(entity=>({entity,summary:relationshipSummary(view,entity)}));
 return entries.length?<div className="list">{entries.map(({entity,summary})=><article className="entity relationship-card" data-entity-id={entity.id} key={entity.id}><div className="person"><Avatar entity={entity}/><div><h3>{nameOf(entity)}</h3><p>{summary.text}</p></div></div>{summary.tones.map(t=><p key={t.key}>{relLabels[t.key]??'关系指标'}：{t.value}</p>)}</article>)}</div>:<p className="empty">尚无玩家可知的关系记录。</p>;
}
function InventoryPanel({ view }: PanelProps) {
  const actor=playerOf(view),entries=Object.entries(inventory(actor)).filter(([,n])=>n>0);
  const placements=(actor.components.inventory?.placements??{}) as Record<string,string|null>;
  const equipped=new Set(Object.values((actor.components.equipment?.slots??{}) as Record<string,string|null>).filter((id):id is string=>Boolean(id)));
  const weight=entries.reduce((sum,[id,n])=>sum+Number(view.entities.find(e=>e.id===id)?.components.item?.weight??0)*n,0);
  const children=(parent:string|null)=>entries.filter(([id])=>(placements[id]??null)===parent&&!equipped.has(id));
  const renderItem=([id,n]:[string,number],depth=0):ReactNode=>{
    const entity=view.entities.find(e=>e.id===id),nested=children(id),label=<div className="item-row"><span>{nameOf(entity)}</span><b>× {n}</b></div>;
    return nested.length?<details key={id} className="inventory-container" style={{marginLeft:depth*12}}><summary>{label}</summary>{nested.map(entry=>renderItem(entry,depth+1))}</details>:<div key={id} style={{marginLeft:depth*12}}>{label}</div>;
  };
  const carried=children(null),worn=entries.filter(([id])=>equipped.has(id));
  return <><p className="muted">总重量 {weight.toFixed(2)} · 包含手持与穿戴物品</p>
    {carried.length?carried.map(entry=>renderItem(entry)):<p className="empty">背包为空。</p>}
    {worn.length?<><h4>手持与穿戴</h4>{worn.map(entry=>renderItem(entry))}</>:null}</>;
}

function descendants(locations: PublicLocation[], parent: string) {
  const out = new Set<string>(), queue = [parent];
  while (queue.length) { const p = queue.shift()!; for (const l of locations.filter(x => x.parent_id === p)) if (!out.has(l.id)) { out.add(l.id); queue.push(l.id); } }
  return out;
}
function ancestorChain(locations: PublicLocation[], id: string) {
  const chain: PublicLocation[] = []; let cur = locations.find(l => l.id === id); const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); chain.unshift(cur); cur = cur.parent_id ? locations.find(l => l.id === cur!.parent_id) : undefined; }
  return chain;
}
/** The map remembers where the player was browsing, per world, so switching tabs never yanks it back. */
function storedMapScope(gameId:string){try{return localStorage.getItem(`agf:map-scope:${gameId}`);}catch{return null;}}
function MapPanel({ view, act, busy }: PanelProps) {
  const current = locationOf(view), currentChain = ancestorChain(view.locations, current);
  const storedScope=()=>storedMapScope(view.game_id);
  const bestScopeFor=(locationId:string)=>{const chain=ancestorChain(view.locations,locationId);
    return chain.filter(place=>view.locations.some(item=>item.parent_id===place.id)).at(-1)?.id??null;};
  const [scope, setScope] = useState<string | null>(() => {
    const stored=storedMapScope(view.game_id);
    if(stored!==null&&stored!==''&&view.locations.some(item=>item.id===stored))return stored;
    return bestScopeFor(current);
  });
  // First entry, a new world, or a stale stored level opens the level that contains the player; afterwards the
  // player's own browsing wins until they press 「定位当前位置」 again.
  useEffect(()=>{const stored=storedMapScope(view.game_id);
    if(stored!==null&&stored!==''&&view.locations.some(item=>item.id===stored))return;
    setScope(bestScopeFor(current));},[view.game_id,current]);
  useEffect(()=>{try{localStorage.setItem(`agf:map-scope:${view.game_id}`,scope??'');}catch{/* private mode */}},[scope,view.game_id]);
  const [regionId,setRegionId]=useState<string|null>(null);
  const currentRegion=view.locations.find(location=>location.id===current)?.spatial?.region_id??null;
  useEffect(()=>{if(!currentRegion)return;const region=view.regions?.find(item=>item.id===currentRegion);
    if(region&&storedScope()===null){setRegionId(currentRegion);setScope(region.scope_location_id);}},[currentRegion,view.regions]);
  const [zoom, setZoom] = useState(1);
  const [pan,setPan]=useState({x:0,y:0});
  const drag=useRef<{x:number;y:number;pan:{x:number;y:number};width:number;height:number}|null>(null);
  const suppressNodeClick=useRef(false);
  const regionsForScope=(view.regions??[]).filter(region=>region.scope_location_id===scope);
  const activeRegion=regionsForScope.some(region=>region.id===regionId)?regionId:null;
  const children = useMemo(() => view.locations.filter(l => (l.parent_id ?? null) === scope&&
    (!activeRegion||l.spatial?.region_id===activeRegion)), [view.locations, scope,activeRegion]);
  const scopeLocation = scope ? view.locations.find(l => l.id === scope) : undefined;
  const visible = children.length ? [...(scopeLocation?[scopeLocation]:[]),...children] : (scope ? [scopeLocation!].filter(Boolean) : view.locations.filter(l => !l.parent_id));
  const rootNodes = visible.length ? visible : view.locations;
  const positions=mapNodePositions(rootNodes,view,scope??undefined);
  const pos=(location:PublicLocation)=>positions.get(location.id)!;
  const drawn=layoutMapEdges(view,rootNodes,positions,view.recent_movement_route?.location_ids);
  const reachable = new Map(view.locations.map(location=>[location.id,routePath(view.routes,current,location.id)]));
  const connections=rootNodes.flatMap(location=>{const path=reachable.get(location.id);return path?.length?[{location,path,minutes:path.reduce((sum,edge)=>sum+edge.travel_minutes,0)}]:[];});
  const boundaryRoutes=activeRegion?view.routes.filter(route=>route.gateway?.from_region_id===activeRegion&&
    view.locations.some(location=>location.id===route.from&&location.spatial?.region_id===activeRegion)):[];
  const viewSize = 100 / zoom, offset = (100 - viewSize) / 2;
  const panLimit=Math.max(0,offset);
  const boundedPan={x:Math.max(-panLimit,Math.min(panLimit,pan.x)),
    y:Math.max(-panLimit,Math.min(panLimit,pan.y))};
  const resetViewport=()=>{setZoom(1);setPan({x:0,y:0});};
  const crumbs = scope ? ancestorChain(view.locations, scope) : [];
  function clickNode(location: PublicLocation) {
    if(suppressNodeClick.current){suppressNodeClick.current=false;return;}
    const hasChildren = view.locations.some(l => l.parent_id === location.id);
    if (hasChildren&&location.id!==scope) { setScope(location.id); resetViewport(); return; }
    const path = reachable.get(location.id); if (path?.length && !busy) act({ type:'MOVE', target_id:location.id });
  }
  return <div className="map-panel-wrap">
    <div className="map-toolbar"><div className="breadcrumbs"><button className="crumb" onClick={()=>{setScope(null);setRegionId(null);resetViewport()}}>世界</button>{crumbs.map(c=><button className="crumb" key={c.id} onClick={()=>{setScope(c.id);setRegionId(null);resetViewport()}}>› {c.name}</button>)}{scope&&<button className="crumb" onClick={()=>{setScope(scopeLocation?.parent_id??null);setRegionId(null);resetViewport()}}>返回上一级</button>}</div><div className="zoom-controls"><button className="quiet" onClick={()=>setZoom(z=>Math.max(1,z/1.35))}>−</button><span>{Math.round(zoom*100)}%</span><button className="quiet" onClick={()=>setZoom(z=>Math.min(6,z*1.35))}>＋</button><button className="quiet" onClick={resetViewport}>重置</button></div></div>
    {regionsForScope.length>1&&<div className="map-region-tabs" aria-label="地图区域">{regionsForScope.map(region=><button key={region.id}
      className={activeRegion===region.id?'selected':'quiet'} onClick={()=>{setRegionId(region.id);resetViewport()}}>{region.name}</button>)}</div>}
    <div className="map-current-path">当前位置：世界{currentChain.map(place=>` › ${place.name}`).join('')} {currentChain.length>1&&<button className="crumb" onClick={()=>{setScope(bestScopeFor(current));setRegionId(currentRegion);setZoom(1);setPan({x:0,y:0})}}>定位当前位置</button>}</div>
    <div className="graph-map" aria-label="分层平面地图">
      {view.recent_movement_route&&<p className="map-recent-route">上次移动：{view.recent_movement_route.location_ids.map(id=>view.locations.find(place=>place.id===id)?.name??id).join(' → ')} · {view.recent_movement_route.total_minutes} 分钟</p>}
      <svg viewBox={`${offset+boundedPan.x} ${offset+boundedPan.y} ${viewSize} ${viewSize}`} role="img" aria-label={scopeLocation ? `${scopeLocation.name}地图` : '世界地图'}
        onPointerDown={event=>{suppressNodeClick.current=false;if(zoom<=1)return;const rect=event.currentTarget.getBoundingClientRect();
          drag.current={x:event.clientX,y:event.clientY,pan:boundedPan,width:rect.width,height:rect.height};
          event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{const start=drag.current;if(!start)return;
          const dx=event.clientX-start.x,dy=event.clientY-start.y;
          if(Math.hypot(dx,dy)>5)suppressNodeClick.current=true;
          setPan({x:Math.max(-panLimit,Math.min(panLimit,start.pan.x-dx/start.width*viewSize)),
            y:Math.max(-panLimit,Math.min(panLimit,start.pan.y-dy/start.height*viewSize))});}}
        onPointerUp={()=>{drag.current=null;}}
        onPointerCancel={()=>{drag.current=null;}}>
        <defs><marker id="map-arrow" markerWidth="2.6" markerHeight="2.6" refX="2.1" refY="1.3" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 0 0 L 2.6 1.3 L 0 2.6 z"/></marker></defs>
        {drawn.map(edge=><path key={`${edge.from}:${edge.to}`} data-route-from={edge.from} data-route-to={edge.to}
          className={`map-route${edge.highlighted?' map-route-travelled':''}`} d={edge.d}
          markerEnd={edge.forward_minutes!==null?'url(#map-arrow)':undefined}
          markerStart={edge.reverse_minutes!==null?'url(#map-arrow)':undefined}/>)}
        {drawn.map(edge=><g className="map-edge-badge" key={`label:${edge.from}:${edge.to}`}>
          <rect className="route-label-bg" x={edge.label_x-edge.label_width/2} y={edge.label_y-3.2} width={edge.label_width} height="6.4" rx="2"/>
          <text className="route-label" x={edge.label_x} y={edge.label_y+1}>{edge.label}</text></g>)}
        {rootNodes.map(location=>{const p=pos(location), isCurrent=location.id===current || descendants(view.locations,location.id).has(current), path=reachable.get(location.id), hasChildren=view.locations.some(l=>l.parent_id===location.id), canReach=!!path?.length,opensChildren=hasChildren&&location.id!==scope,isScope=location.id===scope; return <g key={location.id} className={`map-node ${isCurrent?'current':canReach?'reachable':''} ${hasChildren?'container-node':''} ${isScope?'scope-entrance':''}`} tabIndex={0} role="button" onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')clickNode(location)}} onClick={()=>clickNode(location)}><title>{`${location.name}${opensChildren?'（展开）':canReach?`（${path.reduce((sum,edge)=>sum+edge.travel_minutes,0)}分钟）`:''}`}</title><rect x={p.x-(isScope?3:5)} y={p.y-(isScope?2:3.8)} width={isScope?6:10} height={isScope?4:7.6} rx="1.2"/><text className="map-node-label" x={p.x} y={isScope?p.y-5:p.y+8}>{isScope?'入口':location.name}</text>{opensChildren&&<text className="map-node-plus" x={p.x+5.6} y={p.y-4}>＋</text>}</g>})}
      </svg>
      <div className="map-legend"><span><i className="dot current-dot"/>当前位置所在层级</span><span><i className="dot reachable-dot"/>沿已知路线可达</span><span>连线只表示直接路线；箭头表示方向，亮色是上次移动路线</span><span>{rootNodes.filter(node=>node.id!==scope).every(node=>node.position)?'子地点按已登记位置绘制；顶部入口与线条转角仅作示意，不代表途经地点或真实方位':'无完整位置记录，按固定示意布局绘制；方位不代表真实方向'}</span><span>方块可展开 · 放大后拖动查看</span></div>
      <p className="map-mobile-hint">左右滑动查看完整连接图；下方路线列表可直接查看全部地点。</p>
    </div>
    {connections.length>0&&<div className="map-connections" aria-label="当前可达路线">{connections.map(connection=><div key={connection.location.id} className="map-connection"><span>{[current,...connection.path.map(edge=>edge.to)].map(id=>view.locations.find(place=>place.id===id)?.name??id).join(' → ')}</span><strong>{connection.minutes} 分钟</strong></div>)}</div>}
    {boundaryRoutes.length>0&&<div className="map-connections" aria-label="区域出口">{boundaryRoutes.map(route=>{
      const target=view.locations.find(location=>location.id===route.to),region=view.regions?.find(item=>item.id===route.gateway?.to_region_id);
      return <div className="map-connection" key={`${route.from}:${route.to}`}><span>出口 → {region?.name??'相邻区域'} · {target?.name??'入口'} · {route.travel_minutes} 分钟</span>
        <button className="quiet" disabled={busy} onClick={()=>act({type:'MOVE',target_id:route.to})}>前往</button></div>;
    })}</div>}
    <div className="map-location-list">{rootNodes.map(location=>{const path=reachable.get(location.id), here=location.id===current, hasChildren=view.locations.some(l=>l.parent_id===location.id),opensChildren=hasChildren&&location.id!==scope;return <article className={`map-location-card ${here?'selected':''}`} key={location.id}><div><small>{here?'当前位置':opensChildren?'包含下级地图':path?.length?`移动 ${path.reduce((sum,edge)=>sum+edge.travel_minutes,0)} 分钟${path.length>1?` · 途经 ${path.slice(0,-1).map(edge=>view.locations.find(place=>place.id===edge.to)?.name??edge.to).join('、')}`:''}`:'地图节点'}</small><h3>{location.name}</h3><p>{location.description}</p></div><button className="quiet" disabled={busy&&!opensChildren} onClick={()=>clickNode(location)}>{opensChildren?'打开地图':path?.length?'前往':'查看'}</button></article>})}</div>
  </div>;
}
function Commerce({ view, act, busy }: PanelProps) {
  const shops = view.entities.filter(e => e.components.shop && e.components.location?.location_id === locationOf(view));
  if (!shops.length) return <p className="empty">当前位置没有商店。</p>;
  return <>{shops.map(e => { const shop=e.components.shop as unknown as {currency_id:string;stock:Record<string,number>;prices:Record<string,{buy:number;sell:number}>}; return <section key={e.id}><h3>{nameOf(e)}</h3>{Object.entries(shop.prices).map(([id,price])=><article className="product" key={id}><div><strong>{nameOf(view.entities.find(e=>e.id===id))}</strong><small>库存 {shop.stock[id]??0} · 持有 {inventory(playerOf(view))[id]??0}</small></div><div className="trade"><button disabled={busy||!shop.stock[id]} onClick={()=>act({type:'BUY',target_id:e.id,parameters:{item_id:id,quantity:1}})}>买入 · {price.buy} {view.currencies[shop.currency_id]}</button><button className="quiet" disabled={busy||!inventory(playerOf(view))[id]} onClick={()=>act({type:'SELL',target_id:e.id,parameters:{item_id:id,quantity:1}})}>卖出 · {price.sell}</button></div></article>)}</section>})}</>;
}
function AttributesPanel({ view }: PanelProps) { const c=playerOf(view).components.attributes??{},v=numbers(c.values),labels=(c.labels??{}) as Record<string,string>; return Object.keys(v).length?<div className="stat-grid">{Object.entries(v).map(([k,x])=><div className="mini-card" key={k}><span>{labels[k]??'未命名属性'}</span><strong>{x}</strong></div>)}</div>:<p className="empty">这个世界还没有定义角色属性。</p>; }
function AptitudesPanel({ view }: PanelProps) { const e=(playerOf(view).components.aptitudes?.entries??{}) as Record<string,{name?:string;value?:number;note?:string}>;return Object.keys(e).length?<div className="stat-grid">{Object.entries(e).map(([id,x])=><div className="mini-card" key={id}><span>{x.name??'未命名资质'}</span><strong>{x.value??0}</strong>{x.note&&<small>{x.note}</small>}</div>)}</div>:<p className="empty">这个世界还没有定义资质。</p>; }
function SkillsPanel({ view }: PanelProps) { const e=(playerOf(view).components.skills?.entries??{}) as Record<string,{name?:string;level?:number;xp?:number;next_xp?:number;aptitude_ref?:string|null;note?:string}>;return Object.keys(e).length?<div className="list">{Object.entries(e).map(([id,s])=>{const pct=Math.min(100,Math.round((s.xp??0)/Math.max(1,s.next_xp??1)*100));return <article className="entity skill-card" key={id}><div className="item-row"><strong>{s.name??'未命名技能'}</strong><b>Lv {s.level??0}</b></div><div className="xp-track"><i style={{width:`${pct}%`}}/></div><small>XP {s.xp??0} / {s.next_xp??'?'}{s.aptitude_ref?` · 资质 ${String(((playerOf(view).components.aptitudes?.entries??{}) as Record<string,{name?:string}>)[s.aptitude_ref]?.name??'未登记')}`:''}</small>{s.note&&<p>{s.note}</p>}</article>})}</div>:<p className="empty">还没有形成可记录的技能。</p>; }
function TraitsPanel({ view }: PanelProps) { const e=(playerOf(view).components.traits?.entries??{}) as Record<string,{name?:string;type?:string;status?:string;effects?:string[];note?:string}>;return Object.keys(e).length?<div className="list">{Object.entries(e).map(([id,t])=><article className="entity" key={id}><div className="item-row"><strong>{t.name??'未命名特质'}</strong><b>{t.status??''}</b></div><small>{t.type??''}</small>{(t.effects??[]).map((x,i)=><p key={i}>· {x}</p>)}{t.note&&<p>{t.note}</p>}</article>)}</div>:<p className="empty">没有已记录的持续特质。</p>; }
function EquipmentPanel({ view, act, busy }: PanelProps) { const p=playerOf(view),eq=p.components.equipment??{},slots=(eq.slots??{}) as Record<string,string|null>,labels=(eq.labels??{}) as Record<string,string>,inv=inventory(p),candidates=view.entities.filter(e=>e.components.equipment_item&&(inv[e.id]??0)>0);if(!Object.keys(slots).length)return <p className="empty">这个角色没有定义装备槽位。</p>;return <div className="list">{Object.entries(slots).map(([slot,itemId])=><article className="entity" key={slot}><div className="item-row"><strong>{labels[slot]??'未命名槽位'}</strong><b>{itemId?nameOf(view.entities.find(e=>e.id===itemId)):'空'}</b></div>{itemId?<button className="quiet" disabled={busy} onClick={()=>act({type:'UNEQUIP',parameters:{slot}})}>卸下</button>:<div className="button-row compact">{candidates.filter(e=>((e.components.equipment_item?.allowed_slots??[]) as string[]).includes(slot)).map(e=><button key={e.id} disabled={busy} onClick={()=>act({type:'EQUIP',parameters:{item_id:e.id,slot}})}>装备 {nameOf(e)}</button>)}</div>}</article>)}</div>; }
function QuestsPanel({ view }: PanelProps) {
 const p=playerOf(view),key='agf.task-visibility';
 const [hidden,setHidden]=useState<Record<string,string[]>>(()=>{try{return JSON.parse(localStorage.getItem(key)??'{}');}catch{return {};}});
 const [showHidden,setShowHidden]=useState(false);
 const hide=(book:string,id:string,value:boolean)=>setHidden(previous=>{const k=view.game_id+':'+book,ids=previous[k]??[],next={...previous,[k]:value?[...new Set([...ids,id])]:ids.filter(x=>x!==id)};try{localStorage.setItem(key,JSON.stringify(next));}catch{}return next;});
 type QuestEntry={title?:string;status?:string;summary?:string;objectives?:string[];deadline?:unknown;metadata?:Record<string,unknown>};
 const section=(title:string,book:string)=>{
 const entries=(p.components[book]?.entries??{}) as Record<string,QuestEntry>,groups=taskGroups(entries,hidden[view.game_id+':'+book]??[]);
 const cards=(rows:[string,QuestEntry][],archived=false)=>rows.map(([id,x])=><article className="entity quest-card" key={id}><div className="quest-head"><strong>{displayQuestTitle(id,x)}</strong>{x.status&&<span className="status-badge">{humanStatus(x.status)}</span>}</div>{x.summary&&<p>{x.summary}</p>}{(x.objectives??[]).map((objective,i)=><p key={i}>{objective}</p>)}{Boolean(x.deadline)&&<small>截止：{typeof x.deadline==='string'?x.deadline:'第 '+String((x.deadline as {day?:number}).day??'?')+' 天'}</small>}{endedTask(x.status)&&<button className="quiet" onClick={()=>hide(book,id,!archived)}>{archived?'恢复显示':'隐藏归档'}</button>}</article>);
 return <section className="quest-section"><h3>{title}</h3>{cards(groups.active)}<details><summary>已结束（{groups.ended.length}）</summary>{cards(groups.ended)}</details>{showHidden&&<details open><summary>已隐藏（{groups.hidden.length}）</summary>{cards(groups.hidden,true)}</details>}</section>;
 };
 return <><label><input type="checkbox" checked={showHidden} onChange={e=>setShowHidden(e.target.checked)}/>显示已隐藏任务</label>{section('任务','quests')}{section('机会 / 活动','opportunities')}</>;
}

function StoryPanel({view}:PanelProps){
 const story=view.story;if(!story)return <p className="empty">这个旧存档还没有建立故事记录；它会在需要时安全初始化。</p>;
 const phases:Record<string,string>={FORMING:'正在形成',DEVELOPING:'发展中',ESCALATING:'升级中',CLIMAX:'高潮',AFTERMATH:'余波'};const statuses:Record<string,string>={SEED:'伏笔',EMERGING:'正在形成',ACTIVE:'进行中',DORMANT:'暂时搁置',CONVERGING:'正在收束',CLIMAX:'高潮',RESOLVED:'已解决',FAILED:'失败',ABANDONED:'已放弃',AFTERMATH:'余波',CLOSED:'已结束'};
 const horizon=story.life_horizon.kind==='open_ended'?'开放式':story.life_horizon.kind==='immortal'?'不老/永生':story.life_horizon.target_age_min===story.life_horizon.target_age_max?`${story.life_horizon.target_age_min} 岁左右`:`${story.life_horizon.target_age_min}～${story.life_horizon.target_age_max} 岁参考`;
 return <div className="story-record"><article className="entity"><small>人生长度参考 · {horizon}</small><h3>{story.current_saga?.title??'当前没有成形的篇章'}</h3><p>{story.current_saga?`阶段：${phases[story.current_saga.phase]??story.current_saga.phase}`:'世界仍会继续；故事可以从真实事件中自然形成。'}</p></article><section><h3>当前主要故事</h3>{story.major_arcs.length?<div className="list">{story.major_arcs.map(arc=><article className="entity" key={arc.id}><div className="item-row"><strong>{arc.title}</strong><b>{statuses[arc.status]??arc.status}</b></div>{arc.summary&&<p>{arc.summary}</p>}</article>)}</div>:<p className="empty">暂时没有主要故事线。安静生活也是有效的游玩状态。</p>}</section><section><h3>过去篇章</h3>{story.completed_sagas.length?<div className="list">{story.completed_sagas.map(saga=><article className="entity" key={saga.id}><strong>{saga.title}</strong><p>{saga.outcome}</p><small>第 {saga.start_time.day} 日—第 {saga.end_time.day} 日{saga.unresolved_count?` · ${saga.unresolved_count} 条未完成故事`:''}</small></article>)}</div>:<p className="empty">还没有完成的篇章。</p>}</section></div>;
}


// Local log viewer: a first-class panel in every build. This is the only place where internal ids are visible.
type LogEntry = { timestamp:string; level:string; event:string; module:string; trace_id:string|null; request_id:string|null; job_id:string|null; revision:number|null; duration_ms:number|null; metadata:Record<string,unknown> };
type TraceSummary = { trace_id:string; module:string; started_at:string; total_ms:number; spans:{name:string;duration_ms:number}[] };
type LogResponse = { level:string; file:string|null; entries:LogEntry[]; traces:TraceSummary[] };
const logFilters = [['all','全部'],['routine','Routine'],['ai','AI'],['save','Save'],['rng','RNG'],['migration','Migration'],['warning','Warning'],['error','Error']] as const;
function logMatches(entry:LogEntry,filter:string){
  if(filter==='all')return true;
  if(filter==='warning')return entry.level==='warn'||entry.level==='error';
  if(filter==='error')return entry.level==='error';
  if(filter==='routine')return entry.event.startsWith('routine.');
  if(filter==='ai')return entry.event.startsWith('routine.ai.')||entry.event==='provider.error';
  if(filter==='save')return entry.event.startsWith('save.');
  if(filter==='rng')return entry.event.startsWith('rng.');
  if(filter==='migration')return entry.event.startsWith('migration.');
  return true;
}
function logSummary(entry:LogEntry){
  const detail=entry.metadata??{};
  for(const key of ['reason','message','status','selected','branch','detail','value']){
    const value=detail[key];
    if(typeof value==='string'&&value.trim())return value.trim().slice(0,160);
  }
  return entry.event;
}
export function LogPanel(){
  const [data,setData]=useState<LogResponse|null>(null),[filter,setFilter]=useState('all'),[open,setOpen]=useState(''),[error,setError]=useState(''),[copied,setCopied]=useState(''),[showReads,setShowReads]=useState(false),[traceFilter,setTraceFilter]=useState('');
  useEffect(()=>{
    let disposed=false,inFlight=false;
    const load=async()=>{if(inFlight)return;inFlight=true;try{const next=await request<LogResponse>(`logs?limit=400&hide_reads=${!showReads}${traceFilter.trim()?`&${traceFilter.trim().startsWith('tr_')?'trace_id':'request_id'}=${encodeURIComponent(traceFilter.trim())}`:''}`);if(!disposed){setData(next);setError('');}}catch(e){if(!disposed)setError(e instanceof Error?e.message:String(e));}finally{inFlight=false;}};
    void load();const timer=window.setInterval(()=>void load(),3000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[showReads,traceFilter]);
  const entries=(data?.entries??[]).filter(entry=>logMatches(entry,filter)).slice().reverse();
  async function copyTrace(entry:LogEntry){
    const trace=data?.traces.find(item=>item.trace_id===entry.trace_id);
    const lines=[`trace_id: ${entry.trace_id??'（无 trace）'}`,`event: ${entry.event}`,`request_id: ${entry.request_id??'—'}`,`job_id: ${entry.job_id??'—'}`,...(trace?.spans??[]).map(span=>`${span.name.padEnd(24)} ${String(span.duration_ms).padStart(9)} ms`)];
    try{await navigator.clipboard.writeText(lines.join('\n'));setCopied(entry.trace_id??entry.event);}catch{setCopied('复制失败，请手动选择文本');}
    window.setTimeout(()=>setCopied(''),2500);
  }
  return <div className="log-panel">
    <div className="log-toolbar"><div className="log-filters">{logFilters.map(([id,label])=><button key={id} type="button" className={`quiet ${filter===id?'active':''}`} onClick={()=>setFilter(id)}>{label}</button>)}</div><small>{entries.length} 条 · 等级 {data?.level??'—'}</small></div>
    <label><input type="checkbox" checked={showReads} onChange={e=>setShowReads(e.target.checked)}/>显示高频存档读取</label>
    <input aria-label="筛选 Trace 或请求" placeholder="trace_id / request_id" value={traceFilter} onChange={e=>setTraceFilter(e.target.value)}/>
    <small className="log-file">{data?.file??'未启用文件日志（仅内存）'}</small>
    {error&&<p className="empty">{error}</p>}
    {copied&&<p className="muted">已复制 Trace：{copied}</p>}
    {entries.length?<div className="log-list">{entries.map((entry,index)=>{const key=`${entry.timestamp}:${entry.event}:${index}`;return <article className={`log-row level-${entry.level}`} key={key}>
      <button type="button" className="log-head" onClick={()=>setOpen(open===key?'':key)}>
        <span className="log-time">{entry.timestamp.slice(11,23)}</span>
        <span className="log-event">{entry.event}</span>
        <span className="log-trace">{entry.trace_id??'—'}</span>
        <span className="log-job">{entry.job_id?entry.job_id.slice(0,8):'—'}</span>
        <span className="log-summary">{logSummary(entry)}</span>
        <span className="log-duration">{entry.duration_ms===null?'—':`${entry.duration_ms} ms`}</span>
      </button>
      {open===key&&<div className="log-detail"><pre>{JSON.stringify({timestamp:entry.timestamp,event:entry.event,level:entry.level,module:entry.module,trace_id:entry.trace_id,job_id:entry.job_id,request_id:entry.request_id,revision:entry.revision,duration_ms:entry.duration_ms,...entry.metadata},null,2)}</pre><div className="button-row compact"><button type="button" className="quiet" onClick={()=>void copyTrace(entry)}>复制 Trace</button></div></div>}

    </article>;})}</div>:<p className="empty">当前筛选没有日志。</p>}
  </div>;
}

export const panelRegistry: Record<string, ComponentType<PanelProps>> = { status:Status, characters:Characters, relationships:Relationships, inventory:InventoryPanel, map:MapPanel, commerce:Commerce, attributes:AttributesPanel, aptitudes:AptitudesPanel, skills:SkillsPanel, traits:TraitsPanel, equipment:EquipmentPanel, quests:QuestsPanel, routine:RoutinePlanPanel, story:StoryPanel, logs:LogPanel, system:SystemPanel };

import {endedTask,taskGroups} from './task-visibility.js';
import type {RoutineJob} from '../routine/jobs.js';
import type {Calendar} from '../routine/schema.js';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { request } from './api.js';
import {AvatarCropEditor} from './AvatarCropEditor.js';
import {SystemPanel} from './SystemPanel.js';
import {relationshipBadge, relationshipSummary} from '../shared/relationship.js';

import {RoutinePlanPanel} from './RoutinePlanPanel.js';
import type {AvatarCropMetadata} from '../shared/avatar.js';
import type { Entity, PublicLocation, PublicView, ActionInput } from '../shared/contracts.js';

export const nameOf = (entity?: Entity) => String(entity?.components.identity?.name ?? '未知人物');
export const playerOf = (view: PublicView) => view.entities.find(e => e.id === view.player_id)!;
export const locationOf = (view: PublicView) => String(playerOf(view).components.location?.location_id ?? '');
export interface PanelProps { onView?:(next:PublicView)=>void; onExport?:()=>void; onOpenCharacterCrop?:(entityId:string)=>void; acknowledgeTask?:(id:string,outcome:'completed'|'cancelled')=>Promise<void>;
routineJob?:RoutineJob|null; configureCalendar?:(calendar:Calendar)=>Promise<void>; routineAuto?: boolean; pauseRoutine?: () => void; onOpenLogs?:()=>void; view: PublicView; act: (action: ActionInput) => void; busy: boolean; uploadAvatar?: (entity: Entity, file: File, crop?:AvatarCropMetadata) => Promise<void>; clearAvatar?: (entity: Entity) => Promise<void>; uploadVisualAsset?: (entity: Entity, slot: string, file: File) => Promise<void>; importCharacterCard?: (file: File) => Promise<void>; onSelectCharacter?: (entity: Entity) => void }
const numbers = (value: unknown) => (value ?? {}) as Record<string, number>;
const inventory = (e: Entity) => numbers(e.components.inventory?.items);
const relLabels: Record<string,string> = { familiarity:'熟悉度', trust:'信任', affection:'亲近', dependence:'依赖', protectiveness:'保护欲', suspicion:'怀疑', fear:'恐惧', respect:'尊重', romantic_interest:'恋爱倾向', leverage:'影响力' };
export function Avatar({ entity, className='' }: { entity: Entity; className?: string }) { const id=entity.components.identity?.avatar_id; return id ? <span className={`avatar has-image ${className}`.trim()}><img src={`/api/avatar/${String(id)}`} alt={`${nameOf(entity)}头像`}/></span> : <span className={`avatar ${className}`.trim()} aria-label="无头像">{nameOf(entity).slice(0, 1)}</span>; }
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

export function CharacterDetail({ view, entity, busy, uploadAvatar, clearAvatar, uploadVisualAsset, onClose, initialCropOpen }: PanelProps & { entity: Entity; onClose?: () => void; initialCropOpen?:boolean }) {
  const role = String(entity.components.character?.role ?? '人物');
  const locationId = String(entity.components.location?.location_id ?? '');
  const location = view.locations.find(l => l.id === locationId);
  const images = visualImages(entity);
  const fullbodyId = typeof images.fullbody === 'string' ? images.fullbody : '';
  const [cropOpen,setCropOpen]=useState(Boolean(initialCropOpen));
  const card = entity.components.character_card as undefined | Record<string, unknown>;
  const traits = Array.isArray(entity.components.character?.traits) ? entity.components.character?.traits as unknown[] : [];
  const relEntries = (playerOf(view).components.relationships?.entries ?? {}) as Record<string, Record<string, number>>;
  const relation = relEntries[entity.id];
  const description = textSummary(entity.components.identity?.description);
  const descriptionLines = readableSummaryLines(entity.components.identity?.description, entity);
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
      <div><h3>{nameOf(entity)}</h3><p>{role}</p><small>{location?.name ?? '位置未知'}</small></div>
    </div>
    {description&&<section className="character-detail-section"><h4>已知信息</h4><div className="identity-summary-lines character-summary-lines">{descriptionLines.map((line,i)=><p className="identity-summary-line" key={`${entity.id}:detail:${i}:${line}`}>{line}</p>)}</div></section>}
    {traits.length>0&&<section className="character-detail-section"><h4>特征</h4><div className="chip-row">{traits.slice(0,12).map((x,i)=><span className="chip" key={`${String(x)}:${i}`}>{String(x)}</span>)}</div></section>}
    {relationshipSummary(view,entity).source!=='unknown'&&<section className="character-detail-section"><h4>与你的关系</h4><p>{relationshipSummary(view,entity).text}</p><div className="relation-bars">{Object.entries(relation??{}).map(([key,val])=><div className="relation-row" key={key}><span>{relLabels[key]??'关系指标'}</span><div className="relation-track"><i style={{width:`${Math.max(0,Math.min(100,(val+100)/2))}%`}}/></div><b>{val}</b></div>)}</div></section>}
    {card&&<section className="character-detail-section"><h4>角色卡资料</h4>{String(card.personality??'').trim()&&<p><b>性格：</b>{String(card.personality)}</p>}{String(card.scenario??'').trim()&&<p><b>场景：</b>{String(card.scenario)}</p>}{Array.isArray(card.tags)&&card.tags.length>0&&<div className="chip-row">{(card.tags as string[]).slice(0,12).map(tag=><span className="chip" key={tag}>{tag}</span>)}</div>}</section>}
  </div>;
}

function Status({ view, uploadAvatar, clearAvatar, uploadVisualAsset, busy, onSelectCharacter }: PanelProps) {
  const player = playerOf(view), balances = numbers(player.components.wallet?.balances);
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
      {locationOf(view)&&<div className="mini-card"><span>当前位置</span><strong>{view.locations.find(l => l.id === locationOf(view))?.name ?? '未知'}</strong></div>}
      {Object.entries(balances).map(([key, amount]) => <div className="mini-card" key={key}><span>{view.currencies[key] ?? '货币'}</span><strong>{amount}</strong></div>)}
      {Object.entries(attrs).slice(0,6).map(([key,value]) => <div className="mini-card" key={key}><span>{labels[key] ?? '未命名属性'}</span><strong>{value}</strong></div>)}
    </div>
    {Object.keys(traits).length > 0 && <div className="chip-row">{Object.entries(traits).slice(0,8).map(([id,t]) => <span className="chip" key={id}>{t.name ?? '未命名特质'}{t.status && t.status !== 'active' ? ` · ${t.status}` : ''}</span>)}</div>}
  </div>;
}
function Characters({ view, uploadAvatar, clearAvatar, importCharacterCard, busy, onSelectCharacter }: PanelProps) {
  const current = locationOf(view);
  const characters = view.entities.filter(e => e.components.character && e.id !== view.player_id);
  return <><div className="character-import"><div><strong>角色卡</strong><small>支持 Tavern/Character Card V1、V2、V3 JSON。导入到当前位置，不推进时间，也不调用 AI。</small></div>{importCharacterCard&&<label className="file-button">导入角色卡 JSON<input type="file" accept=".json,application/json" disabled={busy} onChange={ev=>{const f=ev.target.files?.[0];ev.target.value='';if(f)void importCharacterCard(f)}}/></label>}</div><div className="list">{characters.map(e => {
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
 const entries=view.entities.filter(e=>e.id!==view.player_id&&e.components.character).map(entity=>({entity,summary:relationshipSummary(view,entity)})).filter(x=>x.summary.source!=='unknown');
 return entries.length?<div className="list">{entries.map(({entity,summary})=><article className="entity relationship-card" data-entity-id={entity.id} key={entity.id}><div className="person"><Avatar entity={entity}/><div><h3>{nameOf(entity)}</h3><p>{summary.text}</p></div></div>{summary.tones.map(t=><p key={t.key}>{relLabels[t.key]??'关系指标'}：{t.value}</p>)}</article>)}</div>:<p className="empty">尚无玩家可知的关系记录。</p>;
}
function InventoryPanel({ view }: PanelProps) {
  const entries = Object.entries(inventory(playerOf(view))).filter(([, n]) => n > 0);
  const weight = entries.reduce((sum, [id, n]) => sum + Number(view.entities.find(e => e.id === id)?.components.item?.weight ?? 0) * n, 0);
  return <><p className="muted">总重量 {weight.toFixed(2)} · 来自当前持有物品</p>{entries.length ? entries.map(([id, n]) => <div className="item-row" key={id}><span>{nameOf(view.entities.find(e => e.id === id))}</span><b>× {n}</b></div>) : <p className="empty">背包为空。</p>}</>;
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
function snap(n: number) { return Math.round(n / 10) * 10; }
function MapPanel({ view, act, busy }: PanelProps) {
  const current = locationOf(view), currentChain = ancestorChain(view.locations, current);
  const defaultScope = currentChain.length > 1 ? currentChain[currentChain.length - 2]?.id ?? null : null;
  const [scope, setScope] = useState<string | null>(defaultScope);
  const [zoom, setZoom] = useState(1);
  const children = useMemo(() => view.locations.filter(l => (l.parent_id ?? null) === scope), [view.locations, scope]);
  const scopeLocation = scope ? view.locations.find(l => l.id === scope) : undefined;
  const visible = children.length ? children : (scope ? [scopeLocation!].filter(Boolean) : view.locations.filter(l => !l.parent_id));
  const rootNodes = visible.length ? visible : view.locations;
  const idx = new Map(rootNodes.map((l,i)=>[l.id,i]));
  const pos = (location: PublicLocation) => {
    if (location.position) return { x:snap(location.position.x), y:snap(location.position.y) };
    const i = idx.get(location.id) ?? 0, cols = Math.max(2, Math.ceil(Math.sqrt(rootNodes.length)));
    return { x: 15 + (i % cols) * (70 / Math.max(1, cols - 1)), y: 18 + Math.floor(i / cols) * 28 };
  };
  const childForLeaf = (leaf: string) => rootNodes.find(node => node.id === leaf || descendants(view.locations,node.id).has(leaf));
  const aggregate = new Map<string,{from:string;to:string;travel_minutes:number}>();
  for (const route of view.routes) {
    const a = childForLeaf(route.from), b = childForLeaf(route.to); if (!a || !b || a.id === b.id) continue;
    const key=[a.id,b.id].sort().join('::'), prev=aggregate.get(key);
    if (!prev || route.travel_minutes < prev.travel_minutes) aggregate.set(key,{from:a.id,to:b.id,travel_minutes:route.travel_minutes});
  }
  const direct = new Map(view.routes.filter(r => r.from === current).map(r => [r.to, r]));
  const viewSize = 100 / zoom, offset = (100 - viewSize) / 2;
  const crumbs = scope ? ancestorChain(view.locations, scope) : [];
  function clickNode(location: PublicLocation) {
    const hasChildren = view.locations.some(l => l.parent_id === location.id);
    if (hasChildren) { setScope(location.id); setZoom(1); return; }
    const route = direct.get(location.id); if (route && !busy) act({ type:'MOVE', target_id:location.id });
  }
  return <div className="map-panel-wrap">
    <div className="map-toolbar"><div className="breadcrumbs"><button className="crumb" onClick={()=>{setScope(null);setZoom(1)}}>世界</button>{crumbs.map(c=><button className="crumb" key={c.id} onClick={()=>{setScope(c.id);setZoom(1)}}>› {c.name}</button>)}</div><div className="zoom-controls"><button className="quiet" onClick={()=>setZoom(z=>Math.max(.7,z-.2))}>−</button><span>{Math.round(zoom*100)}%</span><button className="quiet" onClick={()=>setZoom(z=>Math.min(2.6,z+.2))}>＋</button><button className="quiet" onClick={()=>setZoom(1)}>重置</button></div></div>
    <div className="graph-map" aria-label="分层平面地图">
      <svg viewBox={`${offset} ${offset} ${viewSize} ${viewSize}`} role="img" aria-label={scopeLocation ? `${scopeLocation.name}地图` : '世界地图'}>
        {[...aggregate.values()].map(edge=>{const a=pos(rootNodes.find(l=>l.id===edge.from)!),b=pos(rootNodes.find(l=>l.id===edge.to)!); const midX=(a.x+b.x)/2; return <g key={`${edge.from}-${edge.to}`}><path className="map-route" d={`M ${a.x} ${a.y} H ${midX} V ${b.y} H ${b.x}`}/><rect className="route-label-bg" x={midX-5.5} y={(a.y+b.y)/2-3} width="11" height="5.5" rx="1"/><text className="route-label" x={midX} y={(a.y+b.y)/2+.7}>{edge.travel_minutes}m+</text></g>})}
        {rootNodes.map(location=>{const p=pos(location), isCurrent=location.id===current || descendants(view.locations,location.id).has(current), route=direct.get(location.id), hasChildren=view.locations.some(l=>l.parent_id===location.id), reachable=!!route; return <g key={location.id} className={`map-node ${isCurrent?'current':reachable?'reachable':''} ${hasChildren?'container-node':''}`} tabIndex={0} role="button" onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')clickNode(location)}} onClick={()=>clickNode(location)}><title>{location.name}{hasChildren?'（展开）':reachable?`（${route.travel_minutes}分钟）`:''}</title><rect x={p.x-5} y={p.y-3.8} width="10" height="7.6" rx="1.2"/><text className="map-node-label" x={p.x} y={p.y+8}>{location.name}</text>{hasChildren&&<text className="map-node-plus" x={p.x+5.6} y={p.y-4}>＋</text>}</g>})}
      </svg>
      <div className="map-legend"><span><i className="dot current-dot"/>当前位置所在层级</span><span><i className="dot reachable-dot"/>当前可直达</span><span>方块可展开 · 使用 ＋ / − 缩放</span></div>
    </div>
    <div className="map-location-list">{rootNodes.map(location=>{const route=direct.get(location.id), here=location.id===current, hasChildren=view.locations.some(l=>l.parent_id===location.id);return <article className={`map-location-card ${here?'selected':''}`} key={location.id}><div><small>{here?'当前位置':hasChildren?'包含下级地图':route?`移动 ${route.travel_minutes} 分钟`:'地图节点'}</small><h3>{location.name}</h3><p>{location.description}</p></div><button className="quiet" disabled={busy&&!hasChildren} onClick={()=>clickNode(location)}>{hasChildren?'打开地图':route?'前往':'查看'}</button></article>})}</div>
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
  const [data,setData]=useState<LogResponse|null>(null),[filter,setFilter]=useState('all'),[open,setOpen]=useState(''),[error,setError]=useState(''),[copied,setCopied]=useState('');
  useEffect(()=>{
    let disposed=false,inFlight=false;
    const load=async()=>{if(inFlight)return;inFlight=true;try{const next=await request<LogResponse>('logs?limit=400');if(!disposed){setData(next);setError('');}}catch(e){if(!disposed)setError(e instanceof Error?e.message:String(e));}finally{inFlight=false;}};
    void load();const timer=window.setInterval(()=>void load(),3000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[]);
  const entries=(data?.entries??[]).filter(entry=>logMatches(entry,filter)).slice().reverse();
  async function copyTrace(entry:LogEntry){
    const trace=data?.traces.find(item=>item.trace_id===entry.trace_id);
    const lines=[`trace_id: ${entry.trace_id??'（无 trace）'}`,`event: ${entry.event}`,`request_id: ${entry.request_id??'—'}`,`job_id: ${entry.job_id??'—'}`,...(trace?.spans??[]).map(span=>`${span.name.padEnd(24)} ${String(span.duration_ms).padStart(9)} ms`)];
    try{await navigator.clipboard.writeText(lines.join('\n'));setCopied(entry.trace_id??entry.event);}catch{setCopied('复制失败，请手动选择文本');}
    window.setTimeout(()=>setCopied(''),2500);
  }
  return <div className="log-panel">
    <div className="log-toolbar"><div className="log-filters">{logFilters.map(([id,label])=><button key={id} type="button" className={`quiet ${filter===id?'active':''}`} onClick={()=>setFilter(id)}>{label}</button>)}</div><small>{entries.length} 条 · 等级 {data?.level??'—'}</small></div>
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

export const panelRegistry: Record<string, ComponentType<PanelProps>> = { status:Status, characters:Characters, relationships:Relationships, inventory:InventoryPanel, map:MapPanel, commerce:Commerce, attributes:AttributesPanel, aptitudes:AptitudesPanel, skills:SkillsPanel, traits:TraitsPanel, equipment:EquipmentPanel, quests:QuestsPanel, routine:RoutinePlanPanel, logs:LogPanel, system:SystemPanel };

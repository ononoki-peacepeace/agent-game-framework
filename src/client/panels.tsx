import { useMemo, useState, type ComponentType } from 'react';
import type { Entity, PublicLocation, PublicView, ActionInput } from '../shared/contracts.js';

export const nameOf = (entity?: Entity) => String(entity?.components.identity?.name ?? entity?.id ?? '未知');
export const playerOf = (view: PublicView) => view.entities.find(e => e.id === view.player_id)!;
export const locationOf = (view: PublicView) => String(playerOf(view).components.location.location_id);
export interface PanelProps { view: PublicView; act: (action: ActionInput) => void; busy: boolean; uploadAvatar?: (entity: Entity, file: File) => Promise<void> }
const numbers = (value: unknown) => (value ?? {}) as Record<string, number>;
const inventory = (e: Entity) => numbers(e.components.inventory?.items);
const relLabels: Record<string,string> = { familiarity:'熟悉度', trust:'信任', affection:'亲近', dependence:'依赖', protectiveness:'保护欲', suspicion:'怀疑', fear:'恐惧', respect:'尊重', romantic_interest:'恋爱倾向', leverage:'影响力' };
function Avatar({ entity }: { entity: Entity }) { const id=entity.components.identity?.avatar_id; return id ? <span className="avatar has-image"><img src={`/api/avatar/${String(id)}`} alt={`${nameOf(entity)}头像`}/></span> : <span className="avatar" aria-label="无头像">{nameOf(entity).slice(0, 1)}</span>; }
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
    dormant:'暂缓', open:'开放', pending:'待定'
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

function Status({ view, uploadAvatar, busy }: PanelProps) {
  const player = playerOf(view), balances = numbers(player.components.wallet?.balances);
  const role = String(player.components.character?.role ?? '玩家角色');
  const attrs = numbers(player.components.attributes?.values), labels = (player.components.attributes?.labels ?? {}) as Record<string,string>;
  const traits = (player.components.traits?.entries ?? {}) as Record<string,{name?:string;status?:string}>;
  return <div className="status-stack">
    <div className="status-hero"><div className="avatar-editor"><Avatar entity={player}/>{uploadAvatar&&<label className="avatar-upload">{player.components.identity?.avatar_id?'更换':'上传头像'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void uploadAvatar(player,f)}}/></label>}</div><div><h3>{nameOf(player)}</h3><p>{role}</p><small>{textSummary(player.components.identity?.description)}</small></div></div>
    <div className="status-grid">
      <div className="mini-card"><span>当前位置</span><strong>{view.locations.find(l => l.id === locationOf(view))?.name ?? '未知'}</strong></div>
      {Object.entries(balances).map(([key, amount]) => <div className="mini-card" key={key}><span>{view.currencies[key] ?? key}</span><strong>{amount}</strong></div>)}
      {Object.entries(attrs).slice(0,6).map(([key,value]) => <div className="mini-card" key={key}><span>{labels[key] ?? key}</span><strong>{value}</strong></div>)}
    </div>
    {Object.keys(traits).length > 0 && <div className="chip-row">{Object.entries(traits).slice(0,8).map(([id,t]) => <span className="chip" key={id}>{t.name ?? id}{t.status && t.status !== 'active' ? ` · ${t.status}` : ''}</span>)}</div>}
  </div>;
}
function Characters({ view, uploadAvatar, busy }: PanelProps) {
  const current = locationOf(view);
  const characters = view.entities.filter(e => e.components.character && e.id !== view.player_id);
  return <div className="list">{characters.map(e => {
    const here = e.components.location?.location_id === current;
    const role = String(e.components.character?.role ?? '人物');
    return <article className={`entity character-card ${here ? 'selected' : ''}`} key={e.id}><div className="person"><div className="avatar-editor compact-avatar"><Avatar entity={e}/>{uploadAvatar&&<label className="avatar-upload icon-only" title="上传 / 更换头像">＋<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={ev=>{const f=ev.target.files?.[0];ev.target.value='';if(f)void uploadAvatar(e,f)}}/></label>}</div><div><h3>{nameOf(e)}</h3><small>{role} · {here ? '当前在场' : view.locations.find(l => l.id === e.components.location?.location_id)?.name ?? '位置未知'}</small></div></div>
      {textSummary(e.components.identity?.description) && <p>{textSummary(e.components.identity?.description)}</p>}
    </article>;
  })}</div>;
}
function Relationships({ view }: PanelProps) {
  const entries = (playerOf(view).components.relationships?.entries ?? {}) as Record<string, Record<string, number>>;
  return Object.keys(entries).length ? <div className="list">{Object.entries(entries).map(([id, dimensions]) => <article className="entity relationship-card" key={id}><div className="person"><Avatar entity={view.entities.find(e=>e.id===id) ?? {id,type:'unknown',components:{}}}/><div><h3>{nameOf(view.entities.find(e => e.id === id))}</h3><small>{Object.entries(dimensions).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,2).map(([k,v])=>`${relLabels[k]??k} ${relationTone(v)}`).join(' · ') || '关系已建立'}</small></div></div>
    <div className="relation-bars">{Object.entries(dimensions).map(([key,val]) => <div className="relation-row" key={key}><span>{relLabels[key] ?? key}</span><div className="relation-track"><i style={{width:`${Math.max(0,Math.min(100,(val+100)/2))}%`}}/></div><b>{val}</b></div>)}</div>
  </article>)}</div> : <p className="empty">关系会随实际交往逐渐形成，不会因为一次成功直接跳满。</p>;
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
function AttributesPanel({ view }: PanelProps) { const c=playerOf(view).components.attributes??{},v=numbers(c.values),labels=(c.labels??{}) as Record<string,string>; return Object.keys(v).length?<div className="stat-grid">{Object.entries(v).map(([k,x])=><div className="mini-card" key={k}><span>{labels[k]??k}</span><strong>{x}</strong></div>)}</div>:<p className="empty">这个世界还没有定义角色属性。</p>; }
function AptitudesPanel({ view }: PanelProps) { const e=(playerOf(view).components.aptitudes?.entries??{}) as Record<string,{name?:string;value?:number;note?:string}>;return Object.keys(e).length?<div className="stat-grid">{Object.entries(e).map(([id,x])=><div className="mini-card" key={id}><span>{x.name??id}</span><strong>{x.value??0}</strong>{x.note&&<small>{x.note}</small>}</div>)}</div>:<p className="empty">这个世界还没有定义资质。</p>; }
function SkillsPanel({ view }: PanelProps) { const e=(playerOf(view).components.skills?.entries??{}) as Record<string,{name?:string;level?:number;xp?:number;next_xp?:number;aptitude_ref?:string|null;note?:string}>;return Object.keys(e).length?<div className="list">{Object.entries(e).map(([id,s])=>{const pct=Math.min(100,Math.round((s.xp??0)/Math.max(1,s.next_xp??1)*100));return <article className="entity skill-card" key={id}><div className="item-row"><strong>{s.name??id}</strong><b>Lv {s.level??0}</b></div><div className="xp-track"><i style={{width:`${pct}%`}}/></div><small>XP {s.xp??0} / {s.next_xp??'?'}{s.aptitude_ref?` · 资质 ${s.aptitude_ref}`:''}</small>{s.note&&<p>{s.note}</p>}</article>})}</div>:<p className="empty">还没有形成可记录的技能。</p>; }
function TraitsPanel({ view }: PanelProps) { const e=(playerOf(view).components.traits?.entries??{}) as Record<string,{name?:string;type?:string;status?:string;effects?:string[];note?:string}>;return Object.keys(e).length?<div className="list">{Object.entries(e).map(([id,t])=><article className="entity" key={id}><div className="item-row"><strong>{t.name??id}</strong><b>{t.status??''}</b></div><small>{t.type??''}</small>{(t.effects??[]).map((x,i)=><p key={i}>· {x}</p>)}{t.note&&<p>{t.note}</p>}</article>)}</div>:<p className="empty">没有已记录的持续特质。</p>; }
function EquipmentPanel({ view, act, busy }: PanelProps) { const p=playerOf(view),eq=p.components.equipment??{},slots=(eq.slots??{}) as Record<string,string|null>,labels=(eq.labels??{}) as Record<string,string>,inv=inventory(p),candidates=view.entities.filter(e=>e.components.equipment_item&&(inv[e.id]??0)>0);if(!Object.keys(slots).length)return <p className="empty">这个角色没有定义装备槽位。</p>;return <div className="list">{Object.entries(slots).map(([slot,itemId])=><article className="entity" key={slot}><div className="item-row"><strong>{labels[slot]??slot}</strong><b>{itemId?nameOf(view.entities.find(e=>e.id===itemId)):'空'}</b></div>{itemId?<button className="quiet" disabled={busy} onClick={()=>act({type:'UNEQUIP',parameters:{slot}})}>卸下</button>:<div className="button-row compact">{candidates.filter(e=>((e.components.equipment_item?.allowed_slots??[]) as string[]).includes(slot)).map(e=><button key={e.id} disabled={busy} onClick={()=>act({type:'EQUIP',parameters:{item_id:e.id,slot}})}>装备 {nameOf(e)}</button>)}</div>}</article>)}</div>; }
function QuestsPanel({ view }: PanelProps) {
  const p=playerOf(view);
  type QuestEntry={title?:string;status?:string;summary?:string;objectives?:string[];deadline?:string|null;metadata?:Record<string,unknown>};
  const q=(p.components.quests?.entries??{}) as Record<string,QuestEntry>;
  const o=(p.components.opportunities?.entries??{}) as Record<string,QuestEntry>;
  const sec=(title:string,entries:Record<string,QuestEntry>)=><section className="quest-section"><h3>{title}</h3>{Object.keys(entries).length?<div className="list">{Object.entries(entries).map(([id,x])=><article className="entity quest-card" key={id}><div className="quest-head"><strong>{displayQuestTitle(id,x)}</strong>{x.status&&<span className="status-badge">{humanStatus(x.status)}</span>}</div>{x.summary&&<p>{x.summary}</p>}{(x.objectives??[]).length>0&&<div className="quest-objectives">{(x.objectives??[]).map((y,i)=><small key={i}>· {y}</small>)}</div>}{x.deadline&&<small className="quest-deadline">截止：{x.deadline}</small>}</article>)}</div>:<p className="empty">暂无。</p>}</section>;
  return <>{sec('任务',q)}{sec('机会 / 活动',o)}</>;
}

function RoutinePanel({ view, act, busy }: PanelProps) {
  const r = playerOf(view).components.routine as undefined | { active?:boolean;label?:string;pattern?:string;activities?:string[];elapsed_minutes?:number;cycles?:number;interrupted?:boolean;last_interrupt?:string|null };
  if (!r || (!r.active && !r.interrupted && (!r.label || r.label === '未设置'))) return <div className="routine-empty"><p className="empty">还没有设置生活模式。</p><small>直接在左侧输入，例如：“接下来每天照常上课和学习，直到发生值得我处理的事。”</small></div>;
  return <div className="routine-card"><div className="routine-head"><div><small>{r.active?'正在运行':r.interrupted?'已被打断':'已停止'}</small><h3>{r.label ?? '生活模式'}</h3></div><span className={`status-badge ${r.interrupted?'warn':''}`}>{r.interrupted?'需要接管':r.active?'自动推进':'停止'}</span></div><p>{r.pattern}</p><div className="status-grid"><div className="mini-card"><span>已压缩时间</span><strong>{Math.round((r.elapsed_minutes??0)/60*10)/10} 小时</strong></div><div className="mini-card"><span>推进块</span><strong>{r.cycles??0}</strong></div></div>{r.last_interrupt&&<div className="routine-interrupt">打断原因：{r.last_interrupt}</div>}<div className="button-row compact">{r.active&&<button disabled={busy} onClick={()=>act({type:'CONTINUE_ROUTINE',parameters:{max_minutes:1440}})}>继续生活模式</button>}<button className="quiet" disabled={busy} onClick={()=>act({type:'CANCEL_ROUTINE',parameters:{}})}>结束模式</button></div><small>Routine 只负责时间压缩并触发世界 hook；具体上课、工作、训练收益由对应模块决定。</small></div>;
}

export const panelRegistry: Record<string, ComponentType<PanelProps>> = { status:Status, characters:Characters, relationships:Relationships, inventory:InventoryPanel, map:MapPanel, commerce:Commerce, attributes:AttributesPanel, aptitudes:AptitudesPanel, skills:SkillsPanel, traits:TraitsPanel, equipment:EquipmentPanel, quests:QuestsPanel, routine:RoutinePanel };

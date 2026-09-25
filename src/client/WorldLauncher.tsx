import { useEffect, useState } from 'react';
import { request } from './api.js';
import type { PublicView } from '../shared/contracts.js';
import './world.css';
import './world-v2.css';

type TemplateSummary = { id: string; display_name: string; description: string; recommended_experience: string[]; inspiration: string[] };
type Chip = { id: string; label: string; dimension: string };
type Preview = {
  source: { kind: string; id?: string }; title: string; one_liner: string; era: string; player_role: string;
  initial_scope: string; danger: string; supernatural: string; npc_density: string;
  experiences: string[]; special_rules: string[]; recommended_modules: string[];
};
type PreviewResponse = { preview_id: string; flow_id: string; preview: Preview; description: string; blank: boolean; signature: string; picks: string[]; features: string[]; chips: Chip[] };
type View = 'home' | 'templates' | 'ai' | 'custom' | 'preview' | 'editing';
const dangerLabel: Record<string, string> = { low: '低危险', medium: '中等危险', high: '高危险' };
const supernaturalLabel: Record<string, string> = { none: '无超自然', subtle: '轻微隐藏异常', open: '超自然公开' };
const densityLabel: Record<string, string> = { low: 'NPC 较少', medium: 'NPC 适中', high: 'NPC 很多' };
const viewTitles: Record<Exclude<View, 'home'>, string> = { templates: '从模板开始', ai: '让 AI 帮我想', custom: '自己创建', preview: '这个世界', editing: '调整这个世界' };
/**
 * Three strictly separated entries (templates / AI idea / custom), then a preview card. Only "开始这个世界"
 * creates a world; 调整 and 换一个 never do. Each entry owns its own screen, so nothing is mixed together.
 */
export function WorldLauncher({ busy, onCreated, onCustom }: { busy: boolean; onCreated: (view: PublicView) => void; onCustom: (description: string) => void }) {
  const [view, setView] = useState<View>('home');
  const [origin, setOrigin] = useState<Exclude<View, 'home' | 'preview' | 'editing'>>('templates');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [idea, setIdea] = useState('');
  const [custom, setCustom] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [editText, setEditText] = useState('');
  const [pending, setPending] = useState<'preview' | 'another' | 'adjust' | 'confirm' | null>(null);
  const [note, setNote] = useState('');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  useEffect(() => { void (async () => { try { setTemplates(await request<TemplateSummary[]>('world/templates')); } catch { /* entries stay usable */ } })(); }, []);
  useEffect(() => { void (async () => { try { const result = await request<{ chips: Chip[] }>(`world/inspiration?seed=${seed}`); setChips(result.chips); } catch { /* optional */ } })(); }, [seed]);
  const openEntry = (next: Exclude<View, 'home' | 'preview' | 'editing'>) => { setOrigin(next); setPreview(null); setNote(''); setView(next); };
  const call = async (kind: 'preview' | 'another' | 'adjust', body: Record<string, unknown>) => {
    setPending(kind); setNote('');
    try {
      const next = await request<PreviewResponse>('world/preview', body);
      setPreview(next); setView('preview');
      if (next.chips?.length) setChips(next.chips);
    } catch (e) { setNote((e as Error).message); }
    finally { setPending(null); }
  };
  const another = () => {
    const next = seed + 1; setSeed(next);
    void call('another', { another: true, preview_id: preview?.preview_id, preview_session: preview?.flow_id, picked, inspiration_seed: next, ...(idea.trim() ? { idea: idea.trim() } : {}) });
  };
  const start = async () => {
    if (!preview) return;
    setPending('confirm');
    try { onCreated(await request<PublicView>('world/confirm', { preview_id: preview.preview_id })); }
    catch (e) { setNote((e as Error).message); }
    finally { setPending(null); }
  };
  const busyAll = busy || pending !== null;
  const list = showAll ? templates : templates.slice(0, 6);
  return <section className="world-launcher">
    {view !== 'home' && <button type="button" className="quiet" disabled={busyAll} onClick={() => setView(view === 'preview' || view === 'editing' ? origin : 'home')}>← 返回</button>}
    {view === 'home' && <div className="world-hero">
      <h3>创建新世界</h3>
      <p>选一个起点就行，之后随时可以改。</p>
      <div className="world-entries">
        <button type="button" className="quiet" disabled={busyAll} onClick={() => openEntry('templates')}>▦ 从模板开始</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => openEntry('ai')}>✨ 让 AI 帮我想</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => openEntry('custom')}>✎ 自己创建</button>
      </div>
    </div>}
    {view === 'templates' && <div className="template-grid">
      {list.map(template => <button key={template.id} type="button" className="template-card" disabled={busyAll} onClick={() => void call('preview', { template_id: template.id })}>
        <strong>{template.display_name}</strong>
        <small>{template.description}</small>
        <span className="template-tags">{template.recommended_experience.slice(0, 4).join(' · ')}</span>
      </button>)}
      {!showAll && templates.length > 6 && <button type="button" className="quiet" disabled={busyAll} onClick={() => setShowAll(true)}>查看更多</button>}
    </div>}
    {view === 'ai' && <div className="world-idea">
      <textarea aria-label="世界灵感" value={idea} maxLength={500} onChange={event => setIdea(event.target.value)} placeholder="例如：现代社会，人物很多，但存在极少数隐藏异常。" />
      <div className="world-chips">
        {chips.map(chip => <button key={chip.id} type="button" className={picked.includes(chip.id) ? 'world-chip picked' : 'world-chip'} disabled={busyAll} onClick={() => setPicked(current => current.includes(chip.id) ? current.filter(id => id !== chip.id) : [...current, chip.id])}>{chip.label}</button>)}
        <button type="button" className="quiet" disabled={busyAll} onClick={() => setSeed(seed + 1)}>🎲 换一批</button>
      </div>
      <div className="button-row compact">
        <button type="button" disabled={busyAll} onClick={() => void call('preview', { idea: idea.trim(), picked, inspiration_seed: seed })}>看看会是怎样的世界</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => void call('preview', { picked, inspiration_seed: seed })}>我什么都没想好</button>
      </div>
    </div>}
    {view === 'custom' && <div className="world-idea">
      <textarea aria-label="自己描述世界" value={custom} maxLength={12000} onChange={event => setCustom(event.target.value)} placeholder="例如：现代城市背景，以社会关系、学习和职业为核心。玩家刚刚搬入一座陌生城市。" />
      <div className="button-row compact"><button type="button" disabled={busyAll || !custom.trim()} onClick={() => onCustom(custom.trim())}>用这段描述创建</button></div>
    </div>}
    {(view === 'preview' || view === 'editing') && preview && <article className="world-preview">
      <h3>{preview.preview.title}</h3>
      <p className="preview-one-liner">{preview.preview.one_liner}</p>
      <p className="preview-tags">{[preview.preview.era, dangerLabel[preview.preview.danger] ?? preview.preview.danger, supernaturalLabel[preview.preview.supernatural] ?? preview.preview.supernatural, densityLabel[preview.preview.npc_density] ?? preview.preview.npc_density].join(' · ')}</p>
      <dl>
        <dt>你的身份</dt><dd>{preview.preview.player_role}</dd>
        <dt>主要体验</dt><dd>{preview.preview.experiences.join(' / ')}</dd>
        <dt>世界特征</dt><dd>{(preview.features?.length ? preview.features : preview.preview.special_rules).join(' / ') || '—'}</dd>
        <dt>初始地点</dt><dd>{preview.preview.initial_scope}</dd>
      </dl>
      {preview.blank && <p className="world-note">这是一个空白世界，不会预置人物、地点或剧情。</p>}
      {view === 'editing' ? <div className="world-edit">
        <textarea aria-label="调整这个世界" value={editText} maxLength={400} onChange={event => setEditText(event.target.value)} placeholder="例如：危险程度低一点 / 我不想当学生，我想当老师 / NPC 多一点" />
        <div className="button-row compact">
          <button type="button" disabled={busyAll || !editText.trim()} onClick={() => void call('adjust', { preview_id: preview.preview_id, modify: editText.trim(), preview_session: preview.flow_id, inspiration_seed: seed })}>{pending === 'adjust' ? '正在调整…' : '改好了'}</button>
          <button type="button" className="quiet" disabled={busyAll} onClick={() => setView('preview')}>取消调整</button>
        </div>
      </div> : <div className="preview-actions">
        <button type="button" className="primary" disabled={busyAll} onClick={() => void start()}>{pending === 'confirm' ? '正在创建…' : '开始这个世界'}</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => { setEditText(''); setView('editing'); }}>调整</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={another}>{pending === 'another' ? '正在换一个…' : '换一个'}</button>
        {pending === 'another' && <span className="loading-note">正在换一个…</span>}
      </div>}
    </article>}
    {note && <p className="world-error" role="alert">{note}</p>}
  </section>;
}

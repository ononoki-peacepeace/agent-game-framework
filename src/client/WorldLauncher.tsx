import { useEffect, useState } from 'react';
import { request } from './api.js';
import type { PublicView } from '../shared/contracts.js';
import './world.css';

type TemplateSummary = { id: string; display_name: string; description: string; recommended_experience: string[]; inspiration: string[] };
type Chip = { id: string; label: string; dimension: string };
type Preview = {
  source: { kind: string; id?: string }; title: string; one_liner: string; era: string; player_role: string;
  initial_scope: string; danger: string; supernatural: string; npc_density: string;
  experiences: string[]; special_rules: string[]; recommended_modules: string[];
};
type PreviewResponse = { preview_id: string; flow_id: string; preview: Preview; description: string; blank: boolean; signature: string; picks: string[]; features: string[]; chips: Chip[] };
const dangerLabel: Record<string, string> = { low: '低危险', medium: '中等危险', high: '高危险' };
const supernaturalLabel: Record<string, string> = { none: '无超自然', subtle: '轻微隐藏异常', open: '超自然公开' };
const densityLabel: Record<string, string> = { low: 'NPC 较少', medium: 'NPC 适中', high: 'NPC 很多' };
const entryLabels: { id: 'ai' | 'template' | 'custom'; icon: string; title: string }[] = [
  { id: 'ai', icon: '✨', title: 'AI 帮我想' },
  { id: 'template', icon: '▦', title: '从模板开始' },
  { id: 'custom', icon: '✎', title: '自己创建' },
];
/**
 * Creating a world: pick an entry, look at a preview card, adjust it in plain language, and only then start.
 * Nothing here creates a world except "开始这个世界" (and the explicit 自己创建 entry).
 */
export function WorldLauncher({ busy, onCreated, onCustom }: { busy: boolean; onCreated: (view: PublicView) => void; onCustom: (description: string) => void }) {
  const [entry, setEntry] = useState<'home' | 'ai' | 'template' | 'custom'>('home');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [idea, setIdea] = useState('');
  const [custom, setCustom] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  useEffect(() => { void (async () => { try { setTemplates(await request<TemplateSummary[]>('world/templates')); } catch { /* the entries stay usable */ } })(); }, []);
  useEffect(() => { void (async () => { try { const result = await request<{ chips: Chip[] }>(`world/inspiration?seed=${seed}`); setChips(result.chips); } catch { /* chips are optional */ } })(); }, [seed]);
  const call = async (body: Record<string, unknown>) => {
    setPending(true); setNote('');
    try { const next = await request<PreviewResponse>('world/preview', body); setPreview(next); setEditing(false); if (next.chips?.length) setChips(next.chips); }

    catch (e) { setNote((e as Error).message); }
    finally { setPending(false); }
  };
  const start = async () => {
    if (!preview) return;
    setPending(true);
    try { onCreated(await request<PublicView>('world/confirm', { preview_id: preview.preview_id })); }
    catch (e) { setNote((e as Error).message); }
    finally { setPending(false); }
  };
  const another = () => { const next = seed + 1; setSeed(next); void call({ ...(preview?.preview.source.id ? { template_id: preview.preview.source.id } : idea.trim() ? { idea: idea.trim() } : {}), preview_session: preview?.flow_id, picked, inspiration_seed: next }); };
  const busyAll = busy || pending;
  const list = showAll ? templates : templates.slice(0, 6);
  return <section className="world-launcher">
    {entry === 'home' && <div className="world-hero">
      <h3>创建新世界</h3>
      <p>选一个起点就行，之后随时可以改。</p>
      <div className="world-entries">{entryLabels.map(item => <button key={item.id} type="button" className="quiet" disabled={busyAll} onClick={() => setEntry(item.id)}>{item.icon} {item.title}</button>)}</div>
    </div>}
    {entry !== 'home' && <button type="button" className="quiet" disabled={busyAll} onClick={() => { setEntry('home'); setPreview(null); setEditing(false); }}>← 返回</button>}
    {entry === 'template' && <div className="template-grid">
      {list.map(template => <button key={template.id} type="button" className="template-card" disabled={busyAll} onClick={() => void call({ template_id: template.id })}>
        <strong>{template.display_name}</strong>
        <small>{template.description}</small>
        <span className="template-tags">{template.recommended_experience.slice(0, 4).join(' · ')}</span>
      </button>)}
      {!showAll && templates.length > 6 && <button type="button" className="quiet" disabled={busyAll} onClick={() => setShowAll(true)}>查看更多</button>}
    </div>}
    {entry === 'ai' && <div className="world-idea">
      <textarea aria-label="世界灵感" value={idea} maxLength={500} onChange={event => setIdea(event.target.value)} placeholder="例如：有点像魔法学校，但更黑暗，人物关系复杂" />
      <div className="world-chips">
        {chips.map(chip => <button key={chip.id} type="button" className={picked.includes(chip.id) ? 'world-chip picked' : 'world-chip'} disabled={busyAll} onClick={() => setPicked(current => current.includes(chip.id) ? current.filter(id => id !== chip.id) : [...current, chip.id])}>{chip.label}</button>)}
        <button type="button" className="quiet" disabled={busyAll} onClick={() => setSeed(seed + 1)}>🎲 换一批</button>
      </div>
      <div className="button-row compact">
        <button type="button" disabled={busyAll} onClick={() => void call({ idea: idea.trim(), picked, inspiration_seed: seed })}>看看会是怎样的世界</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => void call({ picked, inspiration_seed: seed })}>我什么都没想好</button>
      </div>
    </div>}
    {entry === 'custom' && <div className="world-idea">
      <textarea aria-label="自己描述世界" value={custom} maxLength={12000} onChange={event => setCustom(event.target.value)} placeholder="例如：现代城市背景，以社会关系、学习和职业为核心。玩家刚刚搬入一座陌生城市。" />
      <div className="button-row compact"><button type="button" disabled={busyAll || !custom.trim()} onClick={() => onCustom(custom.trim())}>用这段描述创建</button></div>
    </div>}
    {preview && <article className="world-preview">
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
      {editing ? <div className="world-edit">
        <textarea aria-label="调整这个世界" value={editText} maxLength={400} onChange={event => setEditText(event.target.value)} placeholder="例如：危险程度低一点 / 我不想当学生，我想当老师 / NPC 多一点" />
        <div className="button-row compact">
          <button type="button" disabled={busyAll || !editText.trim()} onClick={() => void call({ preview_id: preview.preview_id, modify: editText.trim(), preview_session: preview.flow_id, inspiration_seed: seed })}>改好了</button>
          <button type="button" className="quiet" disabled={busyAll} onClick={() => setEditing(false)}>取消调整</button>
        </div>
      </div> : <div className="preview-actions">
        <button type="button" className="primary" disabled={busyAll} onClick={() => void start()}>开始这个世界</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => { setEditing(true); setEditText(''); }}>调整</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => void another()}>换一个</button>
      </div>}
    </article>}
    {note && <p className="world-error" role="alert">{note}</p>}
  </section>;
}

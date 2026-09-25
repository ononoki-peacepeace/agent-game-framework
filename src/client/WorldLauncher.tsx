import { useEffect, useState } from 'react';
import { request } from './api.js';
import type { PublicView } from '../shared/contracts.js';
type TemplateSummary = { id: string; display_name: string; description: string; recommended_experience: string[]; inspiration: string[] };
type Preview = {
  source: { kind: string; id?: string }; title: string; one_liner: string; era: string; player_role: string;
  initial_scope: string; danger: string; supernatural: string; npc_density: string;
  experiences: string[]; special_rules: string[]; recommended_modules: string[];
};
type PreviewResponse = { preview_id: string; preview: Preview; description: string; blank: boolean; inspiration: string[] };
const dangerLabel: Record<string, string> = { low: '低', medium: '中等', high: '高' };
const supernaturalLabel: Record<string, string> = { none: '没有', subtle: '轻微隐秘', open: '公开存在' };
const densityLabel: Record<string, string> = { low: '少', medium: '中等', high: '多' };
/**
 * New world entry: templates, an idea box that can be answered with "我什么都没想好", and a preview that must be
 * confirmed before anything is created. No giant form, no internals — the draft fields are all experience-level.
 */
export function WorldLauncher({ busy, onCreated, onCustom }: { busy: boolean; onCreated: (view: PublicView) => void; onCustom: (description: string) => void }) {
  const [tab, setTab] = useState<'templates' | 'idea'>('templates');
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [idea, setIdea] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const [seed, setSeed] = useState(0);
  useEffect(() => { void (async () => { try { setTemplates(await request<TemplateSummary[]>('world/templates')); } catch { /* the launcher stays usable without the list */ } })(); }, []);
  const makePreview = async (body: Record<string, unknown>) => {
    setPending(true); setNote('');
    try { setPreview(await request<PreviewResponse>('world/preview', body)); }
    catch (e) { setNote((e as Error).message); }
    finally { setPending(false); }
  };
  const confirm = async () => {
    if (!preview) return;
    setPending(true);
    try { onCreated(await request<PublicView>('world/confirm', { preview_id: preview.preview_id })); }
    catch (e) { setNote((e as Error).message); }
    finally { setPending(false); }
  };
  const busyAll = busy || pending;
  const ideaBody = () => (idea.trim() ? { idea: idea.trim() } : {});
  return <section className="world-launcher">
    <div className="button-row compact">
      <button type="button" className={tab === 'templates' ? '' : 'quiet'} onClick={() => setTab('templates')}>从模板开始</button>
      <button type="button" className={tab === 'idea' ? '' : 'quiet'} onClick={() => setTab('idea')}>让 AI 帮我想</button>
    </div>
    {tab === 'templates' && <div className="template-grid">
      {templates.map(template => <button key={template.id} type="button" className="template-card" disabled={busyAll} onClick={() => void makePreview({ template_id: template.id })}>
        <strong>{template.display_name}</strong><small>{template.description}</small>
      </button>)}
    </div>}
    {tab === 'idea' && <div className="idea-box">
      <textarea aria-label="世界灵感" value={idea} maxLength={500} onChange={event => setIdea(event.target.value)} placeholder="例如：有点像魔法学校，但更黑暗，人物关系复杂" />
      <div className="button-row compact">
        <button type="button" disabled={busyAll || !idea.trim()} onClick={() => void makePreview(ideaBody())}>生成预览</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => void makePreview({ variant: seed })}>我什么都没想好</button>
      </div>
      <div className="inspiration-row">
        {(preview?.inspiration ?? []).slice(0, 6).map(line => <span key={line} className="inspiration-chip">{line}</span>)}
        <button type="button" className="quiet" disabled={busyAll} onClick={() => { const next = seed + 1; setSeed(next); void makePreview({ ...ideaBody(), inspiration_seed: next }); }}>🎲 换一批</button>
      </div>
    </div>}
    {preview && <article className="world-preview">
      <h3>{preview.preview.title}</h3>
      <p>{preview.preview.one_liner}</p>
      <ul>
        <li>时代：{preview.preview.era}</li>
        <li>初始地点：{preview.preview.initial_scope}</li>
        <li>你的身份：{preview.preview.player_role}</li>
        <li>危险程度：{dangerLabel[preview.preview.danger] ?? preview.preview.danger}</li>
        <li>超自然：{supernaturalLabel[preview.preview.supernatural] ?? preview.preview.supernatural}</li>
        <li>NPC 密度：{densityLabel[preview.preview.npc_density] ?? preview.preview.npc_density}</li>
        <li>主要体验：{preview.preview.experiences.join('、')}</li>
        {preview.preview.special_rules.length > 0 && <li>特殊规则：{preview.preview.special_rules.join('；')}</li>}
        {preview.preview.recommended_modules.length > 0 && <li>推荐功能：{preview.preview.recommended_modules.join('、')}</li>}
      </ul>
      <div className="button-row compact">
        <button type="button" disabled={busyAll} onClick={() => void confirm()}>开始</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => { const next = seed + 1; setSeed(next); void makePreview({ ...ideaBody(), variant: next, inspiration_seed: next }); }}>换一个</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => void makePreview({ ...(preview.preview.source.id ? { template_id: preview.preview.source.id } : ideaBody()), inspiration_seed: seed + 2 })}>重新生成</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => onCustom(preview.description)}>修改</button>
      </div>
    </article>}
    {note && <p role="alert">{note}</p>}
  </section>;
}

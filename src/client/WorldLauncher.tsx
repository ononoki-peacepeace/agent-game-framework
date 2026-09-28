import { useEffect, useState } from 'react';
import { request } from './api.js';
import type { PublicView } from '../shared/contracts.js';
import './world.css';
import './world-v2.css';

type TemplateSummary = { id: string; display_name: string; description: string; recommended_experience: string[]; inspiration: string[] };
type Chip = { id: string; label: string; dimension: string; picked?: boolean };
type Preview = {
  source: { kind: string; id?: string }; title: string; one_liner: string; era: string; player_role: string;
  initial_scope: string; danger: string; supernatural: string; npc_density: string;
  experiences: string[]; special_rules: string[]; recommended_modules: string[];
};
type PreviewResponse = { preview_id: string; flow_id: string; category?: string | null; preview: Preview; description: string; blank: boolean; signature: string; picks: string[]; features: string[]; chips: Chip[];life_horizon_suggestion?:CreationRoleplayConfig['life_horizon'] };
export type CreationRoleplayConfig={version:1;constitution_version:1;death_policy:'narrative_standard';narrative_mode:'minimal'|'standard'|'story_focused';narrative_scale:'short'|'seasonal'|'life_chapter'|'life_epic'|'open_ended';major_arc_soft_cap:3;major_open_loop_soft_cap:5;life_horizon:{kind:'species_normal'|'custom'|'ai_suggested'|'open_ended'|'immortal';target_age_min:number|null;target_age_max:number|null;basis:string}};
type View = 'home' | 'templates' | 'ai' | 'custom' | 'preview' | 'editing';
const dangerLabel: Record<string, string> = { low: '低危险', medium: '中等危险', high: '高危险' };
const supernaturalLabel: Record<string, string> = { none: '无超自然', subtle: '轻微隐藏异常', open: '超自然公开' };
const densityLabel: Record<string, string> = { low: 'NPC 较少', medium: 'NPC 适中', high: 'NPC 很多' };
const viewTitles: Record<Exclude<View, 'home'>, string> = { templates: '从模板开始', ai: '让 AI 帮我想', custom: '自己创建', preview: '这个世界', editing: '调整这个世界' };
/**
 * Three strictly separated entries (templates / AI idea / custom), then a preview card. Only "开始这个世界"
 * creates a world; 调整 and 换一个 never do. Each entry owns its own screen, so nothing is mixed together.
 */
export function WorldLauncher({ busy, onCreated, onCustom, promptName, onImportPrompt, onRemovePrompt }: { busy: boolean; onCreated: (view: PublicView) => void; onCustom: (description: string,config:CreationRoleplayConfig) => void; promptName?: string; onImportPrompt?: () => void; onRemovePrompt?: () => void }) {
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
  const [horizon,setHorizon]=useState<CreationRoleplayConfig['life_horizon']['kind']>('species_normal');
  const [horizonAge,setHorizonAge]=useState(90);
  const [scale,setScale]=useState<CreationRoleplayConfig['narrative_scale']>('seasonal');
  const [narrativeMode,setNarrativeMode]=useState<CreationRoleplayConfig['narrative_mode']>('standard');
  const roleplayConfig=():CreationRoleplayConfig=>({version:1,constitution_version:1,death_policy:'narrative_standard',narrative_mode:narrativeMode,narrative_scale:scale,major_arc_soft_cap:3,major_open_loop_soft_cap:5,life_horizon:horizon==='open_ended'||horizon==='immortal'?{kind:horizon,target_age_min:null,target_age_max:null,basis:horizon==='immortal'?'世界允许的不老/永生角色；仍可完成阶段性篇章':'不预设整个人生终点；仍可完成阶段性篇章'}:horizon==='custom'?{kind:horizon,target_age_min:horizonAge,target_age_max:horizonAge,basis:'玩家自定义的软性寿命参考，不是死亡年龄'}:horizon==='ai_suggested'?preview?.life_horizon_suggestion??{kind:horizon,target_age_min:70,target_age_max:100,basis:'依据当前世界与常见人类寿命给出的初始建议，可被世界中的真实变化超越'}:{kind:horizon,target_age_min:70,target_age_max:100,basis:'按种族正常寿命的软性范围；未提供种族资料时使用人类参考'}});
  useEffect(() => { void (async () => { try { setTemplates(await request<TemplateSummary[]>('world/templates')); } catch { /* entries stay usable */ } })(); }, []);
  const refreshChips = async (nextSeed: number, exclude: string[] = [], locked: string[] = picked) => {
    try {
      const query = [`seed=${nextSeed}`, `exclude=${encodeURIComponent(exclude.join(','))}`, `picked=${encodeURIComponent(locked.join(','))}`].join('&');
      const result = await request<{ chips: Chip[] }>(`world/inspiration?${query}`);
      setChips(result.chips);
    } catch { /* chips are optional */ }
  };
  // Only the first load is automatic: a later 换一批 refreshes explicitly, otherwise the seed effect would race
  // it and drop the chips the player had locked in.
  useEffect(() => { void refreshChips(seed, [], []); }, []);

  const rewriteChips = () => {
    const next = seed + 1; setSeed(next);
    void refreshChips(next, chips.filter(chip => !chip.picked).map(chip => chip.id), picked);
  };
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
    void call('another', { another: true, preview_id: preview?.preview_id, preview_session: preview?.flow_id, picked, inspiration_seed: next, ...(preview?.category ? { template_id: preview.category === 'space' ? 'space_colony' : preview.category === 'academy' ? 'arcane_academy' : preview.category === 'city' ? 'modern_city' : preview.category === 'town' ? 'small_town' : preview.category === 'school' ? 'school_life' : preview.category === 'crime' ? 'crime_city' : preview.category === 'medieval' ? 'medieval_adventure' : 'post_apocalypse' } : {}), ...(idea.trim() ? { idea: idea.trim() } : {}) });
  };
  const start = async () => {
    if (!preview) return;
    setPending('confirm');
    try { onCreated(await request<PublicView>('world/confirm', { preview_id: preview.preview_id,roleplay_config:roleplayConfig() })); }
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
        {chips.map(chip => <button key={chip.id} type="button" aria-pressed={picked.includes(chip.id)} className={picked.includes(chip.id) ? 'world-chip picked' : 'world-chip'} disabled={busyAll} onClick={() => setPicked(current => current.includes(chip.id) ? current.filter(id => id !== chip.id) : [...current, chip.id])}>{chip.label}</button>)}
        <button type="button" className="quiet" disabled={busyAll} onClick={rewriteChips}>🎲 换一批</button>
      </div>
      <div className="button-row compact">
        <button type="button" disabled={busyAll} onClick={() => void call('preview', { idea: idea.trim(), picked, inspiration_seed: seed })}>看看会是怎样的世界</button>
        <button type="button" className="quiet" disabled={busyAll} onClick={() => void call('preview', { picked, inspiration_seed: seed })}>我什么都没想好</button>
      </div>
    </div>}
    {view === 'custom' && <div className="world-idea">
      <textarea aria-label="自己描述世界" value={custom} maxLength={12000} onChange={event => setCustom(event.target.value)} placeholder="例如：现代城市背景，以社会关系、学习和职业为核心。玩家刚刚搬入一座陌生城市。" />
      {onImportPrompt&&<div className="prompt-slot"><div><strong>{promptName??'可选：导入 Prompt'}</strong><small>{promptName?promptName:'支持 .txt / .md / Prompt Profile .json；它会随新世界保存。'}</small></div><div className="button-row compact"><button type="button" className="quiet" disabled={busyAll} onClick={()=>onImportPrompt()}>导入提示词</button>{promptName&&<button type="button" className="quiet" disabled={busyAll} onClick={()=>onRemovePrompt?.()}>移除</button>}</div></div>}
      <CreationPreferences horizon={horizon} setHorizon={setHorizon} horizonAge={horizonAge} setHorizonAge={setHorizonAge} scale={scale} setScale={setScale} mode={narrativeMode} setMode={setNarrativeMode}/>
      <div className="button-row compact"><button type="button" disabled={busyAll || !custom.trim()} onClick={() => onCustom(custom.trim(),roleplayConfig())}>用这段描述创建</button></div>

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
      <CreationPreferences horizon={horizon} setHorizon={setHorizon} horizonAge={horizonAge} setHorizonAge={setHorizonAge} scale={scale} setScale={setScale} mode={narrativeMode} setMode={setNarrativeMode}/>
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

function CreationPreferences({horizon,setHorizon,horizonAge,setHorizonAge,scale,setScale,mode,setMode}:{horizon:CreationRoleplayConfig['life_horizon']['kind'];setHorizon:(value:CreationRoleplayConfig['life_horizon']['kind'])=>void;horizonAge:number;setHorizonAge:(value:number)=>void;scale:CreationRoleplayConfig['narrative_scale'];setScale:(value:CreationRoleplayConfig['narrative_scale'])=>void;mode:CreationRoleplayConfig['narrative_mode'];setMode:(value:CreationRoleplayConfig['narrative_mode'])=>void}){
 return <fieldset className="creation-roleplay"><legend>人生与故事</legend><label>人生长度<select aria-label="人生长度" value={horizon} onChange={event=>setHorizon(event.target.value as typeof horizon)}><option value="species_normal">按种族正常寿命</option><option value="ai_suggested">AI 建议（70～100 年参考）</option><option value="custom">自定义参考</option><option value="open_ended">Open Ended</option><option value="immortal">Immortal</option></select></label>{horizon==='custom'&&<label>参考年龄<input aria-label="自定义人生参考年龄" type="number" min="1" max="1000000" value={horizonAge} onChange={event=>setHorizonAge(Math.max(1,Number(event.target.value)||1))}/></label>}<label>故事尺度<select aria-label="故事尺度" value={scale} onChange={event=>setScale(event.target.value as typeof scale)}><option value="short">短篇</option><option value="seasonal">1～3 年</option><option value="life_chapter">人生篇章</option><option value="life_epic">一生史诗</option><option value="open_ended">开放式</option></select></label><label>叙事模式<select aria-label="叙事模式" value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="minimal">轻叙事</option><option value="standard">标准</option><option value="story_focused">故事导向</option></select></label><small>人生长度是节奏参考，不是死亡日期；安静生活和失败结局都有效。</small></fieldset>;
}

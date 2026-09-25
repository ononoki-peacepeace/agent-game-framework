import type {Entity,PublicLocation} from './contracts.js';

// Display resolution is reference-driven, not shape-driven.
// Only fields that explicitly name an object enter a resolver; schema keys, metadata keys,
// enum values, equipment slots, provider diagnostics and state fields are opaque data.
export type ReferenceKind = 'entity' | 'item' | 'location' | 'quest' | 'activity';
export type DisplayMode = 'narrative' | 'diagnostic';
export interface UnresolvedReport { kind: ReferenceKind; key: string; value: string; path: string; scope: 'reference' | 'prose' }
export type DisplayReporter = (report: UnresolvedReport) => void;

let displayReporter: DisplayReporter | null = null;
export function setDisplayReporter(next: DisplayReporter | null) { displayReporter = next; }
export function currentDisplayReporter() { return displayReporter; }
function reportUnresolved(entry: UnresolvedReport) {
  if (displayReporter) displayReporter(entry);
  else console.warn(`Unresolved display identifier: ${entry.value} (${entry.kind} ${entry.key} at ${entry.path})`);
}

// Field names that carry a canonical reference. Everything else stays untouched data.
export const referenceFields: Record<string, ReferenceKind> = {
  entity_id:'entity', entity_ids:'entity', actor_id:'entity', target_id:'entity', target_ids:'entity',
  speaker_id:'entity', participant_ids:'entity', participants:'entity', candidate_ids:'entity',
  opponent_id:'entity', npc_id:'entity', character_id:'entity', relationship_target_id:'entity',
  location_id:'location', location_ids:'location', parent_id:'location', destination_id:'location',
  item_id:'item', item_ids:'item',
  quest_id:'quest', quest_ids:'quest', task_id:'quest', task_ids:'quest', opportunity_id:'quest', opportunity_ids:'quest',
  activity_id:'activity', activity_ids:'activity',
};

// Narrative fields: player-visible prose that may mention an internal id instead of a display name.
export const proseFields = new Set([
  'description','summary','narrative','dialogue','choices','intent','reason',
  'interrupt_reason','last_interrupt','next_arrangement','pattern','note','notes','source','role','message',
  'notices','calendar_issue','time_label','known_state','current_relationship','objectives',
  'objective','effect','effects','personality','scenario',
]);
// Canonical labels and plan clarifications: already display text or technical guidance.
// Ids are localized, but nothing is masked and nothing is reported — never a bare "未知对象".
export const labelFields = new Set(['name','title','label','clarification']);

export interface DisplayIndex {
  entity: Map<string, string>; item: Map<string, string>; location: Map<string, string>;
  quest: Map<string, string>; activity: Map<string, string>; names: Map<string, string>;
}
export interface DisplayOptions { index?: DisplayIndex; activities?: { id: string; label: string }[]; path?: string; mode?: DisplayMode }

function titleOf(id: string, entry: { title?: string; metadata?: Record<string, unknown> }) {
  const meta = entry.metadata ?? {};
  for (const key of ['title','name','task','type']) { const value = meta[key]; if (typeof value === 'string' && value.trim()) return value.trim(); }
  return String(entry.title ?? '').trim() || id;
}

export function buildDisplayIndex(entities: Entity[] = [], locations: PublicLocation[] = [], activities: { id: string; label: string }[] = []): DisplayIndex {
  const entity = new Map<string, string>(), item = new Map<string, string>(), location = new Map<string, string>();
  const quest = new Map<string, string>(), activity = new Map<string, string>();
  for (const e of entities) {
    entity.set(e.id, String(e.components.identity?.name ?? '未知人物'));
    if (e.components.item) item.set(e.id, String(e.components.identity?.name ?? e.id));
    for (const key of ['quests','opportunities']) {
      const entries = (e.components[key]?.entries ?? {}) as Record<string, { title?: string; metadata?: Record<string, unknown> }>;
      for (const [id, entry] of Object.entries(entries)) if (!quest.has(id)) quest.set(id, titleOf(id, entry));
    }
  }
  for (const l of locations) location.set(l.id, l.name);
  for (const a of activities) activity.set(a.id, a.label);
  return { entity, item, location, quest, activity, names: new Map([...item, ...location, ...quest, ...activity, ...entity]) };
}

const idShape = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g;
function parsedJson(value: string) {
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
// Machine payloads (JSON documents, JSON fragments, key=value dumps) are data, not narration:
// their own keys and enum values must never be read as entity references.
function isMachineData(value: string) {
  const text = value.trim();
  if (!text) return false;
  if (text.startsWith('{') || text.startsWith('[')) return true;
  if (/"[^"]{0,60}"\s*:/.test(text)) return true;
  if (/(?:^|[；;\n])\s*[A-Za-z_][A-Za-z0-9_]*\s*[=:]/.test(text)) return true;
  // Provider / scheduler diagnostics such as "DeepSeek 响应未完成: max_output_tokens".
  return /\b(?:max_output_tokens|finish_reason|incomplete_details|content_filter|rate_limit|provider|timeout)\b/.test(text);
}

function resolveReference(index: DisplayIndex, kind: ReferenceKind, id: string, key: string, path: string, seen: Set<string>) {
  // Structured data keeps canonical ids so the UI can keep looking objects up by id.
  if (!id || index[kind].has(id)) return id;
  const fingerprint = `reference|${kind}|${key}|${id}|${path}`;
  if (!seen.has(fingerprint)) { seen.add(fingerprint); reportUnresolved({ kind, key, value: id, path, scope: 'reference' }); }
  return '未知对象';
}

function localize(value: string, index: DisplayIndex) {
  let text = value;
  for (const [id, name] of [...index.names].sort((a, b) => b[0].length - a[0].length)) {
    if (!id || name === id) continue;
    text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'), () => name);
  }
  return text;
}
function renderData(value: string, index: DisplayIndex, path: string, seen: Set<string>, mode: DisplayMode) {
  const structured = parsedJson(value);
  return structured === undefined || structured === null || typeof structured !== 'object' ? value : JSON.stringify(renderStructured(structured, index, path, seen, mode));
}
function renderLabel(value: string, index: DisplayIndex, path: string, seen: Set<string>, mode: DisplayMode) {
  return isMachineData(value) ? renderData(value, index, path, seen, mode) : localize(value, index);
}
function renderProse(value: string, index: DisplayIndex, path: string, seen: Set<string>, mode: DisplayMode) {
  if (isMachineData(value)) return renderData(value, index, path, seen, mode);
  const text = localize(value, index);
  // Diagnostic text keeps raw technical tokens (max_output_tokens, provider reasons) intact.
  if (mode === 'diagnostic') return text;
  return text.replace(idShape, (token) => {
    const fingerprint = `prose|${token}|${path}`;
    if (!seen.has(fingerprint)) { seen.add(fingerprint); reportUnresolved({ kind: 'entity', key: 'text', value: token, path, scope: 'prose' }); }
    return '未知对象';
  });
}

function renderStructured(value: unknown, index: DisplayIndex, path: string, seen: Set<string>, mode: DisplayMode): unknown {
  if (typeof value === 'string') return renderStructuredField(value, '', index, path, seen, mode);
  if (Array.isArray(value)) return value.map((entry, i) => renderStructured(entry, index, `${path}[${i}]`, seen, mode));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderStructuredField(entry, key, index, `${path}.${key}`, seen, mode)]));
  return value;
}
function renderStructuredField(value: unknown, key: string, index: DisplayIndex, path: string, seen: Set<string>, mode: DisplayMode): unknown {
  if (typeof value === 'string') {
    const kind = referenceFields[key];
    if (kind) return resolveReference(index, kind, value, key, path, seen);
    if (proseFields.has(key)) return renderProse(value, index, path, seen, mode);
    if (labelFields.has(key)) return renderLabel(value, index, path, seen, mode);
    return isMachineData(value) ? renderData(value, index, path, seen, mode) : value;
  }
  if (Array.isArray(value)) return value.map((entry, i) => renderStructuredField(entry, key, index, `${path}[${i}]`, seen, mode));
  if (value && typeof value === 'object') return renderStructured(value, index, path, seen, mode);
  return value;
}

export function displayText(value: string, entities: Entity[] = [], locations: PublicLocation[] = [], options: DisplayOptions = {}) {
  const index = options.index ?? buildDisplayIndex(entities, locations, options.activities ?? []);
  return renderProse(value, index, options.path ?? 'text', new Set<string>(), options.mode ?? 'narrative');
}

// Technical / diagnostic strings (job messages, provider errors, scheduler reasons) keep their raw tokens.
export function displayDiagnostic(value: string, entities: Entity[] = [], locations: PublicLocation[] = [], options: DisplayOptions = {}) {
  return displayText(value, entities, locations, { ...options, mode: 'diagnostic' });
}

export function resolvePresentation<T>(input: T, entities: Entity[], locations: PublicLocation[], options: DisplayOptions = {}): T {
  const index = options.index ?? buildDisplayIndex(entities, locations, options.activities ?? []), seen = new Set<string>(), mode = options.mode ?? 'narrative';
  const visit = (value: unknown, key: string, path: string): unknown => {
    if (typeof value === 'string') {
      const kind = referenceFields[key];
      if (kind) return resolveReference(index, kind, value, key, path, seen);
      if (proseFields.has(key)) return renderProse(value, index, path, seen, mode);
      if (labelFields.has(key)) return renderLabel(value, index, path, seen, mode);
      return isMachineData(value) ? renderData(value, index, path, seen, mode) : value;
    }
    if (Array.isArray(value)) return value.map((entry, i) => visit(entry, key, `${path}[${i}]`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, visit(entry, name, `${path}.${name}`)]));
    return value;
  };
  return visit(input, '', '$') as T;
}

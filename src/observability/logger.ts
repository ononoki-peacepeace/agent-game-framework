import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Local observability. Structured JSONL logs stay on disk under data/logs and never leave the machine.
// Secrets (API keys, Authorization headers, tokens, passwords) are redacted before anything is written.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const logLevels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export function isLogLevel(value: unknown): value is LogLevel { return typeof value === 'string' && Object.hasOwn(logLevels, value); }

export interface LogEntry {
  timestamp: string; level: LogLevel; event: string; module: string;
  trace_id: string | null; request_id: string | null; job_id: string | null;
  revision: number | null; duration_ms: number | null; metadata: Record<string, unknown>;
}
export interface LogFields {
  module?: string; trace_id?: string | null; request_id?: string | null; job_id?: string | null;
  revision?: number | null; duration_ms?: number | null; metadata?: Record<string, unknown>;
}
export interface LogQuery { level?: LogLevel; module?: string; event?: string; eventPrefix?: string; trace_id?: string; job_id?: string; limit?: number }
export interface TraceSpanSummary { name: string; duration_ms: number }
export interface TraceSummary {
  trace_id: string; module: string; started_at: string; total_ms: number;
  request_id: string | null; job_id: string | null; spans: TraceSpanSummary[];
}
export interface LoggerOptions {
  directory?: string | null; level?: LogLevel; fileLevel?: LogLevel; maxBytes?: number;
  keepFiles?: number; history?: number; echo?: boolean; clock?: () => Date;
}

// Token *usage* fields (input_tokens/output_tokens) stay visible; credential-shaped keys never are.
const secretKey = /^(?:api[_-]?key|authorization|auth|secret|client[_-]?secret|password|passwd|credential|credentials|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|session[_-]?token|token)$/i;

const secretText = /\b(?:sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,})\b/g;
const maxString = 512, maxDepth = 4, maxKeys = 40, maxItems = 30;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > maxDepth) return '[truncated]';
  if (typeof value === 'string') { const masked = value.replace(secretText, '[redacted]'); return masked.length > maxString ? `${masked.slice(0, maxString)}…` : masked; }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, maxItems).map(entry => redactValue(entry, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, maxKeys).map(([key, entry]) => [key, secretKey.test(key) ? '[redacted]' : redactValue(entry, depth + 1)]));
}
export function redactFields(fields: Record<string, unknown>) { return redactValue(fields) as Record<string, unknown>; }
export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function round(value: number) { return Math.round(value * 1000) / 1000; }
export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class StructuredLogger {
  readonly directory: string | null;
  readonly fileLevel: LogLevel;
  readonly maxBytes: number;
  readonly keepFiles: number;
  readonly history: number;
  level: LogLevel;
  private echo: boolean;
  private clock: () => Date;
  private buffer: LogEntry[] = [];
  private pending: Promise<void> = Promise.resolve();
  private traceList: TraceSummary[] = [];
  private lastFailure: string | null = null;

  constructor(options: LoggerOptions = {}) {
    this.directory = options.directory ?? null;
    this.level = options.level ?? (isLogLevel(process.env.GAME_LOG_LEVEL) ? process.env.GAME_LOG_LEVEL : 'debug');
    this.fileLevel = options.fileLevel ?? this.level;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keepFiles = options.keepFiles ?? 10;
    this.history = options.history ?? 2000;
    this.echo = options.echo ?? false;
    this.clock = options.clock ?? (() => new Date());
  }
  setLevel(level: LogLevel) { this.level = level; }
  filePath(date = this.clock()) { return this.directory ? join(this.directory, `game-${dayKey(date)}.log`) : null; }
  get failure() { return this.lastFailure; }

  log(level: LogLevel, event: string, fields: LogFields = {}): LogEntry | null {
    if (logLevels[level] < logLevels[this.level]) return null;
    const entry: LogEntry = {
      timestamp: this.clock().toISOString(), level, event, module: fields.module ?? 'app',
      trace_id: fields.trace_id ?? null, request_id: fields.request_id ?? null, job_id: fields.job_id ?? null,
      revision: typeof fields.revision === 'number' ? fields.revision : null,
      duration_ms: typeof fields.duration_ms === 'number' ? round(fields.duration_ms) : null,
      metadata: redactValue(fields.metadata ?? {}) as Record<string, unknown>,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.history) this.buffer.splice(0, this.buffer.length - this.history);
    if (this.echo) (level === 'error' || level === 'warn' ? console.warn : console.log)(`${entry.timestamp} ${level.toUpperCase()} ${event}`, entry.metadata);
    if (this.directory && logLevels[level] >= logLevels[this.fileLevel]) this.enqueue(entry);
    return entry;
  }
  debug(event: string, fields?: LogFields) { return this.log('debug', event, fields); }
  info(event: string, fields?: LogFields) { return this.log('info', event, fields); }
  warn(event: string, fields?: LogFields) { return this.log('warn', event, fields); }
  error(event: string, fields?: LogFields) { return this.log('error', event, fields); }

  entries(query: LogQuery = {}) {
    const matched = this.buffer.filter(entry =>
      (!query.level || entry.level === query.level) &&
      (!query.module || entry.module === query.module) &&
      (!query.event || entry.event === query.event) &&
      (!query.eventPrefix || entry.event.startsWith(query.eventPrefix)) &&
      (!query.trace_id || entry.trace_id === query.trace_id) &&
      (!query.job_id || entry.job_id === query.job_id));
    const limit = Math.min(Math.max(query.limit ?? 200, 1), this.history);
    return matched.slice(-limit).map(entry => structuredClone(entry));
  }
  recordTrace(summary: TraceSummary) {
    this.traceList = [...this.traceList.filter(entry => entry.trace_id !== summary.trace_id), structuredClone(summary)].slice(-50);
  }
  traces(limit = 20) { return this.traceList.slice(-Math.max(limit, 1)).reverse(); }
  flush() { return this.pending; }

  // Restart-friendly viewer source: the newest log file on disk when the in-memory buffer is cold.
  async readHistory(limit = 200): Promise<LogEntry[]> {
    if (!this.directory) return [];
    try {
      const files = (await readdir(this.directory)).filter(name => /^game-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name)).sort();
      const newest = files.at(-1);
      if (!newest) return [];
      const lines = (await readFile(join(this.directory, newest), 'utf8')).split('\n').filter(Boolean).slice(-Math.max(limit, 1));
      return lines.flatMap(line => { try { return [JSON.parse(line) as LogEntry]; } catch { return []; } });
    } catch { return []; }
  }

  private enqueue(entry: LogEntry) {
    this.pending = this.pending.then(() => this.append(entry)).catch(error => { this.lastFailure = errorText(error); });
  }
  private async append(entry: LogEntry) {
    const path = await this.resolveFile(entry.timestamp);
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
  private async resolveFile(timestamp: string) {
    const directory = this.directory!;
    await mkdir(directory, { recursive: true });
    const base = `game-${dayKey(new Date(timestamp))}`, plain = join(directory, `${base}.log`);
    let path = plain;
    try {
      if ((await stat(plain)).size >= this.maxBytes) {
        for (let index = 1; ; index++) {
          const candidate = join(directory, `${base}.${index}.log`);
          try { await stat(candidate); } catch { path = candidate; break; }
        }
        await this.prune(directory);
      }
    } catch { /* first write of the day */ }
    return path;
  }
  // Rotation only ever touches files this logger created inside its own log directory.
  private async prune(directory: string) {
    const files = (await readdir(directory)).filter(name => /^game-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name));
    if (files.length <= this.keepFiles) return;
    const dated = await Promise.all(files.map(async name => ({ name, mtime: (await stat(join(directory, name))).mtimeMs })));
    for (const entry of dated.sort((a, b) => b.mtime - a.mtime).slice(this.keepFiles)) await rm(join(directory, entry.name), { force: true });
  }
}

let defaultLogger = new StructuredLogger({ directory: null, level: isLogLevel(process.env.GAME_LOG_LEVEL) ? process.env.GAME_LOG_LEVEL : 'debug' });
export function getLogger() { return defaultLogger; }
export function configureDefaultLogger(logger: StructuredLogger) { defaultLogger = logger; return logger; }

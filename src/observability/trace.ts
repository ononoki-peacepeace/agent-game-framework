import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger, type LogFields, type LogLevel, type StructuredLogger, type TraceSummary } from './logger.js';

// One trace_id per player action, world directive, routine job or AI operation.
// Spans make the pipeline visible: intent -> scheduler -> local/AI -> rng -> validation -> save -> projection.
export function newTraceId() { return `tr_${randomBytes(6).toString('hex')}`; }
export interface Span { name: string; duration_ms: number; metadata: Record<string, unknown> }
export interface SpanHandle { end: (extra?: Record<string, unknown>) => number }
export interface TraceInit {
  module: string; logger?: StructuredLogger; request_id?: string | null; job_id?: string | null;
  game_id?: string | null; revision?: number | null;
}
function round(value: number) { return Math.round(value * 1000) / 1000; }

export class Trace {
  readonly trace_id = newTraceId();
  readonly started_at = new Date().toISOString();
  private started = performance.now();
  private spanList: Span[] = [];
  constructor(
    readonly module: string, readonly logger: StructuredLogger,
    readonly request_id: string | null = null, readonly job_id: string | null = null,
    readonly game_id: string | null = null, readonly revision: number | null = null,
  ) {}
  span(name: string, metadata: Record<string, unknown> = {}): SpanHandle {
    const start = performance.now();
    return { end: (extra) => {
      const duration_ms = round(performance.now() - start);
      this.spanList.push({ name, duration_ms, metadata: { ...metadata, ...(extra ?? {}) } });
      this.publish();
      return duration_ms;
    } };
  }
  async measure<T>(name: string, fn: () => Promise<T>, metadata: Record<string, unknown> = {}): Promise<T> {
    const handle = this.span(name, metadata);
    try { return await fn(); } finally { handle.end(); }
  }
  debug(event: string, fields: LogFields = {}) { return this.log('debug', event, fields); }
  info(event: string, fields: LogFields = {}) { return this.log('info', event, fields); }
  warn(event: string, fields: LogFields = {}) { return this.log('warn', event, fields); }
  error(event: string, fields: LogFields = {}) { return this.log('error', event, fields); }
  log(level: LogLevel, event: string, fields: LogFields = {}) {
    return this.logger.log(level, event, {
      module: fields.module ?? this.module, trace_id: this.trace_id, request_id: this.request_id,
      job_id: this.job_id, revision: fields.revision ?? this.revision,
      duration_ms: fields.duration_ms ?? null, metadata: fields.metadata,
    });
  }
  spans() { return structuredClone(this.spanList); }
  total_ms() { return round(performance.now() - this.started); }
  snapshot(): TraceSummary {
    return {
      trace_id: this.trace_id, module: this.module, started_at: this.started_at, total_ms: this.total_ms(),
      request_id: this.request_id, job_id: this.job_id,
      spans: this.spanList.map(span => ({ name: span.name, duration_ms: span.duration_ms })),
    };
  }
  private publish() { this.logger.recordTrace(this.snapshot()); }
}

const storage = new AsyncLocalStorage<Trace>();
export function startTrace(init: TraceInit) {
  return new Trace(init.module, init.logger ?? getLogger(), init.request_id ?? null, init.job_id ?? null, init.game_id ?? null, init.revision ?? null);
}
export function runWithTrace<T>(trace: Trace, run: () => T): T { return storage.run(trace, run); }
export function currentTrace() { return storage.getStore(); }
export function traceSpan(name: string, metadata: Record<string, unknown> = {}): SpanHandle {
  return currentTrace()?.span(name, metadata) ?? { end: () => 0 };
}

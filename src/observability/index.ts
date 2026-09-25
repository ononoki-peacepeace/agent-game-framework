import { getLogger, type LogFields, type LogLevel } from './logger.js';
import { currentTrace } from './trace.js';
import type { UnresolvedReport } from '../shared/display.js';

export * from './logger.js';
export * from './trace.js';
export { summarizeSaveDiff } from './diff.js';

// Records an event against the current trace when one is active, otherwise against the default logger.
export function observe(level: LogLevel, event: string, fields: LogFields = {}) {
  const trace = currentTrace();
  return trace ? trace.log(level, event, fields) : getLogger().log(level, event, fields);
}

// The same unresolved reference is reported once per window: UI polling and log polling must not flood the log.
const unresolvedSeen = new Map<string, { first: number; count: number }>();
const unresolvedTtlMs = 5 * 60 * 1000;
export function reportDisplayUnresolved(report: UnresolvedReport) {
  const key = `${report.scope}|${report.kind}|${report.key}|${report.value}`, now = Date.now(), seen = unresolvedSeen.get(key);
  if (seen && now - seen.first < unresolvedTtlMs) { seen.count += 1; return null; }
  if (unresolvedSeen.size > 500) unresolvedSeen.clear();
  unresolvedSeen.set(key, { first: now, count: 1 });
  return observe('warn', 'display.unresolved', { module: 'display', metadata: { kind: report.kind, key: report.key, value: report.value, path: report.path, scope: report.scope, suppressed_since_last_report: seen ? seen.count : 0 } });
}

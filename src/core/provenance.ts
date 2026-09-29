/**
 * Creation provenance keeps *atomic* cells: every record is one short statement the player may be quoted
 * verbatim, and the array itself is bounded. A single over-long sentence (a long player premise, an imported
 * document) must therefore never fail an entire world creation — it is deterministically split into several
 * records of the same kind, in order, without dropping a character.
 */
export const PROVENANCE_STATEMENT_LIMIT = 1000;
export const PROVENANCE_RECORD_MAX = 200;

/** Split text after each boundary character, keeping the delimiter attached to the text it ends. */
function segment(text: string, boundaries: RegExp): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!boundaries.test(text[index])) continue;
    parts.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/**
 * Deterministic, loss-free split: sentences first, then clauses, then a hard boundary as the last resort.
 * `chunks.join('')` always equals the input, so no information is truncated or reordered.
 */
export function atomicStatements(text: string, limit: number = PROVENANCE_STATEMENT_LIMIT): string[] {
  const value = String(text ?? '');
  if (!value.length) return [];
  if (value.length <= limit) return [value];
  const chunks: string[] = [];
  let buffer = '';
  const flush = () => { if (buffer.length) { chunks.push(buffer); buffer = ''; } };
  for (const sentence of segment(value, /[。！？；!?;\n]/)) {
    if (sentence.length <= limit) {
      if (buffer.length + sentence.length > limit) flush();
      buffer += sentence;
      continue;
    }
    flush();
    for (const clause of segment(sentence, /[，,、：: \t]/)) {
      if (clause.length > limit) {
        flush();
        for (let index = 0; index < clause.length; index += limit) chunks.push(clause.slice(index, index + limit));
        continue;
      }
      if (buffer.length + clause.length > limit) flush();
      buffer += clause;
    }
  }
  flush();
  return chunks;
}

/** Every record stays one atomic cell: the same kind/source, split only when the statement is too long. */
export function atomicProvenanceRecords<T extends { statement: string }>(records: T[], limit: number = PROVENANCE_STATEMENT_LIMIT): T[] {
  return records.flatMap(record => atomicStatements(record.statement, limit).map(statement => ({ ...record, statement })));
}

/** Normalise provenance at the single choke point every creation entry passes through. */
export function normalizeProvenance<P extends { records: { statement: string }[] }>(provenance: P, limit: number = PROVENANCE_STATEMENT_LIMIT): P {
  return { ...provenance, records: atomicProvenanceRecords(provenance.records, limit) };
}

/**
 * Provider-facing structured-output normalization.
 *
 * The canonical framework schemas stay exactly as they are (a world may legitimately have no map,
 * no shop, no inventory). Providers with a strict "every property must be required" rule cannot
 * express that with optional keys, so the outgoing JSON Schema is rewritten instead:
 *   optional property `T`  ->  `anyOf: [T, {type:'null'}]` and listed in `required`
 * and the framework parses a returned `null` back as "absent".
 */
type JsonObject = Record<string, unknown>;
const dropped = new Set(['$schema', 'default']);

function nullable(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const node = schema as JsonObject;
  if (node.type === 'null') return node;
  if (Array.isArray(node.type) && (node.type as string[]).includes('null')) return node;
  // Already nullable (zod emits anyOf[T, null]): keep the union but normalize the inner object.
  if (Array.isArray(node.anyOf) && (node.anyOf as JsonObject[]).some(entry => entry?.type === 'null')) return { ...node, anyOf: (node.anyOf as JsonObject[]).map(entry => normalizeNode(entry)) };

  return { anyOf: [normalizeNode(node), { type: 'null' }] };
}

function normalizeObject(node: JsonObject): JsonObject {
  const properties = node.properties as JsonObject;
  const previouslyRequired = new Set(Array.isArray(node.required) ? node.required as string[] : []);
  const out: JsonObject = { ...node };
  for (const key of dropped) delete out[key];
  const nextProperties: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) nextProperties[key] = previouslyRequired.has(key) ? normalizeNode(value as JsonObject) : nullable(value);
  out.properties = nextProperties;
  // Strict providers require the two lists to match exactly.
  out.required = Object.keys(nextProperties);
  out.additionalProperties = false;
  return out;
}

function normalizeNode(node: JsonObject): JsonObject {
  const out: JsonObject = { ...node };
  for (const key of dropped) delete out[key];
  if (out.properties && typeof out.properties === 'object') return normalizeObject(out);
  if (out.items) out.items = normalizeNode(out.items as JsonObject);
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(out[combinator])) out[combinator] = (out[combinator] as JsonObject[]).map(entry => normalizeNode(entry));
  if (out.additionalProperties && typeof out.additionalProperties === 'object') out.additionalProperties = normalizeNode(out.additionalProperties as JsonObject);
  return out;
}

export function normalizeStructuredSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  return normalizeNode(schema as JsonObject);
}

/** Every object node must list exactly its own properties in `required` (strict provider rule). */
export function schemaViolations(schema: unknown, path = '$', found: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return found;
  if (Array.isArray(schema)) { schema.forEach((entry, index) => schemaViolations(entry, `${path}[${index}]`, found)); return found; }
  const node = schema as JsonObject;
  if (node.properties && typeof node.properties === 'object') {
    const properties = Object.keys(node.properties as JsonObject).sort();
    const required = [...(Array.isArray(node.required) ? node.required as string[] : [])].sort();
    if (properties.join('|') !== required.join('|')) found.push(`${path}: properties=[${properties.join(',')}] required=[${required.join(',')}]`);
    if (node.additionalProperties !== false) found.push(`${path}: additionalProperties must be false`);
  }
  for (const [key, value] of Object.entries(node)) schemaViolations(value, `${path}.${key}`, found);
  return found;
}

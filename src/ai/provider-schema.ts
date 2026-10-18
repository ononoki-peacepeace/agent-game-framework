/**
 * Provider-facing structured-output normalization.
 *
 * The canonical framework schemas stay exactly as they are (a world may legitimately have no map,
 * no shop, no inventory). Providers with a strict "every property must be required" rule cannot
 * express that with optional keys, so the outgoing JSON Schema is rewritten instead:
 *   optional property `T`  ->  `anyOf: [T, {type:'null'}]` and listed in `required`
 * and the framework parses a returned `null` back as "absent".
 */
import {z} from 'zod';
type JsonObject = Record<string, unknown>;

/** Wire contracts describe what the model may supply, not Zod's parsed output.
 * Defaults make input optional even when the parsed output is required. Keeping
 * this distinction here avoids guessing field semantics from names or values.
 */
export function structuredInputSchema(schema:z.ZodType){
  return z.toJSONSchema(schema,{io:'input'});
}
export function parseProviderOutput<T>(schema:z.ZodType<T>,value:unknown):T{
  return schema.parse(normalizeProviderOptionals(value,structuredInputSchema(schema)));
}
/** Exact contract fields where provider null/omission means an empty collection, never a null-valued fact. */
const emptyCollections={
  narrator:['choices','context_actions','scene_beats','mechanical_claims','choice_semantics','item_claims','stable_locations','patches'],
  freeform:['facts','required_conditions'],
  freeformResolution:['stages','evidence_ids'],
} as const;
export function normalizeProviderCollections(role:'narrator'|'freeform',value:unknown):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const out={...(value as JsonObject)};
  for(const key of emptyCollections[role])if(out[key]==null)out[key]=[];
  if(role==='freeform'&&out.resolution&&typeof out.resolution==='object'&&!Array.isArray(out.resolution)){
    const resolution={...(out.resolution as JsonObject)};
    for(const key of emptyCollections.freeformResolution)if(resolution[key]==null)resolution[key]=[];
    if(resolution.discover_facts==null)resolution.discover_facts=false;
    out.resolution=resolution;
  }
  return out;
}
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
  const out: JsonObject = node.properties && typeof node.properties === 'object' ? normalizeObject(node) : { ...node };
  for (const key of dropped) delete out[key];
  if (out.items) out.items = normalizeNode(out.items as JsonObject);
  if (Array.isArray(out.prefixItems)) out.prefixItems = (out.prefixItems as JsonObject[]).map(normalizeNode);
  for (const definitions of ['$defs', 'definitions']) if (out[definitions] && typeof out[definitions] === 'object')
    out[definitions] = Object.fromEntries(Object.entries(out[definitions] as JsonObject).map(([key, value]) => [key, normalizeNode(value as JsonObject)]));
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(out[combinator])) out[combinator] = (out[combinator] as JsonObject[]).map(entry => normalizeNode(entry));
  if (out.additionalProperties && typeof out.additionalProperties === 'object') out.additionalProperties = normalizeNode(out.additionalProperties as JsonObject);
  return out;
}

export function normalizeStructuredSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  return normalizeNode(schema as JsonObject);
}

/** Reverse only nullability introduced for optional keys by the wire compiler.
 * Ambiguous unions are left intact unless every applicable branch agrees.
 * This is a projection, not validation: the original domain validator still runs.
 */
export function normalizeProviderOptionals(value:unknown,schema:unknown):unknown{
  const root=schema as JsonObject;
  const nodeOf=(input:unknown):JsonObject=>{
    const node=input&&typeof input==='object'?input as JsonObject:{};
    if(typeof node.$ref==='string'&&node.$ref.startsWith('#/')){
      const resolved=node.$ref.slice(2).split('/').reduce<unknown>((part,key)=>
        part&&typeof part==='object'?(part as JsonObject)[key.replace(/~1/g,'/').replace(/~0/g,'~')]:undefined,root);
      return resolved&&typeof resolved==='object'?resolved as JsonObject:node;
    }
    return node;
  };
  const matches=(v:unknown,input:unknown):boolean=>{
    const n=nodeOf(input);
    if(Object.hasOwn(n,'const')&&n.const!==v)return false;
    if(Array.isArray(n.enum)&&!n.enum.includes(v))return false;
    if(Array.isArray(n.anyOf)&&!n.anyOf.some(b=>matches(v,b)))return false;
    if(Array.isArray(n.oneOf)&&!n.oneOf.some(b=>matches(v,b)))return false;
    if(Array.isArray(n.allOf)&&!n.allOf.every(b=>matches(v,b)))return false;
    const type=v===null?'null':Array.isArray(v)?'array':typeof v;
    if(n.type&&!(Array.isArray(n.type)?n.type:[n.type]).some(t=>t===type||t==='integer'&&typeof v==='number'&&Number.isInteger(v)))return false;
    if(v&&typeof v==='object'&&!Array.isArray(v)&&n.properties){
      for(const [key,child] of Object.entries(n.properties as JsonObject)){
        const c=nodeOf(child);
        if((Object.hasOwn(c,'const')||c.enum)&&Object.hasOwn(v,key)&&!matches((v as JsonObject)[key],child))return false;
      }
    }
    return true;
  };
  const walk=(v:unknown,input:unknown):unknown=>{
    const n=nodeOf(input);
    if(v===null||typeof v!=='object')return v;
    const variants=n.anyOf??n.oneOf;
    if(Array.isArray(variants)){
      const results=variants.filter(branch=>matches(v,branch)).map(branch=>walk(v,branch));
      return results.length&&results.every(result=>JSON.stringify(result)===JSON.stringify(results[0]))?results[0]:v;
    }
    if(Array.isArray(v))return v.map((item,index)=>{
      const child=Array.isArray(n.prefixItems)?n.prefixItems[index]??n.items:n.items;
      return child?walk(item,child):item;
    });
    const properties=(n.properties??{}) as JsonObject,required=new Set(n.required as string[]??[]);
    const out:JsonObject={};
    for(const [key,entry] of Object.entries(v)){
      const child=properties[key];
      if(child&&entry===null&&!required.has(key)&&!matches(null,child))continue;
      out[key]=child?walk(entry,child):n.additionalProperties&&typeof n.additionalProperties==='object'?
        walk(entry,n.additionalProperties):entry;
    }
    return out;
  };
  return walk(value,schema);
}

/**
 * Drops keys the schema does not know about, guided by the same JSON Schema that was sent to the model.
 * Strict validation still runs afterwards, so this never widens what may enter canonical state — it only
 * keeps a stray field invented by a model from failing an otherwise valid result.
 */
export function pruneUnknownKeys(value: unknown, schema: unknown, path = 'root', dropped: string[] = []): unknown {
  if (!schema || typeof schema !== 'object' || value === null || typeof value !== 'object') return value;
  const node = schema as JsonObject;
  if (Array.isArray(value)) {
    const items = node.items as JsonObject | undefined;
    return items ? value.map((entry, index) => pruneUnknownKeys(entry, items, path + '[' + index + ']', dropped)) : value;
  }
  const properties = node.properties as JsonObject | undefined;
  if (!properties) return value;
  const source = value as JsonObject, out: JsonObject = {};
  for (const [key, entry] of Object.entries(source)) {
    if (Object.hasOwn(properties, key)) out[key] = pruneUnknownKeys(entry, properties[key], path + '.' + key, dropped);
    else dropped.push(path + '.' + key);
  }
  return out;
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
/** Compile a domain JSON Schema into the strict contract accepted by structured-output providers. */
export function compileStructuredSchema(schema: unknown): unknown {
  const compiled = normalizeStructuredSchema(schema);
  const violations = schemaViolations(compiled);
  if (violations.length) throw new Error(`INVALID_PROVIDER_SCHEMA: ${violations.slice(0, 8).join('; ')}`);
  return compiled;
}

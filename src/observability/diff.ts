import type { SavePackage } from '../core/schema.js';

// Save/migration trace without dumping the whole save: which top-level modules and entity components changed.
export function summarizeSaveDiff(before: SavePackage, after: SavePackage) {
  const modules: string[] = [], components: string[] = [];
  for (const key of Object.keys(after) as (keyof SavePackage)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) modules.push(String(key));
  }
  const previous = new Map(before.entities.map(entity => [entity.id, entity]));
  for (const entity of after.entities) {
    const before = previous.get(entity.id);
    const names = new Set([...Object.keys(entity.components), ...Object.keys(before?.components ?? {})]);
    for (const name of names) if (JSON.stringify(before?.components?.[name]) !== JSON.stringify(entity.components[name])) components.push(`${entity.id}.${name}`);
  }
  return { modules, components: components.slice(0, 40), components_truncated: components.length > 40 };
}

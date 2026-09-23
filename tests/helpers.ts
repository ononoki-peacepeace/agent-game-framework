import { readFile } from 'node:fs/promises';
import { newSave } from '../src/core/state.js';
import { worldSchema, type SavePackage } from '../src/core/schema.js';
import type { SaveStorage } from '../src/storage/json-store.js';
export const demo = worldSchema.parse(JSON.parse(await readFile(new URL('../content/worlds/town.json', import.meta.url), 'utf8')));
export const fresh = () => newSave(demo);
export class MemoryStore implements SaveStorage {
  slots = new Map<string, SavePackage>();
  async read(slot = 'current') { return structuredClone(this.slots.get(slot) ?? null); }
  async write(save: SavePackage, slot = 'current') { this.slots.set(slot, structuredClone(save)); }
}

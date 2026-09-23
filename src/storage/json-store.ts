import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSave } from '../core/state.js';
import type { SavePackage } from '../core/schema.js';
export interface SaveStorage { read(slot?: 'current' | 'checkpoint'): Promise<SavePackage | null>; write(save: SavePackage, slot?: 'current' | 'checkpoint'): Promise<void> }
export class JsonStore implements SaveStorage {
  constructor(private directory: string) {}
  async read(slot: 'current' | 'checkpoint' = 'current') {
    try { return validateSave(JSON.parse(await readFile(join(this.directory, `${slot}.json`), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async write(save: SavePackage, slot: 'current' | 'checkpoint' = 'current') {
    const text = JSON.stringify(validateSave(save), null, 2);
    await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, `${slot}.${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx');
      try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temp, join(this.directory, `${slot}.json`));
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

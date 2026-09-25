import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSave } from '../core/state.js';
import type { SavePackage } from '../core/schema.js';
import { observe, errorText } from '../observability/index.js';
export interface SaveStorage { read(slot?: 'current' | 'checkpoint'): Promise<SavePackage | null>; write(save: SavePackage, slot?: 'current' | 'checkpoint'): Promise<void> }
export class JsonStore implements SaveStorage {
  constructor(readonly directory: string) {}
  async read(slot: 'current' | 'checkpoint' = 'current') {
    try { return validateSave(JSON.parse(await readFile(join(this.directory, `${slot}.json`), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async write(save: SavePackage, slot: 'current' | 'checkpoint' = 'current') {
    const started = performance.now(), validated = validateSave(save), text = JSON.stringify(validated, null, 2);
    try {
      await mkdir(this.directory, { recursive: true });
      const temp = join(this.directory, `${slot}.${randomUUID()}.tmp`);
      try {
        const file = await open(temp, 'wx');
        try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temp, join(this.directory, `${slot}.json`));
      } finally { await unlink(temp).catch(() => undefined); }
    } catch (error) {
      observe('error', 'save.write', { module: 'storage', duration_ms: performance.now() - started, revision: validated.state_revision, metadata: { slot, ok: false, reason: errorText(error) } });
      throw error;
    }
    observe('debug', 'save.write', { module: 'storage', duration_ms: performance.now() - started, revision: validated.state_revision, metadata: { slot, ok: true, bytes: text.length, game_id: validated.game_id } });
  }
}

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSave } from '../core/state.js';
import type { Action,SavePackage } from '../core/schema.js';
import { observe, errorText } from '../observability/index.js';
export interface PendingTurn {game_id:string;request_id:string;fingerprint:string;expected_revision:number;candidate:SavePackage;action:Action;facts:string[];generic:boolean}
export interface SaveStorage { read(slot?: 'current' | 'checkpoint'): Promise<SavePackage | null>; write(save: SavePackage, slot?: 'current' | 'checkpoint'): Promise<void>;
  readPending?(requestId:string):Promise<PendingTurn|null>;writePending?(turn:PendingTurn):Promise<void>;clearPending?(requestId:string):Promise<void> }
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
  private pendingPath(requestId:string){if(!/^[0-9a-f-]{36}$/i.test(requestId))throw Error('Invalid pending request id');return join(this.directory,'pending-resolutions',requestId+'.json');}
  async readPending(requestId:string):Promise<PendingTurn|null>{
    try{return JSON.parse(await readFile(this.pendingPath(requestId),'utf8')) as PendingTurn;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async writePending(turn:PendingTurn){
    const path=this.pendingPath(turn.request_id),folder=join(this.directory,'pending-resolutions');await mkdir(folder,{recursive:true});
    const temp=path+'.'+randomUUID()+'.tmp';
    try{const file=await open(temp,'wx');try{await file.writeFile(JSON.stringify(turn),'utf8');await file.sync();}finally{await file.close();}await rename(temp,path);}
    finally{await unlink(temp).catch(()=>undefined);}
  }
  async clearPending(requestId:string){await unlink(this.pendingPath(requestId)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}

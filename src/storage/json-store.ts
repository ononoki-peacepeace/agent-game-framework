import { mkdir, open, readFile, unlink, stat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSave } from '../core/state.js';
import type { Action,SavePackage } from '../core/schema.js';
import { observe, errorText } from '../observability/index.js';
import {behaviorPatchSchema,type BehaviorPatch} from '../ai/guidance.js';
import {z} from 'zod';
import {inputRecoverySchema} from '../recovery/request-context.js';
import {replaceWithBoundedRetry,writeAtomicJson} from './atomic-json.js';
export interface PendingTurn {game_id:string;request_id:string;fingerprint:string;expected_revision:number;candidate:SavePackage;action:Action;facts:string[];generic:boolean}
const inputRecordSchema=z.strictObject({version:z.literal(1),game_id:z.string().uuid(),request_id:z.string().uuid(),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['running','completed','failed']),started_at:z.number(),
  response:z.json().optional(),error:z.string().optional(),http_status:z.number().int().optional(),committed_revision:z.number().int().optional(),
  recovery:inputRecoverySchema.optional()});
export type StoredInputRecord=z.infer<typeof inputRecordSchema>;
export type SaveReadSource='unspecified'|'service_current'|'service_view'|'turn_commit_check'|'request_recovery'|'semantic_context';
export interface SaveStorage { read(slot?: 'current' | 'checkpoint',source?:SaveReadSource): Promise<SavePackage | null>; write(save: SavePackage, slot?: 'current' | 'checkpoint'): Promise<void>;
  /** Optional guarded read migration; false means re-read. Same-process coordination only. */
  writeMigration?(expected:SavePackage,migrated:SavePackage):Promise<boolean>;
  /** Internal storage guarantees; never derived from save data or model output. */
  consumeReadValidation?(save:SavePackage):boolean;readonly validatesWrites?:boolean;
  readPending?(requestId:string):Promise<PendingTurn|null>;writePending?(turn:PendingTurn):Promise<void>;clearPending?(requestId:string):Promise<void>;
  readGlobalGuidance?():Promise<BehaviorPatch[]>;writeGlobalGuidance?(patches:BehaviorPatch[]):Promise<void>;
  readInputRecord?(gameId:string,requestId:string):Promise<StoredInputRecord|null>;writeInputRecord?(record:StoredInputRecord):Promise<void> }
// All JsonStore instances for one lexical path coordinate current-image writes.
// This is not an inter-process or external-writer lock.
const currentWrites=new Map<string,Promise<void>>();
export class JsonStore implements SaveStorage {
  readonly validatesWrites=true;
  private readonly validatedReads=new WeakSet<SavePackage>();
  consumeReadValidation(save:SavePackage){return this.validatedReads.delete(save);}
  // Only validated, private snapshots are reused. The file identity includes
  // nanosecond timestamps so external save replacements invalidate this cache.
  private readonly reads=new Map<string,{identity:string;save:SavePackage}>();
  private async identity(path:string){
    const info=await stat(path,{bigint:true});
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }
  constructor(readonly directory: string) {}
  private inputRecordPath(gameId:string,requestId:string){
    z.string().uuid().parse(gameId);z.string().uuid().parse(requestId);
    return join(this.directory,'input-requests',gameId,requestId+'.json');
  }
  async readInputRecord(gameId:string,requestId:string){
    try{const record=inputRecordSchema.parse(JSON.parse(await readFile(this.inputRecordPath(gameId,requestId),'utf8')));
      if(record.game_id!==gameId||record.request_id!==requestId)throw Error('Input record identity mismatch');return record;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async writeInputRecord(record:StoredInputRecord){
    // Persist exactly the JSON wire representation (optional response fields may
    // be undefined in memory, but are omitted by Express's JSON serialization).
    const validated=inputRecordSchema.parse(JSON.parse(JSON.stringify(record))),path=this.inputRecordPath(record.game_id,record.request_id);
    await writeAtomicJson(path,validated);
  }
  async readGlobalGuidance(){
    try{return z.array(behaviorPatchSchema).max(100).parse(JSON.parse(await readFile(join(this.directory,'behavior-guidance.json'),'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  }
  async writeGlobalGuidance(patches:BehaviorPatch[]){
    await writeAtomicJson(join(this.directory,'behavior-guidance.json'),z.array(behaviorPatchSchema).max(100).parse(patches));
  }
  async read(slot: 'current' | 'checkpoint' = 'current',source:SaveReadSource='unspecified') {
    const path=join(this.directory, `${slot}.json`),started=performance.now();
    try {
      const identity=await this.identity(path),cached=this.reads.get(slot);
      if(cached?.identity===identity){
        const save=structuredClone(cached.save);
        this.validatedReads.add(save);
        observe('debug','save.read',{module:'storage',revision:save.state_revision,duration_ms:performance.now()-started,metadata:{slot,source,cache_hit:true}});
        return save;
      }
      const save=validateSave(JSON.parse(await readFile(path,'utf8')));
      // Never associate bytes with a different file version during an external write.
      if(await this.identity(path)===identity)this.reads.set(slot,{identity,save});
      const result=structuredClone(save);
      this.validatedReads.add(result);
      observe('debug','save.read',{module:'storage',revision:save.state_revision,duration_ms:performance.now()-started,metadata:{slot,source,cache_hit:false}});
      return result;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  private currentWrite<T>(operation:()=>Promise<T>):Promise<T>{
    const path=resolve(this.directory,'current.json'),key=process.platform==='win32'?path.toLowerCase():path;
    const prior=currentWrites.get(key)??Promise.resolve(),run=prior.then(operation,operation);
    const settled=run.then(()=>undefined,()=>undefined);currentWrites.set(key,settled);
    void settled.then(()=>{if(currentWrites.get(key)===settled)currentWrites.delete(key);});
    return run;
  }
  async writeMigration(expected:SavePackage,migrated:SavePackage){
    const expectedImage=structuredClone(expected),candidate=structuredClone(migrated);
    return this.currentWrite(async()=>{
      const current=await this.read('current','service_current');
      if(!current||JSON.stringify(current)!==JSON.stringify(expectedImage))return false;
      await this.persist(candidate,'current');return true;
    });
  }
  async write(save: SavePackage, slot: 'current' | 'checkpoint' = 'current') {
    const snapshot=structuredClone(save);
    return slot==='current'?this.currentWrite(()=>this.persist(snapshot,slot)):this.persist(snapshot,slot);
  }
  private async persist(save: SavePackage, slot: 'current' | 'checkpoint') {
    this.reads.delete(slot);
    const started = performance.now(), validated = validateSave(save), text = JSON.stringify(validated, null, 2);
    try {
      await mkdir(this.directory, { recursive: true });
      const temp = join(this.directory, `${slot}.${randomUUID()}.tmp`);
      try {
        const file = await open(temp, 'wx');
        try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
        await replaceWithBoundedRetry(temp, join(this.directory, `${slot}.json`),text);
      } finally { await unlink(temp).catch(() => undefined); }
    } catch (error) {
      observe('error', 'save.write', { module: 'storage', duration_ms: performance.now() - started, revision: validated.state_revision, metadata: { slot, ok: false, reason: errorText(error) } });
      throw error;
    } finally {
      // A concurrent reader may have cached the previous file while fsync ran.
      this.reads.delete(slot);
    }
    observe('debug', 'save.write', { module: 'storage', duration_ms: performance.now() - started, revision: validated.state_revision, metadata: { slot, ok: true, bytes: text.length, game_id: validated.game_id } });
  }
  private pendingPath(requestId:string){if(!/^[0-9a-f-]{36}$/i.test(requestId))throw Error('Invalid pending request id');return join(this.directory,'pending-resolutions',requestId+'.json');}
  async readPending(requestId:string):Promise<PendingTurn|null>{
    try{return JSON.parse(await readFile(this.pendingPath(requestId),'utf8')) as PendingTurn;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async writePending(turn:PendingTurn){
    await writeAtomicJson(this.pendingPath(turn.request_id),turn);
  }
  async clearPending(requestId:string){await unlink(this.pendingPath(requestId)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {GameError} from '../core/schema.js';
import type {SaveStorage,StoredInputRecord} from '../storage/json-store.js';

const markerSchema=z.strictObject({kind:z.literal('guidance-configuration-v1'),request_id:z.string().uuid(),
 scope:z.enum(['global','session'])});
/** Keep child configuration records separate from the /api/input parent record. */
export function guidanceRecordId(gameId:string,requestId:string){
 const hex=createHash('sha256').update(`guidance-configuration-v1:${gameId}:${requestId}`).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export class GuidanceRequestError extends GameError{
 readonly failure_engine_code='transaction_failure';
 readonly failure_stage='guidance_configuration';
 readonly state_certain=false;
 readonly retry_policy='do_not_replay';
}
const unavailable=()=>new GuidanceRequestError('行为指导请求的结果尚未可靠确认，请查看指导列表；不要重复提交原请求。',409);

/** Journal intent before non-world effects. A stranded intent is never evidence of commit. */
export class GuidanceRequests{
 private readonly pending=new Map<string,Promise<void>>();
 constructor(private readonly storage:SaveStorage){}
 async recover(gameId:string,requestId:string,fingerprint:string){
  const id=guidanceRecordId(gameId,requestId);
  await this.pending.get(id);
  const record=await this.storage.readInputRecord?.(gameId,id);
  if(!record)return false;
  const marker=markerSchema.safeParse(record.response);
  if(!marker.success||marker.data.request_id!==requestId||record.fingerprint!==this.fingerprint(fingerprint))
   throw new GameError('请求 ID 已用于另一操作',409);
  if(record.state==='completed')return true;
  if(record.state==='failed')throw new GuidanceRequestError(record.error??'行为指导请求失败，请查看当前指导列表。',record.http_status??503);
  throw unavailable();
 }
 private fingerprint(intent:string){return createHash('sha256').update(intent).digest('hex');}
 async run(gameId:string,requestId:string,fingerprint:string,scope:'global'|'session',mutate:()=>Promise<void>){
  if(await this.recover(gameId,requestId,fingerprint))return;
  if(!this.storage.writeInputRecord||!this.storage.readInputRecord)
   throw new GuidanceRequestError('行为指导请求的持久恢复不可用，修改尚未开始。',503);
  const id=guidanceRecordId(gameId,requestId);
  let release!:()=>void;
  this.pending.set(id,new Promise<void>(done=>{release=done;}));
  const running:StoredInputRecord={version:1,game_id:gameId,request_id:id,fingerprint:this.fingerprint(fingerprint),
   state:'running',started_at:Date.now(),response:{kind:'guidance-configuration-v1',request_id:requestId,scope}};
  try{
   // If this write throws, no mutation has been attempted. A possible saved intent
   // remains conservative after restart; do not overwrite it with a guessed result.
   try{await this.storage.writeInputRecord(running);}catch{throw unavailable();}
   try{await mutate();}
   catch(error){
    const failure=new GuidanceRequestError(error instanceof Error?error.message:'行为指导修改失败',error instanceof GameError?error.status:503);
    try{await this.storage.writeInputRecord({...running,state:'failed',error:failure.message,http_status:failure.status});}
    catch{/* The retained running intent still prevents an unsafe repeat. */}
    throw failure;
   }
   // Never replace a possibly saved completed record with a failed record.
   try{await this.storage.writeInputRecord({...running,state:'completed',http_status:200});}
   catch{throw unavailable();}
  }finally{this.pending.delete(id);release();}
 }
}

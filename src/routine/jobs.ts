import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {assert,GameError,safeParse} from '../core/schema.js';
import {requestSchema,type GameService} from '../server/service.js';
import {routineOf} from './scheduler.js';
import {absoluteTime} from './calendar.js';
import {startTrace,runWithTrace,errorText,type LogLevel,type Trace} from '../observability/index.js';
const runSchema=z.strictObject({request_id:z.string().uuid(),game_id:z.string().uuid(),expected_revision:z.number().int().min(0),action:z.unknown(),max_days:z.number().int().min(1).max(7).optional()});

export type RoutineJobStatus='queued'|'running'|'paused'|'interrupted'|'failed'|'completed'|'cancelled';
export type RoutineJobPhase='queued'|'waiting_for_safe_handoff'|'compiling'|'running_local'|'waiting_for_ai'|'validating'|'committing'|'idle';
export interface RoutineAiSummary {role:string;provider:string;model:string|null;status:'ok'|'failed';duration_ms:number;reason:string|null;usage:{input_tokens:number;output_tokens:number}|null;retry_count:number}
export interface RoutineJob {
 job_id:string;game_id:string;request_id:string;fingerprint:string;status:RoutineJobStatus;phase:RoutineJobPhase;message:string;
 created_at:string;updated_at:string;start_revision:number;last_revision:number;steps:number;last_ai:RoutineAiSummary|null;
 metrics:{ai_requests:number;compiler_calls:number;ai_wait_ms:number;local_ms:number;input_tokens:number;output_tokens:number;usage_available:boolean};
}
const active=(j:RoutineJob)=>j.status==='queued'||j.status==='running';
const phaseMessage:Record<RoutineJobPhase,string>=({
 queued:'已接收，等待执行。',
 waiting_for_safe_handoff:'已启用，正在等待安全交接点。',
 compiling:'正在编译生活计划（仅新建或修改计划时执行）。',
 running_local:'正在后台推进普通生活安排。',
 waiting_for_ai:'正在请求 AI 判断开放事件。',
 validating:'正在校验本次推进的结果。',
 committing:'正在写入存档。',
 idle:'已停止。',
});
export class RoutineJobs {
 private completions=new Map<string,Promise<void>>();private jobs:RoutineJob[]=[];private controllers=new Map<string,AbortController>();private serial:Promise<void>=Promise.resolve();readonly ready:Promise<void>;
 constructor(readonly service:GameService,private directory?:string,private handoffTimeoutMs=120000){this.ready=this.recover();}
 private async recover(){if(!this.directory)return;try{const parsed=JSON.parse(await readFile(join(this.directory,'routine-jobs.json'),'utf8'));assert(Array.isArray(parsed),'后台任务日志格式无效');this.jobs=parsed;for(const j of this.jobs)if(active(j)){j.status='cancelled';j.phase='idle';j.message='服务已重启；已保存结果保留，未完成段未重放。可继续原计划。';}await this.persist();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 private persist(){if(!this.directory)return Promise.resolve();const text=JSON.stringify(this.jobs.slice(-100),null,2),dir=this.directory;this.serial=this.serial.then(async()=>{await mkdir(dir,{recursive:true});const path=join(dir,'routine-jobs.json'),tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,text);await rename(tmp,path);});return this.serial;}
 async get(id?:string){await this.ready;const job=id?this.jobs.find(j=>j.job_id===id):this.jobs.at(-1);if(id&&!job)throw new GameError('后台任务不存在',404);if(job&&!active(job))await this.completions.get(job.job_id);return job?structuredClone(job):null;}
 async start(raw:unknown){await this.ready;const input=safeParse(runSchema,raw);const req=safeParse(requestSchema,{request_id:input.request_id,game_id:input.game_id,expected_revision:input.expected_revision,action:input.action});
 const action=req.action as {type?:string};assert(['START_ROUTINE','CONTINUE_ROUTINE'].includes(action?.type??''),'仅支持启用或继续生活模式');
 const fingerprint=createHash('sha256').update(JSON.stringify({action:input.action,max_days:input.max_days??1})).digest('hex');const existing=this.jobs.find(j=>j.request_id===input.request_id);if(existing){assert(existing.game_id===input.game_id&&existing.fingerprint===fingerprint,'请求ID已用于另一后台任务');return structuredClone(existing);}
 if(this.jobs.some(active)||this.service.routineLease)throw new GameError('已有后台生活任务，请先请求安全暂停',409);
 const jobId=randomUUID();this.service.routineLease=jobId;
 try{const save=await this.service.current();if(save.game_id!==req.game_id||save.state_revision!==req.expected_revision)throw new GameError('状态已更新，请刷新后重试',409);
 const job:RoutineJob={job_id:jobId,game_id:save.game_id,request_id:req.request_id,fingerprint,status:'queued',phase:'queued',message:phaseMessage.queued,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),start_revision:save.state_revision,last_revision:save.state_revision,steps:0,last_ai:null,metrics:{ai_requests:0,compiler_calls:0,ai_wait_ms:0,local_ms:0,input_tokens:0,output_tokens:0,usage_available:false}};
 const trace=startTrace({module:'routine.job',logger:this.service.logger,job_id:jobId,request_id:req.request_id,game_id:save.game_id,revision:save.state_revision});
 this.jobs.push(job);const controller=new AbortController();this.controllers.set(jobId,controller);await this.persist();this.completions.set(jobId,new Promise<void>(resolve=>setImmediate(()=>{void this.run(job,req,input.max_days??1,controller,trace).catch(error=>console.error("Routine job persistence failed",errorText(error))).finally(()=>{this.completions.delete(jobId);resolve();});})));return structuredClone(job);
 }catch(e){this.service.routineLease=null;throw e;}}
 async cancel(id:string){await this.ready;const job=this.jobs.find(j=>j.job_id===id);assert(job,'后台任务不存在');if(active(job)){job.message='已请求安全暂停，将在当前安全结算点停止。';this.controllers.get(id)?.abort(new Error('USER_CANCELLED'));await this.persist();}return structuredClone(job);}
 private async run(job:RoutineJob,req:{request_id:string;game_id:string;expected_revision:number;action?:unknown;input?:string},days:number,controller:AbortController,trace:Trace){return runWithTrace(trace,async()=>{const metrics={...this.service.ai.metrics},begin=performance.now();const signal=controller.signal;
 trace.info('routine.job.started',{metadata:{game_id:job.game_id,start_revision:job.start_revision,days}});
 const sync=()=>{const now=this.service.ai.metrics;job.metrics={ai_requests:now.requests-metrics.requests,compiler_calls:now.compiler_calls-metrics.compiler_calls,ai_wait_ms:Math.round(now.ai_wait_ms-metrics.ai_wait_ms),local_ms:Math.max(0,Math.round(performance.now()-begin-(now.ai_wait_ms-metrics.ai_wait_ms))),input_tokens:now.input_tokens-metrics.input_tokens,output_tokens:now.output_tokens-metrics.output_tokens,usage_available:now.usage_available};const last=this.service.ai.last;if(last)job.last_ai={role:last.role,provider:last.provider,model:last.model,status:last.status,duration_ms:last.duration_ms,reason:last.reason,usage:last.usage,retry_count:last.retry_count};job.updated_at=new Date().toISOString();};
 const phase=(value:string)=>{job.phase=(value==='compiler'?'compiling':value==='local'?'running_local':value==='ai'?'waiting_for_ai':value==='validating'?'validating':value==='committing'?'committing':'running_local') as RoutineJobPhase;job.status='running';job.message=phaseMessage[job.phase];sync();void this.persist().catch(()=>controller.abort(new Error('JOB_STORAGE_FAILED')));};
 try{signal.throwIfAborted();job.status='running';job.phase='queued';await this.persist();
 const handoff=await this.awaitSafeHandoff(job,controller,begin);if(handoff)return;
 // The foreground transaction may have committed while we waited: take the current revision, never a stale one.
 const ready=await this.service.current();
 if(ready.game_id!==job.game_id)throw new GameError('游戏已切换，请刷新后重试',409);
 await this.service.turn({...req,expected_revision:ready.state_revision},job.job_id,signal,phase,true);
 let save=await this.service.current();const end=absoluteTime(save)+days*1440;
 while(absoluteTime(save)<end && job.steps<200){signal.throwIfAborted();const r=routineOf(save);if(!r.active||r.interrupted){job.status='interrupted';job.message=String(r.last_interrupt??'生活已暂停');break;}
 if(!save.calendar||save.routine_meta?.calendar_issue){job.status='interrupted';job.message=save.routine_meta?.calendar_issue??'请先确认日历';break;}
 const before=absoluteTime(save);await this.service.turn({request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,action:{type:'CONTINUE_ROUTINE',parameters:{max_minutes:Math.min(1440,end-before)}}},job.job_id,signal,phase);
 save=await this.service.current();job.steps++;job.last_revision=save.state_revision;sync();await this.persist();
 if(routineOf(save).interrupted){job.status='interrupted';job.message=String(routineOf(save).last_interrupt);break;}
 assert(absoluteTime(save)>before,'调度器没有取得进展，已停止以避免重复结算');await new Promise<void>(resolve=>setImmediate(resolve));}
 if(job.status==='running'){job.status=job.steps>=200?'interrupted':'completed';job.message=job.steps>=200?'已到安全事件数量上限，可检查后继续。':'本批普通生活已完成。';}
 }catch(e){if(signal.aborted && signal.reason instanceof Error && signal.reason.message==='USER_CANCELLED'){job.status='cancelled';job.message='已安全暂停；已提交的生活保留，未提交的段没有修改存档。';}
else{job.status='failed';job.message=readableFailure(e);}}
 finally{sync();job.phase='idle';try{job.last_revision=(await this.service.current()).state_revision;await this.persist();}finally{this.controllers.delete(job.job_id);this.service.routineLease=null;
 const level:LogLevel=job.status==='failed'?'error':job.status==='completed'?'info':'warn';
 trace.log(level,'routine.job.completed',{duration_ms:performance.now()-begin,revision:job.last_revision,metadata:{status:job.status,steps:job.steps,start_revision:job.start_revision,last_revision:job.last_revision,message:job.message,last_ai:job.last_ai,metrics:job.metrics}});
 }}});
 }
 // Enabling routine never preempts a foreground transaction: it waits for a safe handoff, or arms itself.
 private async awaitSafeHandoff(job:RoutineJob,controller:AbortController,begin:number){
 const deadline=begin+this.handoffTimeoutMs;
 for(;;){
  const block=await this.service.handoffBlocker();
  if(!block){job.phase='compiling';job.message='安全交接点已到达，生活模式开始接管自动推进。';await this.persist();return false;}
  if(block.kind==='player_decision'||performance.now()>deadline){
    // Hand control back to the player: the routine stays armed and the foreground transaction keeps priority.
    job.status='interrupted';job.phase='idle';
    job.message=`后台任务已中断（未接管）：${block.reason}。处理完当前事务后，在左侧输入“继续日常”。`;
    await this.persist();
    return true;
  }
  job.status='running';job.phase='waiting_for_safe_handoff';
  job.message=`等待安全交接：${block.reason}`;
  await this.persist();
  await new Promise(resolve=>setTimeout(resolve,350));

  if(controller.signal.aborted)throw controller.signal.reason instanceof Error?controller.signal.reason:new Error('USER_CANCELLED');
 }
 }
}
function readableFailure(error:unknown){
 const message=error instanceof Error?error.message:String(error);
 if(/USER_CANCELLED/.test(message))return '已安全暂停；未提交的段没有修改存档。';
 if(/abort|cancel|timeout|timed out|超时/i.test(message))return 'AI 服务等待超时；未提交的段没有修改存档，可稍后重试。';
 return message||'后台生活执行失败，未提交段未保存';
}

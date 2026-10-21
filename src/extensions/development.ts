import {AIRuntime} from '../ai/runtime.js';
import {structuredInputSchema,normalizeProviderOptionals} from '../ai/provider-schema.js';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {redactValue,redactTextTail} from '../observability/logger.js';
import {CodexAdapter} from '../ai/codex.js';
import type {AIAdapter} from '../ai/contracts.js';
import {assert,safeParse} from '../core/schema.js';
import {manifestFrom,manifestSchema,specSchema,templates,type ExtensionSpec} from './schema.js';
import {ExtensionHost,transactionSchema} from './host.js';
import {verifyReference} from './verification.js';
import {writeAtomicJson} from '../storage/atomic-json.js';
import {withoutInputRecovery,committedInputReceipts} from '../recovery/request-context.js';
import {withoutRequestBudget,withRequestBudget} from '../ai/request-budget.js';
import {startTrace,runWithTrace} from '../observability/index.js';
const run=promisify(execFile);
const requestSchema=z.strictObject({request_id:z.string().uuid(),request:z.string().min(1).max(3000),template:z.enum(templates),allow_betting:z.boolean().default(false),use_codex:z.boolean(),extension_id:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine(v=>!['constructor','prototype','__proto__'].includes(v)),spec:specSchema.optional()});
const installationSchema=transactionSchema.extend({migration_confirmed:z.boolean()});
const jobSchema=z.strictObject({job_id:z.string().uuid(),request_id:z.string().uuid(),game_id:z.string().uuid().optional(),
 request_fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),trace_id:z.string().max(80).optional(),
 status:z.enum(['queued','running','ready','installed','failed','cancelled']),phase:z.string().max(100),message:z.string().max(12000),
 logs:z.array(z.string().max(12000)).max(1000),manifest:manifestSchema.nullable(),hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 workspace:z.string().min(1).max(4096),install_intent:installationSchema.optional()});
export type DevelopmentJob=z.infer<typeof jobSchema>;
export class ExtensionDevelopment {
 private jobs:DevelopmentJob[]=[];private controllers=new Map<string,AbortController>();private running=new Map<string,Promise<void>>();private serial:Promise<void>=Promise.resolve();private starts:Promise<void>=Promise.resolve();private installs:Promise<void>=Promise.resolve();readonly ready:Promise<void>;
 constructor(readonly host:ExtensionHost,private adapterFactory:(directory:string)=>AIAdapter=directory=>new CodexAdapter(directory)){this.ready=this.load();}
 private workspacePath(job:DevelopmentJob){
  const path=resolve(job.workspace),base=resolve(this.host.directory),parts=relative(base,path).split(/[\\/]/);
  const normal=parts.length===2&&parts[0]==='workspaces'&&parts[1]===job.job_id;
  const task=parts.length===3&&parts[0]==='tasks'&&z.string().uuid().safeParse(parts[1]).success&&parts[2]==='candidate';
  assert(job.workspace===path&&(normal||task),'开发工作区路径不匹配');return path;
 }
 private async checkedArtifact(job:DevelopmentJob){
  const workspace=this.workspacePath(job),root=await realpath(this.host.directory),path=await realpath(join(workspace,'dist','profile.json'));
  const local=relative(root,path);assert(local&&!local.startsWith('..')&&!isAbsolute(local),'开发产物路径越界');
  assert(path===join(await realpath(workspace),'dist','profile.json'),'开发产物路径不匹配');
  const bytes=await readFile(path,'utf8');assert(createHash('sha256').update(bytes).digest('hex')===job.hash,'构建产物已改变，请重新验证');
  assert(JSON.stringify(JSON.parse(bytes))===JSON.stringify(job.manifest),'构建产物与安装预览不符');
 }
 private async reconcileInstall(job:DevelopmentJob){
  if(!job.install_intent||!job.manifest)return null;
  const save=await this.host.service.storage.read('current','request_recovery'),tx=job.install_intent;
  if(!save||save.game_id!==job.game_id||tx.game_id!==job.game_id)return null;
  const fingerprint=createHash('sha256').update(JSON.stringify({extension_operation:{install:job.manifest.extension_id,
   version:job.manifest.version,migrationConfirmed:tx.migration_confirmed}})).digest('hex');
  const receipts=committedInputReceipts(save,{original_player_input:'extension install',trace_id:job.trace_id??'legacy',
   transactions:[{request_id:tx.request_id,fingerprint,expected_revision:tx.expected_revision}]});
  const entry=save.extensions?.[job.manifest.extension_id];
  if(!receipts.length||!entry?.installed||JSON.stringify(entry.manifest)!==JSON.stringify(job.manifest))return null;
  job.status='installed';job.phase='installed';job.message='已按当前世界收据核验安装成功；没有重复安装。';return save;
 }
 private async load(){try{
  const jobs=safeParse(z.array(jobSchema).max(1000),JSON.parse(await readFile(join(this.host.directory,'development.json'),'utf8')));
  assert(new Set(jobs.map(j=>j.job_id)).size===jobs.length&&new Set(jobs.map(j=>j.request_id)).size===jobs.length,'开发日志身份重复');
  for(const j of jobs){this.workspacePath(j);assert(!j.install_intent||j.install_intent.game_id===j.game_id,'安装意图世界身份不匹配');
   if(j.install_intent){if(!await this.reconcileInstall(j)){j.status='failed';
    if(!['install_preparing','approving','installing','recording_install'].includes(j.phase))j.phase='install_recovery';
    j.message='安装结果无法从当前世界核验，已停止自动重放；请检查世界状态。';}}
   else if(!j.game_id&&['ready','installed'].includes(j.status)){j.status='failed';j.phase='idle';j.message='旧候选缺少世界身份，未自动恢复安装资格；原记录保留。';}
   else if(['queued','running'].includes(j.status)){j.status='cancelled';j.phase='idle';j.message='服务重启，未安装的开发任务已停止。';}
  }this.jobs=jobs;
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 private persist(){const snapshot=structuredClone(this.jobs.slice(-50));const write=this.serial.then(()=>writeAtomicJson(join(this.host.directory,'development.json'),snapshot));this.serial=write.catch(()=>undefined);return write;}
 async get(){await this.ready;if(!['queued','running'].includes(this.jobs.at(-1)?.status??''))await this.serial;return structuredClone(this.jobs.at(-1)??null);}
 async start(raw:unknown,options?:{workspace:string;version:string}){
 const operation=this.starts.then(()=>this.startJob(raw,options));this.starts=operation.then(()=>undefined,()=>undefined);return operation;
 }
 private async startJob(raw:unknown,options?:{workspace:string;version:string}){await this.ready;const input=safeParse(requestSchema,raw),fingerprint=createHash('sha256').update(JSON.stringify({input,workspace:options?.workspace??null,version:options?.version??null})).digest('hex'),old=this.jobs.find(j=>j.request_id===input.request_id);
 if(old){assert(old.request_fingerprint&&old.request_fingerprint===fingerprint,'请求标识已用于不同需求，或旧记录缺少可核验的请求身份');return structuredClone(old);} assert(!this.jobs.some(j=>['queued','running'].includes(j.status)),'已有扩展开发任务');const save=await this.host.service.current(),id=randomUUID(),trace=startTrace({module:'extension',logger:this.host.service.logger,request_id:input.request_id,job_id:id}),job:DevelopmentJob={job_id:id,request_id:input.request_id,game_id:save.game_id,request_fingerprint:fingerprint,trace_id:trace.trace_id,status:'queued',phase:'requirements',message:'已确认需求，等待生成。',logs:[],manifest:null,hash:null,workspace:options?.workspace??resolve(this.host.directory,'workspaces',id)};this.workspacePath(job);this.jobs.push(job);const controller=new AbortController();this.controllers.set(id,controller);
 try{await this.persist();}catch(error){this.jobs=this.jobs.filter(entry=>entry.job_id!==id);this.controllers.delete(id);throw error;}
 const running=withoutInputRecovery(()=>withoutRequestBudget(()=>withRequestBudget(()=>runWithTrace(trace,()=>this.build(job,input,controller,options?.version)))));this.running.set(id,running);void running.catch(error=>this.host.service.logger.error('extension.development.storage_failed',{module:'extension',job_id:id,trace_id:trace.trace_id,metadata:{reason:String(error)}})).finally(()=>this.running.delete(id));return structuredClone(job);}
 async wait(id:string){await this.running.get(id);const job=this.jobs.find(j=>j.job_id===id);assert(job,'开发任务不存在');return structuredClone(job);}
 async cancel(id:string){const j=this.jobs.find(j=>j.job_id===id);assert(j,'开发任务不存在');this.controllers.get(id)?.abort(new Error('用户取消扩展生成'));return structuredClone(j);}
 private async build(job:DevelopmentJob,input:z.infer<typeof requestSchema>,controller:AbortController,versionOverride?:string){
 const signal=controller.signal,phase=async(name:string,message:string)=>{signal.throwIfAborted();job.status='running';job.phase=name;job.message=message;job.logs.push(message);await this.persist();};
 try{
   await phase('creating_workspace','准备独立扩展工作区。');for(const dir of ['src','dist','tests','assets'])await mkdir(join(job.workspace,dir),{recursive:true});
   await phase('generating','在独立扩展目录生成声明式配置，核心源文件不参与生成。');
   const declarativeDefaults={fields:[{key:'count',type:'number' as const,initial:0}],declarative_actions:[{id:'plus_one',label:'+1',op:'increment' as const,field:'count',value:1},{id:'reset',label:'重置',op:'set' as const,field:'count',value:0}],surfaces:[{id:`${input.extension_id}_panel`,kind:'contextual_panel' as const,title:'小工具',visibility:'always' as const}]};
   let spec:ExtensionSpec=input.spec
     ?safeParse(specSchema,{...input.spec,extension_id:input.extension_id,template:input.template})
     :input.template==='declarative'
       ?safeParse(specSchema,{extension_id:input.extension_id,name:'声明式小工具',description:input.request,template:'declarative',allow_betting:false,max_stake:0,healing_item_id:null,...declarativeDefaults})
       :{extension_id:input.extension_id,name:input.template==='blackjack'?'21 点':'回合制训练',description:input.request,template:input.template,allow_betting:input.allow_betting,max_stake:input.allow_betting?20:0,healing_item_id:null,fields:[],declarative_actions:[],surfaces:[]};
   if(input.use_codex){const adapter=this.adapterFactory(job.workspace);const result=await new AIRuntime(adapter).generateValidated({role:'gm_reasoning',signal,maxOutputTokens:2500,prompt:'只为扩展输出 JSON Spec。禁止代码、工具、shell、文件修改和世界事实写入。template、extension_id 必须与请求相同。声明式（declarative）扩展只能声明自己的状态字段、受限动作（increment/decrement/set/toggle）和 UI surface。人物独立属性必须使用 field.scope=entity、可读 label，并声明 contextual_panel.host=character_detail 或 character_card；extension-global 字段不能冒充人物属性。不能声明对世界正史的写入；允许的写入只有 extension-owned state。请求：'+JSON.stringify({...input,spec:undefined})},specSchema);spec=safeParse(specSchema,normalizeProviderOptionals(result.data,structuredInputSchema(specSchema)));assert(spec.template===input.template&&spec.extension_id===input.extension_id,'生成结果改变了玩家确认的模板或 ID');if(input.template==='declarative')assert(spec.fields.length>0&&spec.declarative_actions.length>0&&spec.surfaces.length>0,'声明式扩展缺少状态、动作或界面');}

   await phase('static_validation','校验 manifest、权限白名单与状态命名空间。');spec=safeParse(specSchema,spec);const save=await this.host.service.current();assert(save.game_id===job.game_id,'世界已切换，候选未继续构建');const existing=save.extensions?.[spec.extension_id],oldVersion=existing?.version;const version=versionOverride??await this.host.nextVersion(spec.extension_id,oldVersion);const manifest=manifestFrom(spec,version,input.use_codex?'Codex / declarative spec':'参考模板');job.manifest=manifest;
   await phase('writing_files','保存候选扩展的声明文件。');
   const json=JSON.stringify(manifest,null,2);await writeFile(join(job.workspace,'extension.json'),json);await writeFile(join(job.workspace,'src','profile.ts'),'export const profile: {framework_api_version:"1";[key:string]:unknown} = '+json+';\n');
   await phase('building','TypeScript 检查独立 profile，构建 JSON 入口。');
   await run(process.execPath,[resolve('node_modules/typescript/lib/tsc.js'),'--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext',join(job.workspace,'src','profile.ts')],{signal,timeout:30000,maxBuffer:1024*1024,windowsHide:true});
   await writeFile(join(job.workspace,'dist','profile.json'),json);
   await phase('testing','执行参考规则单元测试及 Framework API 兼容检查。');job.logs.push(...verifyReference(spec));await writeFile(join(job.workspace,'tests','results.json'),JSON.stringify({passed:true,checks:job.logs.slice(-3)},null,2));
   signal.throwIfAborted();job.hash=createHash('sha256').update(json).digest('hex');job.status='ready';job.phase='preview';job.message='构建和规则测试通过。请查看权限与规则，然后确认安装。';
 }catch(e){job.status=signal.aborted?'cancelled':'failed';
   if(signal.aborted){job.phase='idle';job.message='生成已取消；当前工作版本未改变。';}
   else{
     const error=e as {code?:unknown;signal?:unknown;stdout?:unknown;stderr?:unknown};
     const tail=(value:unknown)=>redactTextTail(value);
     const stdout=tail(error?.stdout),stderr=tail(error?.stderr);
     job.message=[`[${job.phase}] ${String(redactValue(e instanceof Error?e.message:String(e))).slice(0,4000)}`,
       typeof error?.code==='number'?`exit=${error.code}`:typeof error?.code==='string'?`code=${tail(error.code)}`:'',
       typeof error?.signal==='string'?`signal=${tail(error.signal)}`:'',stdout?`stdout:\n${stdout}`:'',stderr?`stderr:\n${stderr}`:''].filter(Boolean).join('\n').slice(0,12000);
   }
   job.logs.push(job.message);}
 finally{this.controllers.delete(job.job_id);await this.persist();this.host.service.logger.info('extension.development.finished',{module:'extension',job_id:job.job_id,metadata:{status:job.status,phase:job.phase,message:job.message}});}
 }
 async install(id:string,raw:unknown,migrationConfirmed=false){
  const operation=this.installs.then(()=>this.installJob(id,raw,migrationConfirmed));this.installs=operation.then(()=>undefined,()=>undefined);return operation;
 }
 /** Read-only world reconciliation for callers whose own prepare journal survived a restart. */
 async recoverInstallation(id:string,raw:unknown,migrationConfirmed=false){
  const input=safeParse(transactionSchema.extend({confirmed:z.literal(true)}),raw);await this.ready;
  const job=this.jobs.find(j=>j.job_id===id);if(!job?.install_intent)return null;
  const {confirmed,...tx}=input;
  assert(JSON.stringify(job.install_intent)===JSON.stringify({...tx,migration_confirmed:migrationConfirmed}),'安装请求标识或参数改变，已停止自动重放');
  return this.reconcileInstall(job);
 }
 private async installJob(id:string,raw:unknown,migrationConfirmed:boolean){
  const input=safeParse(transactionSchema.extend({confirmed:z.literal(true)}),raw);await this.ready;
  const job=this.jobs.find(j=>j.job_id===id);assert(job?.manifest&&job.hash,'仅可安装已通过构建测试的候选');
  assert(job.game_id===input.game_id,'候选属于另一世界，未安装');
  const {confirmed,...tx}=input,intent={...tx,migration_confirmed:migrationConfirmed};
  if(job.install_intent){
   assert(JSON.stringify(job.install_intent)===JSON.stringify(intent),'安装请求标识或参数改变，已停止自动重放');
   const committed=await this.reconcileInstall(job);assert(committed,'安装结果尚未确认，已停止自动重放，请检查世界状态');
   await this.persist();return this.host.service.project(committed);
  }
  assert(job.status==='ready','仅可安装已通过构建测试的候选');await this.checkedArtifact(job);
  const current=await this.host.service.storage.read('current','request_recovery');
  assert(current?.game_id===job.game_id,'世界已切换，未安装');assert(current.state_revision===input.expected_revision,'状态已更新，未安装');
  const preview={phase:job.phase,message:job.message};job.install_intent=intent;job.phase='install_preparing';
  try{await this.persist();}catch(error){delete job.install_intent;Object.assign(job,preview);
   this.host.service.logger.error('extension.install.prepare_failed',{module:'extension',job_id:job.job_id,trace_id:job.trace_id,
    metadata:{phase:'install_preparing',reason:String(redactValue(error instanceof Error?error.message:String(error)))}});throw error;}
  let installStage='approving';
  try{
   job.phase=installStage;await this.persist();await this.host.approve(job.manifest);
   installStage='installing';job.phase=installStage;await this.persist();const result=await this.host.install(tx,job.manifest,migrationConfirmed);
   installStage='recording_install';job.status='installed';job.phase='installed';job.message='扩展已安装；可以在适用场景通过左侧输入打开。';await this.persist();return result;
  }catch(error){
   try{if(!await this.reconcileInstall(job)){job.status='failed';job.phase=installStage;job.message='安装未能确认完成，已停止自动重放；请检查世界状态。';}
    job.logs.push(`[${installStage}] ${String(redactValue(error instanceof Error?error.message:String(error)))}`);await this.persist();
   }catch(journalError){this.host.service.logger.error('extension.install.reconciliation_failed',{module:'extension',job_id:job.job_id,
    trace_id:job.trace_id,metadata:{phase:'install_reconciliation',failed_phase:installStage,reason:String(redactValue(journalError instanceof Error?journalError.message:String(journalError)))}});}
   throw error;
  }
 }
}

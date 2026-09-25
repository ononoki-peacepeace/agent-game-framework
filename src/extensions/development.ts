import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {redactValue} from '../observability/logger.js';
import {CodexAdapter} from '../ai/codex.js';
import type {AIAdapter} from '../ai/contracts.js';
import {assert,safeParse} from '../core/schema.js';
import {manifestFrom,specSchema,templates,type ExtensionManifest,type ExtensionSpec} from './schema.js';
import {ExtensionHost} from './host.js';
import {verifyReference} from './verification.js';
const run=promisify(execFile);
const requestSchema=z.strictObject({request_id:z.string().uuid(),request:z.string().min(1).max(3000),template:z.enum(templates),allow_betting:z.boolean().default(false),use_codex:z.boolean(),extension_id:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine(v=>!['constructor','prototype','__proto__'].includes(v)),spec:specSchema.optional()});
export interface DevelopmentJob {job_id:string;request_id:string;status:'queued'|'running'|'ready'|'installed'|'failed'|'cancelled';phase:string;message:string;logs:string[];manifest:ExtensionManifest|null;hash:string|null;workspace:string}
export class ExtensionDevelopment {
 private jobs:DevelopmentJob[]=[];private controllers=new Map<string,AbortController>();private running=new Map<string,Promise<void>>();private serial:Promise<void>=Promise.resolve();readonly ready:Promise<void>;
 constructor(readonly host:ExtensionHost,private adapterFactory:(directory:string)=>AIAdapter=directory=>new CodexAdapter(directory)){this.ready=this.load();}
 private async load(){try{this.jobs=JSON.parse(await readFile(join(this.host.directory,'development.json'),'utf8'));for(const j of this.jobs)if(['queued','running'].includes(j.status)){j.status='cancelled';j.phase='idle';j.message='服务重启，未安装的开发任务已停止。';}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 private persist(){const payload=JSON.stringify(this.jobs.slice(-50),null,2);this.serial=this.serial.then(async()=>{await mkdir(this.host.directory,{recursive:true});const tmp=join(this.host.directory,randomUUID()+'.tmp');await writeFile(tmp,payload);await rename(tmp,join(this.host.directory,'development.json'));});return this.serial;}
 async get(){await this.ready;if(!['queued','running'].includes(this.jobs.at(-1)?.status??''))await this.serial;return structuredClone(this.jobs.at(-1)??null);}
 async start(raw:unknown,options?:{workspace:string;version:string}){await this.ready;const input=safeParse(requestSchema,raw),old=this.jobs.find(j=>j.request_id===input.request_id);if(old)return structuredClone(old);assert(!this.jobs.some(j=>['queued','running'].includes(j.status)),'已有扩展开发任务');const id=randomUUID(),job:DevelopmentJob={job_id:id,request_id:input.request_id,status:'queued',phase:'requirements',message:'已确认需求，等待生成。',logs:[],manifest:null,hash:null,workspace:options?.workspace??resolve(this.host.directory,'workspaces',id)};this.jobs.push(job);const controller=new AbortController();this.controllers.set(id,controller);await this.persist();const running=this.build(job,input,controller,options?.version);this.running.set(id,running);void running.catch(error=>this.host.service.logger.error('extension.development.storage_failed',{module:'extension',metadata:{reason:String(error)}})).finally(()=>this.running.delete(id));return structuredClone(job);}
 async wait(id:string){await this.running.get(id);const job=this.jobs.find(j=>j.job_id===id);assert(job,'开发任务不存在');return structuredClone(job);}
 async cancel(id:string){const j=this.jobs.find(j=>j.job_id===id);assert(j,'开发任务不存在');this.controllers.get(id)?.abort(new Error('用户取消扩展生成'));return structuredClone(j);}
 private async build(job:DevelopmentJob,input:z.infer<typeof requestSchema>,controller:AbortController,versionOverride?:string){
 const signal=controller.signal,phase=async(name:string,message:string)=>{signal.throwIfAborted();job.status='running';job.phase=name;job.message=message;job.logs.push(message);await this.persist();};
 try{
   await phase('generating','在独立扩展目录生成声明式配置，核心源文件不参与生成。');for(const dir of ['src','dist','tests','assets'])await mkdir(join(job.workspace,dir),{recursive:true});
   const declarativeDefaults={fields:[{key:'count',type:'number' as const,initial:0}],declarative_actions:[{id:'plus_one',label:'+1',op:'increment' as const,field:'count',value:1},{id:'reset',label:'重置',op:'set' as const,field:'count',value:0}],surfaces:[{id:`${input.extension_id}_panel`,kind:'contextual_panel' as const,title:'小工具',visibility:'always' as const}]};
   let spec:ExtensionSpec=input.spec
     ?safeParse(specSchema,{...input.spec,extension_id:input.extension_id,template:input.template})
     :input.template==='declarative'
       ?safeParse(specSchema,{extension_id:input.extension_id,name:'声明式小工具',description:input.request,template:'declarative',allow_betting:false,max_stake:0,healing_item_id:null,...declarativeDefaults})
       :{extension_id:input.extension_id,name:input.template==='blackjack'?'21 点':'回合制训练',description:input.request,template:input.template,allow_betting:input.allow_betting,max_stake:input.allow_betting?20:0,healing_item_id:null,fields:[],declarative_actions:[],surfaces:[]};
   if(input.use_codex){const adapter=this.adapterFactory(job.workspace);const result=await adapter.generate({role:'gm_reasoning',signal,maxOutputTokens:2500,schema:z.toJSONSchema(specSchema),prompt:'只为扩展输出 JSON Spec。禁止代码、工具、shell、文件修改和世界事实写入。template、extension_id 必须与请求相同。声明式（declarative）扩展只能声明自己的状态字段、受限动作（increment/decrement/set/toggle）和 UI surface，不能声明对世界正史的写入；允许的写入只有 extension-owned state。请求：'+JSON.stringify({...input,spec:undefined})});spec=safeParse(specSchema,result.data);assert(spec.template===input.template&&spec.extension_id===input.extension_id,'生成结果改变了玩家确认的模板或 ID');if(input.template==='declarative')assert(spec.fields.length>0&&spec.declarative_actions.length>0&&spec.surfaces.length>0,'声明式扩展缺少状态、动作或界面');}

   await phase('static_validation','校验 manifest、权限白名单与状态命名空间。');spec=safeParse(specSchema,spec);const save=await this.host.service.current(),existing=save.extensions?.[spec.extension_id],oldVersion=existing?.version;const version=versionOverride??await this.host.nextVersion(spec.extension_id,oldVersion);const manifest=manifestFrom(spec,version,input.use_codex?'Codex / declarative spec':'参考模板');job.manifest=manifest;
   const json=JSON.stringify(manifest,null,2);await writeFile(join(job.workspace,'extension.json'),json);await writeFile(join(job.workspace,'src','profile.ts'),'export const profile: {framework_api_version:"1";[key:string]:unknown} = '+json+';\n');
   await phase('building','TypeScript 检查独立 profile，构建 JSON 入口。');
   await run(process.execPath,[resolve('node_modules/typescript/lib/tsc.js'),'--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext',join(job.workspace,'src','profile.ts')],{signal,timeout:30000,maxBuffer:1024*1024,windowsHide:true});
   await writeFile(join(job.workspace,'dist','profile.json'),json);
   await phase('testing','执行参考规则单元测试及 Framework API 兼容检查。');job.logs.push(...verifyReference(spec));await writeFile(join(job.workspace,'tests','results.json'),JSON.stringify({passed:true,checks:job.logs.slice(-3)},null,2));
   signal.throwIfAborted();job.hash=createHash('sha256').update(json).digest('hex');job.status='ready';job.phase='preview';job.message='构建和规则测试通过。请查看权限与规则，然后确认安装。';
 }catch(e){job.status=signal.aborted?'cancelled':'failed';job.phase='idle';
   const detail=String((e as {stderr?:string}).stderr??'').trim().split('\n').slice(0,3).join(' ');
   job.message=signal.aborted?'生成已取消；当前工作版本未改变。':`${String(redactValue((e as Error).message))}${detail?`：${detail}`:''}`;
   job.logs.push(job.message);}
 finally{this.controllers.delete(job.job_id);await this.persist();this.host.service.logger.info('extension.development.finished',{module:'extension',job_id:job.job_id,metadata:{status:job.status,message:job.message}});}
 }
 async install(id:string,raw:unknown,migrationConfirmed=false){const input=safeParse(z.strictObject({confirmed:z.literal(true),game_id:z.string().uuid(),expected_revision:z.number().int().min(0),request_id:z.string().uuid()}),raw);await this.ready;const job=this.jobs.find(j=>j.job_id===id);assert(job?.status==='ready'&&job.manifest&&job.hash,'仅可安装已通过构建测试的候选');
 const bytes=await readFile(join(job.workspace,'dist','profile.json'),'utf8');assert(createHash('sha256').update(bytes).digest('hex')===job.hash,'构建产物已改变，请重新验证');const manifest=job.manifest;assert(JSON.stringify(JSON.parse(bytes))===JSON.stringify(manifest),'构建产物与安装预览不符');
 await this.host.approve(manifest);const {confirmed,...tx}=input;const result=await this.host.install(tx,manifest,migrationConfirmed);job.status='installed';job.message='扩展已安装；可以在适用场景通过左侧输入打开。';await this.persist();return result;}
}

import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {assert} from '../core/schema.js';
import type {AIAdapter} from '../ai/contracts.js';
import {specSchema,type ExtensionManifest} from './schema.js';
import {ExtensionDevelopment} from './development.js';
export const capabilityGapSchema=z.strictObject({required_capability:z.string().max(150),why_needed:z.string().max(600),affected_modules:z.array(z.string()).max(10),current_limitation:z.string().max(600),proposed_generic_capability:z.string().max(600),risk:z.string().max(600)});
export const developmentPlanSchema=z.strictObject({
 normalized_requirements:z.array(z.string().max(600)).min(1).max(20),complexity:z.enum(['LOW','MEDIUM','HIGH','VERY_HIGH']),clarification:z.string().max(600).nullable(),
 milestones:z.array(z.strictObject({id:z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),title:z.string().max(100),kind:z.enum(['behavior','ui','integration']),acceptance:z.array(z.string().max(250)).min(1).max(8)})).min(1).max(8),
 capability_gaps:z.array(capabilityGapSchema).max(10),affected_milestone_ids:z.array(z.string().max(40)).max(8).default([]),
});
const generationSchema=z.strictObject({spec:specSchema.nullable(),capability_gaps:z.array(capabilityGapSchema).max(10)});
export type CapabilityGap=z.infer<typeof capabilityGapSchema>;
export interface CoreProposal {problem:string;proposed_api:string[];impact:string[];migration:string;tests:string[];rollback:string;risk:string;status:'pending'|'approved';approved_at?:string}
export interface DevelopmentTask {
 id:string;game_id:string;extension_id:string;original_request:string;normalized_requirements:string[];requirement_history:string[];
 complexity:'LOW'|'MEDIUM'|'HIGH'|'VERY_HIGH';status:'planning'|'developing'|'testing'|'repairing'|'waiting_for_user'|'waiting_for_core_approval'|'ready_for_preview'|'installed'|'failed'|'cancelled'|'paused';
 replan_required?:boolean;workspace:string;current_version:string;installed_version:string|null;revision:number;attempts:number;budget:{max_attempts:number};
 milestones:(z.infer<typeof developmentPlanSchema>['milestones'][number]&{status:'pending'|'passed'|'failed';checkpoint?:string})[];
 capability_gaps:CapabilityGap[];core_proposal:CoreProposal|null;
 artifacts:{version:string;milestone:string;path:string;job_id:string;manifest:ExtensionManifest}[];
 test_results:{version:string;milestone:string;passed:boolean;detail:string}[];history:{at:string;event:string;detail:string}[];
 message:string;candidate_job_id:string|null;
 preview:null|{name:string;requirements:string[];usage:string;rules:string[];ui:string[];world_integration:string;canonical_writes:string[];own_state:string[];permissions:string[];risk:string;version:string;migration:string[]};
}
const inputSchema=z.strictObject({request:z.string().min(1).max(3000),request_id:z.string().uuid(),extension_id:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine(x=>!['constructor','prototype','__proto__'].includes(x)).optional()});
const sdk='SDK 只支持扩展自有 number/flag/text 字段，increment/decrement/set/toggle 动作和静态 panel/modal/contextual_panel。不支持任意代码、连续输入、随机游戏规则、世界状态写入。只能开发 SDK 可表达的需求。';
export class DevelopmentTasks {
 private tasks:DevelopmentTask[]=[];private receipts:Record<string,{id:string;request:string}>={};private writes:Promise<void>=Promise.resolve();
 private installing=new Set<string>();private controls=new Set<string>();private starting=false;
 private runs=new Map<string,{controller:AbortController;promise:Promise<void>}>();readonly ready:Promise<void>;
 constructor(readonly builder:ExtensionDevelopment,private adapter:()=>AIAdapter=()=>builder.host.service.ai.adapter){this.ready=this.load();}
 private async load(){try{const data=JSON.parse(await readFile(join(this.builder.host.directory,'tasks.json'),'utf8'));this.tasks=data.tasks;this.receipts=data.receipts;
 for(const t of this.tasks){z.string().uuid().parse(t.id);z.string().uuid().parse(t.game_id);assert(t.workspace===resolve(this.builder.host.directory,'tasks',t.id),'开发工作区路径不匹配');}
 for(const t of this.tasks)if(['planning','developing','testing','repairing'].includes(t.status)){t.status='paused';t.message='服务重启，需求与检查点已保留，可以继续。';}
 const current=await this.builder.host.service.storage.read();
 for(const t of this.tasks){const installed=current?.game_id===t.game_id?current.extensions?.[t.extension_id]:undefined;const candidate=t.artifacts.at(-1)?.manifest;if(installed&&candidate&&installed.version===t.current_version&&JSON.stringify(installed.manifest)===JSON.stringify(candidate)){t.status='installed';t.installed_version=installed.version;t.message='已从存档确认此版本安装成功。';}}
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 private persist(){const payload=JSON.stringify({tasks:this.tasks,receipts:this.receipts},null,2);this.writes=this.writes.catch(()=>{}).then(async()=>{await mkdir(this.builder.host.directory,{recursive:true});const path=join(this.builder.host.directory,randomUUID()+'.tmp');await writeFile(path,payload);await rename(path,join(this.builder.host.directory,'tasks.json'));});return this.writes;}
 private history(t:DevelopmentTask,event:string,detail:string){t.history.push({at:new Date().toISOString(),event,detail});}
 private async find(id:string){await this.ready;const t=this.tasks.find(t=>t.id===id);assert(t,'开发任务不存在');assert(t.game_id===(await this.builder.host.service.current()).game_id,'开发任务属于另一个世界');return t;}
 async list(){await this.ready;const s=await this.builder.host.service.current();return structuredClone(this.tasks.filter(t=>t.game_id===s.game_id));}
 async get(id:string){return structuredClone(await this.find(id));}
 async start(raw:unknown){await this.ready;const input=inputSchema.parse(raw),old=this.receipts[input.request_id];if(old){assert(old.request===JSON.stringify(input),'请求标识已用于不同需求');return this.get(old.id);}
 assert(!this.runs.size&&!this.starting,'已有开发任务正在运行');this.starting=true;try{const save=await this.builder.host.service.current();
 if(input.extension_id){const existing=this.tasks.findLast(t=>t.game_id===save.game_id&&t.extension_id===input.extension_id);if(existing)return this.revise(existing.id,input.request);}
 const id=randomUUID(),extension_id=input.extension_id??'extension_'+id.replaceAll('-','').slice(0,16),installed=save.extensions?.[extension_id];
 assert(!input.extension_id||installed,'找不到要更新的已安装功能');
 const version=await this.builder.host.nextVersion(extension_id,installed?.version);
 const t:DevelopmentTask={id,game_id:save.game_id,extension_id,original_request:input.request,normalized_requirements:[input.request],requirement_history:[input.request],complexity:'MEDIUM',status:'planning',workspace:resolve(this.builder.host.directory,'tasks',id),current_version:version,installed_version:installed?.version??null,revision:1,attempts:0,budget:{max_attempts:3},milestones:[],capability_gaps:[],core_proposal:null,artifacts:[],test_results:[],history:[],message:'正在整理需求及开发阶段。',candidate_job_id:null,preview:null};
 if(installed)t.artifacts.push({version:installed.version,milestone:'installed',path:'',job_id:'',manifest:installed.manifest});
 this.tasks.push(t);this.receipts[input.request_id]={id,request:JSON.stringify(input)};this.history(t,'created',input.request);await mkdir(t.workspace,{recursive:true});await this.persist();this.launch(t);return structuredClone(t);}finally{this.starting=false;}}
 private launch(t:DevelopmentTask){const controller=new AbortController();const promise=Promise.resolve().then(()=>this.run(t,controller.signal)).finally(()=>this.runs.delete(t.id));this.runs.set(t.id,{controller,promise});}
 private gap(t:DevelopmentTask,gaps:CapabilityGap[]){t.capability_gaps=gaps;t.status='waiting_for_core_approval';t.message='当前扩展接口不足以完成需求，核心能力提案等待审阅。';t.core_proposal={problem:gaps.map(g=>g.why_needed).join('\n'),proposed_api:gaps.map(g=>g.proposed_generic_capability),impact:gaps.flatMap(g=>g.affected_modules),migration:'新增状态必须可选且版本化；旧档往返兼容，迁移前保留检查点。',tests:['权限越界拒绝','旧档往返兼容','并发冲突与原子回滚','中断恢复','新接口行为验证'],rollback:'禁用新能力，恢复迁移前检查点和上一扩展版本。',risk:gaps.map(g=>g.risk).join('\n'),status:'pending'};this.history(t,'capability_gap',t.message);}
 private async run(t:DevelopmentTask,signal:AbortSignal){
 try{
 while((t.replan_required||!t.milestones.length)&&t.attempts<t.budget.max_attempts){
  signal.throwIfAborted();t.attempts++;t.status='planning';await this.persist();
  try{const reply=await this.adapter().generate({role:'gm_reasoning',signal,maxOutputTokens:5000,schema:z.toJSONSchema(developmentPlanSchema),prompt:sdk+' 只规划用户目标，不默认生成参考游戏或计数器。玩家说的是产品概念时先给最小可用版本：只有需求明确要求某个高级行为（例如达到上限后真的不能继续成长）时才引入对应规则、迁移或额外能力；不要把 hook、可见性框架、数据迁移、额外核心能力当作默认。规则缺失用 clarification 询问；给玩家的问题只用自然语言，不包含内部标识。超出 SDK 必须产生 capability_gaps，不降级冒充实现。每个 milestone 为可实现/构建/测试/检查点的纵向功能切片；高复杂任务需要多个阶段。修改现有需求时，affected_milestone_ids 必须明确指出受影响的已有阶段；不受影响的阶段保持 id、验收标准和标题不变。'+JSON.stringify({requirements:t.requirement_history,previous_milestones:t.milestones,previous:t.artifacts.at(-1)?.manifest,diagnostics:t.test_results.slice(-2)})});
   signal.throwIfAborted();const p=developmentPlanSchema.parse(reply.data);assert(new Set(p.milestones.map(m=>m.id)).size===p.milestones.length,'阶段标识重复');assert(!['HIGH','VERY_HIGH'].includes(p.complexity)||p.milestones.length>=2,'复杂需求必须拆分多个阶段');t.normalized_requirements=p.normalized_requirements;t.complexity=p.complexity;let affected=false;const old=t.milestones;
   t.milestones=p.milestones.map(m=>{const previous=old.find(x=>x.id===m.id);if(!p.affected_milestone_ids.length||p.affected_milestone_ids.includes(m.id)||!previous||previous.title!==m.title||JSON.stringify(previous.acceptance)!==JSON.stringify(m.acceptance))affected=true;return {...m,status:!affected&&previous?.status==='passed'?'passed':'pending',...(!affected&&previous?.checkpoint?{checkpoint:previous.checkpoint}:{})};});t.replan_required=false;t.budget.max_attempts=Math.max(t.budget.max_attempts,t.attempts+p.milestones.length*2);
   if(p.capability_gaps.length)this.gap(t,p.capability_gaps);else if(p.clarification){t.status='waiting_for_user';t.message=p.clarification;}
  }catch(e){if(signal.aborted)throw e;t.test_results.push({version:t.current_version,milestone:'planning',passed:false,detail:String((e as Error).message).slice(0,1500)});}
 }
 if(['waiting_for_user','waiting_for_core_approval'].includes(t.status)){await this.persist();return;}
 if(t.replan_required||!t.milestones.length){t.status='paused';t.message='规划尝试预算已用完，需求已保留。';await this.persist();return;}
 for(const m of t.milestones){
  if(m.status==='passed')continue;
  while(m.status!=='passed'&&t.attempts<t.budget.max_attempts){
   signal.throwIfAborted();t.attempts++;t.status=m.status==='failed'?'repairing':'developing';t.message='正在处理：'+m.title;await this.persist();
   try{
    const reply=await this.adapter().generate({role:'gm_reasoning',signal,maxOutputTokens:5000,schema:z.toJSONSchema(generationSchema),prompt:sdk+' 在现有候选上局部实现或修复当前阶段，返回累积完整Spec。template只能declarative。缺少SDK能力返回capability_gaps并令spec=null，不能偷偷修改Core。保留已通过阶段。'+JSON.stringify({extension_id:t.extension_id,requirements:t.normalized_requirements,milestone:m,previous:t.artifacts.at(-1)?.manifest,diagnostics:t.test_results.filter(x=>!x.passed).slice(-2)})});
    signal.throwIfAborted();const generated=generationSchema.parse(reply.data);if(generated.capability_gaps.length){this.gap(t,generated.capability_gaps);await this.persist();return;}
    const spec=generated.spec;assert(spec&&spec.template==='declarative'&&spec.extension_id===t.extension_id,'候选身份或执行边界不匹配');
    const job=await this.builder.start({request_id:randomUUID(),request:t.normalized_requirements.join('\n').slice(0,3000),extension_id:t.extension_id,template:'declarative',allow_betting:false,use_codex:false,spec},{workspace:join(t.workspace,'candidate'),version:t.current_version});
    t.candidate_job_id=job.job_id;t.status='testing';t.message='正在构建与验证：'+m.title;await this.persist();
    const cancel=()=>{void this.builder.cancel(job.job_id);};signal.addEventListener('abort',cancel,{once:true});
    let built;try{built=await this.builder.wait(job.job_id);}finally{signal.removeEventListener('abort',cancel);}
    signal.throwIfAborted();assert(built.status==='ready'&&built.manifest,built.message);
    const path=join(t.workspace,'checkpoints',t.current_version+'-'+m.id+'.json');await mkdir(join(t.workspace,'checkpoints'),{recursive:true});await copyFile(join(built.workspace,'dist','profile.json'),path);
    m.status='passed';m.checkpoint=path;t.artifacts.push({version:t.current_version,milestone:m.id,path,job_id:built.job_id,manifest:built.manifest});
    t.test_results.push({version:t.current_version,milestone:m.id,passed:true,detail:'TypeScript、状态动作约束及规则验证通过。'});this.history(t,'checkpoint',m.title);await this.persist();
   }catch(e){if(signal.aborted)throw e;m.status='failed';const detail=String((e as Error).message).slice(0,1500);t.test_results.push({version:t.current_version,milestone:m.id,passed:false,detail});this.history(t,'repair',detail);await this.persist();}
  }
  if(m.status!=='passed'){t.status='paused';t.message='本轮预算用完，需求、工作区和检查点已保留，可继续修复。';await this.persist();return;}
 }
 const artifact=t.artifacts.at(-1);assert(artifact,'没有通过验证的候选');
 const save=await this.builder.host.service.current();assert(save.game_id===t.game_id,'世界已切换，候选未安装');
 const m=artifact.manifest,old=save.extensions?.[t.extension_id]?.manifest,changed=old&&JSON.stringify(old.fields.map(f=>[f.key,f.type]))!==JSON.stringify(m.fields.map(f=>[f.key,f.type]));
 t.preview={name:m.name,requirements:t.normalized_requirements,usage:'在功能面板使用：'+m.declarative_actions.map(a=>a.label).join('、'),rules:m.declarative_actions.map(a=>a.label+'：'+({increment:'增加',decrement:'减少',set:'设定',toggle:'切换'})[a.op]+(a.value===undefined?'':' '+a.value)),ui:m.surfaces.map(s=>s.title),world_integration:'独立功能面板，不推进世界时间。',canonical_writes:[],own_state:m.fields.map((f,i)=>'状态 '+(i+1)+'：'+({number:'数值',flag:'开关',text:'文字'})[f.type]),permissions:['只读玩家公开信息','只修改扩展自身数据'],risk:'受当前扩展接口限制，请检查规则是否符合你的要求。',version:t.current_version,migration:changed?['保留同名同类型字段；新增或改类型字段使用新默认值；移除字段保留在完整回滚快照。']:[]};
 t.status='ready_for_preview';t.message='候选已通过构建和规则验证，可继续修改或确认安装。';await this.persist();
 }catch(e){t.status=signal.aborted?'paused':'failed';t.message=signal.aborted?'已暂停，已有进展保留。':'本次开发已停止，已有进展保留；详细原因见高级开发记录。';this.history(t,'stopped',String((e as Error).message).slice(0,1500));await this.persist();}
 }
 async wait(id:string){await this.runs.get(id)?.promise;return this.get(id);}
 private async control<T>(id:string,operation:()=>Promise<T>){assert(!this.controls.has(id),'此任务正在处理另一项操作');this.controls.add(id);try{return await operation();}finally{this.controls.delete(id);}}
 async revise(id:string,request:string){return this.control(id,()=>this.reviseTask(id,request));}
 private async reviseTask(id:string,request:string){
 const t=await this.find(id);assert(!this.installing.has(id),'安装正在提交，请稍后修改');assert(request.trim()&&request.length<=3000,'修改要求不能为空或过长');assert(![...this.runs.keys()].some(key=>key!==id),'另一个开发任务正在运行');
 const running=this.runs.get(id);running?.controller.abort();await running?.promise;
 const live=(await this.builder.host.service.current()).extensions?.[t.extension_id];
 if(live&&live.version!==t.installed_version)t.artifacts.push({version:live.version,milestone:'installed_baseline',path:'',job_id:'',manifest:live.manifest});
 t.installed_version=live?.version??null;
 this.history(t,'requirements_changed',request);t.requirement_history.push(request);t.normalized_requirements.push(request);t.revision++;
 const [major,minor,patch]=t.current_version.split('.').map(Number);t.current_version=[major,minor,patch+1].join('.');
 t.attempts=0;t.budget.max_attempts=Math.max(3,t.milestones.length*2+1);t.preview=null;t.candidate_job_id=null;t.capability_gaps=[];t.core_proposal=null;t.status='planning';
 t.replan_required=true;await this.persist();this.launch(t);return structuredClone(t);
 }
 async resume(id:string){return this.control(id,()=>this.resumeTask(id));}
 private async resumeTask(id:string){const t=await this.find(id);assert(!this.runs.size&&['paused','failed'].includes(t.status),'当前任务不能恢复');assert(!t.capability_gaps.length,'核心能力尚未提供，请先修改需求或完成核心开发');t.budget.max_attempts=t.attempts+Math.max(3,t.milestones.length*2);t.status='developing';await this.persist();this.launch(t);return structuredClone(t);}
 async cancel(id:string){return this.control(id,()=>this.cancelTask(id));}
 private async cancelTask(id:string){assert(!this.installing.has(id),'安装正在提交');const t=await this.find(id),running=this.runs.get(id);running?.controller.abort();await running?.promise;t.status='cancelled';t.message='已取消；工作区与历史保留。';await this.persist();return structuredClone(t);}
 async approveCore(id:string,confirmed:boolean){return this.control(id,()=>this.approveCoreTask(id,confirmed));}
 private async approveCoreTask(id:string,confirmed:boolean){const t=await this.find(id);assert(confirmed===true&&t.core_proposal&&t.status==='waiting_for_core_approval','请明确确认核心开发提案');t.core_proposal.status='approved';t.core_proposal.approved_at=new Date().toISOString();t.status='paused';t.message='提案已批准，核心接口仍需单独开发和测试；扩展没有获得修改源码的权限。';this.history(t,'core_approved',t.message);await this.persist();return structuredClone(t);}
 async install(id:string,raw:unknown){return this.control(id,()=>this.installTask(id,raw));}
 private async installTask(id:string,raw:unknown){
 const t=await this.find(id);const current=await this.builder.host.service.current();assert((current.extensions?.[t.extension_id]?.version??null)===t.installed_version,'已安装版本改变，请重新准备候选');assert(t.status==='ready_for_preview'&&t.candidate_job_id&&t.preview,'候选尚未通过验证');
 const body=z.strictObject({candidate_version:z.string(),confirmed:z.literal(true),migration_confirmed:z.boolean().optional(),game_id:z.string().uuid(),expected_revision:z.number().int().min(0),request_id:z.string().uuid()}).parse(raw);
 assert(body.game_id===t.game_id,'世界已切换');assert(body.candidate_version===t.current_version,'候选已更新，请重新预览');assert(!t.preview.migration.length||body.migration_confirmed===true,'需要明确确认状态迁移');
 assert(!this.installing.has(id),'安装正在提交');this.installing.add(id);try{
 const {migration_confirmed,candidate_version,...tx}=body;const view=await this.builder.install(t.candidate_job_id,tx,migration_confirmed);
 t.status='installed';t.installed_version=t.current_version;t.message='版本已安装，可以继续提出修改要求。';this.history(t,'installed',t.current_version);await this.persist();return view;
 }finally{this.installing.delete(id);}
 }
}

import childProcess,{execFile,type ChildProcess} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JsonStore} from '../../src/storage/json-store.js';
import {GameService} from '../../src/server/service.js';
import {AIRuntime} from '../../src/ai/runtime.js';
import {capabilityRegistry} from '../../src/system/capabilities.js';

const [directory,mode,boundary,nonce,requestId]=process.argv.slice(2);
if(!directory||!['run','recover'].includes(mode)||!['package','framework_build','core_install','runtime_build','typescript','npm_pipeline','core_pipeline'].includes(boundary)||!nonce||!requestId||!process.send)
 throw Error('Owned development worker requires explicit fixture identity');
const original=promisify(execFile);
let calls=0,active:ChildProcess|undefined,toolIdentity:{pid:number;inner_pid?:number;nonce:string}|undefined;
const core=boundary==='core_install'||boundary==='runtime_build'||boundary==='core_pipeline';
const pipeline=boundary==='npm_pipeline'||boundary==='core_pipeline';
async function realPipeline(file:string,args:string[],options:object){
 calls++;if(mode==='recover')throw Error('Recovery unexpectedly launched a pipeline');
 const preload=pathToFileURL(resolve('tests/fixtures/development-pipeline-deadline.mjs')).href;
 const task=original(file,args,{...options,cwd:join(directory,core?'repository':'framework'),timeout:110000,windowsHide:true,
  env:{...process.env,NODE_OPTIONS:`--import=${preload}`,AGF_TEST_PIPELINE_DIR:directory,AGF_TEST_PIPELINE_NONCE:nonce}}) as
  Promise<{stdout:string;stderr:string}>&{child:ChildProcess};
 active=task.child;let output='';
 active.stdout!.on('data',data=>{output+=String(data);
  const line=output.split(/\r?\n/).find(line=>line.startsWith('AGF_VITE_READY '));
  if(!line||toolIdentity)return;
  const identity=JSON.parse(line.slice('AGF_VITE_READY '.length));
  if(identity.nonce!==nonce||identity.stage!=='vite_build_start')throw Error('Pipeline identity mismatch');
  toolIdentity=identity;process.send!({kind:'tool_ready',...identity,stage:boundary,actual_stage:identity.stage,command:{file,args},owner_pid:active!.pid});
 });
 return task;
}
async function ownedTool(options:object){
 calls++;
 if(mode==='recover')throw Error('Recovery unexpectedly launched an external tool');
 // A failed runtime validation uses the existing explicit rollback build next.
 if(core&&calls>1)return {stdout:'controlled rollback build success',stderr:''};
 const args=boundary==='typescript'?['--import',pathToFileURL(resolve('tests/fixtures/development-compiler-deadline.mjs')).href,
  resolve('node_modules/typescript/lib/tsc.js'),'--noEmit','--watch',
  '--preserveWatchOutput','--pretty','false','--project',resolve('tsconfig.json')]:
  [resolve('tests/fixtures/development-kill-tool.mjs'),boundary==='package'||boundary==='core_install'?'leaf':'nested',nonce];
 const task=original(process.execPath,args,
  {...options,cwd:directory,timeout:25000,windowsHide:true,
   ...(boundary==='typescript'?{env:{...process.env,AGF_TEST_COMPILER_NONCE:nonce}}:{})}) as Promise<{stdout:string;stderr:string}>&{child:ChildProcess};
 active=task.child;let output='';
 active.stdout!.on('data',data=>{output+=String(data);
  if(boundary==='typescript'){
   if(!toolIdentity&&output.includes('Starting compilation in watch mode')){
    toolIdentity={pid:active!.pid!,nonce};process.send!({kind:'tool_ready',stage:boundary,...toolIdentity,
     compiler:resolve('node_modules/typescript/lib/tsc.js'),project:resolve('tsconfig.json')});
   }
   return;
  }
  const line=output.split(/\r?\n/).find(line=>line.startsWith('{'));
  if(!line||toolIdentity)return;try{const identity=JSON.parse(line);if(identity.nonce!==nonce||identity.pid!==active!.pid)throw Error('Tool identity mismatch');
   toolIdentity=identity;process.send!({kind:'tool_ready',stage:boundary,...identity});}catch(error){if(!(error instanceof SyntaxError))throw error;}
 });
 return task;
}
// Replace only the executable command with a bounded local OS process fixture.
// The typescript boundary instead starts the actual full-project compiler in
// noEmit watch mode, waits for its own startup line, and kills its held handle.
// The task lifecycle, durable files, gate failure and independent restart use
// the real implementation. No coding agent, provider or full build is launched.
const originalExecFile=execFile;
const replacement=(...args:unknown[])=>Reflect.apply(originalExecFile,childProcess,args);
Object.defineProperty(replacement,promisify.custom,{value:async(file:string,args:string[],options:Parameters<typeof execFile>[2])=>{
 if(file==='git')return original(file,args,options as object);
 const stage=args.includes('scripts/verify-capability-package.ts')?'package':'framework_build';
 if(pipeline){
  if(mode==='recover')throw Error('Recovery unexpectedly launched an external command');
  if(stage==='package'){calls++;return original(file,args,options as object);}
  return realPipeline(file,args,options as object);
 }
 if(stage!==boundary&&!(boundary==='typescript'&&stage==='framework_build')&&!core){calls++;return {stdout:'controlled preceding gate success',stderr:''};}
 return ownedTool(options as object);
}});
childProcess.execFile=replacement as typeof execFile;syncBuiltinESMExports();
process.on('message',message=>{
 const data=message as {kind:string;nonce:string};if(data.kind!=='kill'||data.nonce!==nonce||!active||active.exitCode!==null||!toolIdentity)return;
 if(pipeline){void writeFile(join(directory,'kill-vite'),nonce);return;}
 if(boundary==='package'||boundary==='core_install'||boundary==='typescript')active.kill('SIGKILL');else active.stdin!.write('kill-inner:'+nonce+'\n');
});
const {ExtensionHost}=await import('../../src/extensions/host.js');
const {ExtensionDevelopment}=await import('../../src/extensions/development.js');
const {DevelopmentTasks}=await import('../../src/extensions/tasks.js');
const {CoreCandidateInstaller}=await import('../../src/development/core-installer.js');
const store=new JsonStore(join(directory,'save')),initial=await store.read();if(!initial)throw Error('Missing synthetic isolated save');
const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected Provider');}});
const registry=capabilityRegistry.without(['feature.develop']),service=new GameService(store,ai,initial.definition,[],undefined,registry);
const host=new ExtensionHost(service,join(directory,'development'));await host.ready;
const builder=new ExtensionDevelopment(host);
let tasks:InstanceType<typeof DevelopmentTasks>,terminal;
if(core){
 const report=JSON.parse(await readFile(join(directory,'core-report.json'),'utf8'));
 const plan={normalized_requirements:['fixture runtime'],complexity:'HIGH',clarification:null,
  milestones:[{id:'runtime',title:'fixture runtime',kind:'integration',acceptance:['fixture runtime']},{id:'resume',title:'fixture resume',kind:'integration',acceptance:['fixture resume']}],
  capability_gaps:[{required_capability:'fixture.runtime',why_needed:'fixture',affected_modules:['core'],current_limitation:'fixture',proposed_generic_capability:'fixture runtime',risk:'fixture'}],affected_milestone_ids:[]};
 const adapter={name:'offline-fixed-plan',generate:async()=>({data:plan})};
 const executor={availability:async()=>({available:true,provider:'offline-fixture',reason:null}),execute:async()=>structuredClone(report)};
 const run=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>file==='git'?original(file,args,{cwd,signal,windowsHide:true}):
  pipeline?realPipeline(file,args,{signal}):ownedTool({signal});
 const bootRun=async(file:string,args:string[],cwd:string,signal?:AbortSignal)=>file==='git'?original(file,args,{cwd,signal,windowsHide:true}):{stdout:'controlled preceding install build',stderr:''};
 tasks=new DevelopmentTasks(builder,()=>adapter,executor,undefined,new CoreCandidateInstaller(join(directory,'repository'),
  boundary==='runtime_build'&&mode==='run'?bootRun:run,'boot-a'));
 await tasks.ready;const task=await tasks.start({request_id:requestId,request:'核心强杀边界夹具'});
 if(mode==='run'){
  await tasks.wait(task.id);await tasks.approveCore(task.id,true);await tasks.wait(task.id);
  try{await tasks.installCore(task.id,true);}catch(error){if(boundary!=='core_install'&&boundary!=='core_pipeline')throw error;}
  if(boundary==='runtime_build'){
   tasks=new DevelopmentTasks(builder,()=>adapter,executor,undefined,new CoreCandidateInstaller(join(directory,'repository'),run,'boot-b'));await tasks.ready;
  }
 }
 terminal=await tasks.get(task.id);
}else{
 tasks=new DevelopmentTasks(builder);await tasks.ready;
 const task=await tasks.startCapability({request_id:requestId,request:'强杀边界夹具',capability_ids:['feature.develop']});terminal=await tasks.wait(task.id);
}
process.send!({kind:'terminal',task:terminal,calls,registered:Boolean(registry.get('feature.develop')),provider_calls:ai.metrics.requests,
 tool_exit:active?{code:active.exitCode,signal:active.signalCode}:null});
process.disconnect();

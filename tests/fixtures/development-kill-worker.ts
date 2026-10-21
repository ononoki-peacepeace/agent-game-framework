import childProcess,{execFile,type ChildProcess} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {JsonStore} from '../../src/storage/json-store.js';
import {GameService} from '../../src/server/service.js';
import {AIRuntime} from '../../src/ai/runtime.js';
import {capabilityRegistry} from '../../src/system/capabilities.js';

const [directory,mode,boundary,nonce,requestId]=process.argv.slice(2);
if(!directory||!['run','recover'].includes(mode)||!['package','framework_build'].includes(boundary)||!nonce||!requestId||!process.send)
 throw Error('Owned development worker requires explicit fixture identity');
const original=promisify(execFile);
let calls=0,active:ChildProcess|undefined,toolIdentity:{pid:number;inner_pid?:number;nonce:string}|undefined;
// Replace only the executable command with a bounded local OS process fixture.
// The task lifecycle, durable files, gate failure and independent restart use
// the real implementation. No coding agent, provider or full build is launched.
const originalExecFile=execFile;
const replacement=(...args:unknown[])=>Reflect.apply(originalExecFile,childProcess,args);
Object.defineProperty(replacement,promisify.custom,{value:async(file:string,args:string[],options:Parameters<typeof execFile>[2])=>{
 calls++;
 if(mode==='recover')throw Error('Recovery unexpectedly launched an external tool');
 const stage=args.includes('scripts/verify-capability-package.ts')?'package':'framework_build';
 if(stage!==boundary)return {stdout:'controlled preceding gate success',stderr:''};
 const task=original(process.execPath,[resolve('tests/fixtures/development-kill-tool.mjs'),boundary==='package'?'leaf':'nested',nonce],
  {...options as object,cwd:directory,timeout:25000,windowsHide:true}) as Promise<{stdout:string;stderr:string}>&{child:ChildProcess};
 active=task.child;let output='';
 active.stdout!.on('data',data=>{output+=String(data);const line=output.split(/\r?\n/).find(line=>line.startsWith('{'));
  if(!line||toolIdentity)return;try{const identity=JSON.parse(line);if(identity.nonce!==nonce||identity.pid!==active!.pid)throw Error('Tool identity mismatch');
   toolIdentity=identity;process.send!({kind:'tool_ready',stage,...identity});}catch(error){if(!(error instanceof SyntaxError))throw error;}
 });
 return task;
}});
childProcess.execFile=replacement as typeof execFile;syncBuiltinESMExports();
process.on('message',message=>{
 const data=message as {kind:string;nonce:string};if(data.kind!=='kill'||data.nonce!==nonce||!active||active.exitCode!==null||!toolIdentity)return;
 if(boundary==='package')active.kill('SIGKILL');else active.stdin!.write('kill-inner:'+nonce+'\n');
});
const {ExtensionHost}=await import('../../src/extensions/host.js');
const {ExtensionDevelopment}=await import('../../src/extensions/development.js');
const {DevelopmentTasks}=await import('../../src/extensions/tasks.js');
const store=new JsonStore(join(directory,'save')),initial=await store.read();if(!initial)throw Error('Missing synthetic isolated save');
const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected Provider');}});
const registry=capabilityRegistry.without(['feature.develop']),service=new GameService(store,ai,initial.definition,[],undefined,registry);
const host=new ExtensionHost(service,join(directory,'development'));await host.ready;
const tasks=new DevelopmentTasks(new ExtensionDevelopment(host));await tasks.ready;
const input={request_id:requestId,request:'强杀边界夹具',capability_ids:['feature.develop']};
const task=await tasks.startCapability(input);
const terminal=await tasks.wait(task.id);
process.send!({kind:'terminal',task:terminal,calls,registered:Boolean(registry.get('feature.develop')),provider_calls:ai.metrics.requests,
 tool_exit:active?{code:active.exitCode,signal:active.signalCode}:null});
process.disconnect();

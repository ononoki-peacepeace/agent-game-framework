import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/server/app.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {worldSchema} from '../src/core/schema.js';

// Actual isolated HTTP + JsonStore + Core + browser. All generation is offline.
const mode=process.argv.includes('--refresh')?'refresh':'direct';
const evidenceRoot=resolve('.codex-checkpoints/framework-reliability-handoff/continuation-2026-10-20/browser');
await mkdir(evidenceRoot,{recursive:true});
const directory=await mkdtemp(join(evidenceRoot,mode+'-'));
const world=worldSchema.parse(JSON.parse(await readFile(resolve('content/worlds/town.json'),'utf8')));
const store=new JsonStore(directory),mock=new MockAIAdapter();
let service:GameService,releaseFailure=()=>{},markCommitted=()=>{},semanticCalls=0;
const failureGate=new Promise<void>(resolve=>{releaseFailure=resolve;});
const committed=new Promise<void>(resolve=>{markCommitted=resolve;});
const adapter={name:'offline-browser-fault-injection',async generate(request:Parameters<MockAIAdapter['generate']>[0]){
  const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(properties.interaction_lane){
    semanticCalls++;
    const before=await service.current();
    await service.turn({game_id:before.game_id,request_id:randomUUID(),expected_revision:before.state_revision,
      action:{type:'WAIT',parameters:{minutes:5}}});
    markCommitted();
    if(mode==='refresh')await failureGate;
    throw new ProviderError('timeout','Injected after committed child; offline browser test','timeout');
  }
  return mock.generate(request);
}};
service=new GameService(store,new AIRuntime(adapter),world);
await service.newGame();const before=await service.current();
const server=createApp(service,resolve('dist/client'),undefined,join(directory,'assets')).listen(0,'127.0.0.1');
await once(server,'listening');const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let page:Awaited<ReturnType<NonNullable<typeof browser>['newPage']>>|undefined;
const errors:string[]=[],requests:{method:string;path:string}[]=[];
let report:Record<string,unknown>={mode,directory,real_provider_calls:0,formal_save_used:false,port};
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const path=new URL(request.url()).pathname;
    if(path.startsWith('/api/'))requests.push({method:request.method(),path});});
  await page.goto(base);await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
  await page.locator('#action').fill('执行隔离的跨阶段恢复检查');
  await page.getByRole('button',{name:'发送 →',exact:true}).click();
  let commitTimer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([committed,new Promise<never>((_,reject)=>{
    commitTimer=setTimeout(()=>reject(Error('Core did not commit')),20_000);
  })]);}finally{if(commitTimer)clearTimeout(commitTimer);}
  if(mode==='refresh'){
    await page.reload();
    await page.waitForFunction(()=>Boolean(sessionStorage.getItem('herne.pending.input')));
    releaseFailure();
    await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
  }
  await page.locator('.turn-progress.partial').waitFor({timeout:20_000});
  const revision=await page.locator('.scene-heading-meta small').textContent();
  assert(revision?.includes(`REV ${before.state_revision+1}`),'browser did not synchronize committed revision');
  const after=(await store.read())!;
  assert.equal(after.state_revision,before.state_revision+1);
  assert.equal(after.runtime.time.minute,before.runtime.time.minute+5);
  assert.equal(requests.filter(request=>request.method==='POST'&&request.path==='/api/input').length,1);
  assert.equal(semanticCalls,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:join(directory,'result.png'),fullPage:true});
  await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
  await page.locator('#action').waitFor();
  assert.equal((await store.read())!.state_revision,after.state_revision);
  assert.equal(semanticCalls,1);
  report={...report,passed:true,revision:after.state_revision,minutes_advanced:5,semantic_calls:semanticCalls,
    input_posts:1,requests,page_errors:errors};
}catch(error){
  await page?.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(()=>undefined);
  report={...report,passed:false,error:error instanceof Error?error.message:String(error),requests,page_errors:errors};
  process.exitCode=1;
}finally{
  releaseFailure();await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
  await writeFile(join(directory,'evidence.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}

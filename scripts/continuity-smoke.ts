// Runs built production modules. Reads provider credentials only; every write stays in this isolated directory.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
const root=resolve('.tmp/continuity-smoke-'+Date.now());await mkdir(root,{recursive:true});
const built=(path:string)=>import(new URL('../dist/server/'+path,import.meta.url).href);
const [{GameService},{JsonStore},{AIRuntime},{createApp},{newSave},{worldImage},{AIProviderManager,readPersistedProviderConfig},{configureDefaultLogger,StructuredLogger}]=await Promise.all([
 built('server/service.js'),built('storage/json-store.js'),built('ai/runtime.js'),built('server/app.js'),built('core/state.js'),built('core/turn-history.js'),built('ai/providers.js'),built('observability/index.js')]);
configureDefaultLogger(new StructuredLogger({directory:join(root,'logs'),level:'debug'}));
const real=process.argv.includes('--real'),config=real?await readPersistedProviderConfig(resolve('data')):null;
if(real&&(!config||!['deepseek','responses-compatible','openai'].includes(config.provider))){console.log(JSON.stringify({status:'unavailable',reason:'No configured API provider',directory:root}));process.exit(0);}
const world=JSON.parse(await readFile('content/worlds/town.json','utf8'));world.events=[];
const initial=newSave(world),player=initial.entities.find((e:any)=>e.id===initial.player_state.entity_id),npc=initial.entities.find((e:any)=>e.id!==player.id&&e.components.character);
npc.components.identity.name='伊芙琳';npc.components.character={role:'成年学习伙伴与朋友',traits:['谨慎','不爱冒险','重视互相尊重']};npc.components.location=structuredClone(player.components.location);
const requests:any[]=[];
const fixture={name:'smoke',generate:async(req:any):Promise<any>=>{
 const props=req.schema.properties;
 if(props.destination)return {data:{destination:'WORLD_INTENT',confidence:.98,clarification:null,speech_target_id:npc.id,world_input:'你觉得呢？',resolved_input:null,end_conversation:false}};
 if(req.role==='narrator')return {data:{narrative:'她合上笔记本，抬头看你。',speaker:npc.id,dialogue:'我想先把刚才的事情想清楚。',choices:[],context_actions:[],patches:[],interaction:{target_id:npc.id,status:'active'}}};
 throw Error('No fixture response needed for this path');
}};
const provider=real?new AIProviderManager(root,config):fixture;
const ai=new AIRuntime({name:provider.name,providerInfo:()=>provider.providerInfo?.()??{provider:'fixture'},generate:async(req:any)=>{requests.push({role:req.role,has_character_context:req.prompt.includes('character_context'),has_recent_events:req.prompt.includes('recent_turns')});return provider.generate(req);}});
const store=new JsonStore(join(root,'save'));await store.write(initial);const service=new GameService(store,ai,world);
const server=createApp(service,resolve('dist/client'),undefined,join(root,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+(server.address() as any).port,token=(await(await fetch(base+'/api/session')).json()).token;
const report:any={mode:real?'real-provider':'deterministic',provider:real?config.provider:'fixture',directory:root,checks:[],stress:[]};
try{
 const tx=async()=>{const s=await service.current();return {request_id:randomUUID(),game_id:s.game_id,expected_revision:s.state_revision};};
 const post=async(path:string,body:any)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;};
 const done=(name:string)=>{report.checks.push(name);console.log('PASS '+name);};
 await post('action',{...await tx(),action:{type:'TALK',target_id:npc.id,parameters:{topic:'刚才的事情，你怎么看？'}}});assert.equal((await service.current()).interaction_context?.target_entity_id,npc.id);done('explicit TALK focus');
 const beforeFollowup=await service.current();await post('input',{...await tx(),input:'你觉得呢？'});const followed=await service.current();assert.equal(followed.interaction_context?.target_entity_id,npc.id);assert(followed.interaction_context.last_interaction_turn>beforeFollowup.interaction_context.last_interaction_turn);done('followup inherits focus');
 // Deterministic mode supplies only the semantic decision; execution uses the production System handler.
 const original=fixture.generate;if(!real)fixture.generate=async(req:any)=>(req.schema.properties.destination?{data:{destination:'SYSTEM_META_INTENT',confidence:1,clarification:null,speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false}}:original(req));
 const time=structuredClone((await service.current()).runtime.time);const style=await post('input',{...await tx(),input:'以后故事更文学一点'});assert.equal(style.intent,'SYSTEM_META_INTENT');assert.deepEqual((await service.current()).runtime.time,time);assert((await service.current()).behavior_config.length>0);done('world style request handed to System without time');
 fixture.generate=original;
 const beforeRight=await service.current();const right=await post('system',{...await tx(),input:'我过去问伊芙琳怎么了'});assert(right.category==='IN_WORLD_INPUT'||right.clarification);if(!right.clarification)assert((await service.current()).state_revision>beforeRight.state_revision,'World request did not execute');assert.deepEqual(await(await fetch(base+'/api/development/tasks')).json(),[]);done('System world request does not create development task');
 const before=await service.current();await post('action',{...await tx(),action:{type:'WAIT',parameters:{minutes:1}}});await post('undo',await tx());const restored=await service.current();assert.deepEqual(worldImage(restored),worldImage(before));assert(restored.state_revision>before.state_revision);done('atomic undo full world image');
 if(real){for(const input of ['我愤怒地推了伊芙琳一下。','我拦住伊芙琳的去路，质问她为什么躲开我。']){const result=await post('input',{...await tx(),input});const s=await service.current();report.stress.push({input,narrative:s.last_turn?.narrative,dialogue:s.last_turn?.dialogue,clarification:result.clarification??null});console.log('RECORDED stress continuity sample');}}
 if(process.argv.includes('--browser')){
   const {chromium,expect}=await import('@playwright/test');
   const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
   try{
     const page=await browser.newPage({viewport:{width:1440,height:1000}});
     await page.goto(base);await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
     const beforeBrowser=await service.current();await expect(page.getByRole('button',{name:'↶ 撤回上一步',exact:true})).toBeDisabled();
     await page.locator('#action').fill('我对伊芙琳说：「你好」');await page.getByRole('button',{name:'发送 →',exact:true}).click();
     const undo=page.getByRole('button',{name:'↶ 撤回上一步',exact:true});await expect(undo).toBeEnabled();
     page.on('dialog',dialog=>void dialog.accept());await undo.click();await expect(undo).toBeDisabled();
     assert.deepEqual(worldImage(await service.current()),worldImage(beforeBrowser));
     await page.getByRole('button',{name:'系统',exact:true}).click();
     await expect(page.locator('.system-panel .extension-panel h3')).toHaveCount(0);
     await expect(page.locator('.system-advanced')).not.toHaveAttribute('open','');
     await page.screenshot({path:join(root,'system-undo.png')});done('Chrome Undo and clean System default UI');
   }finally{await browser.close();}
 }
 report.requests=requests;report.status='passed';
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;console.error(report.error);}
finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log('Report: '+join(root,'report.json'));}

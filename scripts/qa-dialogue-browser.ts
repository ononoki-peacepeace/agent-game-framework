import {chromium,expect} from '@playwright/test';
import {once} from 'node:events';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';
const source=resolve('.tmp/qa-immediate-real-1792133500721');
const root=resolve(`.tmp/qa-dialogue-browser-${Date.now()}`);await mkdir(root,{recursive:true});
const save=JSON.parse(await readFile(join(source,'current.json'),'utf8'));
const store=new JsonStore(root);await store.write(save);
let calls=0;const attempts:any[]=[];const service=new GameService(store,new AIRuntime({name:'fixture',generate:async request=>{calls++;attempts.push({role:request.role,schema_keys:Object.keys((request.schema as any)?.properties??{})});throw Error('browser acceptance must not call Provider');}}),save.definition);
const server=createApp(service,resolve('dist/client')).listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results:any[]=[];
try{for(const width of [1366,390]){
 const page=await browser.newPage({viewport:{width,height:844}});let posts=0;
 page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/input'))posts++;});
 await page.goto(base);await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
 await expect(page.locator('.scene-performance')).toBeVisible();
 const expected=save.last_turn.scene_beats.filter((b:any)=>b.kind==='speech');
 await expect(page.locator('.scene-beat-speech')).toHaveCount(expected.length);
 for(const beat of expected)await expect(page.locator('.scene-beat-speech p').filter({hasText:beat.utterance})).toBeVisible();
 const complete=await page.locator('.scene-performance').innerText();
 for(const paragraph of save.last_turn.narrative.split(/\n\s*\n/).filter((p:string)=>!p.startsWith('“')))expect(complete).toContain(paragraph);
 expect(await page.locator('.scene-speaker .avatar').count()).toBeGreaterThan(0);
 expect(posts).toBe(0);await page.screenshot({path:join(root,`story-${width}.png`),fullPage:true});
 if(width===390){await page.locator('.scene-beat-speech').first().evaluate(el=>el.scrollIntoView({block:'center'}));await page.screenshot({path:join(root,'speech-mobile-viewport.png')});}
 results.push({width,speech_count:expected.length,full_prose:true,posts,passed:true});await page.close();
}}finally{await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await writeFile(join(root,'report.json'),JSON.stringify({results,fixture_generate_attempts:calls,real_provider_calls:0,attempts},null,2));console.log(JSON.stringify({root,results,fixture_generate_attempts:calls,real_provider_calls:0,attempts}));}

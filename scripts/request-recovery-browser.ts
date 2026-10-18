import {chromium,expect} from '@playwright/test';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {createApp} from '../src/server/app.js';
const fixture=await sparseSetup(),save=await fixture.service.current(),root=resolve(`.tmp/request-recovery-browser-${Date.now()}`);await mkdir(root,{recursive:true});
const server=createApp(fixture.service,resolve('dist/client')).listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 for(const width of [1366,390])for(const scenario of ['missing','manual-clear']){
  const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),id=randomUUID();let queries=0,posts=0;
  await context.addInitScript(({id,game})=>{if(!sessionStorage.getItem('test.marker.seeded')){
   sessionStorage.setItem('test.marker.seeded','1');sessionStorage.setItem('herne.pending.input',JSON.stringify({request_id:id,game_id:game,started_at:Date.now()}));
  }},{id,game:save.game_id});
  page.on('request',request=>{if(request.url().includes('/api/input/status/'+id))queries++;if(request.method()==='POST'&&request.url().endsWith('/api/input'))posts++;});
  if(scenario==='manual-clear')await page.route('**/api/input/status/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({state:'running',phase:'interpreting'})}));
  await page.goto(base);const enter=page.getByRole('button',{name:'继续当前世界',exact:true});await expect(enter).toBeVisible();
  if(scenario==='manual-clear'){
   await expect.poll(()=>queries).toBeGreaterThan(0);await expect(enter).toBeDisabled();
   await page.evaluate(()=>sessionStorage.removeItem('herne.pending.input'));
  }
  await expect(enter).toBeEnabled({timeout:15000});await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('herne.pending.input'))).toBeNull();
  const settled=queries;await page.waitForTimeout(5500);expect(queries).toBe(settled);
  await enter.click();await expect(page.locator('#action')).toBeEnabled();
  await page.screenshot({path:join(root,`${width}-${scenario}.png`),fullPage:true});
  await page.reload();await expect(enter).toBeEnabled();await page.waitForTimeout(1000);expect(queries).toBe(settled);expect(posts).toBe(0);
  console.log(JSON.stringify({width,scenario,queries,posts,passed:true}));await context.close();
 }
 console.log(root);
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}

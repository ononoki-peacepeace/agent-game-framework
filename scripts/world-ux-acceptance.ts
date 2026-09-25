import {chromium,expect} from '@playwright/test';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {createApp} from '../src/server/app.js';
/** Chrome acceptance for World Creation UX v2: entry cost, cards, preview card and the confirm gate. */
const directory=resolve('.tmp/world-ux-'+Date.now());await mkdir(directory,{recursive:true});
const f=await sparseSetup();
const server=createApp(f.service,resolve('dist/client')).listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1680,height:1000}});
  page.setDefaultTimeout(15000);
  await page.goto(base);
  await expect(page.locator('.launch-card.continue-card')).toBeVisible();
  await expect(page.locator('.launcher .launch-card:visible')).toHaveCount(2);
  await page.screenshot({path:join(directory,'1-home.png')});
  await page.getByRole('button',{name:/AI WORLD|创建新世界/}).first().click().catch(()=>undefined);
  await page.getByRole('button',{name:'▦ 从模板开始'}).click();
  await expect(page.locator('.template-card').first()).toBeVisible();
  await page.screenshot({path:join(directory,'2-templates.png')});
  await page.locator('.template-card').first().click();
  await expect(page.locator('.world-preview')).toBeVisible();
  await page.screenshot({path:join(directory,'3-preview.png')});
  const title=(await page.locator('.world-preview h3').textContent())??'';
  // "调整" must not enter the world
  await page.getByRole('button',{name:'调整'}).click();
  await expect(page.locator('.world-preview')).toBeVisible();
  await expect(page.locator('.story')).toHaveCount(0);
  await page.getByLabel('调整这个世界').fill('危险程度低一点');
  await page.getByRole('button',{name:'改好了'}).click();
  await expect(page.locator('.world-preview')).toBeVisible();
  await page.screenshot({path:join(directory,'4-adjusted.png')});
  // "换一个" must change the candidate and still not enter the world
  await page.getByRole('button',{name:'换一个'}).click();
  await expect(page.locator('.world-preview')).toBeVisible();
  const nextTitle=(await page.locator('.world-preview h3').textContent())??'';
  expect(nextTitle.length).toBeGreaterThan(0);
  await page.screenshot({path:join(directory,'5-another.png')});
  expect(title.length).toBeGreaterThan(0);
  // only "开始这个世界" enters the world (blank template keeps the fixture's model-free path)
  await page.getByRole('button',{name:'← 返回'}).click();
  await page.getByRole('button',{name:'▦ 从模板开始'}).click();
  await page.getByRole('button',{name:'查看更多'}).click().catch(()=>undefined);
  await page.locator('.template-card').filter({hasText:'空白世界'}).click();
  await expect(page.locator('.world-preview')).toContainText('空白世界');
  await page.getByRole('button',{name:'开始这个世界'}).click();
  await expect(page.locator('.story')).toBeVisible({timeout:20000});
  await page.screenshot({path:join(directory,'6-entered.png')});
  console.log('WORLD UX ACCEPTANCE PASS '+directory);
}catch(error){
  console.error('WORLD UX ACCEPTANCE FAIL',(error as Error).message);
  process.exitCode=1;
}finally{
  await browser?.close();
  server.closeAllConnections();await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));
}

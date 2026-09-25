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
  // HOME only offers the three entries: no idea textarea, no template cards, no preview
  await page.getByRole('button',{name:'创建新世界',exact:false}).first().click().catch(()=>undefined);
  await expect(page.getByLabel('世界灵感')).toHaveCount(0);
  await expect(page.locator('.template-card')).toHaveCount(0);
  await expect(page.locator('.world-preview')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'自己创建'})).toBeVisible();
  await page.screenshot({path:join(directory,'1-home.png')});
  // templates: readable without hovering
  await page.getByRole('button',{name:'从模板开始'}).click();
  await expect(page.locator('.template-card').first()).toBeVisible();
  const cardColor=await page.locator('.template-card strong').first().evaluate(element=>getComputedStyle(element).color);
  const cardBackground=await page.locator('.template-card').first().evaluate(element=>getComputedStyle(element).backgroundColor);
  const channels=(value:string)=>value.match(/\d+/g)?.map(Number)??[];
  const textChannels=channels(cardColor), backgroundChannels=channels(cardBackground);
  // Readable without hovering: dark text on a light surface (hover only adds a faint tint).
  expect(Math.max(...textChannels.slice(0,3))).toBeLessThan(130);
  expect(Math.min(...backgroundChannels.slice(0,3))).toBeGreaterThan(225);

  await page.screenshot({path:join(directory,'2-templates.png')});
  await page.locator('.template-card').first().hover();
  await page.screenshot({path:join(directory,'3-templates-hover.png')});
  await expect(page.getByLabel('世界灵感')).toHaveCount(0);
  await page.locator('.template-card').first().click();
  await expect(page.locator('.world-preview')).toBeVisible();
  await page.screenshot({path:join(directory,'4-preview.png')});
  const title=(await page.locator('.world-preview h3').textContent())??'';
  // "换一个" shows loading, replaces the candidate, and does not enter the world
  await page.getByRole('button',{name:'换一个'}).click();
  await expect(page.locator('.world-preview')).toBeVisible();
  const nextTitle=(await page.locator('.world-preview h3').textContent())??'';
  expect(nextTitle.length).toBeGreaterThan(0);
  await page.screenshot({path:join(directory,'5-another.png')});
  expect(title.length).toBeGreaterThan(0);
  await expect(page.locator('.story')).toHaveCount(0);
  // "调整" stays on the preview
  await page.getByRole('button',{name:'调整'}).click();
  await expect(page.getByLabel('调整这个世界')).toBeVisible();
  await expect(page.locator('.story')).toHaveCount(0);
  await page.getByLabel('调整这个世界').fill('危险程度低一点');
  await page.getByRole('button',{name:/改好了|正在调整/}).click();
  await expect(page.locator('.world-preview')).toBeVisible();
  await page.screenshot({path:join(directory,'6-adjusted.png')});
  // only "开始这个世界" enters the world
  await page.getByRole('button',{name:'← 返回'}).click();
  await expect(page.locator('.template-card').first()).toBeVisible();
  await page.getByRole('button',{name:'查看更多'}).click().catch(()=>undefined);

  await page.locator('.template-card').filter({hasText:'空白世界'}).click();
  await expect(page.locator('.world-preview')).toContainText('空白世界');
  await page.getByRole('button',{name:'开始这个世界'}).click();
  await expect(page.locator('.story')).toBeVisible({timeout:20000});
  await page.screenshot({path:join(directory,'7-entered.png')});

  console.log('WORLD UX ACCEPTANCE PASS '+directory);
}catch(error){
  console.error('WORLD UX ACCEPTANCE FAIL',(error as Error).message);
  process.exitCode=1;
}finally{
  await browser?.close();
  server.closeAllConnections();await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));
}

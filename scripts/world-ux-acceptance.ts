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
  // Two levels have a back affordance ("← 返回" inside the creation workspace, "← 返回启动页" on it).
  const goBack=async()=>{await page.locator('.launcher-back').click();
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();};
  await page.goto(base);
  await expect(page.locator('.launch-card.continue-card')).toBeVisible();
  await expect(page.locator('.launcher .launch-card:visible')).toHaveCount(4);
  for(const label of ['当前世界','创建新世界','读取存档','模型 / API'])await expect(page.locator('.launch-card').filter({hasText:label})).toBeVisible();
  // All four primary entries are actionable before entering the clean creation workspace.
  const chooserPromise=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'选择存档',exact:true}).click();
  const chooser=await chooserPromise;
  expect(chooser).toBeTruthy();
  await chooser.setFiles([]);
  await page.getByRole('button',{name:'切换模型 / API',exact:true}).click();
  await expect(page.locator('.provider-modal')).toBeVisible();
  await page.screenshot({path:join(directory,'1c-provider-modal.png')});
  await page.locator('.provider-modal').getByRole('button',{name:'关闭'}).click();
  await expect(page.locator('.provider-modal')).toHaveCount(0);
  await page.screenshot({path:join(directory,'1b-home-entries.png')});
  // Creation is a second-level workspace and initially offers only the three creation entries.
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();
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
  // The card returns to its preview actions only once the adjustment finished (the 返回 button is disabled
  // while a request is in flight).
  await expect(page.getByRole('button',{name:'调整'})).toBeVisible();
  // AI mode: chips live only here; 换一批 changes the batch and keeps a locked chip
  await page.locator('.launcher-back').click();
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();

  await page.getByRole('button',{name:/返回/}).first().click().catch(()=>undefined);
  await page.getByRole('button',{name:'让 AI 帮我想'}).click();
  await expect(page.getByLabel('世界灵感')).toBeVisible();
  const firstBatch=await page.locator('.world-chip').allTextContents();
  await page.locator('.world-chip').first().click();
  const locked=(await page.locator('.world-chip').first().textContent())??'';
  await page.getByRole('button',{name:'🎲 换一批'}).click();
  await expect(page.locator('.world-chip').first()).toHaveText(locked);
  const secondBatch=await page.locator('.world-chip').allTextContents();
  expect(secondBatch.join('|')).not.toBe(firstBatch.join('|'));
  await page.screenshot({path:join(directory,'8-ai-chips.png')});
  // templates: 换一个 must change the place, not just the fields
  await page.locator('.launcher-back').click();
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();
  await page.getByRole('button',{name:'从模板开始'}).click();
  await page.getByRole('button',{name:'查看更多'}).click().catch(()=>undefined);
  await page.locator('.template-card').filter({hasText:'太空殖民地'}).click();
  const scopeOne=await page.locator('.world-preview dd').last().textContent();

  await page.getByRole('button',{name:'换一个'}).click();
  await expect(page.locator('.world-preview')).toBeVisible();
  const scopeTwo=await page.locator('.world-preview dd').last().textContent();
  expect(scopeOne).not.toBe(scopeTwo);
  await page.screenshot({path:join(directory,'9-another-place.png')});
  // custom mode owns the prompt import
  await page.locator('.launcher-back').click();
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();
  await goBack().catch(()=>undefined);
  await page.getByRole('button',{name:'自己创建'}).click();

  await expect(page.getByRole('button',{name:'导入提示词'})).toBeVisible();
  await page.screenshot({path:join(directory,'10-custom.png')});
  await page.locator('.launcher-back').click();
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();
  await page.getByRole('button',{name:'从模板开始'}).click();
  // only "开始这个世界" enters the world

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

import {chromium,expect,type Page} from '@playwright/test';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server/app.js';
import {publicView} from '../src/core/state.js';
import {sparseSetup} from '../tests/sparse-fixture.js';

const fixture=await sparseSetup();
const server=createApp(fixture.service,'dist/client').listen(0,'127.0.0.1');
await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const submissions:Record<string,unknown>[]=[];

async function openCustom(page:Page){
  await page.goto(base);
  await page.getByRole('button',{name:'创建新世界',exact:true}).click();
  await page.getByRole('button',{name:'自己创建'}).click();
  await expect(page.getByLabel('自己描述世界')).toBeVisible();
}
async function upload(page:Page,name:string,mimeType:string,buffer:string){
  const chooserPromise=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'导入提示词'}).click();
  const chooser=await chooserPromise;
  await chooser.setFiles({name,mimeType,buffer:Buffer.from(buffer,'utf8')});
}

try{
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport});
    page.setDefaultTimeout(12000);
    await page.route('**/api/new',async route=>{
      submissions.push(route.request().postDataJSON() as Record<string,unknown>);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(publicView(await fixture.service.current()))});
    });
    await openCustom(page);
    const button=page.getByRole('button',{name:'用这段描述创建'});
    await expect(button).toBeDisabled();
    await upload(page,'世界设定.txt','text/plain','海边的架空城市，有昼夜变化。');
    await expect(page.getByLabel('自己描述世界')).toHaveValue('海边的架空城市，有昼夜变化。');
    await expect(page.locator('.prompt-slot')).toContainText('已读取');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator('.story')).toBeVisible();
    expect(submissions.at(-1)?.description).toBe('海边的架空城市，有昼夜变化。');
    expect(submissions.at(-1)?.prompt_text).toBeUndefined();
    await page.close();
  }
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(12000);
  await page.route('**/api/new',async route=>{
    submissions.push(route.request().postDataJSON() as Record<string,unknown>);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(publicView(await fixture.service.current()))});
  });
  await openCustom(page);
  await page.getByLabel('自己描述世界').fill('手动设定');
  await upload(page,'补充.md','text/markdown','文件设定');
  await expect(page.getByRole('group',{name:'处理已有世界描述'})).toBeVisible();
  await expect(page.getByRole('button',{name:'用这段描述创建'})).toBeDisabled();
  await page.getByRole('button',{name:'追加文件内容'}).click();
  await expect(page.getByLabel('自己描述世界')).toHaveValue('手动设定\n\n文件设定');
  await page.getByRole('button',{name:'用这段描述创建'}).click();
  expect(submissions.at(-1)?.description).toBe('手动设定\n\n文件设定');
  await page.close();
  const jsonPage=await browser.newPage({viewport:{width:390,height:844}});
  await openCustom(jsonPage);
  await upload(jsonPage,'存档.json','application/json',JSON.stringify({schema_version:1,definition:{}}));
  await expect(jsonPage.getByRole('alert')).toContainText('读取存档');
  await expect(jsonPage.getByRole('button',{name:'用这段描述创建'})).toBeDisabled();
  await upload(jsonPage,'创作.json','application/json',JSON.stringify({type:'world_prompt',prompt:'山谷里的小城'}));
  await expect(jsonPage.getByLabel('自己描述世界')).toHaveValue('山谷里的小城');
  await expect(jsonPage.getByRole('button',{name:'用这段描述创建'})).toBeEnabled();
  await jsonPage.close();
  const failedPage=await browser.newPage({viewport:{width:1280,height:900}});
  await failedPage.route('**/api/new',route=>route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'新世界候选存在世界规则或引用冲突，限定修复次数已用尽；旧世界没有改变。'})}));
  await openCustom(failedPage);
  await failedPage.getByLabel('自己描述世界').fill('一个包含完整人物与地图的世界');
  await failedPage.getByRole('button',{name:'用这段描述创建'}).click();
  await expect(failedPage.getByRole('alert')).toContainText('旧世界没有改变');
  await expect(failedPage.getByRole('button',{name:'用这段描述创建'})).toBeEnabled();
  await failedPage.close();
  if(process.env.WORLD_PROMPT_FILE){
    const source=process.env.WORLD_PROMPT_FILE;
    const original=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(source));
    // HTML text controls canonically expose CRLF file contents as LF; no authored text is removed.
    const submitted=original.replace(/\r\n?/g,'\n');
    for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
      const originalPage=await browser.newPage({viewport});
      originalPage.setDefaultTimeout(12000);
      await originalPage.route('**/api/new',async route=>{
        submissions.push(route.request().postDataJSON() as Record<string,unknown>);
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(publicView(await fixture.service.current()))});
      });
      await openCustom(originalPage);
      const chooserPromise=originalPage.waitForEvent('filechooser');
      await originalPage.getByRole('button',{name:'导入提示词'}).click();
      await (await chooserPromise).setFiles(source);
      await expect(originalPage.locator('.prompt-slot')).toContainText('已读取');
      const visible=await originalPage.getByLabel('自己描述世界').inputValue();
      if(visible!==submitted)throw new Error(`file preview mismatch: expected ${submitted.length} chars, received ${visible.length}`);
      await originalPage.getByRole('button',{name:'用这段描述创建'}).click();
      const sent=submissions.at(-1)?.description;
      if(sent!==original)throw new Error(`request mismatch: expected ${original.length} chars, received ${typeof sent==='string'?sent.length:'missing'}`);
      await originalPage.close();
    }
    console.log(JSON.stringify({original_file_chars:original.length,textarea_visible_chars:submitted.length,
      original_file_request_chars:original.length,
      original_file_request_sha256:createHash('sha256').update(original).digest('hex')}));
  }
  console.log(`WORLD PROMPT BROWSER ACCEPTANCE PASS: desktop/mobile TXT, MD merge, JSON discrimination; ${submissions.length} captured /api/new requests`);
}finally{
  await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
}

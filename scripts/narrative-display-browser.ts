import {chromium,expect} from '@playwright/test';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {createApp} from '../src/server/app.js';
import {agentResult} from '../src/agent/contracts.js';
import {gameOutcome} from '../src/agent/outcome.js';

// Isolated UI contract check: a committed story has one outlet, while feedback stays visible.
const fixture=await sparseSetup();
const app=createApp(fixture.service,resolve('dist/client'));
const server=app.listen(0,'127.0.0.1');
await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  for(const viewport of [{width:1366,height:768},{width:390,height:844}]){
    const page=await browser.newPage({viewport});
    const before=(await fixture.service.view())!;
    const story='你在广场停留片刻，树影仍落在石砖上。';
    const after={...before,revision:before.revision+1,time:{...before.time,minute:before.time.minute+5},
      last_turn:{...before.last_turn!,narrative:story}};
    const seen:string[]=[];
    await page.route('**/api/input',async route=>{
      const body=route.request().postDataJSON() as {input:string};seen.push(body.input);
      const result=seen.length===1?agentResult('WORLD_ACTION',story,{presentation:'story',
        outcome:gameOutcome('completed','narrative',after.revision,['wait'],['receipt-1']),view:after}):
        agentResult('WORLD_ACTION','请说明下一步。',{presentation:'assistant',
          outcome:gameOutcome('feedback','agent_response',after.revision),view:after});
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    await page.goto(base);
    await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
    await page.locator('#action').fill('等一会儿');
    await page.getByRole('button',{name:'发送 →'}).click();
    await expect(page.locator('.narrative')).toHaveText(story);
    await expect(page.locator('.agent-reply')).toHaveCount(0);
    await expect.poll(()=>seen.length).toBe(1);
    await page.locator('#action').fill('需要补充');
    await page.getByRole('button',{name:'发送 →'}).click();
    await expect(page.locator('.agent-reply')).toContainText('请说明下一步。');
    await expect.poll(()=>seen.length).toBe(2);
    console.log(`NARRATIVE DISPLAY PASS ${viewport.width}px`);
    await page.close();
  }
}finally{
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
}

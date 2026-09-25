import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory=resolve('data/browser-smoke-'+Date.now());await mkdir(directory,{recursive:true});
const port=3700+Math.floor(Math.random()*300),base='http://127.0.0.1:'+port;
const child=fork(resolve('dist/server/server/index.js'),[],{env:{...process.env,AI_ADAPTER:'mock',PORT:String(port),GAME_DATA_DIR:directory,GAME_WORLD_FILE:resolve('content/worlds/town.json'),PROMPT_PROFILE_PATH:resolve('content/profiles/default.json')},stdio:['ignore','pipe','pipe','ipc']});
let started=false,stderr='';child.stdout!.on('data',b=>{if(String(b).includes(base))started=true;});child.stderr!.on('data',b=>{stderr+=b;});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 for(let i=0;!started&&i<100;i++){if(child.exitCode!==null)throw new Error(stderr||'server exited');await new Promise(r=>setTimeout(r,100));}
 assert(started,'Own test server did not start');
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'选择 JSON 文件',exact:true}).waitFor();
 const importer=page.locator('input[type=file][accept=".json,application/json"]');
 await importer.setInputFiles(resolve('content/worlds/town.json'));await page.locator('.world-status').getByText('港湾日常',{exact:true}).waitFor();
 await page.getByRole('button',{name:'地图',exact:true}).click();
 await page.locator('article.map-location-card').filter({hasText:'街角商店'}).getByRole('button',{name:'前往',exact:true}).click();
 await page.getByRole('heading',{name:'街角商店',exact:true}).first().waitFor();
 await page.getByRole('button',{name:'商店',exact:true}).click();await page.getByRole('button',{name:'买入 · 6 点',exact:true}).click();
 await page.getByRole('button',{name:'商店',exact:true}).click();await page.locator('article.product').filter({hasText:'饮用水'}).getByText('库存 9 · 持有 1',{exact:true}).waitFor();
 await page.getByRole('button',{name:'卖出 · 3',exact:true}).click();
 const target=page.locator('article.context-entity').filter({hasText:'乔宁'});
 await target.getByRole('button',{name:'查看操作',exact:true}).click();await target.getByRole('button',{name:'交流',exact:true}).click();
 await page.locator('#action').fill('你好，今天店里怎么样？');await page.getByRole('button',{name:'确认并执行 →',exact:true}).click();
 await page.locator('.dialogue-card').waitFor();await page.screenshot({path:directory+'/desktop.png'});
 await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();await page.locator('.dialogue-card').waitFor();
 await page.getByRole('button',{name:'存档',exact:true}).click();await page.getByRole('button',{name:'保存检查点',exact:true}).click();
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'导出存档 JSON',exact:true}).click();
 await (await downloadEvent).saveAs(directory+'/export.json');
 await page.locator('.save-actions').getByRole('button',{name:'返回启动页',exact:true}).click();await importer.setInputFiles(directory+'/export.json');
 await page.locator('.world-status').getByText('港湾日常',{exact:true}).waitFor();assert.deepEqual(errors,[]);
 console.log('DESKTOP SMOKE PASS: public world import, MOVE/BUY/SELL/TALK, refresh, checkpoint and export/import. '+directory);
}finally{
 await browser?.close();if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.send('shutdown');await stopped;}
}

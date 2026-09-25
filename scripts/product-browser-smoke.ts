import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve('.tmp/product-browser-'+Date.now());await mkdir(directory,{recursive:true});
const world=JSON.parse(await readFile('content/worlds/town.json','utf8'));
world.enabled_modules.push('quests');
for(const location of world.map.locations)location.tags=[...(location.tags??[]),'casino','training'];
const fixture=resolve(directory,'world.json');await writeFile(fixture,JSON.stringify(world));
const port=4100+Math.floor(Math.random()*300),base='http://127.0.0.1:'+port;
const child=fork(resolve('dist/server/server/index.js'),[],{env:{...process.env,NODE_ENV:'production',AI_ADAPTER:'mock',PORT:String(port),GAME_DATA_DIR:directory,GAME_WORLD_FILE:fixture},stdio:['ignore','pipe','pipe','ipc']});
let started=false,stderr='';child.stdout!.on('data',b=>{if(String(b).includes(base))started=true;});child.stderr!.on('data',b=>stderr+=b);
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 for(let i=0;!started&&i<100;i++){if(child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,100));}assert(started);
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto(base);await page.getByRole('button',{name:'选择 JSON 文件',exact:true}).waitFor();
 await page.locator('input[type=file][accept=".json,application/json"]').setInputFiles(fixture);await page.locator('.world-status').getByText('港湾日常',{exact:true}).waitFor();
 const api=async(path:string,body?:unknown)=>page.evaluate(async({path,body})=>{const token=(await(await fetch('/api/session')).json()).token;const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result;},{path,body});
 await page.getByRole('button',{name:'生活模式',exact:true}).click();await expect(page.locator('.routine-panel-compose')).toContainText('生活计划：未设置');
 const before=await api('state');await page.getByRole('button',{name:'创建计划',exact:true}).click();await page.getByLabel('生活规则',{exact:true}).fill('每天正常休息和生活');await page.getByRole('button',{name:'保存计划',exact:true}).click();await expect(page.locator('.routine-panel-compose')).toContainText('生活计划：已保存');
 assert.deepEqual((await api('state')).time,before.time);assert.equal(await page.getByRole('button',{name:'这件事已经做完了'}).count(),0);
 await page.locator('#action').fill('我希望以后去银杯赌馆可以自己玩21点。');await page.getByRole('button',{name:'发送 →',exact:true}).click();await expect(page.locator('.extension-panel')).toContainText('需求：');
 await page.getByLabel('允许使用现有游戏货币下注（最高 20）').check();await page.getByRole('button',{name:'构建参考扩展',exact:true}).click();
 await page.getByRole('button',{name:'地图',exact:true}).click();await expect(page.locator('.panel')).toBeVisible();
 await page.getByRole('button',{name:'扩展',exact:true}).click();await page.getByRole('button',{name:'确认安装此版本',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'确认安装此版本',exact:true}).click();await expect(page.locator('.extension-panel')).toContainText('已启用');
 await page.locator('#action').fill('我在银杯玩21点。');await page.getByRole('button',{name:'发送 →',exact:true}).click();await page.getByRole('region',{name:'21 点牌桌'}).waitFor();
 await page.getByLabel('下注金额').fill('5');await page.getByRole('button',{name:'新一局',exact:true}).click();await expect(page.locator('.playing-card')).toHaveCount(4);
 const hand=(await api('export',{})).extensions.blackjack;
 await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();assert.deepEqual((await api('export',{})).extensions.blackjack,hand);
 await page.getByRole('button',{name:'扩展',exact:true}).click();await page.getByRole('button',{name:'查看玩法',exact:true}).click();
 if(await page.getByRole('button',{name:'要牌',exact:true}).count()){await page.getByRole('button',{name:'要牌',exact:true}).click();await expect(page.locator('.playing-card')).not.toHaveCount(4);}
 if(await page.getByRole('button',{name:'停牌',exact:true}).count()){await page.getByRole('button',{name:'停牌',exact:true}).click();await page.getByRole('button',{name:'新一局',exact:true}).waitFor();}
 await page.locator('.extension-panel>details>summary').click();await page.locator('.extension-panel select').selectOption('turn_based_combat');await page.getByRole('button',{name:'构建参考扩展',exact:true}).click();await page.getByRole('button',{name:'确认安装此版本',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'确认安装此版本',exact:true}).click();await page.locator('article.entity').filter({hasText:'回合制训练 0.1.0'}).getByRole('button',{name:'查看玩法',exact:true}).click();await page.getByRole('button',{name:'新一局',exact:true}).click();await page.getByRole('button',{name:'攻击',exact:true}).click();await page.getByRole('button',{name:'逃跑',exact:true}).click();await expect(page.locator('.minigame')).toContainText('撤退');
 await page.getByRole('button',{name:'日志',exact:true}).click();await page.locator('.log-panel').waitFor();await page.screenshot({path:directory+'/desktop.png'});
 // Generated chart makes crop changes observable.
 const imageData=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=1800;const x=c.getContext('2d')!;for(let y=0;y<1800;y+=60){x.fillStyle='hsl('+y/5+',70%,55%)';x.fillRect(0,y,600,60);x.fillStyle='#fff';x.fillRect(y%400,y,100,30);}return c.toDataURL('image/png').split(',')[1];});
 await page.getByRole('button',{name:'状态',exact:true}).click();await page.getByTitle('查看自己的角色详情',{exact:true}).click();assert.equal(await page.getByLabel('头像缩放',{exact:true}).count(),0);
 await page.locator('.visual-upload input').setInputFiles({name:'chart.png',mimeType:'image/png',buffer:Buffer.from(imageData,'base64')});await page.getByRole('button',{name:'调整头像',exact:true}).waitFor();
 await page.getByRole('button',{name:'调整头像',exact:true}).click();const slider=page.getByLabel('头像缩放',{exact:true});await expect(slider).toBeEnabled();assert(Number(await slider.getAttribute('max'))>10);
 const preview=()=>page.locator('.crop-preview').evaluate(c=>(c as HTMLCanvasElement).toDataURL());const originalPreview=await preview();await slider.fill('6');await expect(slider).toHaveValue('6');
 const stage=await page.locator('.crop-stage').boundingBox();assert(stage);await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.down();await page.mouse.move(stage.x+stage.width/2+45,stage.y+stage.height/2+35,{steps:5});await page.mouse.up();await page.mouse.wheel(0,-100);await page.waitForTimeout(100);assert.notEqual(await preview(),originalPreview);
 await page.screenshot({path:directory+'/crop-desktop.png'});await page.getByRole('button',{name:'确定',exact:true}).click();await page.getByRole('dialog',{name:'调整头像'}).waitFor({state:'hidden'});
 const savedCrop=(await api('export',{})).entities.find((e:any)=>e.id===before.player_id).components.visual_assets.avatar_crop;assert(savedCrop.scale>6);
 const originalAsset=await page.request.get(base+'/api/visual/'+encodeURIComponent(savedCrop.source_asset_id));assert.deepEqual(await originalAsset.body(),Buffer.from(imageData,'base64'));
 await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();await page.getByTitle('查看自己的角色详情',{exact:true}).click();await page.getByRole('button',{name:'调整头像',exact:true}).click();await expect(page.getByLabel('头像缩放',{exact:true})).toHaveValue(savedCrop.scale.toFixed(2));await page.getByRole('button',{name:'取消',exact:true}).click();
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));
 await phone.goto(base);await phone.getByRole('button',{name:'继续当前世界',exact:true}).click();await expect(phone.locator('#action')).toBeVisible();
 const noOverflow=async()=>assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'phone horizontal overflow');
 await noOverflow();const nav=phone.getByRole('navigation',{name:'手机快捷导航'});
 for(const label of ['人物','地图','背包']){await nav.getByRole('button',{name:label,exact:true}).tap();await expect(phone.locator('.sidebar')).toBeVisible();await noOverflow();}
 for(const label of ['任务','生活模式','日志','存档','扩展']){await nav.getByRole('button',{name:'更多',exact:true}).tap();await phone.getByRole('region',{name:'更多面板'}).getByRole('button',{name:label,exact:true}).tap();await expect(phone.locator('.sidebar')).toBeVisible();await noOverflow();}
 await phone.locator('article.entity').filter({hasText:'21 点 0.1.0'}).getByRole('button',{name:'查看玩法',exact:true}).tap();await phone.getByRole('button',{name:'新一局',exact:true}).tap();await expect(phone.locator('.playing-card')).toHaveCount(4);await noOverflow();await phone.screenshot({path:directory+'/phone.png'});
 await nav.getByRole('button',{name:'更多',exact:true}).tap();await phone.getByRole('region',{name:'更多面板'}).getByRole('button',{name:'状态',exact:true}).tap();await phone.getByTitle('查看自己的角色详情',{exact:true}).tap();await phone.getByRole('button',{name:'调整头像',exact:true}).tap();
 await expect(phone.getByLabel('头像缩放',{exact:true})).toBeEnabled();const touchStage=await phone.locator('.crop-stage').boundingBox();assert(touchStage);const x=touchStage.x+touchStage.width/2,y=touchStage.y+touchStage.height/2;
 const cdp=await mobile.newCDPSession(phone);const touch=(type:string,touchPoints:any[])=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints} as any);
 const touchPreview=()=>phone.locator('.crop-preview').evaluate(c=>(c as HTMLCanvasElement).toDataURL());const beforeTouch=await touchPreview();const oldZoom=Number(await phone.getByLabel('头像缩放',{exact:true}).inputValue());
 await touch('touchStart',[{x:x-35,y,id:1},{x:x+35,y,id:2}]);await touch('touchMove',[{x:x-65,y,id:1},{x:x+65,y,id:2}]);await touch('touchEnd',[]);await phone.waitForTimeout(150);assert(Number(await phone.getByLabel('头像缩放',{exact:true}).inputValue())>oldZoom,'native touch pinch zoom');
 await touch('touchStart',[{x,y,id:1}]);await touch('touchMove',[{x:x+25,y:y+30,id:1}]);await touch('touchEnd',[]);await phone.waitForTimeout(100);assert.notEqual(await touchPreview(),beforeTouch);await phone.screenshot({path:directory+'/crop-phone.png'});await phone.getByRole('button',{name:'取消',exact:true}).tap();await noOverflow();
 await phone.evaluate(async()=>{await navigator.serviceWorker.ready;});await phone.reload();await phone.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const cached=await phone.evaluate(async()=>{const out:string[]=[];for(const key of await caches.keys())for(const req of await(await caches.open(key)).keys())out.push(new URL(req.url).pathname);return out;});assert(cached.includes('/offline.html'));assert(!cached.some(p=>p.startsWith('/api/')));
 await mobile.setOffline(true);await phone.reload();await expect(phone.getByText('暂时无法连接游戏服务',{exact:true})).toBeVisible();await mobile.setOffline(false);
 assert.deepEqual(errors,[]);await writeFile(directory+'/results.json',JSON.stringify({passed:true,viewport:'390x844',checks:['routine save without time advance','natural extension request','background build while navigating','explicit install','blackjack hit stand refresh','production logs','phone navigation and blackjack touch','desktop crop drag wheel live preview persisted metadata original unchanged','native mobile touch drag and pinch','PWA network-only API and offline notice'],cached},null,2));
 console.log('PRODUCT BROWSER PASS '+directory);
}finally{await browser?.close();if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.send('shutdown');await done;}}

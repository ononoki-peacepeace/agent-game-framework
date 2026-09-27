import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {manifestFrom,type ExtensionSpec} from '../src/extensions/schema.js';
import {createApp} from '../src/server/app.js';
const close=async(server:any)=>{server.closeAllConnections();await new Promise<void>((done,reject)=>server.close((error?:Error)=>error?reject(error):done()));};
const tx=async(service:any)=>{const save=await service.current();return {game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID()};};
const root=await mkdtemp(join(tmpdir(),'agf-character-host-')),development=join(root,'extensions'),assets=join(root,'assets');
const fixture=await sparseSetup(),host=new ExtensionHost(fixture.service,development);
const spec:ExtensionSpec={extension_id:'character_morale',name:'人物士气',description:'每个人物独立保存士气。',template:'declarative',allow_betting:false,max_stake:0,healing_item_id:null,fields:[{key:'morale',label:'士气',type:'number',initial:50,scope:'entity'}],declarative_actions:[{id:'raise_morale',label:'提升士气',op:'increment',field:'morale',value:10}],surfaces:[{id:'morale_character',kind:'contextual_panel',title:'人物士气',visibility:'always',host:'character_detail'}]};
const manifest=manifestFrom(spec,'0.1.0','browser acceptance');await host.approve(manifest);await host.install(await tx(fixture.service),manifest);
const server=createApp(fixture.service,resolve('dist/client'),undefined,assets).listen(0,'127.0.0.1');await once(server,'listening');let browser:Awaited<ReturnType<typeof chromium.launch>>|null=null;
try{
 const base='http://127.0.0.1:'+(server.address() as any).port;browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const enter=async()=>{await page.goto(base);await page.getByRole('button',{name:'继续当前世界',exact:true}).click();await page.getByRole('button',{name:'人物',exact:true}).click();};
 await enter();await page.getByRole('complementary').getByRole('button',{name:'林舟',exact:true}).first().click();const lin=page.getByRole('region',{name:'扩展人物属性'});await expect(lin.getByText('士气',{exact:true})).toBeVisible();await expect(lin.getByText('50',{exact:true})).toBeVisible();await lin.getByRole('button',{name:'提升士气',exact:true}).click();await expect(lin.getByText('60',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'← 返回',exact:true}).click();await page.getByRole('complementary').getByRole('button',{name:'乔宁',exact:true}).first().click();const qiao=page.getByRole('region',{name:'扩展人物属性'});await expect(qiao.getByText('50',{exact:true})).toBeVisible();
 await host.manage('character_morale',await tx(fixture.service),'disable');await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();await page.getByRole('button',{name:'人物',exact:true}).click();await page.getByRole('complementary').getByRole('button',{name:'林舟',exact:true}).first().click();await expect(page.getByRole('region',{name:'扩展人物属性'})).toHaveCount(0);
 await host.manage('character_morale',await tx(fixture.service),'enable');await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();await page.getByRole('button',{name:'人物',exact:true}).click();await page.getByRole('complementary').getByRole('button',{name:'林舟',exact:true}).first().click();await expect(page.getByRole('region',{name:'扩展人物属性'}).getByText('60',{exact:true})).toBeVisible();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',character_host_dom:'PASS',entity_isolation:'PASS',disable_hides:'PASS',enable_restores:'PASS',reload_persists:'PASS'},null,2));
}finally{if(browser)await browser.close();await close(server);await rm(root,{recursive:true,force:true});}




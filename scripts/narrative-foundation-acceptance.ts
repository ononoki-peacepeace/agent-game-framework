import {chromium,expect} from '@playwright/test';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../src/server/app.js';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {addArc,ensureNarrativeState} from '../src/narrative/runtime.js';

const root=await mkdtemp(join(tmpdir(),'agf-narrative-browser-')),shots=join(root,'screens');await mkdir(shots,{recursive:true});
const fixture=await sparseSetup(),save=await fixture.service.current(),state=ensureNarrativeState(save);
save.gm_state.hidden_truth={version:1,commitments:[{id:'secret_origin',commitment:'HARD_TRUTH',statement:'CANARY_HIDDEN_ORIGIN',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,evidence:[],known_by:[]}]};
addArc(save,{id:'harbor_mystery',title:'港口失踪事件',status:'ACTIVE',summary:'调查港口附近持续发生的失踪。',canonical_event_refs:[],truth_refs:['secret_origin'],participant_refs:[],closure_priority:.5,reveal_step:0,accelerated_closure:false,last_meaningful_revision:save.state_revision});
for(const [id,title] of [['dock_strike','码头罢工'],['old_debt','旧日债务'],['incoming_storm','正在逼近的风暴']] as const)addArc(save,{id,title,status:'ACTIVE',summary:'由当前世界局势真实形成。',canonical_event_refs:[],truth_refs:[],participant_refs:[],closure_priority:.4,reveal_step:0,accelerated_closure:false,last_meaningful_revision:save.state_revision});
state.current_saga={id:'harbor_year',title:'港湾之年',start_time:{day:1,minute:0},phase:'DEVELOPING',arc_refs:['harbor_mystery'],canonical_event_refs:[]};
save.narrative_state=state;await fixture.service.storage.write(save);
const server=createApp(fixture.service,resolve('dist/client'),undefined,join(root,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
let browser:Awaited<ReturnType<typeof chromium.launch>>|null=null;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});const base='http://127.0.0.1:'+(server.address() as any).port;
 const desktop=await browser.newPage({viewport:{width:1366,height:768}}),errors:string[]=[];desktop.on('pageerror',error=>errors.push(error.message));await desktop.goto(base);
 await desktop.getByRole('button',{name:'创建新世界',exact:true}).click();await desktop.getByRole('button',{name:'自己创建'}).click();await expect(desktop.getByLabel('人生长度')).toBeVisible();await desktop.getByLabel('人生长度').selectOption('custom');await expect(desktop.getByLabel('自定义人生参考年龄')).toBeVisible();await desktop.getByLabel('自定义人生参考年龄').fill('90');await desktop.getByLabel('故事尺度').selectOption('life_chapter');await desktop.getByLabel('叙事模式').selectOption('story_focused');await desktop.screenshot({path:join(shots,'01-creation-life-horizon.png'),fullPage:true});await desktop.getByRole('button',{name:'← 返回',exact:true}).click();
 await desktop.getByRole('button',{name:'← 返回启动页',exact:true}).click();await desktop.getByRole('button',{name:'继续当前世界',exact:true}).click();await desktop.locator('.desktop-panel-nav').getByRole('button',{name:'故事',exact:true}).click();await expect(desktop.locator('.sidebar-scroll')).toContainText('港湾之年');await expect(desktop.locator('.sidebar-scroll')).toContainText('港口失踪事件');await expect(desktop.locator('body')).not.toContainText('CANARY_HIDDEN_ORIGIN');await desktop.screenshot({path:join(shots,'02-story-record-desktop.png'),fullPage:true});
 const storyCommand=async(text:string,expected:string)=>{await desktop.locator('#action').fill(text);await desktop.getByRole('button',{name:'发送 →',exact:true}).click();await expect(desktop.locator('.story .narrative')).toContainText(expected);};
 await storyCommand('先放一放这条故事','暂时搁置');await expect(desktop.locator('.sidebar-scroll')).toContainText('暂时搁置');await storyCommand('我想继续以前那条故事','重新成为当前焦点');await storyCommand('我想赶快把这个故事收尾','加速收束');await expect(desktop.locator('.sidebar-scroll')).toContainText('正在收束');await storyCommand('我现在就想开一个新的大故事','焦点会更分散');await storyCommand('这条故事我不想管了','不再参与');
 await desktop.locator('.desktop-panel-nav').getByRole('button',{name:'系统',exact:true}).click();await desktop.locator('.system-advanced summary').click();await desktop.getByRole('button',{name:'读取叙事诊断',exact:true}).click();await expect(desktop.getByLabel('叙事诊断')).toContainText('HARD_TRUTH');await expect(desktop.getByLabel('叙事诊断')).not.toContainText('CANARY_HIDDEN_ORIGIN');
 const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});phone.on('pageerror',error=>errors.push(error.message));await phone.goto(base);await phone.getByRole('button',{name:'继续当前世界',exact:true}).tap();await phone.getByRole('navigation',{name:'手机快捷导航'}).getByRole('button',{name:'更多',exact:true}).tap();await phone.getByRole('region',{name:'更多面板'}).getByRole('button',{name:'故事',exact:true}).tap();await expect(phone.locator('.sidebar-scroll')).toContainText('港湾之年');await expect(phone.locator('body')).not.toContainText('CANARY_HIDDEN_ORIGIN');await phone.screenshot({path:join(shots,'03-story-record-mobile.png'),fullPage:true});
 const overflow=await Promise.all([desktop,phone].map(page=>page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)));if(overflow.some(value=>value>1))throw Error('Horizontal overflow: '+JSON.stringify(overflow));if(errors.length)throw Error(errors.join('\n'));
 console.log('NARRATIVE FOUNDATION BROWSER PASS '+root);
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));if(process.env.KEEP_QA_ARTIFACTS!=='1')await rm(root,{recursive:true,force:true});}

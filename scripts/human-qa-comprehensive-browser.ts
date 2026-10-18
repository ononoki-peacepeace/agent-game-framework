import {chromium,expect} from '@playwright/test';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {createApp} from '../src/server/app.js';

const root=await mkdtemp(join(tmpdir(),'agf-human-qa-closure-'));
const f=await sparseSetup(),save=await f.service.current();
const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
npc.components.identity.name='角色甲';npc.components.identity.avatar_id='qa-avatar';
npc.components.location=structuredClone(player.components.location);
const other=structuredClone(npc);other.id='qa_other';other.components.identity.name='角色乙';delete other.components.identity.avatar_id;save.entities.push(other);
player.components.scene_position={label:'门口'};
await f.store.write(save);
f.ai.narrate=async()=>({narrative:'你与眼前的人交谈了一会儿。',speaker:npc.id,dialogue:'我听见了。',choices:[],context_actions:[{target_id:npc.id,label:'询问眼前情况',intent:'我向角色甲询问眼前情况',family:'communicate',category:'请教'}],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
for(let i=0;i<3;i++){const before=await f.service.current();await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'TALK',target_id:npc.id,parameters:{topic:'第'+i+'次'}}});}
const server=createApp(f.service,resolve('dist/client'),undefined,join(root,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
let browser:Awaited<ReturnType<typeof chromium.launch>>|null=null;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const desktop=await browser.newPage({viewport:{width:1366,height:768}});desktop.on('dialog',dialog=>void dialog.accept());
 await desktop.goto(base);await desktop.getByRole('button',{name:'继续当前世界',exact:true}).click();
 const parent=save.definition.map?.locations.find(location=>location.id===player.components.location?.location_id)?.name??'';
 await expect(desktop.locator('.scene-heading h2')).toContainText(parent+' · 门口');
 await expect(desktop.locator('.sidebar-scroll .mini-card').filter({hasText:'地点'})).toContainText(parent);
 await expect(desktop.locator('.sidebar-scroll .mini-card').filter({hasText:'区域'})).toContainText('门口');
 await desktop.locator('.context-entity').first().getByRole('button',{name:'查看操作'}).click();
 await expect(desktop.locator('.context-entity').first().getByRole('button',{name:'请教'})).toBeVisible();
 await expect(desktop.locator('.context-entity').first().getByRole('button',{name:'观察',exact:true})).toHaveCount(0);
 await desktop.locator('.context-entity').first().getByRole('button',{name:'请教'}).click();
 await expect(desktop.getByRole('button',{name:'询问眼前情况'})).toBeVisible();
 await desktop.locator('.desktop-panel-nav').getByRole('button',{name:'人物'}).click();
 const card=desktop.locator('.character-card').filter({hasText:'角色甲'}),remove=card.locator('.avatar-remove-icon');
 await expect(remove).toHaveCSS('opacity','0');await card.hover();await expect(remove).toHaveCSS('opacity','1');
 await desktop.locator('.scene-heading h2').click();await remove.focus();await expect(remove).toHaveCSS('opacity','1');
 await desktop.locator('.desktop-panel-nav').getByRole('button',{name:'状态'}).click();
 const undo=desktop.getByRole('button',{name:'撤回上一步'});
 for(let i=0;i<3;i++){await expect(undo).toBeEnabled();await undo.click();await expect(desktop.locator('.scene-heading-meta small')).toContainText('REV');}
 await expect(undo).toBeDisabled();
 const beforeMobile=await f.service.current();await f.service.turn({request_id:randomUUID(),game_id:beforeMobile.game_id,expected_revision:beforeMobile.state_revision,action:{type:'TALK',target_id:npc.id,parameters:{topic:'手机验收'}}});
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const phone=await mobile.newPage();
 phone.on('dialog',dialog=>void dialog.accept());
 await phone.goto(base);await phone.getByRole('button',{name:'继续当前世界',exact:true}).tap();
 await phone.locator('.context-entity').first().getByRole('button',{name:'查看操作'}).tap();
 await phone.locator('.context-entity').first().getByRole('button',{name:'请教'}).tap();await expect(phone.getByRole('button',{name:'询问眼前情况'})).toBeVisible();
 const phoneUndo=phone.getByRole('button',{name:'撤回上一步'});await expect(phoneUndo).toBeEnabled();await phoneUndo.tap();await expect(phoneUndo).toBeDisabled();
 await phone.getByRole('navigation',{name:'手机快捷导航'}).getByRole('button',{name:'人物'}).tap();
 const phoneCard=phone.locator('.character-card').filter({hasText:'角色甲'});
 await expect(phoneCard.getByRole('button',{name:'移除 角色甲 的头像'})).toBeVisible();
 await expect(phone.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).resolves.toBeLessThanOrEqual(1);
 console.log('HUMAN QA COMPREHENSIVE BROWSER PASS desktop/mobile; isolated fixture');
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}

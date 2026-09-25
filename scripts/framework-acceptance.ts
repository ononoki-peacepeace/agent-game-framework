import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {createApp} from '../src/server/app.js';
const directory=resolve('.tmp/framework-acceptance-'+Date.now());await mkdir(directory,{recursive:true});
const f=await sparseSetup(),save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
const npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;npc.components.identity.name='梅芙';npc.components.location=structuredClone(player.components.location);
const friend=structuredClone(npc);friend.id='fixture_friend';friend.components.identity.name='伊芙琳';friend.components.character.role='玩家熟悉的朋友';save.entities.push(friend);
player.components.relationships={entries:{}};save.last_turn={narrative:'隔离验收场景',speaker:null,dialogue:null,choices:[],context_actions:[]};await f.store.write(save);
let failOnce=true;
const milestone={id:'slice',title:'输入与状态边界验证',kind:'behavior',acceptance:['只提交允许的状态变化']};
const gap={required_capability:'input.subscription',why_needed:'连续输入需要订阅生命周期',affected_modules:['extension host'],current_limitation:'只支持离散动作',proposed_generic_capability:'可取消、限频的输入订阅和位置事务',risk:'并发与监听释放'};
f.ai.adapter.generate=async req=>{
 const props=(req.schema as any).properties;
 if(props.facts){const body=JSON.parse(req.prompt.slice(req.prompt.indexOf('{"input"'))),punch=body.input.includes('拳');return {data:{narrative:punch?'你挥出一拳，梅芙退后捂住脸颊。':'你走出门，停在屋外。',minutes:1,target_id:punch?npc.id:null,facts:[punch?'发生肢体冲突。':'走到屋外。'],relationship:null}};}
 if(props.normalized_requirements){const input=JSON.parse(req.prompt.slice(req.prompt.indexOf('{"requirements"'))).requirements.join(' ');
 const high=/键盘/.test(input);return {data:{normalized_requirements:[input],complexity:high?'HIGH':'MEDIUM',clarification:high||input.includes('开关')?null:'请说明游戏规则和结束条件。',milestones:high?[milestone,{...milestone,id:'integration',title:'持久化与恢复验证',kind:'integration'}]:[milestone],capability_gaps:[]}};}
 if(props.spec){
 const context=JSON.parse(req.prompt.slice(req.prompt.indexOf('{"extension_id"')));
 if(context.requirements.join(' ').includes('开关'))return {data:{spec:{extension_id:context.extension_id,name:'验收开关',description:'保存一个自有开关',template:'declarative',allow_betting:false,max_stake:0,healing_item_id:null,fields:[{key:'enabled',type:'flag',initial:false}],declarative_actions:[{id:'toggle',label:'切换',op:'toggle',field:'enabled'}],surfaces:[{id:'switch_panel',kind:'panel',title:'验收开关',visibility:'always'}]},capability_gaps:[]}};
 if(failOnce){failOnce=false;return {data:{spec:{invalid:true},capability_gaps:[]}};}return {data:{spec:null,capability_gaps:[gap]}};}

 throw Error('unexpected fixture model request');
};
const server=createApp(f.service,resolve('dist/client'),undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto(base);await page.getByRole('button',{name:'继续当前世界',exact:true}).click();
 const send=async(text:string)=>{await page.locator('#action').fill(text);await page.getByRole('button',{name:'发送 →',exact:true}).click();await expect(page.locator('#action')).toBeEnabled();};
 await send('狠狠揍梅芙一拳');await expect(page.locator('.narrative')).toContainText('挥出一拳');await expect(page.locator('.agent-reply')).toHaveCount(0);
 const afterPunch=await f.service.current();assert.equal(afterPunch.action_facts!.length,1);
 await send('我出门到屋外。');await expect(page.locator('.narrative')).toContainText('屋外');assert.deepEqual((await f.service.current()).map_state,save.map_state);
 await send('我和伊芙琳是什么关系？');const card=page.locator('.relationship-card[data-entity-id="fixture_friend"]');
 await expect(card).toHaveClass(/entity-highlight/);await expect(card).toBeFocused();await expect(card).toContainText('朋友');await page.screenshot({path:join(directory,'relationship.png')});
 await send('我出门到屋外。');await expect(page.locator('.entity-highlight')).toHaveCount(0);await expect(page.locator('.agent-reply')).toHaveCount(0);await expect(page.locator('.relationship-card').first()).toBeVisible();
 const empty=await f.ai.initialize('EMPTY_WORLD',save.definition.prompt_profile);assert.deepEqual(empty.definition.enabled_modules,['core']);assert.equal(empty.entities.length,1);assert.equal(empty.last_turn!.narrative,'');
 const api=async(path:string,body?:unknown)=>{const token=(await(await fetch(base+'/api/session')).json()).token;const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();assert(r.ok,JSON.stringify(value));return value;};
 const waitTask=async(id:string)=>{for(let n=0;n<150;n++){const t=await api('development/tasks/'+id);if(!['planning','developing','testing','repairing'].includes(t.status))return t;await new Promise(r=>setTimeout(r,100));}throw Error('task timeout');};
 const beforeArchive=await f.service.current();
 if(!beforeArchive.definition.enabled_modules.includes('quests'))await f.service.manageModule({module:'quests',confirmed:true,game_id:beforeArchive.game_id,expected_revision:beforeArchive.state_revision,request_id:randomUUID()},'enable');
 const archiveSave=await f.service.current(),archivePlayer=archiveSave.entities.find(e=>e.id===archiveSave.player_state.entity_id)!;
 archivePlayer.components.quests={entries:Object.fromEntries(['completed','cancelled','failed'].map((status,i)=>['archive_'+i,{title:'验收任务'+i,status,summary:'保留历史',objectives:[],deadline:null,tags:[],metadata:{}}]))};await f.store.write(archiveSave);
 await page.reload();await page.getByRole('button',{name:'继续当前世界',exact:true}).click();await page.getByRole('button',{name:'任务',exact:true}).click();
 await page.locator('.quest-section').first().getByText('已结束（3）',{exact:true}).click();
 await page.locator('.quest-card').filter({hasText:'验收任务0'}).getByRole('button',{name:'隐藏归档'}).click();
 await expect(page.locator('.quest-card').filter({hasText:'验收任务0'})).toHaveCount(0);
 await page.getByLabel('显示已隐藏任务').check();await page.locator('.quest-card').filter({hasText:'验收任务0'}).getByRole('button',{name:'恢复显示'}).click();
 await expect(page.locator('.quest-card').filter({hasText:'验收任务0'})).toBeVisible();
 assert.deepEqual((await f.service.current()).entities.find(e=>e.id===archiveSave.player_state.entity_id)!.components.quests,archivePlayer.components.quests);

 await page.getByRole('button',{name:'系统',exact:true}).click();await page.getByLabel('系统请求',{exact:true}).fill('加入赌博小游戏');await page.getByRole('button',{name:'发送',exact:true}).click();
 // A product idea is shaped by one experience question first; "我不知道，你帮我选" then produces the MVP plan.
 await expect(page.locator('.feature-guide')).toContainText('正在完善这个想法');
 await page.getByRole('button',{name:'我不知道，你帮我选',exact:true}).click();
 await expect(page.locator('.feature-guide')).toContainText('开始制作');
 await page.getByRole('button',{name:'开始制作',exact:true}).click();

 await expect(page.locator('.development-panel')).toContainText('等待你补充');let tasks=await api('development/tasks'),t=tasks.at(-1);assert.equal(t.status,'waiting_for_user');assert.equal(t.artifacts.length,0);
 await page.getByLabel('系统请求',{exact:true}).fill('第一版太简单，继续改');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect.poll(async()=>(await api('development/tasks/'+t.id)).revision).toBe(2);const revision=await waitTask(t.id);assert.equal(revision.workspace,t.workspace);assert.equal(revision.extension_id,t.extension_id);
 await page.getByRole('button',{name:'结束当前开发对话',exact:true}).click();await page.getByLabel('系统请求',{exact:true}).fill('希望通过键盘在地图上移动角色');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.locator('.development-panel')).toContainText('等待审阅');tasks=await api('development/tasks');const high=await waitTask(tasks.at(-1).id);
 assert.equal(high.complexity,'HIGH');assert(high.milestones.length>=2);assert(high.test_results.some((r:any)=>!r.passed));assert.equal(high.status,'waiting_for_core_approval');
 await page.getByRole('button',{name:'批准核心开发提案',exact:true}).click();await expect(page.locator('.development-panel')).toContainText('核心接口仍需单独开发');
 await page.screenshot({path:join(directory,'development.png')});
 await page.getByLabel('开发任务',{exact:true}).selectOption('');
 await page.getByLabel('开发要求',{exact:true}).fill('增加一个可切换的开关');await page.getByRole('button',{name:'开始开发',exact:true}).click();
 await page.getByRole('button',{name:'确认安装候选',exact:true}).waitFor({timeout:30000});
 const candidate=(await api('development/tasks')).at(-1);assert.equal(candidate.status,'ready_for_preview');
 await page.screenshot({path:join(directory,'candidate-preview.png')});
 await page.getByRole('button',{name:'确认安装候选',exact:true}).click();await expect.poll(async()=>(await api('development/tasks/'+candidate.id)).status).toBe('installed');
 await page.getByLabel('开发要求',{exact:true}).fill('第一版太简单，继续改开关界面标题');await page.getByRole('button',{name:'提交修改要求',exact:true}).click();
 await page.getByRole('button',{name:'确认安装候选',exact:true}).waitFor({timeout:30000});
 const revisedCandidate=await api('development/tasks/'+candidate.id);assert.equal(revisedCandidate.workspace,candidate.workspace);assert.notEqual(revisedCandidate.current_version,candidate.current_version);
 await page.getByRole('button',{name:'确认安装候选',exact:true}).click();await expect.poll(async()=>(await api('development/tasks/'+candidate.id)).status).toBe('installed');
 await page.getByText('已安装功能',{exact:true}).click();
 const installedCard=page.locator('.extension-panel article.entity').filter({hasText:'验收开关'});
 await installedCard.getByRole('button',{name:'查看玩法',exact:true}).click();await page.locator('.minigame').getByRole('button',{name:'切换',exact:true}).click();
 await expect(page.locator('.minigame')).toContainText('true');
 await installedCard.getByRole('button',{name:'回滚',exact:true}).click();await expect(page.locator('.minigame')).toContainText('false');

 assert.deepEqual(errors,[]);
 await writeFile(join(directory,'results.json'),JSON.stringify({passed:true,mode:'real Chrome + real HTTP + deterministic model fixtures',Y1:'punch story, no assistant',Y2:'local outdoor position, no map change',Y3:'profile-only relationship focused/scrolled/highlighted',Y4:'empty shell zero world content',Y5:'durable task requests missing rules, no default game',Y6:'same task/workspace revised; product preview, install, candidate revision, installed update, action and rollback verified in browser',Y7:'high complexity, milestones, injected failure, bounded repair, capability gap and explicit proposal approval',manual_acceptance:false,live_model_validation:false},null,2));console.log('FRAMEWORK ACCEPTANCE PASS '+directory);
}finally{await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}

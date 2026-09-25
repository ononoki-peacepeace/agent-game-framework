import {it,expect} from 'vitest';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {ExtensionDevelopment} from '../src/extensions/development.js';
import {manifestFrom} from '../src/extensions/schema.js';
import {verifyReference} from '../src/extensions/verification.js';
import {extensionIntent} from '../src/extensions/intent.js';
const spec={extension_id:'blackjack',name:'21 点',description:'参考玩法',template:'blackjack' as const,allow_betting:true,max_stake:20,healing_item_id:null,fields:[],declarative_actions:[],surfaces:[]};

async function setup(){const fixture=await sparseSetup();const s=await fixture.service.current();s.definition.map!.locations.find(l=>l.id==='square')!.tags.push('casino','training');s.entities.find(e=>e.id===s.player_state.entity_id)!.components.location.location_id='square';await fixture.store.write(s);const dir=await mkdtemp(join(tmpdir(),'agf-extension-'));const host=new ExtensionHost(fixture.service,dir);return {...fixture,host,dir};}
const tx=async(service:any)=>{const s=await service.current();return {game_id:s.game_id,expected_revision:s.state_revision,request_id:randomUUID()};};
async function ready(dev:ExtensionDevelopment){for(let i=0;i<1000;i++){const j=(await dev.get())!;if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,20));}throw Error('build timeout');}
it('reference templates use valid decks and deterministic program rules',()=>{expect(verifyReference(spec)).toHaveLength(3);expect(verifyReference({...spec,template:'turn_based_combat'})).toHaveLength(3);});
it('blackjack settles once, hides dealer card and refuses foreign/canonical writes',async()=>{
 const {host,service,dir}=await setup();const manifest=manifestFrom(spec,'0.1.0','test');await host.approve(manifest);await host.install(await tx(service),manifest);
 const before=await service.current(),balance=Number((before.entities[0].components.wallet.balances as any).credit),request={...await tx(service),action:{type:'start',stake:10,currency:'credit'}};
 await host.act('blackjack',request);const first=await service.current();await host.act('blackjack',request);expect(await service.current()).toEqual(first);
 const saved=first.extensions!.blackjack.state as any;expect(saved.deck.length+saved.player.length+saved.dealer.length).toBe(52);
 const restarted=new ExtensionHost(service,dir);expect((await restarted.list())[0].state).toEqual((await host.list())[0].state);
 if(saved.phase==='playing'){expect(((await host.list())[0].state as any).dealer[1]).toBeNull();const finish={...await tx(service),action:{type:'stand'}};await host.act('blackjack',finish);const completed=await service.current();await host.act('blackjack',finish);expect(await service.current()).toEqual(completed);await expect(host.act('blackjack',{...await tx(service),action:{type:'stand'}})).rejects.toThrow('没有进行中');}
 const after=await service.current();expect([balance-10,balance,balance+10]).toContain(Number((after.entities[0].components.wallet.balances as any).credit));
 await expect(host.act('blackjack',{...await tx(service),action:{type:'start',stake:10,currency:'credit',wallet_delta:999}})).rejects.toThrow();
 await expect(host.act('other',{...await tx(service),action:{type:'start'}})).rejects.toThrow();
 const exported=await service.export();await service.import(JSON.parse(exported));expect((await service.current()).extensions).toEqual(after.extensions);
 const missing=new ExtensionHost(service,join(dir,'other-machine'));expect((await missing.list())[0].warning).toContain('缺少');await expect(missing.act('blackjack',{...await tx(service),action:{type:'start'}})).rejects.toThrow('未验证');
});
it('enable disable uninstall and rollback preserve other namespaces',async()=>{
 const {host,service}=await setup();const one=manifestFrom(spec,'0.1.0','test'),two=manifestFrom({...spec,name:'21 点改版'},'0.1.1','test'),other=manifestFrom({...spec,extension_id:'another'},'0.1.0','test');for(const m of [one,two,other])await host.approve(m);await host.install(await tx(service),one);await host.install(await tx(service),other);const foreign=(await service.current()).extensions!.another;
 await host.install(await tx(service),two);await host.manage('blackjack',await tx(service),'rollback');expect((await service.current()).extensions!.blackjack.version).toBe('0.1.0');
 await host.manage('blackjack',await tx(service),'disable');await expect(host.act('blackjack',{...await tx(service),action:{type:'start'}})).rejects.toThrow('未启用');await host.manage('blackjack',await tx(service),'enable');await host.manage('blackjack',await tx(service),'uninstall');expect((await service.current()).extensions!.blackjack.installed).toBe(false);expect((await service.current()).extensions!.another).toEqual(foreign);
});
it('combat damage uses host HP transaction without fabricated rewards',async()=>{
 const {host,service}=await setup(),manifest=manifestFrom({...spec,extension_id:'combat',template:'turn_based_combat',allow_betting:false},'0.1.0','test');await host.approve(manifest);await host.install(await tx(service),manifest);await host.act('combat',{...await tx(service),action:{type:'start'}});const before=await service.current();await host.act('combat',{...await tx(service),action:{type:'attack'}});const after=await service.current();expect(Number(after.entities[0].components.condition.hp)).toBeLessThan(Number(before.entities[0].components.condition.hp));expect(after.entities[0].components.wallet).toEqual(before.entities[0].components.wallet);await host.act('combat',{...await tx(service),action:{type:'flee'}});expect((await service.current()).extensions!.combat.state).toMatchObject({phase:'finished'});
});
it('isolated build runs typecheck/tests; install needs confirmation; tampering cannot replace working version',async()=>{
 const {host,service}=await setup(),dev=new ExtensionDevelopment(host);const before=await service.current();await dev.start({request_id:randomUUID(),request:'创建21点',template:'blackjack',extension_id:'blackjack',allow_betting:true,use_codex:false});const job=await ready(dev);expect(job.status).toBe('ready');expect(job.logs).toContain('32 个程序 RNG 种子规则测试通过');expect(await service.current()).toEqual(before);await expect(dev.install(job.job_id,{...await tx(service),confirmed:false})).rejects.toThrow();await dev.install(job.job_id,{...await tx(service),confirmed:true});const working=(await service.current()).extensions!.blackjack;
 await dev.start({request_id:randomUUID(),request:'更新21点',template:'blackjack',extension_id:'blackjack',allow_betting:true,use_codex:false});const update=await ready(dev);expect(update.status).toBe('ready');await writeFile(join(update.workspace,'dist','profile.json'),'{}');await expect(dev.install(update.job_id,{...await tx(service),confirmed:true})).rejects.toThrow('改变');expect((await service.current()).extensions!.blackjack).toEqual(working);
},30000);
it('failed Codex generation cannot install or replace working version',async()=>{
 const {host,service}=await setup();const manifest=manifestFrom(spec,'0.1.0','test');await host.approve(manifest);await host.install(await tx(service),manifest);const before=await service.current();const bad=new ExtensionDevelopment(host,()=>({name:'bad',generate:async()=>{throw Error('build input failed')}}));const job=await bad.start({request_id:randomUUID(),request:'更新玩法',template:'blackjack',extension_id:'blackjack',allow_betting:true,use_codex:true});expect((await ready(bad)).status).toBe('failed');await expect(bad.install(job.job_id,{...await tx(service),confirmed:true})).rejects.toThrow('仅可安装');expect(await service.current()).toEqual(before);
});
it('input distinguishes development, manual game and abstract simulation',()=>{expect(extensionIntent('我希望以后去银杯赌馆可以自己玩21点。')?.kind).toBe('extension_request');expect(extensionIntent('我在银杯玩21点。')?.kind).toBe('extension_open');expect(extensionIntent('我就随便赌几把，不想手动玩。')).toBeNull();expect(extensionIntent('我想加一个钓鱼小游戏。')).toMatchObject({kind:'extension_request',template:null});});

it('approved versions are immutable and rollback does not reuse a version',async()=>{const {host}=await setup();const one=manifestFrom(spec,'0.1.0','test'),two=manifestFrom(spec,'0.1.1','test');await host.approve(one);await host.approve(two);await expect(host.approve({...one,name:'tampered'})).rejects.toThrow('不可覆盖');expect(await host.nextVersion('blackjack','0.1.0')).toBe('0.1.2');});

import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {manifestFrom,type ExtensionSpec} from '../src/extensions/schema.js';
import {verifyMilestoneHostProjection} from '../src/extensions/verification.js';
import type {SavePackage} from '../src/core/schema.js';
import type {PublicView} from '../src/shared/contracts.js';

const spec:ExtensionSpec={
 extension_id:'character_morale',name:'人物状态',description:'为每个人物保存独立状态',template:'declarative',
 allow_betting:false,max_stake:0,healing_item_id:null,
 fields:[{key:'morale',label:'士气',type:'number',initial:50,scope:'entity'}],
 declarative_actions:[{id:'raise_morale',label:'提升士气',op:'increment',field:'morale',value:10}],
 surfaces:[{id:'character_morale',kind:'contextual_panel',title:'人物状态',visibility:'always',host:'character_detail'}],
};
const tx=async(service:{current:()=>Promise<SavePackage>})=>{const save=await service.current();return {game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID()};};
const fields=(view:PublicView,id:string)=>((view.entities.find(entity=>entity.id===id)?.components.extension_fields?.entries??[]) as {label:string;value:number}[]);

it('projects independent entity values into the real character host and preserves them while disabled',async()=>{
 const {service}=await sparseSetup(),directory=await mkdtemp(join(tmpdir(),'agf-entity-field-'));
 try{
  const host=new ExtensionHost(service,directory),manifest=manifestFrom(spec,'0.1.0','fixture');
  await host.approve(manifest);await host.install(await tx(service),manifest);
  let view=(await service.view())!;
  expect(fields(view,'npc_lin')).toEqual([expect.objectContaining({label:'士气',value:50})]);
  expect(fields(view,'npc_qiao')).toEqual([expect.objectContaining({label:'士气',value:50})]);
  await host.act('character_morale',{...await tx(service),action:{type:'raise_morale',target_entity_id:'npc_lin'}});
  view=(await service.view())!;
  expect(fields(view,'npc_lin')[0]?.value).toBe(60);expect(fields(view,'npc_qiao')[0]?.value).toBe(50);
  await host.manage('character_morale',await tx(service),'disable');
  expect(fields((await service.view())!,'npc_lin')).toEqual([]);
  await host.manage('character_morale',await tx(service),'enable');
  expect(fields((await service.view())!,'npc_lin')[0]?.value).toBe(60);
  const exported=await service.export();await service.import(JSON.parse(exported));
  expect(fields((await service.view())!,'npc_lin')[0]?.value).toBe(60);
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('rejects metadata-only completion for a promised character host',()=>{
 const globalOnly={...spec,fields:[{key:'morale',label:'士气',type:'number' as const,initial:50}],surfaces:[{id:'own',kind:'panel' as const,title:'自己的面板',visibility:'always' as const}]};
 expect(()=>verifyMilestoneHostProjection(globalOnly,'人物页面展示士气数值')).toThrow(/entity-scoped/);
 expect(()=>verifyMilestoneHostProjection(spec,'人物页面展示士气数值')).not.toThrow();
 expect(()=>verifyMilestoneHostProjection(spec,'地图中展示士气')).toThrow(/尚未实现/);
});



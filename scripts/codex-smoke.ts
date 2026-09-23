import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../src/ai/codex.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { readProfile } from '../src/ai/profiles.js';
import { GameService } from '../src/server/service.js';
import { JsonStore } from '../src/storage/json-store.js';
import { readFile } from 'node:fs/promises';
import { worldSchema } from '../src/core/schema.js';
const directory='data/codex-smoke-'+Date.now();
await mkdir(directory,{recursive:true});
const demo=worldSchema.parse(JSON.parse(await readFile('content/worlds/town.json','utf8')));
const adapter=new CodexAdapter(), ai=new AIRuntime(adapter), service=new GameService(new JsonStore(directory),ai,demo);
const report:{step:string;ok:boolean;detail?:string}[]=[];
async function step(name:string,fn:()=>Promise<void>){console.log('START '+name);try{await fn();report.push({step:name,ok:true});console.log('PASS '+name);}catch(e){report.push({step:name,ok:false,detail:String(e).slice(0,1600)});throw e;}finally{await writeFile(directory+'/report.json',JSON.stringify(report,null,2));}}
await step('ChatGPT structured narration + persisted thread',async()=>{
 const v=await service.newGame(); const out=await service.turn({request_id:randomUUID(),game_id:v.game_id,expected_revision:v.revision,action:{type:'TALK',target_id:'npc_lin',parameters:{topic:'你好，给新来的居民一句建议。'}}});
 assert.equal(out.notices.length,0,'Narration degraded: '+out.notices.join(';'));assert(out.last_turn?.dialogue);assert((await service.current()).ai.threads.narrator);
});
await step('resume after service/adapter reconstruction',async()=>{
 const restarted=new GameService(new JsonStore(directory),new AIRuntime(new CodexAdapter()),demo),v=await restarted.view();
 const before=(await restarted.current()).ai.threads.narrator;
 const out=await restarted.turn({request_id:randomUUID(),game_id:v!.game_id,expected_revision:v!.revision,action:{type:'WAIT',parameters:{minutes:1}}});
 assert.equal(out.notices.length,0);assert.equal((await restarted.current()).ai.threads.narrator,before);
});
await step('invalid thread recovery',async()=>{
 const s=await service.current();s.ai.threads.narrator='00000000-0000-0000-0000-000000000000';await service.storage.write(s);
 const out=await service.turn({request_id:randomUUID(),game_id:s.game_id,expected_revision:s.state_revision,action:{type:'WAIT',parameters:{minutes:1}}});
 assert.equal(out.notices.length,0);assert.notEqual((await service.current()).ai.threads.narrator,s.ai.threads.narrator);
});
await step('natural language intent through runtime',async()=>{
 const s=await service.current();const out=await service.turn({request_id:randomUUID(),game_id:s.game_id,expected_revision:s.state_revision,input:'去街角商店。'});
 assert.equal(out.entities.find(e=>e.id==='player')!.components.location.location_id,'market');
});
await step('Codex WorldInitializer -> validated canonical save',async()=>{
 const save=await ai.initialize('创建一个极小的近未来轨道空间站生活世界，四个相互连通的地点，一个NPC，一家商店，一件商品。中文。所有ID用英文。',await readProfile('content/profiles/default.json'));
 assert.notEqual(save.definition.meta.id,demo.meta.id);assert(save.ai.threads.world_initializer);await new JsonStore(directory+'/generated').write(save);
});
console.log('CODEX SMOKE PASSED. Evidence: '+directory+'/report.json');

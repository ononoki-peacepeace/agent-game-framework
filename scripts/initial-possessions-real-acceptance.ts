import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AIRuntime} from '../src/ai/runtime.js';
import {AIProviderManager,readPersistedProviderConfig} from '../src/ai/providers.js';
import {readProfile} from '../src/ai/profiles.js';
import {JsonStore} from '../src/storage/json-store.js';
import {validateSave} from '../src/core/state.js';
import {StructuredLogger,configureDefaultLogger} from '../src/observability/index.js';

const directory=await mkdtemp(join(tmpdir(),'agf-possessions-real-'));
const started=performance.now();
let calls=0;
const logger=configureDefaultLogger(new StructuredLogger({level:'debug',history:500}));
try{
  const config=await readPersistedProviderConfig('data');
  assert(config?.provider==='deepseek','需要已配置的 DeepSeek Provider');
  const provider=new AIProviderManager(directory,config);
  const ai=new AIRuntime({name:provider.name,generate:async request=>{
    calls++;return provider.generate(request);
  }});
  const profile=await readProfile('content/profiles/default.json');
  const premise='创建一个规模适中的现代城市公寓与邻近街区世界，有可正常游玩的地图、人物和日常生活。玩家是一名摄影师，开局此刻随身带着一台相机；相机内部已经装着半卷胶卷；玩家此刻穿着一件外套。三件物品都是玩家当前实际拥有的物品，不只是过去经历或比喻。相机、胶卷和外套必须能够在结构化世界状态中引用。不要增加未要求的关键道具或隐藏线索。';
  const generated=validateSave(await ai.initialize(premise,profile));
  const store=new JsonStore(directory);await store.write(generated);
  const reloaded=validateSave((await store.read())!);
  const player=reloaded.entities.find(entity=>entity.id===reloaded.player_state.entity_id)!;
  const owned=reloaded.entities.filter(entity=>entity.components.item?.owner_id===player.id);
  const find=(pattern:RegExp)=>owned.find(entity=>pattern.test(String(entity.components.identity?.name??'')));
  const camera=find(/相机|照相机/),film=find(/胶卷|胶片/),coat=find(/外套/);
  assert(camera&&film&&coat,'生成结果未登记全部三件初始物品');
  const inventory=player.components.inventory as {items:Record<string,number>;placements?:Record<string,string|null>}|undefined;
  assert((inventory?.items?.[camera.id]??0)>0,'相机未进入玩家持有状态');
  assert(inventory?.placements?.[film.id]===camera.id,'胶卷未装入相机');
  assert(Object.values(player.components.equipment?.slots??{}).includes(coat.id),'外套未穿戴');
  console.log(JSON.stringify({result:'PASS',provider:'deepseek',calls,
    elapsed_ms:Math.round(performance.now()-started),revision:reloaded.state_revision,
    owned_count:owned.length,camera:true,film_inside_camera:true,coat_worn:true,reloaded:true}));
}catch(error){
  const diagnostics=logger.entries({eventPrefix:'world_init.'}).slice(-20).map(entry=>({
    event:entry.event,
    // Only diagnostic paths and codes are printed; generated world content stays private.
    stage:entry.metadata?.stage??null,
    issue_paths:Array.isArray(entry.metadata?.issues)?entry.metadata.issues.map((issue:unknown)=>
      typeof issue==='object'&&issue!==null?'path' in issue?String(issue.path):'unknown':'unknown').slice(0,20):[],
    issue_codes:Array.isArray(entry.metadata?.issues)?entry.metadata.issues.map((issue:unknown)=>
      typeof issue==='object'&&issue!==null?'code' in issue?String(issue.code):'unknown':'unknown').slice(0,20):[],
  }));
  console.log(JSON.stringify({result:'FAIL',provider:'deepseek',calls,
    elapsed_ms:Math.round(performance.now()-started),error:error instanceof Error?error.message:String(error),diagnostics}));
  process.exitCode=1;
}finally{await rm(directory,{recursive:true,force:true});}

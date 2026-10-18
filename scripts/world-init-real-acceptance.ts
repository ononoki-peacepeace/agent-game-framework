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

const directory=await mkdtemp(join(tmpdir(),'agf-world-init-'));
const premise='创建一个可长期游玩的现代城市校园与社区世界。人物有各自的学习、工作与关系，日常独立运行，也可能出现逐步发展的事件。不要固定玩家剧情；保留合理的秘密、可感知证据和偶发长期冲突。';
try{
  const logger=configureDefaultLogger(new StructuredLogger({level:'debug',history:500}));
  const config=await readPersistedProviderConfig('data');
  assert(config&&config.provider!=='mock','当前没有可用的真实 Provider 配置');
  const ai=new AIRuntime(new AIProviderManager(directory,config));
  const store=new JsonStore(directory),profile=await readProfile('content/profiles/default.json');
  for(let i=1;i<=3;i++){
    const logStart=logger.entries({eventPrefix:'world_init.'}).length;
    let generated;
    try{generated=await ai.initialize(premise,profile);}
    catch(error){
      console.error(`WORLD_INIT_REAL ${i}/3 FAIL`,JSON.stringify(logger.entries({eventPrefix:'world_init.'}).slice(logStart).map(entry=>({event:entry.event,metadata:entry.metadata}))));
      throw error;
    }
    const save=validateSave(generated);
    assert((save.definition.world_macro_arcs?.length??0)<=2);
    for(const incident of save.definition.background_incidents??[])
      assert(incident.stages.at(-1)?.terminal!=='none');
    for(const truth of save.gm_state.hidden_truth?.commitments??[])
      for(const evidence of truth.evidence)
        if(evidence.placement)assert(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(evidence.placement.discoverability.domain));
    await store.write(save);
    console.log(`WORLD_INIT_REAL ${i}/3 PASS incidents=${save.definition.background_incidents?.length??0} macro_arcs=${save.definition.world_macro_arcs?.length??0}`);
  }
}finally{await rm(directory,{recursive:true,force:true});}

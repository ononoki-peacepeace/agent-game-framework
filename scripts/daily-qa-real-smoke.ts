// Disposable real-provider daily-action probe. The live save is never opened or written.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave} from '../src/core/state.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {sparseWorld} from '../tests/sparse-fixture.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(!config||config.provider!=='deepseek'){
  console.log('DAILY QA REAL MODEL NOT_RUN: DeepSeek is not configured');
  process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),'agf-daily-real-'));
try{
  const world=sparseWorld(),store=new JsonStore(join(root,'save'));
  world.meta.title='临时居家日常';world.meta.description='玩家在自己有厨房和书桌的公寓里度过普通早晨。';
  world.world.description=world.meta.description;
  const home=world.map!.locations.find(location=>location.id==='square')!;
  home.name='公寓';home.description='玩家居住的公寓室内，有可使用的厨房、自来水和书桌；厨房可用现有面包准备简单早饭。';
  const player=world.entities.find(entity=>entity.id===world.player.entity_id)!;
  player.components.identity.description='住在这间公寓，桌上放着有笔的数学作业本。';
  player.components.inventory!.items={water:1,notebook:1,bread:1};
  world.entities.find(entity=>entity.id==='notebook')!.components.identity.description='带笔的数学作业本，尚有一页未完成。';
  await store.write(newSave(world));
  const service=new GameService(store,new AIRuntime(new AIProviderManager(root,config)),world);
  const inputs=['起身去厨房喝一口水。','坐下来写完这一页数学作业。','在公寓里简单做一份早饭并吃完，大约花二十分钟。'];
  for(let index=0;index<inputs.length;index++){
    const before=await service.current(),input=inputs[index];
    try{
      const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input});
      const after=await service.current(),receipt=after.resolution_receipts?.at(-1);
      const passed=result.plan?.status==='completed'&&after.state_revision>before.state_revision&&
        receipt?.commit_status==='committed'&&receipt.semantic_action===input&&
        (index!==2||result.time_advanced===20);
      console.log(JSON.stringify({case:index+1,status:passed?'PASS':'FAIL',plan_status:result.plan?.status??null,
        goals:result.plan?.goals.map(goal=>({type:goal.type,status:goal.status,reason:goal.status==='completed'?null:goal.result?.summary?.slice(0,120)??null})),
        blocker:after.foreground?.blocker??null,revision_delta:after.state_revision-before.state_revision,
        minutes:result.time_advanced,receipt:receipt?.commit_status??null}));
      if(!passed)process.exitCode=1;
    }catch(error){console.log(JSON.stringify({case:index+1,status:'FAIL',error:error instanceof Error?error.message.slice(0,180):'unknown'}));process.exitCode=1;}
  }
}finally{await rm(root,{recursive:true,force:true});}

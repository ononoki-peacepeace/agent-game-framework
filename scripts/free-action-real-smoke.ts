// Real provider only; the formal data directory is read solely for its provider configuration.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave} from '../src/core/state.js';
import {sparseWorld} from '../tests/sparse-fixture.js';

const configured=await readPersistedProviderConfig(resolve('data'));
const providerConfig=configured??{provider:(process.env.AI_ADAPTER??'codex') as 'codex'|'openai'|'deepseek'|'responses-compatible'|'mock'};
if(providerConfig.provider==='mock'){
  console.log('REAL PROVIDER SMOKE NOT_RUN: configured provider is mock');process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),'agf-real-free-action-'));
try{
  const world=sparseWorld(),here=String(world.entities.find(entity=>entity.id===world.player.entity_id)?.components.location?.location_id);
  const identity=(name:string)=>({name,description:'测试场景中的普通物件',avatar_id:null});
  world.entities.push(
    {id:'qa_table',type:'item',components:{identity:identity('桌子'),location:{location_id:here},item:{weight:12,stackable:false,container:true}}},
    {id:'qa_cup',type:'item',components:{identity:identity('杯子'),location:{location_id:here},item:{weight:0.3,stackable:false}}},
    {id:'qa_fence',type:'object',components:{identity:identity('围栏'),location:{location_id:here}}},
  );
  const npc=world.entities.find(entity=>entity.id!==world.player.entity_id&&entity.components.character);
  if(npc)npc.components.location={location_id:here};
  const provider=new AIProviderManager(root,providerConfig),ai=new AIRuntime(provider),store=new JsonStore(join(root,'save'));
  const generate=provider.generate.bind(provider);let personaPromptSeen=false;
  provider.generate=async request=>{if(request.role==='narrator'&&request.prompt.includes('成熟温柔，语气从容'))personaPromptSeen=true;return generate(request);};
  const originalFreeform=ai.freeform.bind(ai);
  ai.freeform=async(save,input)=>{const parsed=await originalFreeform(save,input);
    console.log(JSON.stringify({input,classification:parsed.resolution?.type??parsed.blocker?.type??'missing',target_id:parsed.target_id,
      required_conditions:parsed.required_conditions??[],item_move:parsed.item_move?.item_id??null}));return parsed;};
  const originalNarrate=ai.narrate.bind(ai);
  ai.narrate=async(...args)=>{try{return await originalNarrate(...args);}catch(error){
    console.log(JSON.stringify({stage:'narrator',error_type:error instanceof Error?error.name:'unknown',detail:error instanceof Error?error.message.slice(0,220):String(error).slice(0,220)}));throw error;
  }};
  await store.write(newSave(world));const service=new GameService(store,ai,world);
  const inputs=['我仔细检查桌子下面有没有东西','看看这个房间有没有异常','我试着翻过围栏','我拿起桌上的杯子','我原地坐着等半小时'];
  let failed=false;
  for(const input of inputs){
    const before=await service.current(),request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input};
    try{
      await service.turn(request);const after=await service.current(),receipt=after.resolution_receipts?.find(entry=>entry.request_id===request.request_id);
      const valid=input.includes('半小时')?after.runtime.time.minute!==before.runtime.time.minute:receipt?.commit_status==='committed';
      if(!valid)failed=true;
      console.log(JSON.stringify({input,status:valid?'PASS':'FAIL',resolution:receipt?.kind??null,outcome:receipt?.outcome??null,time_cost:receipt?.time_cost??null}));
    }catch(error){failed=true;const pending=await store.readPending(request.request_id);
      console.log(JSON.stringify({input,status:'FAIL',reason:error instanceof Error?error.message:String(error),
        staged_resolution:pending?.candidate.resolution_receipts?.find(receipt=>receipt.request_id===request.request_id)?.kind??null}));}
  }
  if(npc){
    try{
      const before=await service.current();await service.setCharacterPersona({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),entity_id:npc.id,personality:'',speech_style:'成熟温柔，语气从容',verbal_habits:'偶尔用轻柔的反问'});
      const current=await service.current(),request_id=randomUUID();
      await service.turn({request_id,game_id:current.game_id,expected_revision:current.state_revision,action:{type:'TALK',target_id:npc.id,parameters:{topic:'今天过得怎么样？'}}});
      const after=await service.current(),pass=personaPromptSeen&&after.state_revision===current.state_revision+1&&Boolean(after.last_turn?.dialogue);
      if(!pass)failed=true;
      console.log(JSON.stringify({input:'custom persona + TALK',status:pass?'PASS':'FAIL',persona_prompt_seen:personaPromptSeen,dialogue:String(after.last_turn?.dialogue??'').slice(0,200)}));
    }catch(error){failed=true;console.log(JSON.stringify({input:'custom persona + TALK',status:'FAIL',reason:error instanceof Error?error.message:String(error)}));}
  }
  if(failed)process.exitCode=1;
}catch(error){
  console.log(JSON.stringify({status:'NOT_RUN',provider:providerConfig.provider,reason:error instanceof Error?error.message:String(error)}));
  process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true});}

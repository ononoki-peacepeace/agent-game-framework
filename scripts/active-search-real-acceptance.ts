// Disposable-world DeepSeek acceptance for open location searches. Never reads the formal save.
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {interpretSemanticEntry} from '../src/agent/semantic-entry.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {MemoryStore,fresh} from '../tests/helpers.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(config?.provider!=='deepseek')throw Error('DeepSeek Flash is not configured');
const onlyCase=process.env.ACTIVE_SEARCH_CASE;
const root=await mkdtemp(join(tmpdir(),'agf-active-search-'));
const provider=new AIProviderManager(root,config);
const generate=provider.generate.bind(provider);
const report:{cases:unknown[];calls:unknown[]}={cases:[],calls:[]};
provider.generate=async request=>{
  if(report.calls.length>=20)throw Error('ACTIVE_SEARCH_ACCEPTANCE_CALL_BUDGET_EXCEEDED');
  const call:{role:string;prompt:string;response?:unknown;usage?:unknown;error?:string}={role:request.role,prompt:request.prompt};
  report.calls.push(call);
  try{const response=await generate(request);call.response=response.data;call.usage=response.usage;return response;}
  catch(error){call.error=error instanceof Error?error.message:String(error);throw error;}
};
try{
  for(const input of ['我去找一家能听现场音乐的酒吧。','我去找红灯区。'].filter(item=>
    !onlyCase||(onlyCase==='music'?item.includes('现场音乐'):item.includes('红灯区')))){
    const store=new MemoryStore(),save=fresh();await store.write(save);
    const service=new GameService(store,new AIRuntime(provider),save.definition);
    const before=await service.current();
    const semantic=await interpretSemanticEntry(service,service.project(before),input,'WORLD');
    const result=semantic?await handleAgentInput(service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,semantic):null;
    const after=await service.current();
    report.cases.push({input,semantic,result,revision_before:before.state_revision,revision_after:after.state_revision,
      time_before:before.runtime.time,time_after:after.runtime.time,
      new_receipts:(after.resolution_receipts??[]).slice((before.resolution_receipts??[]).length),
      last_narrative:after.last_turn?.narrative??null,
      dynamic_locations:after.map_state.dynamic_locations.map(location=>location.name)});
  }
}finally{
  await mkdir(resolve('.tmp'),{recursive:true});
  await writeFile(resolve(onlyCase?`.tmp/active-search-real-acceptance-${onlyCase}.json`:
    '.tmp/active-search-real-acceptance-report.json'),JSON.stringify(report,null,2),'utf8');
  await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({cases:report.cases.map(item=>{const entry=item as Record<string,any>;return {
  input:entry.input,lane:entry.semantic?.interaction_lane,outcome:entry.result?.outcome,
  revision_before:entry.revision_before,revision_after:entry.revision_after,
  receipts:entry.new_receipts?.length,message:entry.result?.message?.slice(0,240),
};}),calls:report.calls.length}));

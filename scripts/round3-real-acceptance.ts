// Bounded DeepSeek acceptance against disposable worlds. Never opens the formal save.
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {MemoryStore,fresh} from '../tests/helpers.js';

const onlyCase=process.env.ROUND3_CASE_ID;
const output=resolve(onlyCase?'.tmp/round3-real-acceptance-display-report.json':'.tmp/round3-real-acceptance-report.json');
const configured=await readPersistedProviderConfig(resolve('data'));
if(!configured||configured.provider!=='deepseek'){
  console.log('ROUND3_REAL_NOT_RUN: DeepSeek is not configured');
  process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),'agf-round3-real-'));
const provider=new AIProviderManager(root,configured);
const original=provider.generate.bind(provider);
const maxCalls=onlyCase?4:16;
const report:{started_at:string;provider:string;max_calls:number;call_log:any[];cases:any[];stopped_reason:string|null;usage:{input_tokens:number;output_tokens:number}}={
  started_at:new Date().toISOString(),provider:'deepseek',max_calls:maxCalls,call_log:[],cases:[],stopped_reason:null,
  usage:{input_tokens:0,output_tokens:0},
};
provider.generate=async request=>{
  if(report.call_log.length>=maxCalls)throw Error('ROUND3_REAL_CALL_BUDGET_EXCEEDED');
  const entry:any={n:report.call_log.length+1,role:request.role,prompt_chars:request.prompt.length,
    max_output_tokens:request.maxOutputTokens??null,prompt:request.prompt};
  report.call_log.push(entry);
  try{
    const result=await original(request);
    entry.result=result.data;entry.usage=result.usage??null;
    report.usage.input_tokens+=result.usage?.input_tokens??0;
    report.usage.output_tokens+=result.usage?.output_tokens??0;
    return result;
  }catch(error){entry.error=error instanceof Error?{name:error.name,message:error.message}:String(error);throw error;}
};
const ai=new AIRuntime(provider);
const cases=[
  {id:'action_guard',surface:'world',input:'我想用魔法把商店的门炸开。',seed:'station'},
  // Independent holdouts chosen before this run; no code changes will be driven by their wording.
  {id:'holdout_unsupported_sequence',surface:'world',input:'先到河岸车站，向站务员询问末班车时间。',seed:'default'},
  {id:'holdout_supported_sequence',surface:'world',input:'先去河岸车站，再返回中央广场。',seed:'default'},
  {id:'holdout_other_entities',surface:'system',input:'如果我现在去河岸车站，林舟会跟我一起过去吗？',seed:'default'},
] as const;
await mkdir(resolve('.tmp'),{recursive:true});
try{
  for(const scenario of cases.filter(item=>!onlyCase||item.id===onlyCase)){
    if(report.call_log.length>=maxCalls){report.stopped_reason='call budget';break;}
    const store=new MemoryStore(),save=fresh();
    if(scenario.seed==='station')save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id='station';
    await store.write(save);
    const service=new GameService(store,ai,save.definition);
    const server=createApp(service,undefined,undefined,join(root,scenario.id,'assets')).listen(0,'127.0.0.1') as Server;
    await once(server,'listening');
    try{
      const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
      const token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
      const before=await service.current(),callStart=report.call_log.length;
      const response=await fetch(base+(scenario.surface==='world'?'/api/input':'/api/system'),{
        method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
        body:JSON.stringify({request_id:randomUUID(),game_id:before.game_id,
          expected_revision:before.state_revision,input:scenario.input}),
      });
      const body=await response.json();
      const after=await service.current();
      const currentReceipts=after.resolution_receipts??[],priorReceipts=before.resolution_receipts??[];
      const item={id:scenario.id,input:scenario.input,surface:scenario.surface,status:response.status,
        response:body,revision_before:before.state_revision,revision_after:after.state_revision,
        time_before:before.runtime.time,time_after:after.runtime.time,
        new_receipts:currentReceipts.slice(priorReceipts.length),
        model_plans:report.call_log.slice(callStart).filter(call=>call.role==='intent_interpreter').map(call=>call.result),
        converted_plan:body.plan??null,
        behavior_rules_before:before.behavior_config?.length??0,
        behavior_rules_after:after.behavior_config?.length??0,
        calls_used:report.call_log.length};
      report.cases.push(item);
      console.log(JSON.stringify({id:item.id,status:item.status,revision_delta:item.revision_after-item.revision_before,
        receipts:item.new_receipts.map(receipt=>receipt.semantic_action),calls_used:item.calls_used}));
    }catch(error){
      report.cases.push({id:scenario.id,error:error instanceof Error?error.message:String(error),calls_used:report.call_log.length});
      if(String(error).includes('ROUND3_REAL_CALL_BUDGET_EXCEEDED')){report.stopped_reason='call budget';break;}
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
    await writeFile(output,JSON.stringify(report,null,2),'utf8');
  }
}finally{
  await writeFile(output,JSON.stringify(report,null,2),'utf8');
  await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({report:output,calls:report.call_log.length,usage:report.usage,
  completed_cases:report.cases.length,stopped_reason:report.stopped_reason}));

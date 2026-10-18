// Runs one ordinary input against a disposable copy of an isolated generated world.
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {AIProviderManager,readPersistedProviderConfig} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {interpretSemanticEntry} from '../src/agent/semantic-entry.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {StructuredLogger,configureDefaultLogger} from '../src/observability/index.js';

const source=process.env.WORLD_GENERATED_DIR;
if(!source)throw new Error('WORLD_GENERATED_DIR is required');
const directory=resolve(`.tmp/world-thirteen-play-${Date.now()}`);
await mkdir(directory,{recursive:true});
await copyFile(resolve(source,'current.json'),resolve(directory,'current.json'));
configureDefaultLogger(new StructuredLogger({directory:resolve(directory,'logs'),level:'debug',history:3000}));
const config=await readPersistedProviderConfig('data');
if(config?.provider!=='deepseek')throw new Error('DeepSeek Provider is unavailable');
const ai=new AIRuntime(new AIProviderManager(directory,config));
const store=new JsonStore(directory);
const before=await store.read();
if(!before)throw new Error('isolated save did not load');
const service=new GameService(store,ai,before.definition);
const input='我先观察一下醒来的房间。';
const started=performance.now();
try{
  const semantic=await interpretSemanticEntry(service,service.project(before),input,'WORLD');
  if(!semantic)throw new Error('semantic entry returned no result');
  const result=await handleAgentInput(service,{request_id:randomUUID(),game_id:before.game_id,
    expected_revision:before.state_revision,input},undefined,null,false,semantic);
  const after=await store.read();
  if(!after)throw new Error('save disappeared after turn');
  const report={directory,source,input,duration_ms:Math.round(performance.now()-started),
    semantic_kind:semantic.kind,interaction_lane:semantic.interaction_lane,
    outcome:result?.outcome,message:result?.message,narrative:after.last_turn?.narrative,
    revision_before:before.state_revision,revision_after:after.state_revision,
    time_before:before.runtime.time,time_after:after.runtime.time,
    receipts:(after.resolution_receipts??[]).slice((before.resolution_receipts??[]).length),
    provider_requests:ai.metrics.requests,input_tokens:ai.metrics.input_tokens,output_tokens:ai.metrics.output_tokens};
  await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({directory,duration_ms:report.duration_ms,semantic_kind:report.semantic_kind,
    interaction_lane:report.interaction_lane,outcome:report.outcome,revision_before:report.revision_before,
    revision_after:report.revision_after,receipts:report.receipts.length,provider_requests:report.provider_requests}));
}catch(error){
  const report={directory,source,input,duration_ms:Math.round(performance.now()-started),
    error:error instanceof Error?error.message:String(error)};
  await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));
  console.error(JSON.stringify(report));process.exitCode=1;
}

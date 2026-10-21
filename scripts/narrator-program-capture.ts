import './narrator-prose-benchmark-capture.js';
import {beforeEach,expect,vi} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import * as executor from '../src/agent/executor.js';
import type {SaveStorage} from '../src/storage/json-store.js';
const directory=process.env.NARRATOR_BENCHMARK_OUTPUT;
if(!directory)throw Error('Use narrator-quality-program.mjs');
const spec=JSON.parse(await readFile('docs/narrator-quality-program.v1.json','utf8')) as {cases:{id:string;test_name?:string}[]};
const original=executor.executePlan;
beforeEach(()=>{
 const name=expect.getState().currentTestName,scenario=spec.cases.find(c=>c.id.startsWith('F')&&c.test_name===name);
 if(!scenario)return;
 vi.spyOn(executor,'executePlan').mockImplementation(async(...args)=>{
  const service=args[0],storage=Reflect.get(service,'storage') as SaveStorage,before=(await storage.read())!;
  const response=await original(...args),after=(await storage.read())!;
  const record={case_id:scenario.id,provenance:'actual_offline_partial_plan',request:args[1],
   rendered:{narrative:response.story??'',player_message:response.message},
   message_is_agent_status_not_narration:true,results:response.results,outcome:response.outcome,
   prior_public_view:service.project(before),after_public_view:service.project(after),
   new_receipts:after.resolution_receipts?.filter(r=>!before.resolution_receipts?.some(old=>old.request_id===r.request_id))??[],
   quality_ratings:null,independent_review:null};
  await writeFile(join(directory,`${scenario.id}.json`),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  return response;
 });
});

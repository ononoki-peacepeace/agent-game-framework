import './narrator-prose-benchmark-capture.js';
import {beforeEach,afterEach,expect,vi} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as executor from '../src/agent/executor.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {narratorRequestEnvelope} from './lib/narrator-request-envelope.js';
import type {SaveStorage} from '../src/storage/json-store.js';
const directory=process.env.NARRATOR_BENCHMARK_OUTPUT;
if(!directory)throw Error('Use narrator-quality-program.mjs');
const spec=JSON.parse(await readFile('docs/narrator-quality-program.v1.json','utf8')) as {cases:{id:string;test_name?:string}[]};
const original=executor.executePlan;
const turn=GameService.prototype.turn;
// Some new capture fixtures do not install their own mock cleanup. A previous
// case's wrapper must never label a later case's invocation as its own.
afterEach(()=>vi.restoreAllMocks());
beforeEach(()=>{
 const name=expect.getState().currentTestName,scenario=spec.cases.find(c=>c.id.startsWith('F')&&c.test_name===name);
 // Preserve the existing capture implementation when the original 18-case
 // hook has already installed a spy. Do not overwrite or recursively call it.
 const existing=GameService.prototype.turn;
 const previous=(vi.isMockFunction(existing)?existing.getMockImplementation():existing) as typeof turn;
 vi.spyOn(GameService.prototype,'turn').mockImplementation(async function(this:GameService,...args){
  const narrate=this.ai.narrate,inputs:Parameters<AIRuntime['narrate']>[]=[];
  this.ai.narrate=async(...input)=>{inputs.push(structuredClone(input));return narrate.apply(this.ai,input);};
  try{return await (previous??turn).apply(this,args);}
  finally{
   this.ai.narrate=narrate;
   if(inputs.length){
    const requests:ReturnType<typeof narratorRequestEnvelope>[]=[];
    const probe=new AIRuntime({name:'offline-request-construction-only',generate:async request=>{
     requests.push(narratorRequestEnvelope(request));return {data:{narrative:'当前情形没有额外变化。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};
    }});
    await probe.narrate(...inputs[0]);
    await writeFile(join(directory,`E-${randomUUID()}.json`),JSON.stringify({case_test_name:name,app_action_id:inputs[0][1].id,
     provenance:'request_constructed_from_exact_copied_app_narrate_arguments',requests,
     probe_output_is_not_a_candidate:true,real_provider_calls:0},null,2),{flag:'wx'});
   }
  }
 });
 if(!scenario)return;
 vi.spyOn(executor,'executePlan').mockImplementation(async(...args)=>{
  const service=args[0],storage=Reflect.get(service,'storage') as SaveStorage,before=(await storage.read())!;
  const response=await original(...args),after=(await storage.read())!;
  const record={case_id:scenario.id,test_name:name,provenance:'actual_offline_partial_plan',request:args[1],
   rendered:{narrative:response.story??'',player_message:response.message},
   message_is_agent_status_not_narration:true,results:response.results,outcome:response.outcome,
   prior_public_view:service.project(before),after_public_view:service.project(after),
   new_receipts:after.resolution_receipts?.filter(r=>!before.resolution_receipts?.some(old=>old.request_id===r.request_id))??[],
   quality_ratings:null,independent_review:null};
  await writeFile(join(directory,`${scenario.id}.json`),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  return response;
 });
});

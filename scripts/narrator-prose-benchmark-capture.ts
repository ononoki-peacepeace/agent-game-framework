import {beforeEach,expect,vi} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {GameService} from '../src/server/service.js';
import type {SavePackage} from '../src/core/schema.js';
import type {SaveStorage} from '../src/storage/json-store.js';

const output=process.env.NARRATOR_BENCHMARK_OUTPUT;
if(!output)throw Error('Use node scripts/narrator-prose-benchmark.mjs');
const spec=JSON.parse(await readFile('docs/narrator-prose-benchmark.v1.json','utf8')) as {
  cases:{id:string;test_name:string;dimensions:string[]}[]};
const turn=GameService.prototype.turn;
let sequence=0;
beforeEach(()=>{
  const name=expect.getState().currentTestName;
  const scenario=spec.cases.find(item=>item.test_name===name);
  if(!scenario)return;
  vi.spyOn(GameService.prototype,'turn').mockImplementation(async function(this:GameService,...args:Parameters<GameService['turn']>){
    // Reading storage directly avoids current()/migration or another simulated action.
    // These synthetic fixtures do not inject storage-read faults; never use on live data.
    const storage=Reflect.get(this,'storage') as SaveStorage;
    const before=structuredClone(await storage.read()) as SavePackage|null;
    const result=await turn.apply(this,args);
    const after=structuredClone(await storage.read()) as SavePackage|null;
    if(!before||!after)throw Error('Benchmark fixture requires a saved image');
    const old=new Set(before.resolution_receipts?.map(receipt=>receipt.request_id));
    const receipts=after.resolution_receipts?.filter(receipt=>!old.has(receipt.request_id))??[];
    const speech=(after.last_turn?.scene_beats??[]).filter(beat=>beat.kind==='speech');
    const sources=Object.entries(after.npc_agent_state??{}).flatMap(([npc_id,state])=>
      state.last_decisions.filter(decision=>decision.speech&&speech.some(beat=>
        beat.kind==='speech'&&beat.speaker_id===npc_id&&beat.utterance===decision.speech))
        .map(decision=>({npc_id,event_ref:decision.event_ref,revision:decision.revision,speech:decision.speech})));
    const record={case_id:scenario.id,test_name:name,sequence:++sequence,controlled_offline:true,
      fixture_speech_is_not_model_voice_quality:true,request:args[0],prior_public_view:this.project(before),
      after_public_view:this.project(after),new_receipts:receipts,rendered:after.last_turn,
      matching_speech_sources:sources,revision_delta:after.state_revision-before.state_revision,
      unchanged_image:JSON.stringify(before)===JSON.stringify(after),quality_ratings:null,reviewer:null};
    await writeFile(join(output,`${scenario.id}-${String(sequence).padStart(3,'0')}.json`),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    return result;
  });
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {ProviderError} from '../src/ai/failures.js';
import {interruptedActivity} from '../src/core/completion-evidence.js';

afterEach(()=>vi.restoreAllMocks());
const semantic={kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never;
async function fixture(due:number|null,later:boolean){
 const directory=await mkdtemp(join(tmpdir(),'agf-scene-wait-complete-'));
 const f=await sparseSetup(async request=>{
  const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(p.understanding)return {data:{understanding:'问候后等待两分钟',narrative:'林舟回应了你的问候。',dialogue:'你好。',
   speech_events:[{speaker_id:'player',utterance:'你好。',provenance:'verbatim_player_input'},
    {speaker_id:'npc_lin',utterance:'你好。',provenance:'npc_response'}],
   effects:[{kind:'wait',minutes:2},...(later?[{kind:'move',destination:'河岸车站'}]:[])]}};
  if(p.authorized)return {data:{authorized:true,explanation:'原句授权等待以及有明确先后次序的移动'}};
  throw Error('Unexpected offline stage');
 });
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','使用权威降级描写'));
 const before=await f.service.current();before.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 if(due!==null){
  before.entities.find(e=>e.id==='player')!.components.opportunities={entries:{wait_meeting:{status:'accepted',title:'已接受的等待会面'}}};
  before.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'wait_meeting',label:'已接受的等待会面',
   at:before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute+due,
   window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
 }
 const store=new JsonStore(directory);await store.write(before);
 const service=new GameService(store,f.ai,before.definition),save=await service.current();
 return {directory,store,service,before:save,ai:f.ai,request:{game_id:save.game_id,expected_revision:save.state_revision,
  request_id:randomUUID(),input:'你好。先等待2分钟'+(later?'，再去河岸车站。':'。')}};
}
it.each([0,1])('does not complete interrupted scene WAIT or execute the next MOVE at due=%s',async due=>{
 const f=await fixture(due,true);try{
  const turns=vi.spyOn(f.service,'turn'),result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=await f.service.current();
  expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',goal_status:'partial',completed_steps:['scene_interaction']});
  const receipts=after.resolution_receipts?.filter(r=>r.actor_id==='player')??[];
  expect(receipts.map(r=>r.semantic_action)).toEqual(['WAIT']);expect(interruptedActivity(receipts[0])).toBe(true);
  expect(receipts[0].time_cost).toBe(due);expect(result.outcome!.receipt_ids).toContain(receipts[0].request_id);
  expect(after.entities.find(e=>e.id==='player')!.components.location).toEqual(f.before.entities.find(e=>e.id==='player')!.components.location);
  expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(due);expect(turns).toHaveBeenCalledTimes(1);
  expect(result.story).toContain('已接受的等待会面');expect(result.message).not.toContain('等待2分钟');
  const bytes=await readFile(join(f.directory,'current.json')),calls=f.ai.metrics.requests,writes=vi.spyOn(f.store,'write');
  expect(await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic)).toEqual(result);
  expect(writes).not.toHaveBeenCalled();expect(f.ai.metrics.requests).toBe(calls);
  expect(await new GameService(new JsonStore(f.directory),f.ai,f.before.definition).current()).toEqual(after);
  expect(await readFile(join(f.directory,'current.json'))).toEqual(bytes);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each([null,2])('retains complete scene WAIT when due=%s',async due=>{
 const f=await fixture(due,false);try{
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=await f.service.current();
  expect(result.outcome).toMatchObject({type:'game',kind:'completed',goal_status:'completed',completed_steps:['scene_interaction','等待2分钟']});
  expect(after.runtime.time.minute-f.before.runtime.time.minute).toBe(2);
  expect(after.resolution_receipts?.filter(r=>r.actor_id==='player').map(r=>r.semantic_action)).toEqual(['WAIT']);
  expect(result.view).toEqual(f.service.project(after));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';

afterEach(()=>vi.restoreAllMocks());
const answer='你好。',semantic={kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never;
async function fixture(effects=true,count=1){
 const directory=await mkdtemp(join(tmpdir(),'agf-scene-effect-read-'));
 const f=await sparseSetup(async request=>{
  const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(p.understanding)return {data:{understanding:'问候后原地等待',narrative:'林舟回应了问候。',dialogue:answer,
   speech_events:[{speaker_id:'player',utterance:'你好。',provenance:'verbatim_player_input'},
    {speaker_id:'npc_lin',utterance:answer,provenance:'npc_response'}],effects:effects?Array.from({length:count},()=>({kind:'wait',minutes:2})):[]}};
  if(p.authorized)return {data:{authorized:true,explanation:'原文明确授权等待两分钟'}};
  if(request.role==='narrator')return {data:{narrative:'你原地等候片刻。',dialogue:null,speaker:null,choices:[],patches:[]}};
  throw Error('Unexpected offline stage');
 });
 const store=new JsonStore(directory),save=await f.service.current();
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};await store.write(save);
 const service=new GameService(store,f.ai,save.definition),before=await service.current();
 return {directory,store,service,before,ai:f.ai,request:{game_id:before.game_id,expected_revision:before.state_revision,
  request_id:randomUUID(),input:effects?'你好。然后等待2分钟。'+(count>1?'再等待2分钟。':''):'你好。'}};
}
it.each(['before-effect','before-write','after-write','acknowledged-effect','final-effect','final-no-effect'] as const)(
 'keeps only observed commit evidence when %s reads remain unavailable',async mode=>{
 const f=await fixture(mode!=='final-no-effect'),read=f.store.read.bind(f.store),write=f.store.write.bind(f.store);
 try{
  const poison=()=>vi.spyOn(f.store,'read').mockRejectedValue(Error('scene effect canonical read unavailable'));
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
   const effect=save.resolution_receipts?.some(r=>r.commit_status==='committed'&&r.semantic_action==='WAIT');
   if(effect&&(mode==='before-write'||mode==='after-write')){
    if(mode==='after-write')await write(save,slot);poison();throw Error('effect commit response unavailable');
   }
   return write(save,slot);
  });
  if(mode==='before-effect'||mode==='final-effect'||mode==='final-no-effect'){
   const current=f.service.current.bind(f.service);
   vi.spyOn(f.service,'current').mockImplementation(async()=>{
    const save=await current();
    const scene=save.narrative_history?.some(h=>h.request_id===f.request.request_id);
    const effect=save.resolution_receipts?.some(r=>r.semantic_action==='WAIT'&&r.commit_status==='committed');
    if(scene&&(mode!=='final-effect'||effect))poison();return save;
   });
  }
  if(mode==='acknowledged-effect'){
   const turn=f.service.turn.bind(f.service);
   vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{const view=await turn(...args);poison();return view;});
  }
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=(await read())!;
  const observedEffect=mode==='final-effect',actualEffect=['after-write','acknowledged-effect','final-effect'].includes(mode);
  expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',state_certain:false,
   revision:f.before.state_revision+1+Number(observedEffect),
   committed_steps:observedEffect?['scene_interaction','等待2分钟']:['scene_interaction']});
  expect(result.outcome!.receipt_ids).toHaveLength(1+Number(observedEffect));
  expect(result.view).toBeUndefined();expect(result.story).toContain(answer);expect(result.message).not.toContain('世界没有改变');
  expect(after.state_revision).toBe(f.before.state_revision+1+Number(actualEffect));
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='WAIT')??[]).toHaveLength(Number(actualEffect));
  expect(after.narrative_history?.filter(h=>h.request_id===f.request.request_id)).toHaveLength(1);
  const bytes=await readFile(join(f.directory,'current.json')),calls=f.ai.metrics.requests,count=writes.mock.calls.length;
  expect(await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic)).toEqual(result);
  expect(f.ai.metrics.requests).toBe(calls);expect(writes).toHaveBeenCalledTimes(count);
  const fresh=new GameService(new JsonStore(f.directory),f.ai,f.before.definition);
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(f.directory,'current.json'))).toEqual(bytes);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it.each(['before-write','after-write'] as const)('uses readable receipts after a %s effect failure',async mode=>{
 const f=await fixture(),write=f.store.write.bind(f.store);try{
  vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
   if(save.resolution_receipts?.some(r=>r.semantic_action==='WAIT')){
    if(mode==='after-write')await write(save,slot);throw Error('effect write response unavailable');
   }
   return write(save,slot);
  });
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=await f.service.current();
  expect(result.outcome).toMatchObject({type:'engine_failure',stage:'natural_scene_effect',state_certain:mode==='before-write',
   committed_steps:mode==='after-write'?['scene_interaction','等待2分钟']:['scene_interaction']});
  expect(result.outcome!.receipt_ids).toHaveLength(mode==='after-write'?2:1);expect(result.view).toEqual(f.service.project(after));
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('retains the confirmed first effect without claiming a durable but unreadable second effect',async()=>{
 const f=await fixture(true,2),write=f.store.write.bind(f.store),read=f.store.read.bind(f.store);try{
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
   await write(save,slot);
   if(save.resolution_receipts?.filter(r=>r.semantic_action==='WAIT').length===2){
    vi.spyOn(f.store,'read').mockRejectedValue(Error('second effect unreadable'));throw Error('second effect response lost');
   }
  });
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=(await read())!;
  expect(result.outcome).toMatchObject({type:'engine_failure',state_certain:false,revision:f.before.state_revision+2,
   committed_steps:['scene_interaction','等待2分钟']});
  expect(result.outcome!.receipt_ids).toHaveLength(2);expect(result.view).toBeUndefined();
  expect(after.state_revision).toBe(f.before.state_revision+3);expect(after.resolution_receipts?.filter(r=>r.semantic_action==='WAIT')).toHaveLength(2);
  const bytes=await readFile(join(f.directory,'current.json')),calls=f.ai.metrics.requests,n=writes.mock.calls.length;
  expect(await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic)).toEqual(result);
  expect(writes).toHaveBeenCalledTimes(n);expect(f.ai.metrics.requests).toBe(calls);
  expect(await new GameService(new JsonStore(f.directory),f.ai,f.before.definition).current()).toEqual(after);
  expect(await readFile(join(f.directory,'current.json'))).toEqual(bytes);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('does not claim an effect completed when the turn returns without a committed receipt',async()=>{
 const f=await fixture();try{
  vi.spyOn(f.service,'turn').mockImplementation(async()=>f.service.project(await f.service.current()));
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic);
  expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',completed_steps:['scene_interaction']});
  expect(result.message).not.toContain('等待2分钟');expect((await f.service.current()).resolution_receipts).toEqual(f.before.resolution_receipts);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('retains normal committed effects when all canonical reads are available',async()=>{
 const f=await fixture();try{
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=await f.service.current();
  expect(result.outcome).toMatchObject({type:'game',kind:'completed',completed_steps:['scene_interaction','等待2分钟']});
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='WAIT')).toHaveLength(1);
  expect(result.view).toEqual(f.service.project(after));expect(result.story).toContain(answer);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

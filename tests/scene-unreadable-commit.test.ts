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
const input='你好。',answer='你好，先坐会儿。';
const semantic={kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never;
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'agf-scene-unreadable-'));
 const f=await sparseSetup(async request=>{
  const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(p.understanding)return {data:{understanding:'普通交流',narrative:'林舟回应了你的问候。',dialogue:answer,
   speech_events:[{speaker_id:'player',utterance:input,provenance:'verbatim_player_input'},
    {speaker_id:'npc_lin',utterance:answer,provenance:'npc_response'}],effects:[]}};
  if(p.verdict)return {data:{verdict:'aligned',explanation:'保留玩家问候'}};
  throw Error('Unexpected offline stage');
 });
 const store=new JsonStore(directory),save=await f.service.current();
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};await store.write(save);
 const service=new GameService(store,f.ai,save.definition),before=await service.current();
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
 return {directory,store,service,before,ai:f.ai,request};
}
it.each(['before-write','after-write'] as const)('returns uncertain commit status without presenting unconfirmed speech (%s)',async mode=>{
 const f=await fixture(),read=f.store.read.bind(f.store),write=f.store.write.bind(f.store);try{
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
   if(mode==='after-write')await write(save,slot);
   vi.spyOn(f.store,'read').mockRejectedValue(Error('scene recovery storage unavailable'));throw Error('scene commit response unavailable');
  });
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=(await read())!;
  expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'natural_scene_commit',
   state_certain:false,revision:f.before.state_revision,committed_steps:[],receipt_ids:[]});
  expect(result.view).toBeUndefined();expect(result.story).toBeUndefined();expect(result.message).not.toContain(answer);
  expect(result.message).not.toContain('世界没有改变');expect(writes).toHaveBeenCalledTimes(1);
  expect(after.state_revision).toBe(f.before.state_revision+Number(mode==='after-write'));
  expect(after.narrative_history?.filter(h=>h.request_id===f.request.request_id).length??0).toBe(Number(mode==='after-write'));
  const calls=f.ai.metrics.requests;expect(await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic)).toEqual(result);
  expect(f.ai.metrics.requests).toBe(calls);expect(writes).toHaveBeenCalledTimes(1);
  const bytes=await readFile(join(f.directory,'current.json')),fresh=new GameService(new JsonStore(f.directory),f.ai,f.before.definition);
  expect(await fresh.current()).toEqual(after);expect(await readFile(join(f.directory,'current.json'))).toEqual(bytes);expect(f.ai.metrics.requests).toBe(calls);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('preserves an acknowledged scene commit when its final canonical refresh fails',async()=>{
 const f=await fixture(),read=f.store.read.bind(f.store),transaction=f.service.agentTransaction.bind(f.service);try{
  const commits=vi.spyOn(f.service,'agentTransaction').mockImplementation(async(...args)=>{
   const result=await transaction(...args);vi.spyOn(f.store,'read').mockRejectedValue(Error('postcommit refresh unavailable'));return result;
  });
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=(await read())!;
  expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'natural_scene_refresh',state_certain:false,
   revision:after.state_revision,committed_steps:['scene_interaction'],receipt_ids:[after.runtime.receipts.at(-1)!.id]});
  expect(result.view).toBeUndefined();expect(result.story).toContain(answer);expect(result.message).toContain('前面已经结算');
  expect(commits).toHaveBeenCalledTimes(1);expect(after.narrative_history?.filter(h=>h.request_id===f.request.request_id)).toHaveLength(1);
  expect(after.runtime.scene_seconds).toBeGreaterThan(f.before.runtime.scene_seconds??0);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('keeps the existing fresh-view failure when a failed commit can be read reliably',async()=>{
 const f=await fixture();try{
  const writes=vi.spyOn(f.store,'write').mockRejectedValue(Error('before-write refusal'));
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic);
  expect(result.outcome).toMatchObject({type:'engine_failure',stage:'natural_scene_commit',state_certain:true,revision:f.before.state_revision});
  expect(result.view).toEqual(f.service.project(f.before));expect(await f.service.current()).toEqual(f.before);expect(writes).toHaveBeenCalledTimes(1);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
it('acknowledges the scene receipt when a durable write loses its response but recovery can read it',async()=>{
 const f=await fixture(),write=f.store.write.bind(f.store);try{
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('scene saved response lost');});
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic),after=await f.service.current();
  expect(result.outcome).toMatchObject({type:'engine_failure',stage:'natural_scene_commit',state_certain:false,
   revision:after.state_revision,committed_steps:['scene_interaction'],receipt_ids:[after.runtime.receipts.at(-1)!.id]});
  expect(result.message).toContain('前面已经结算');expect(result.view).toEqual(f.service.project(after));expect(writes).toHaveBeenCalledTimes(1);
  expect(after.narrative_history?.filter(h=>h.request_id===f.request.request_id)).toHaveLength(1);
  const calls=f.ai.metrics.requests;expect(await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,semantic)).toEqual(result);
  expect(f.ai.metrics.requests).toBe(calls);expect(writes).toHaveBeenCalledTimes(1);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

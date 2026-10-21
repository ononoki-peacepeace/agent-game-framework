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

afterEach(()=>vi.restoreAllMocks());
const words='一起去街角商店吧。',welcome='欢迎。';
type Lane='natural_scene'|'open_goal';
type Mode='before-write'|'after-write'|'before-unreadable'|'after-unreadable'|'normal'|'invalid'|'provider';
async function fixture(lane:Lane,mode:Mode){
 const directory=await mkdtemp(join(tmpdir(),'agf-arrival-recovery-'));
 const f=await sparseSetup(async request=>{
  const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(p.understanding){
   if(request.prompt.includes('"scene_phase":"arrival"')){
    if(mode==='provider')throw new ProviderError('refusal','offline refusal','offline refusal');
    return {data:{understanding:'到达后的问候',
    narrative:'乔宁在店内问候来客。',dialogue:welcome,
    speech_events:[{speaker_id:'npc_qiao',utterance:welcome,provenance:'npc_response'}],
    effects:mode==='invalid'?[{kind:'wait',minutes:5}]:[]}};
   }
   return {data:{understanding:'出发前邀请',narrative:'林舟听见你的邀请。',dialogue:null,
    speech_events:[{speaker_id:'player',utterance:words,provenance:'verbatim_player_input'}],
    effects:lane==='natural_scene'?[{kind:'move',destination:'街角商店'}]:[]}};
  }
  if(p.authorized)return {data:{authorized:true,explanation:'原文明示移动'}};
  if(request.role==='narrator')return {data:{narrative:'你沿路来到街角商店。',speaker:null,dialogue:null,choices:[],patches:[]}};
  throw Error('Unexpected offline stage');
 });
 const save=await f.service.current();save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,f.ai,save.definition),before=await service.current();
 const semantic={kind:'world_action',interaction_lane:lane,player_speech_mode:'verbatim',
  ...(lane==='open_goal'?{open_goal_context:{destination:'街角商店',continuation:'none',travel_party:'solo',
   event_sequence:[{kind:'speech',timing:'before_move',text:words},{kind:'move',timing:null,text:null}]},
   goal_spec:{play_action:'move',objective:'邀请后出发',targets:[],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',
    temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,external_artifact:false,multi_step:true,ambiguity:null}}:{})} as never;
 return {directory,store,service,before,ai:f.ai,semantic,request:{game_id:before.game_id,expected_revision:before.state_revision,
  request_id:randomUUID(),input:`我对林舟说：“${words}”然后独自出发。`}};
}
it.each((['natural_scene','open_goal'] as const).flatMap(lane=>(['before-write','after-write','before-unreadable','after-unreadable','normal','invalid','provider'] as const).map(mode=>({lane,mode}))))(
 'preserves authoritative arrival evidence and classification ($lane/$mode)',async({lane,mode})=>{
 const f=await fixture(lane,mode),write=f.store.write.bind(f.store),read=f.store.read.bind(f.store);try{
  const unreadable=mode.endsWith('unreadable');
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
   if(save.narrative_history?.at(-1)?.speech_events?.some(e=>e.speaker_id==='npc_qiao')&&
      (mode.startsWith('before-')||mode.startsWith('after-'))){
    if(mode.startsWith('after-'))await write(save,slot);
    if(unreadable)vi.spyOn(f.store,'read').mockRejectedValue(Error('arrival authority unavailable'));
    throw Error('arrival commit response unavailable');
   }
   return write(save,slot);
  });
  const result=await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,f.semantic),after=(await read())!;
  const committed=mode.startsWith('after-')||mode==='normal';
  expect(after.state_revision).toBe(f.before.state_revision+2+Number(committed));
  expect(after.entities.find(e=>e.id==='player')?.components.location?.location_id).toBe('market');
  expect(after.resolution_receipts?.filter(r=>r.semantic_action==='MOVE')).toHaveLength(1);
  expect(after.narrative_history?.filter(h=>h.speech_events?.some(e=>e.speaker_id==='npc_qiao'))).toHaveLength(Number(committed));
  if(committed&&!unreadable){expect(result.outcome).toMatchObject({type:'game',kind:'completed'});expect(result.story).toContain(welcome);}
  else{
   expect(result.outcome).toMatchObject({type:'engine_failure',
    stage:unreadable?(lane==='natural_scene'?'natural_scene_effect_refresh':'open_goal_refresh'):'arrival_scene',
    code:mode==='invalid'?'schema_failure':mode==='provider'?'provider_failure':'transaction_failure',
    revision:unreadable?f.before.state_revision+2:after.state_revision});
   expect(result.story).not.toContain(welcome);
   if(!unreadable)expect(result.outcome?.receipt_ids).toHaveLength(2);
  }
  if(unreadable){expect(result.view).toBeUndefined();expect(result.outcome).toMatchObject({state_certain:false});}
  else expect(result.view).toEqual(f.service.project(after));
  const bytes=await readFile(join(f.directory,'current.json')),calls=f.ai.metrics.requests,count=writes.mock.calls.length;
  expect(await handleAgentInput(f.service,f.request,undefined,'npc_lin',false,f.semantic)).toEqual(result);
  expect(f.ai.metrics.requests).toBe(calls);expect(writes).toHaveBeenCalledTimes(count);
  expect(await new GameService(new JsonStore(f.directory),f.ai,f.before.definition).current()).toEqual(after);
  expect(await readFile(join(f.directory,'current.json'))).toEqual(bytes);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});

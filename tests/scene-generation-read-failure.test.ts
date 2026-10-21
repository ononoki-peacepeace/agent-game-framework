import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
const input='你好。',semantic={kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never;
it.each(['first-failure','terminal-refresh'] as const)('returns uncertain scene failure when %s loses canonical reads',async mode=>{
 let calls=0,poison!:()=>void;
 const f=await sparseSetup(async request=>{
  if((request.schema as {properties?:Record<string,unknown>}).properties?.understanding){
   calls++;if(mode==='first-failure')poison();throw new ProviderError('refusal','offline refusal','未生成候选');
  }
  throw Error('Unexpected offline stage');
 });
 const save=await f.service.current();save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};await f.store.write(save);
 const before=await f.service.current(),read=f.store.read.bind(f.store),writes=vi.spyOn(f.store,'write');
 poison=()=>{vi.spyOn(f.store,'read').mockRejectedValue(Error('scene generation recovery unreadable'));};
 if(mode==='terminal-refresh'){
  const current=f.service.current.bind(f.service);
  vi.spyOn(f.service,'current').mockImplementation(async()=>{
   const state=await current();if(calls===1)poison();return state;
  });
 }
 const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
 const result=await handleAgentInput(f.service,request,undefined,'npc_lin',false,semantic);
 expect(result.outcome).toMatchObject({type:'engine_failure',code:'transaction_failure',stage:'natural_scene_refresh',state_certain:false,
  revision:before.state_revision,receipt_ids:[],committed_steps:[]});
 expect(result.view).toBeUndefined();expect(result.story).toBeUndefined();expect(result.message).not.toContain('世界没有改变');
 expect(await read()).toEqual(before);expect(writes).not.toHaveBeenCalled();expect(calls).toBe(1);
 expect(await handleAgentInput(f.service,request,undefined,'npc_lin',false,semantic)).toEqual(result);expect(calls).toBe(1);
});
it('preserves provider classification and current authority if failure recovery stays readable',async()=>{
 const f=await sparseSetup(async request=>{
  if((request.schema as {properties?:Record<string,unknown>}).properties?.understanding)throw new ProviderError('refusal','offline refusal','未生成候选');
  throw Error('Unexpected offline stage');
 });
 const save=await f.service.current();save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};await f.store.write(save);
 const before=await f.service.current(),writes=vi.spyOn(f.store,'write');
 const result=await handleAgentInput(f.service,{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input},
  undefined,'npc_lin',false,semantic);
 expect(result.outcome).toMatchObject({type:'engine_failure',code:'provider_failure',stage:'natural_scene',state_certain:true});
 expect(result.view).toEqual(f.service.project(before));expect(await f.service.current()).toEqual(before);expect(writes).not.toHaveBeenCalled();
});

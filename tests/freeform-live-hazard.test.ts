import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {EventBus} from '../src/core/registry.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const quote='一段灼热管道';
it.each((['place','entity'] as const).flatMap(source=>[false,true].map(removed=>({source,removed}))))(
 'requires the same hazard source to remain reachable ($source,removed=$removed)',async({source,removed})=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 const player=save.entities.find(e=>e.id==='player')!,npc=save.entities.find(e=>e.id==='npc_lin')!,here=String(player.components.location!.location_id);
 npc.components.location={location_id:here};npc.components.condition={hp:100,stamina:100,stress:0};
 const place=save.definition.map!.locations.find(p=>p.id===here)!;place.description+=' '+quote;
 if(source==='entity')save.entities.push({id:'qa_pipe',type:'object',components:{identity:{name:'管道',description:quote,avatar_id:null},
  discovery:{known_to_player:true},location:{location_id:here}}});
 const before=structuredClone(save),input='尝试把林舟推向灼热管道',original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
   calls++;if(removed&&source==='place')ctx.save.definition.map!.locations.find(p=>p.id===here)!.description='已登记为没有危险管道的空地';
   else if(removed)ctx.save.entities.find(e=>e.id==='qa_pipe')!.components.location!.location_id='station';
  }
 });
 const raw={narrative:'候选动作',minutes:2,target_id:'npc_lin',facts:[],relationship:null,item_move:null,
  physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false,
   mechanism:'environment',hazard_source:{source_id:source==='place'?here:'qa_pipe',quote}},
  resolution:{type:'OPPOSED_CHECK',domain:'strength',band:'normal',visibility:'public',stakes:'真实环境中的推撞',
   stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}};
 let roll=0;const rng=vi.fn(()=>roll++%2===0?.99:.01),run=()=>executeFreeform(save,input,raw,randomUUID(),rng);
 if(removed){expect(run).toThrow('危险来源');expect(rng).not.toHaveBeenCalled();}
 else{
  const turn=run();expect(turn.save.resolution_receipts!.at(-1)!.physical_outcome?.harmed).toBe(true);
  expect(Number(turn.save.entities.find(e=>e.id==='npc_lin')!.components.condition!.hp)).toBeLessThan(100);expect(rng).toHaveBeenCalledTimes(4);
 }
 expect(calls).toBe(1);expect(save).toEqual(before);
});
it('keeps disk state unchanged when a hazard source expires before a physical result',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-live-hazard-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  const here=String(save.entities.find(e=>e.id==='player')!.components.location!.location_id);
  save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:here};
  save.definition.map!.locations.find(p=>p.id===here)!.description+=' '+quote;
  const input='尝试把林舟推向灼热管道',raw={narrative:'候选动作',minutes:2,target_id:'npc_lin',facts:[],relationship:null,item_move:null,
   physical_action:{kind:'harm' as const,source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor' as const,surprise_attempt:false,
    mechanism:'environment' as const,hazard_source:{source_id:here,quote}},
   resolution:{type:'OPPOSED_CHECK' as const,domain:'strength',band:'normal' as const,visibility:'public' as const,stakes:'真实环境中的推撞',
    stages:[{id:'contact',band:'normal' as const},{id:'injury',band:'normal' as const}],evidence_ids:[]}};
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected generation');}});
  vi.spyOn(ai,'freeform').mockResolvedValue(raw);const narrate=vi.spyOn(ai,'narrate');
  const service=new GameService(store,ai,save.definition),before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  const original=EventBus.prototype.emit;let calls=0;
  vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
   original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){
    calls++;ctx.save.definition.map!.locations.find(p=>p.id===here)!.description='这里是没有管道的空地';
   }
  });
  const body={input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  for(const current of [service,new GameService(new JsonStore(directory),ai,save.definition)]){
   await expect(current.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow('危险来源');
   expect(await current.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  }
  expect(calls).toBe(2);expect(narrate).not.toHaveBeenCalled();expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

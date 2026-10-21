import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {activityRequirement,executeFreeform} from '../src/core/freeform.js';
import {validateSave} from '../src/core/state.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

const proposal={narrative:'演奏候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
 visibility:'public' as const,stakes:'普通演奏',stages:[],evidence_ids:[]}};
async function fixture(condition:'intact'|'damaged'|'destroyed',owned:boolean){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 save.entities.push({id:'qa_piano',type:'item',components:{identity:{name:'钢琴',description:'已登记的钢琴',avatar_id:null},
  item:{weight:1,stackable:false,tracking:'tracked',condition,tags:[]},discovery:{known_to_player:true},
  ...(owned?{}:{location:{location_id:here}})}});
 if(owned)(save.entities.find(e=>e.id==='player')!.components.inventory!.items as Record<string,number>).qa_piano=1;
 return validateSave(save);
}
it.each([false,true])('cannot play an actually destroyed scene/held instrument (owned=%s)',async owned=>{
 const save=await fixture('destroyed',owned),before=structuredClone(save);
 expect(()=>executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID())).toThrow();expect(save).toEqual(before);
 expect(activityRequirement(save,'弹两分钟钢琴').available).toBe(false);
 expect(classifyChoiceExecution(save,'弹两分钟钢琴')).toBe('NOT_EXECUTABLE');
});
it('does not let a static location description repair a destroyed registered instrument',async()=>{
 const save=await fixture('destroyed',false),here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 save.definition.map!.locations.find(place=>place.id===here)!.description+=' 房间里有一架可用的钢琴。';
 expect(activityRequirement(save,'弹两分钟钢琴').available).toBe(false);
 expect(()=>executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID())).toThrow();
});
it('retains described scenery without creating an inventory object',async()=>{
 const save=await fixture('intact',false);save.entities=save.entities.filter(e=>e.id!=='qa_piano');
 const here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 save.definition.map!.locations.find(place=>place.id===here)!.description+=' 房间里有一架可用的钢琴。';
 const after=executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID()).save;
 expect(after.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);expect(after.entities).toEqual(save.entities);
});
it('cannot use a known held instrument inside sealed ancestry',async()=>{
 const save=await fixture('intact',true),inventory=save.entities.find(e=>e.id==='player')!.components.inventory!;
 save.entities.push({id:'qa_case',type:'item',components:{identity:{name:'封存箱',description:'已登记容器',avatar_id:null},
  item:{weight:1,stackable:false,tracking:'tracked',container:true,tags:['sealed']},discovery:{known_to_player:true}}});
 (inventory.items as Record<string,number>).qa_case=1;inventory.placements={qa_case:null,qa_piano:'qa_case'};validateSave(save);
 expect(activityRequirement(save,'弹两分钟钢琴').available).toBe(false);expect(()=>executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID())).toThrow();
});
it('retains exact disk state and zero generation after refusal and service recreation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-destroyed-resource-'));try{
  const save=await fixture('destroyed',false),store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Refusal must not generate');}}),service=new GameService(store,ai,save.definition),before=await service.current();
  const bytes=await readFile(join(directory,'current.json')),body={input:'弹两分钟钢琴',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  await expect(service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow();
  expect(await store.read()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);
  await expect(restarted.turn(body,undefined,undefined,undefined,false,undefined,undefined,true)).rejects.toThrow();
  expect(await restarted.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it.each(['intact','damaged'] as const)('retains a usable %s instrument without inventing repair',async condition=>{
 const save=await fixture(condition,false),after=executeFreeform(save,'弹两分钟钢琴',proposal,randomUUID()).save;
 expect(after.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);
 expect(after.entities.find(e=>e.id==='qa_piano')!.components.item!.condition).toBe(condition);
});

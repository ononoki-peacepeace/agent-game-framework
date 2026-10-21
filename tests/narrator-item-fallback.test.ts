import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
const modes=['held','scene','container','scene_container','transfer'] as const;
const cases=narrativeWorldKinds.flatMap(kind=>[
 ...modes.map(mode=>({kind,mode,boundary:'normal' as const})),
 ...(['before','after'] as const).map(boundary=>({kind,mode:'container' as const,boundary})),
]);
it.each(cases)('N8 item prose $kind / $mode / $boundary',async({kind,mode,boundary})=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-n8-item-prose-'));try{
  const save=structuredClone((await prepareNarrativeWorld(kind)).save),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
  const paper=save.entities.find(e=>e.id==='qa_paper')!,here=String(player.components.location!.location_id);
  const inventory=player.components.inventory as {items:Record<string,number>;placements?:Record<string,string|null>};
  inventory.placements??={};if(mode!=='held'){inventory.items.qa_paper=1;inventory.placements.qa_paper=null;delete paper.components.location;paper.components.item!.owner_id=player.id;}
  save.entities.push({id:'prose_bag',type:'item',components:{identity:{name:'布包',description:'已有容器',avatar_id:null},
   item:{weight:.1,stackable:false,container:true,...(mode==='scene_container'?{}:{owner_id:player.id})},
   ...(mode==='scene_container'?{location:{location_id:here}}:{}),discovery:{known_to_player:true}}});
  if(mode!=='scene_container'){inventory.items.prose_bag=1;inventory.placements.prose_bag=null;}
  const ai=new AIRuntime(new MockAIAdapter());let calls=0;
  ai.narrate=async()=>{calls++;throw new ProviderError('refusal','offline-n8','controlled fallback');};
  const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,ai,save.definition),before=await service.current();
  const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
   action:mode==='transfer'?{type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_paper'}}:
    {type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:mode,container_id:mode.includes('container')?'prose_bag':null,position_label:null}}};
  const initialBytes=await readFile(join(directory,'current.json')),write=store.write.bind(store);let injected=false;
  if(boundary!=='normal')store.write=async(next,slot)=>{
   if(!injected&&next.resolution_receipts?.some(r=>r.request_id===request.request_id)){
    injected=true;if(boundary==='after')await write(next,slot);throw Error('controlled N8 world write failure');
   }return write(next,slot);
  };
  let response;
  if(boundary==='normal')response=await service.turn(request);
  else{
   await expect(service.turn(request)).rejects.toThrow('controlled N8 world write failure');expect(injected).toBe(true);
   if(boundary==='before')expect(await readFile(join(directory,'current.json'))).toEqual(initialBytes);
   // Explicit same-request recovery, not an automatic retry or a fresh action.
   response=await new GameService(new JsonStore(directory),ai,save.definition).turn(request);
  }
  const after=await new GameService(new JsonStore(directory),ai,save.definition).current(),text=after.last_turn!.narrative;
  const expected=mode==='held'?'你把纸片拿在手中。':mode==='scene'?'你放下了纸片。':
   mode==='transfer'?'你把纸片交给了林舟。':'你把纸片放进了布包。';
  const output=process.env.NARRATOR_BENCHMARK_OUTPUT;
  if(output&&boundary==='normal')await writeFile(join(output,`D-${kind}-${mode}.json`),JSON.stringify({case_id:`D-${kind}-${mode}`,
   provenance:'actual_offline_fallback',rendered:text,expected,request,receipts:after.resolution_receipts!.filter(r=>r.request_id===request.request_id),
   quality_ratings:null,independent_review:null},null,2));
  expect(text).toBe(expected);expect(text).not.toMatch(/登记|更新|结算|系统|qa_paper|prose_bag/);
  expect(after.last_turn!.presentation!.status).toBe('degraded');expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  const bytes=await readFile(join(directory,'current.json')),fresh=new GameService(new JsonStore(directory),ai,save.definition),priorCalls=calls;
  expect(await fresh.turn(request)).toEqual(response);expect(await fresh.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(calls).toBe(priorCalls);
  expect(after.resolution_receipts!.filter(r=>r.request_id===request.request_id)).toHaveLength(1);
  if(boundary==='normal')expect(calls).toBe(1);
 }finally{await rm(directory,{recursive:true,force:true});}
},30000);

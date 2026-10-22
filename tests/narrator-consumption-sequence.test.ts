import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {executeAction} from '../src/core/runtime.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
const run=randomUUID();
const narrative=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(narrativeWorldKinds)('retains separately described repeated consumption without merging events in %s',async kind=>{
 const {save}=await consumptionWorld(kind),directory=await mkdtemp(join(tmpdir(),'agf-repeated-consume-'));
 try{
  const store=new JsonStore(directory);await store.write(save);
  const text='你吃掉了一份面包。随后你又吃掉了一份面包。';
  const ai=new AIRuntime({name:'offline-repeated-consumption',generate:async request=>{
   if(request.role==='narrator')return {data:narrative(text)};
   throw new ProviderError('refusal','offline-only','No real model');
  }});
  const service=new GameService(store,ai,save.definition),before=await service.current(),steps=['吃掉一份面包','吃掉一份面包'];
  const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:steps.join('，再')};
  await service.turn(body,undefined,undefined,undefined,false,undefined,steps);
  const after=await service.current(),receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
  const children=after.resolution_receipts!.filter(r=>r.consumption);
  await writeFile(`.agent-runtime/codex/repeated-consumption-${run}-${kind}.json`,JSON.stringify({body,before,after,receipt,children},null,2));
  expect(quantity(after)).toBe(1);expect(children).toHaveLength(2);expect(children.map(r=>r.consumption!.consumed_quantity)).toEqual([1,1]);
  expect(after.last_turn!.narrative).toBe(text);expect(after.last_turn!.presentation!.status).toBe('normal');
  for(const legal of [text,'你吃掉了两份面包。'])expect(()=>validateResolvedNarrative(receipt,narrative(legal),false,children,after)).not.toThrow();
  expect(()=>validateResolvedNarrative(receipt,{...narrative(text),scene_beats:[{kind:'narration',text}]},false,children,after)).not.toThrow();
  const single=executeAction(save,{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:2}},randomUUID());
  expect(()=>validateResolvedNarrative(single.save.resolution_receipts!.at(-1)!,narrative(text),false,undefined,single.save)).toThrow();
  for(const wrong of ['你吃掉了三份面包。',text+'之后你又吃掉了一份面包。','你吃掉了两份面包。你又吃掉了两份面包。'])
   expect(()=>validateResolvedNarrative(receipt,narrative(wrong),false,children,after)).toThrow();
  const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  await new GameService(new JsonStore(directory),ai,save.definition).turn(body);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
},90000);

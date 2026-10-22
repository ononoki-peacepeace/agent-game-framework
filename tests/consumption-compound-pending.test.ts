import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import * as core from '../src/core/runtime.js';
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
it.each(narrativeWorldKinds)('recovers compound consumption narration from durable context alone in %s',async kind=>{
 const {save}=await consumptionWorld(kind),actor=save.entities.find(e=>e.id==='player')!,bread=save.entities.find(e=>e.id==='qa_bread')!;
 delete (actor.components.inventory!.items as Record<string,number>).qa_bread;bread.components.location={location_id:actor.components.location!.location_id};bread.components.item!.stackable=false;
 const directory=await mkdtemp(join(tmpdir(),'agf-consume-compound-pending-'));try{
  const store=new JsonStore(directory);await store.write(save);const prompts:Record<string,unknown>[]=[];
  const text='你拿着面包，随后吃掉了一份面包。';
  const ai=new AIRuntime({name:'offline-compound-consumption',generate:async request=>{
   if(request.role==='narrator'){prompts.push(JSON.parse(request.prompt.slice(request.prompt.indexOf('{'))));return {data:{narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};}
   throw new ProviderError('refusal','offline-only','No real model');
  }});
  const original=ai.interpret.bind(ai),interpret=vi.spyOn(ai,'interpret');
  // Only pickup binding is supplied. Consumption is the actual source-grounded route.
  interpret.mockImplementation(async(current,input)=>input==='拿起面包'?{type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'held'}}:original(current,input));
  const narrate=ai.narrate.bind(ai);vi.spyOn(ai,'narrate').mockRejectedValueOnce(Error('prepared compound narration interrupted')).mockImplementation(narrate);
  const service=new GameService(store,ai,save.definition),before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'拿起面包，然后吃掉一份'},steps=['拿起面包','吃掉一份'];
  const bytes=await readFile(join(directory,'current.json'));await expect(service.turn(body,undefined,undefined,undefined,false,undefined,steps)).rejects.toThrow();
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const pending=await store.readPending(body.request_id);expect(quantity(pending!.candidate)).toBe(0);
  const current=new GameService(new JsonStore(directory),ai,save.definition),execute=vi.spyOn(core,'executeAction');
  await expect(current.turn({...body,input:'吃掉两份面包'})).rejects.toThrow();
  await expect(current.turn(body,undefined,undefined,undefined,false,undefined,['拿起面包','吃掉两份面包'])).rejects.toThrow();
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  // The reconstructed client has only its original JSON body, not caller-only arguments.
  const response=await current.turn(body),after=await current.current();
  await writeFile(`.agent-runtime/codex/consumption-compound-pending-${run}-${kind}.json`,JSON.stringify({body,before,pending,response,after,prompts},null,2));
  expect(after.last_turn!.narrative).toBe(text);expect(after.last_turn!.presentation!.status).toBe('normal');expect(quantity(after)).toBe(0);
  expect(prompts.at(-1)?.resolution_receipt).toMatchObject({compound_steps:[{semantic_action:'MOVE_ITEM'},{semantic_action:'CONSUME_ITEM',consumption:{consumed_quantity:1}}]});
  expect(execute).not.toHaveBeenCalled();expect(after.state_revision).toBe(before.state_revision+1);
  const committed=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  await new GameService(new JsonStore(directory),ai,save.definition).turn(body);
  expect(await readFile(join(directory,'current.json'))).toEqual(committed);expect(ai.metrics.requests).toBe(calls);
  await expect(current.turn({...body,input:'吃掉两份面包'})).rejects.toThrow();
  expect(await readFile(join(directory,'current.json'))).toEqual(committed);
 }finally{await rm(directory,{recursive:true,force:true});}
},90000);

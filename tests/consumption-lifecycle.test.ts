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
import {corpusProposal,freeformCorpus} from './fixtures/freeform-fixed-corpus.js';
import type {ActionInput} from '../src/shared/contracts.js';
import {publicView} from '../src/core/state.js';
import {actionBindingContext} from '../src/ai/action-context.js';
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
const result=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(narrativeWorldKinds.flatMap(kind=>[false,true].map(fallback=>({kind,fallback}))))('settles held/contained/temporary consumables and their later use in $kind / fallback=$fallback',async({kind,fallback})=>{
 const {save}=await consumptionWorld(kind),here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 const player=save.entities.find(e=>e.id==='player')!;
 const bread=save.entities.find(e=>e.id==='qa_bread')!;delete (player.components.inventory!.items as Record<string,number>).qa_bread;
 bread.components.item!.stackable=false;bread.components.item!.container_id='qa_box';bread.components.location={location_id:here};
 save.entities.push({id:'qa_box',type:'item',components:{identity:{name:'木盒',description:'世界允许打开的封闭容器',avatar_id:null},location:{location_id:here},item:{weight:1,stackable:false,container:true,openable:true,tags:['sealed']},discovery:{known_to_player:true}}});
 save.definition.ruleset.ordinary_item_consumption=[{name:'便签纸',minutes:1}];
 save.definition.map!.locations.find(l=>l.id===here)!.description+=' 桌上有供日常记录使用的便签纸。';
 const directory=await mkdtemp(join(tmpdir(),'agf-consume-lifecycle-'));try{
  const store=new JsonStore(directory);await store.write(save);
  let prose='你打开了木盒。';const payloads:unknown[]=[],captures:unknown[]=[];
  const ai=new AIRuntime({name:'offline-consumption-lifecycle',generate:async request=>{
   if(request.role==='narrator'){payloads.push(request.prompt);if(fallback)throw new ProviderError('refusal','offline-only','fixed offline refusal');return {data:result(prose)};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded)return {data:{grounded:true,reports_result:true,reason:'fixed offline receipt audit, not human quality',unsupported_claims:[]}};
   throw new ProviderError('refusal','offline-only','No real model');
  }});
  let service=new GameService(store,ai,save.definition);
  const step=async(action:ActionInput,text:string)=>{
   prose=text;const before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action};
   const response=await service.turn(body),after=await service.current(),receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
   expect(receipt.commit_status).toBe('committed');expect(after.state_revision).toBe(before.state_revision+1);
   expect(after.last_turn!.presentation!.status).toBe(fallback?'degraded':'normal');if(!fallback)expect(after.last_turn!.narrative).toBe(text);
   const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
   const fresh=new GameService(new JsonStore(directory),ai,save.definition);expect(await fresh.turn(body)).toEqual(response);expect(await fresh.current()).toEqual(after);
   expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);service=fresh;captures.push({body,before,after,response,receipt});return after;
  };
  const refuse=async(action:ActionInput)=>{
   const before=await service.current(),bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
   await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action})).rejects.toThrow();
   expect(await service.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
  };
  await refuse({type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'held'}});
  await step({type:'OPEN_CONTAINER',target_id:'qa_box',parameters:{}},'你打开了木盒。');
  await step({type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'held'}},'你拿起了面包。');
  let after=await step({type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}},'你吃掉了一份面包。你没有拿着面包。');
  expect(quantity(after)).toBe(0);expect(actionBindingContext(publicView(after),'查看面包').authoritative_inventory.some(item=>item.item_id==='qa_bread')).toBe(false);
  await refuse({type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}});await refuse({type:'MOVE_ITEM',parameters:{item_id:'qa_bread',to:'held'}});
  const before=await service.current(),input='我查看桌上的便签纸',body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
  const proposal=vi.spyOn(ai,'freeform').mockResolvedValue({...corpusProposal(freeformCorpus.find(c=>c.id==='ordinary-activity')!),minutes:1,environment_query:{name:'便签纸',source_quote:input,intent:'observe'},resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',stakes:'查看普通日用品',stages:[],evidence_ids:[]}});
  const assess=vi.spyOn(ai,'assessEnvironment').mockResolvedValue({authorized_intent:'observe',scope_complete:true,classification:'ordinary_item',existence:'present',ownership:'unclaimed',world_compatible:true,scene_compatible:true,contradicts_known:false,resource_advantage:false,weight:.01,description:'普通便签纸',basis:[{source:'scene',quote:'供日常记录使用的便签纸'}],same_as:null});
  prose='你看见了便签纸。';await service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
  after=await service.current();const note=after.entities.find(e=>e.components.identity?.name==='便签纸')!;
  expect(note.components.item!.consumable).toEqual({method:'use',minutes:1});expect(quantity(after,note.id)).toBe(0);
  const bytes=await readFile(join(directory,'current.json')),counts=[proposal.mock.calls.length,assess.mock.calls.length,ai.metrics.requests];
  const restarted=new GameService(new JsonStore(directory),ai,save.definition);await restarted.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect([proposal.mock.calls.length,assess.mock.calls.length,ai.metrics.requests]).toEqual(counts);service=restarted;proposal.mockRestore();assess.mockRestore();
  await step({type:'MOVE_ITEM',parameters:{item_id:note.id,to:'held'}},'你拿起了便签纸。');
  after=await step({type:'CONSUME_ITEM',target_id:note.id,parameters:{quantity:1}},'你用掉了一份便签纸。');expect(quantity(after,note.id)).toBe(0);
  await refuse({type:'MOVE_ITEM',parameters:{item_id:note.id,to:'held'}});await refuse({type:'CONSUME_ITEM',target_id:note.id,parameters:{quantity:1}});
  expect(after.entities.filter(e=>e.components.identity?.name==='便签纸')).toHaveLength(1);
  captures.push({temporary_materialization:body,entity_id:note.id,final:after});
  await writeFile(`.agent-runtime/codex/consumption-lifecycle-${run}-${kind}-${fallback}.json`,JSON.stringify({kind,fallback,captures,payloads},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},180000);

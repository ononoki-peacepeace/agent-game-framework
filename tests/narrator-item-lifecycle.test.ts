import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {executeAction} from '../src/core/runtime.js';
import type {EnvironmentAssessment,EnvironmentQuery} from '../src/core/environment-schema.js';
import * as freeformRuntime from '../src/core/freeform.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validateSave,publicView} from '../src/core/state.js';
import {actionBindingContext} from '../src/ai/action-context.js';
import type {ActionInput} from '../src/shared/contracts.js';
import {freeformCorpus,corpusProposal} from './fixtures/freeform-fixed-corpus.js';
afterEach(()=>vi.restoreAllMocks());
const run=randomUUID();
const narration=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(narrativeWorldKinds)('keeps narration and later actual item actions consistent across disk/replay in %s',async kind=>{
 const prepared=await prepareNarrativeWorld(kind);let seed=structuredClone(prepared.save);
 const here=seed.entities.find(e=>e.id==='player')!.components.location!.location_id;
 for(const [id,name,sealed] of [['qa_open','木盒',false],['qa_closed','封盒',true]] as const)seed.entities.push({id,type:'item',components:{identity:{name,description:'既有容器',avatar_id:null},item:{weight:1,stackable:false,container:true,tracking:'tracked',tags:sealed?['sealed']:[]},location:{location_id:here},discovery:{known_to_player:true}}});
 seed.entities.push({id:'qa_locked',type:'item',components:{identity:{name:'封盒里的木签',description:'已知但封闭',avatar_id:null},item:{weight:.1,stackable:false,container_id:'qa_closed',tracking:'tracked'},location:{location_id:here},discovery:{known_to_player:true}}});
 const place=seed.definition.map!.locations.find(l=>l.id===here)!;place.description+=' 这里有一只普通木盒，旁边是供日常写作的书桌。';
 const assessment={authorized_intent:'observe' as const,scope_complete:true,classification:'ordinary_item' as const,existence:'present' as const,ownership:'unclaimed' as const,world_compatible:true,scene_compatible:true,contradicts_known:false,resource_advantage:false,weight:.1,description:'普通木尺',basis:[{source:'scene' as const,quote:'普通木盒'}],same_as:null};
 const query='我查看木盒里的普通木尺';
 const directory=await mkdtemp(join(tmpdir(),'agf-item-lifecycle-'));try{
  const store=new JsonStore(directory);await store.write(seed);
  const requests:Record<string,unknown>[]=[],captures:unknown[]=[],materializationReceipts:NonNullable<typeof seed.resolution_receipts>=[];
  let candidate:string|null=null;
  const ai=new AIRuntime({name:'offline-item-lifecycle',generate:async request=>{
   if(request.role==='narrator'){requests.push(JSON.parse(request.prompt.slice(request.prompt.indexOf('{'))));if(candidate)return {data:narration(candidate)};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded)return {data:{grounded:true,reports_result:true,reason:'固定离线候选按本次Core凭据审计；不是人工质量评分',unsupported_claims:[]}};
   throw new ProviderError('refusal','offline-item-lifecycle','固定离线拒绝');
  }});
  let service=new GameService(store,ai,seed.definition);
  const act=async(action:ActionInput,text:string|null=null)=>{
   const before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action};
   const name=(id:unknown)=>String(before.entities.find(entity=>entity.id===id)?.components.identity?.name??'物品');
   // Fixed authored candidates, not model quality evidence. Their actual truth
   // is checked against Core and the subsequent executable operations below.
   const item=name(action.parameters?.item_id),to=action.parameters?.to;
   const authored=action.type==='MOVE_ITEM'?(to==='held'?`你拿起${item}。`:to==='scene'?`你放下${item}。`:`你把${item}放进${name(action.parameters?.container_id)}。`):
    action.type==='TRANSFER_ITEM'?`你把${item}交给${name(action.target_id)}。`:
    action.type==='BUY'?`你买下了${action.parameters?.quantity}件${item}。`:
    action.type==='SELL'?`你卖出了${action.parameters?.quantity}件${item}。`:
    action.type==='MOVE'?`你沿路走到了${before.definition.map!.locations.find(location=>location.id===action.target_id)!.name}。`:null;
   candidate=text??authored;
   await service.turn(body);const after=await service.current(),bytes=await readFile(join(directory,'current.json')),calls=requests.length;
   const receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!;
   expect(receipt.commit_status).toBe('committed');
   if(!text&&authored){expect(after.last_turn!.narrative).toBe(authored);expect(after.last_turn!.presentation?.status).toBe('normal');}
   expect(after.state_revision).toBe(before.state_revision+1);
   const restarted=new GameService(new JsonStore(directory),ai,seed.definition);await restarted.turn(body);
   expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(requests).toHaveLength(calls);
   captures.push({body,receipt,story:after.last_turn,inventory:after.entities.filter(e=>e.components.character).map(e=>({id:e.id,inventory:e.components.inventory})),projection:actionBindingContext(publicView(after),'观察物品')});
   await writeFile(join(process.cwd(),'.agent-runtime/codex',`item-lifecycle-progress-${run}-${kind}.json`),JSON.stringify(captures,null,2));
   service=restarted;candidate=null;return after;
  };
  const refuse=async(action:ActionInput)=>{
   const before=await service.current(),bytes=await readFile(join(directory,'current.json')),calls=requests.length;
   for(let retry=0;retry<2;retry++)await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action})).rejects.toThrow();
   expect(await service.current()).toEqual(before);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(requests).toHaveLength(calls);
   captures.push({refused:action,revision:before.state_revision});
  };
  const observe=async(input:string,query:EnvironmentQuery,admission:EnvironmentAssessment,text:string)=>{
   const before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
   const base=corpusProposal(freeformCorpus.find(sample=>sample.id==='ordinary-activity')!);
   const proposal=vi.spyOn(ai,'freeform').mockResolvedValue({...base,minutes:1,environment_query:query,resolution:{...base.resolution!,domain:'perception'}});
   const assessor=vi.spyOn(ai,'assessEnvironment').mockResolvedValue(admission);candidate=text;
   await service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
   const after=await service.current(),receipt=after.resolution_receipts!.find(entry=>entry.request_id===body.request_id)!;
   expect(receipt.commit_status).toBe('committed');expect(receipt.environment?.status).toBe('present');
   expect(after.state_revision).toBe(before.state_revision+1);materializationReceipts.push(receipt);
   const bytes=await readFile(join(directory,'current.json')),calls=[proposal.mock.calls.length,assessor.mock.calls.length,requests.length];
   const restarted=new GameService(new JsonStore(directory),ai,seed.definition);
   await restarted.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
   expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(await restarted.current()).toEqual(after);
   expect([proposal.mock.calls.length,assessor.mock.calls.length,requests.length]).toEqual(calls);
   proposal.mockRestore();assessor.mockRestore();candidate=null;service=restarted;
   captures.push({body,receipt,story:after.last_turn});return after;
  };
  const returnFromNpc=async(itemId:string)=>{
   const before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
   const action={type:'TRANSFER_ITEM',target_id:'player',parameters:{item_id:itemId}},operation={fixture:'controlled NPC Core transfer',actor_id:'npc_lin',action};
   let executions=0;
   await service.agentTransaction(body,operation,current=>{
    executions++;const turn=executeAction(current,action,body.request_id,'ai',undefined,undefined,true,'npc_lin');
    Object.assign(current,turn.save);
    const receipt=current.resolution_receipts!.find(entry=>entry.request_id===body.request_id)!;
    expect(receipt.commit_status).toBe('pending');
    // Framework-owned commit metadata follows the same pattern as NPC execution;
    // the real agentTransaction checkpoints and atomically stores this image.
    receipt.commit_status='committed';
   });
   const after=await service.current(),receipt=after.resolution_receipts!.find(entry=>entry.request_id===body.request_id)!;
   expect(receipt.actor_id).toBe('npc_lin');expect(receipt.commit_status).toBe('committed');expect(after.state_revision).toBe(before.state_revision+1);
   const bytes=await readFile(join(directory,'current.json')),calls=requests.length;
   const restarted=new GameService(new JsonStore(directory),ai,seed.definition);
   await restarted.agentTransaction(body,operation,()=>{throw Error('NPC replay reran Core');});
   expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(executions).toBe(1);expect(requests).toHaveLength(calls);
   captures.push({npc_transaction:body,operation,receipt});service=restarted;return after;
  };
  await observe(query,{name:'普通木尺',source_quote:query,intent:'observe',container_id:'qa_open'},assessment,'你查看木盒，看见普通木尺。');
  const ruler=(await service.current()).entities.find(entity=>entity.components.identity?.name==='普通木尺')!;
  const desk=await observe('我查看书桌',{name:'书桌',source_quote:'我查看书桌',intent:'observe'},
   {...assessment,classification:'environment_detail',ownership:'shared',weight:0,description:'供写作的陈设',basis:[{source:'scene',quote:'供日常写作的书桌'}]},'你看见书桌。');
  expect(desk.entities.some(entity=>entity.components.identity?.name==='书桌'&&entity.components.item)).toBe(false);
  const inv=(save:typeof seed,id='player')=>save.entities.find(e=>e.id===id)!.components.inventory?.items as Record<string,number>;
  await refuse({type:'MOVE_ITEM',parameters:{item_id:'unmaterialized_desk',to:'held'}});
  expect(actionBindingContext(publicView(await service.current()),'查看书桌').authoritative_inventory.some(item=>item.name==='书桌')).toBe(false);
  // A genuine check failure leaves the original scene asset available for a later retry.
  const beforeMiss=await service.current(),missBody={game_id:beforeMiss.game_id,expected_revision:beforeMiss.state_revision,request_id:randomUUID(),input:'拿起纸片'};
  const proposal=vi.spyOn(ai,'freeform').mockResolvedValue(corpusProposal(freeformCorpus.find(sample=>sample.id==='pickup-failure')!));
  const original=freeformRuntime.executeFreeform,rng=vi.fn(()=>.01);
  const core=vi.spyOn(freeformRuntime,'executeFreeform').mockImplementation((...args)=>{args[4]=rng;return original(...args);});candidate='你没有拿起纸片。';
  await service.turn(missBody,undefined,undefined,undefined,false,undefined,undefined,true);
  const missed=await service.current(),missReceipt=missed.resolution_receipts!.find(receipt=>receipt.request_id===missBody.request_id)!;
  expect(missReceipt.outcome).toBe('critical_failure');expect(missReceipt.commit_status).toBe('committed');expect(inv(missed).qa_paper??0).toBe(0);expect(missed.state_revision).toBe(beforeMiss.state_revision+1);
  const missBytes=await readFile(join(directory,'current.json')),missCalls=[rng.mock.calls.length,proposal.mock.calls.length,requests.length];
  const afterMiss=new GameService(new JsonStore(directory),ai,seed.definition);await afterMiss.turn(missBody,undefined,undefined,undefined,false,undefined,undefined,true);
  expect(await readFile(join(directory,'current.json'))).toEqual(missBytes);expect([rng.mock.calls.length,proposal.mock.calls.length,requests.length]).toEqual(missCalls);
  captures.push({body:missBody,receipt:missReceipt,story:missed.last_turn});core.mockRestore();proposal.mockRestore();candidate=null;service=afterMiss;
  let state=await act({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'held'}});expect(inv(state).qa_paper).toBe(1);
  await refuse({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'scene_container',container_id:'qa_closed'}});
  state=await act({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'scene_container',container_id:'qa_open'}});expect(inv(state).qa_paper??0).toBe(0);expect(state.entities.find(e=>e.id==='qa_paper')!.components.item!.container_id).toBe('qa_open');
  await refuse({type:'MOVE_ITEM',parameters:{item_id:'qa_locked',to:'held'}});
  state=await act({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'held'}});expect(inv(state).qa_paper).toBe(1);
  state=await act({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'scene'}});expect(inv(state).qa_paper??0).toBe(0);
  await act({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'held'}});
  state=await act({type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_paper'}},'你仍然拿着纸片。');
  expect(state.last_turn!.presentation?.status).toBe('degraded');expect(state.last_turn!.narrative).not.toContain('仍然拿着纸片');expect(inv(state).qa_paper??0).toBe(0);expect(inv(state,'npc_lin').qa_paper).toBe(1);
  await refuse({type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:'qa_paper'}});
  // The NPC can really return that same asset; the player cannot retrieve a clone.
  await returnFromNpc('qa_paper');
  state=await act({type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'scene'}});expect(inv(state,'npc_lin').qa_paper??0).toBe(0);
  state=await act({type:'MOVE_ITEM',parameters:{item_id:ruler.id,to:'held'}});expect(inv(state)[ruler.id]).toBe(1);
  state=await act({type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:ruler.id}});expect(inv(state,'npc_lin')[ruler.id]).toBe(1);
  await returnFromNpc(ruler.id);
  state=await act({type:'MOVE_ITEM',parameters:{item_id:ruler.id,to:'scene'}});
  state=await act({type:'MOVE_ITEM',parameters:{item_id:ruler.id,to:'held'}});expect(inv(state)[ruler.id]).toBe(1);expect(state.entities.filter(e=>e.components.identity?.name==='普通木尺')).toHaveLength(1);
  if(kind==='commerce'){
   await act({type:'MOVE',target_id:'market',parameters:{}});
   const beforeTrade=await service.current(),water=Number(inv(beforeTrade).water??0);
   state=await act({type:'BUY',target_id:'corner_shop',parameters:{item_id:'water',quantity:2}});expect(inv(state).water).toBe(water+2);
   expect(actionBindingContext(publicView(state),'查看饮水').authoritative_inventory.find(item=>item.item_id==='water')?.quantity).toBe(water+2);
   state=await act({type:'SELL',target_id:'corner_shop',parameters:{item_id:'water',quantity:1}});expect(inv(state).water).toBe(water+1);
  }
  const before=await service.current(),bytes=await readFile(join(directory,'current.json'));
  // The current Core has no consumption capability. Narrator must not silently consume an asset.
  expect(()=>executeFreeform(before,'吃掉普通木尺',{...corpusProposal(freeformCorpus.find(s=>s.id==='ordinary-activity')!),minutes:1},randomUUID())).toThrow('消耗');
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(requests.length).toBeGreaterThan(0);
  for(const payload of requests){
   if(payload.fixed_outcome){
    // Expression-only rewrite has a different envelope; preserve and check it
    // separately instead of pretending it is the main narration context.
    const fixed=payload.fixed_outcome as {facts:unknown;first:{narrative:unknown}};
    expect(Array.isArray(fixed.facts)).toBe(true);expect(typeof fixed.first.narrative).toBe('string');
    continue;
   }
   expect(Array.isArray(payload.authoritative_inventory)).toBe(true);
   expect(Array.isArray(payload.visible_scene_items)).toBe(true);
   const inventory=payload.authoritative_inventory as {item_id:string;placement:string}[];
   const scene=payload.visible_scene_items as {placement:string}[];
   const carried=inventory.find(item=>item.item_id==='qa_paper');
   if(carried)expect(carried.placement).not.toBe('scene');
   expect(scene.every(item=>item.placement==='scene')).toBe(true);
  }
  await writeFile(join(process.cwd(),'.agent-runtime/codex',`item-lifecycle-${run}-${kind}.json`),JSON.stringify({kind,world_witnesses:prepared.evidence,materialization_receipts:materializationReceipts,captures,requests,final_state:validateSave(await service.current())},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
},180000);

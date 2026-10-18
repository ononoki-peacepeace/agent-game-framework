// Real provider check against disposable worlds. The live data directory is read only for provider settings.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave} from '../src/core/state.js';
import {routeContext} from '../src/system/context-router.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {sparseWorld} from '../tests/sparse-fixture.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(!config||config.provider!=='deepseek'){console.log('HUMAN QA REAL SMOKE NOT_RUN: DeepSeek is not configured');process.exit(0);}
const root=await mkdtemp(join(tmpdir(),'agf-human-qa-real-'));
try{
 const world=sparseWorld(),player=world.entities.find(e=>e.id===world.player.entity_id)!,npc=world.entities.find(e=>e.id!==player.id&&e.components.character)!;
 npc.components.identity.name='角色甲';npc.components.location=structuredClone(player.components.location);
 const second=structuredClone(npc);second.id='qa_second';second.components.identity.name='角色乙';
 const provider=new AIProviderManager(root,config),ai=new AIRuntime(provider),store=new JsonStore(join(root,'save'));
 const service=new GameService(store,ai,world);await store.write(newSave(world));
 const tx=async(input:string)=>{const before=await service.current();return {request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input};};
 const results:Array<{case:string;status:'PASS'|'FAIL';detail?:string}>=[];
 const record=(name:string,pass:boolean,detail?:string)=>{results.push({case:name,status:pass?'PASS':'FAIL',...(detail?{detail}:{} )});console.log(JSON.stringify(results.at(-1)));};
 try{
   const input='看异常',gate=await routeContext(service,input,'world_input'),result=await handleAgentInput(service,await tx(input));
   const current=await service.current(),receipt=current.resolution_receipts?.at(-1);
   record('A perception',gate.destination==='WORLD_INTENT'&&result.intent==='WORLD_ACTION'&&!!receipt&&receipt.commit_status==='committed'&&!/这次尝试没有达到预期/.test(current.last_turn?.narrative??''),`route=${gate.destination};receipt=${receipt?.kind??'none'};result=${String(result.message).slice(0,160)}`);
 }catch(error){record('A perception',false,error instanceof Error?error.message.slice(0,160):'unknown');}
 try{
   const before=await service.current();before.last_turn={narrative:'角色甲站在身旁。',speaker:npc.id,dialogue:null,choices:[],context_actions:[]};before.action_facts=[{request_id:randomUUID(),actor_id:player.id,target_id:npc.id,input:'我和角色甲说话',facts:['已交谈'],time:{...before.runtime.time}}];await store.write(before);
   const gate=await routeContext(service,'继续推他','world_input');
   record('B pronoun typo',gate.destination==='WORLD_INTENT'&&gate.resolved_input?.includes('角色甲')===true,`route=${gate.destination};resolved=${Boolean(gate.resolved_input)}`);
 }catch(error){record('B pronoun typo',false,error instanceof Error?error.message.slice(0,160):'unknown');}
 try{
   const before=await service.current();before.entities.push(second);before.last_turn=null;before.action_facts=[];await store.write(before);
   const gate=await routeContext(service,'我想推她一下','world_input');
   const answer=gate.destination==='AMBIGUOUS'?await routeContext(service,'她是角色甲','world_input'):null;
   record('C clarify resume',gate.destination==='AMBIGUOUS'&&answer?.destination==='WORLD_INTENT'&&answer.resolved_input?.includes('角色甲')===true,`initial=${gate.destination};resume=${answer?.destination??'none'}`);
 }catch(error){record('C clarify resume',false,error instanceof Error?error.message.slice(0,160):'unknown');}
 try{
   const before=await service.current();
   before.entities=before.entities.filter(entity=>entity.id!==second.id);
   before.last_turn={narrative:'角色甲站在身旁。',speaker:npc.id,dialogue:null,choices:[],context_actions:[]};
   before.action_facts=[{request_id:randomUUID(),actor_id:player.id,target_id:npc.id,input:'我和角色甲说话',facts:['已交谈'],time:{...before.runtime.time}}];
   await store.write(before);
   const input='趁她转身时推她一下',gate=await routeContext(service,input,'world_input');
   const result=await handleAgentInput(service,await tx(gate.resolved_input??input)),after=await service.current();
   const receipt=after.resolution_receipts?.at(-1),newReceipt=(after.resolution_receipts?.length??0)>(before.resolution_receipts?.length??0);
   record('D conditional action',gate.destination==='WORLD_INTENT'&&!/(条件必须由独立条件节点|ConditionNode|validator)/.test(result.message)&&result.plan?.goals.some(goal=>goal.type==='CONDITIONAL_INTENT')===true&&(after.state_revision===before.state_revision||newReceipt&&Boolean(receipt?.semantic_action.includes('推'))),`route=${gate.destination};plan=${result.plan?.status??'none'};revision_delta=${after.state_revision-before.state_revision}`);
 }catch(error){record('D conditional action',false,error instanceof Error?error.message.slice(0,160):'unknown');}
 try{
   const before=await service.current();before.entities=before.entities.filter(entity=>entity.id!==second.id);before.last_turn={narrative:'角色甲后退了半步。',speaker:npc.id,dialogue:null,choices:[],context_actions:[]};before.action_facts=[{request_id:randomUUID(),actor_id:player.id,target_id:npc.id,input:'我推了角色甲一下',facts:['发生身体接触'],time:{...before.runtime.time}}];await store.write(before);
   const input='继续推她',gate=await routeContext(service,input,'world_input');
   const body=await tx(gate.resolved_input??input),result=await handleAgentInput(service,body),after=await service.current();
   const receipt=after.resolution_receipts?.at(-1),newReceipt=(after.resolution_receipts?.length??0)>(before.resolution_receipts?.length??0);
   record('E physical continuation',gate.destination==='WORLD_INTENT'&&result.intent==='WORLD_ACTION'&&newReceipt&&!!receipt&&receipt.semantic_action.includes('推')&&!receipt.effects.includes('position'),`route=${gate.destination};intent=${result.intent};receipt=${newReceipt?receipt?.kind:'none'};result=${String(result.message).slice(0,120)}`);
 }catch(error){record('E physical continuation',false,error instanceof Error?error.message.slice(0,160):'unknown');}
 if(results.some(result=>result.status==='FAIL'))process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true});}

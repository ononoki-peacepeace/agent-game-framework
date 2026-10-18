// Reuse a real recorded plan; controlled isolated RNG covers the partial-result recovery branch.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {demo} from '../tests/helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {resolutionProfile} from '../src/core/resolution.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {AIProviderManager,readPersistedProviderConfig} from '../src/ai/providers.js';
import {createApp} from '../src/server/app.js';
const source=process.argv[2];if(!source||!resolve(source).startsWith(resolve('.tmp')+'/')&&!resolve(source).startsWith(resolve('.tmp')+'\\'))throw Error('Supply an isolated recorded report');
const recorded=JSON.parse(await readFile(source,'utf8')),proposal=recorded.outputs.find((entry:any)=>entry.stage==='freeform').data,input=recorded.turns[0].input;
const hash=async()=>createHash('sha256').update(await readFile('data/current.json')).digest('hex'),productionBefore=await hash();
const config=await readPersistedProviderConfig(resolve('data'));if(config?.provider!=='deepseek')throw Error('Will not switch provider');
const root=resolve(`.tmp/recorded-partial-real-${Date.now()}`);await mkdir(root,{recursive:true});
const manager=new AIProviderManager(root,config),generate=manager.generate.bind(manager),calls:any[]=[];
const deadline=AbortSignal.timeout(240000);let attempts=0;
manager.generate=async request=>{if(++attempts>5)throw Error('REAL_ACCEPTANCE_REMAINING_CALL_BUDGET');const start=performance.now();
 const result=await generate({...request,signal:AbortSignal.any([deadline,AbortSignal.timeout(90000),...(request.signal?[request.signal]:[])])});
 calls.push({role:request.role,ms:Math.round(performance.now()-start),usage:result.usage,data:result.data});console.log(JSON.stringify({role:request.role,ms:calls.at(-1).ms}));return result;};
const world=structuredClone(demo);world.events=[];const save=newSave(world),player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id==='npc_lin')!;
player.components.scene_position={label:'近处'};npc.components.scene_position={label:'近处'};
npc.components.location=structuredClone(player.components.location);npc.components.condition={hp:100,stamina:100,stress:0};
const store=new JsonStore(root);await store.write(save);const service=new GameService(store,new AIRuntime(manager),world),before=await service.current();
const dice=resolutionProfile(before)==='bell_2d6'?2:1,rolls=[...Array(dice).fill(.99),...Array(dice).fill(0),...Array(dice).fill(0),...Array(dice).fill(.99)];
const requestId=randomUUID(),candidate=executeFreeform(before,input,proposal,requestId,()=>{const value=rolls.shift();if(value===undefined)throw Error('Unexpected extra RNG');return value;});
if(candidate.save.resolution_receipts!.at(-1)!.outcome!=='partial_success')throw Error('Controlled fixture did not cover partial success');
await store.writePending({game_id:before.game_id,request_id:requestId,expected_revision:before.state_revision,
 fingerprint:createHash('sha256').update(JSON.stringify({input})).digest('hex'),candidate:candidate.save,action:candidate.action,facts:candidate.facts,generic:true});
const server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}`;
const started=performance.now();let result:any;
try{
 const session=await (await fetch(base+'/api/session')).json() as {token:string};
 const response=await fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},
  body:JSON.stringify({request_id:requestId,game_id:before.game_id,expected_revision:before.state_revision,input}),signal:deadline});
 const body=await response.json(),after=(await new JsonStore(root).read())!;
 const callCount=calls.length;
 // Exact retry must use the committed receipt, not a second actor/scene call.
 await service.turn({request_id:requestId,game_id:before.game_id,expected_revision:before.state_revision,input});
 result={status:response.status,ms:Math.round(performance.now()-started),body,revision:[before.state_revision,after.state_revision],
  time:[before.runtime.time,after.runtime.time],receipt:after.resolution_receipts?.find(receipt=>receipt.request_id===requestId),
  narrative:after.last_turn?.narrative,retry_extra_calls:calls.length-callCount,
  physical:after.entities.find(e=>e.id==='npc_lin')?.components.physical_state};
}catch(error){result={error_name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'};}
finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
 await writeFile(resolve(root,'report.json'),JSON.stringify({root,source,controlled_rng:true,calls,result,production_unchanged:productionBefore===await hash()},null,2));
 console.log(JSON.stringify({root,calls:calls.length,result:{status:result.status,ms:result.ms,error_name:result.error_name,retry_extra_calls:result.retry_extra_calls}}));}

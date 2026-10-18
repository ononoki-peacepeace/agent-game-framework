// Bounded real-model acceptance. Only a synthetic world is written; no production action.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {StructuredLogger} from '../src/observability/logger.js';
import {newSave} from '../src/core/state.js';
import {demo} from '../tests/helpers.js';
const sourceHash=()=>readFile(resolve('data/current.json')).then(bytes=>createHash('sha256').update(bytes).digest('hex'));
const productionBefore=await sourceHash(),config=await readPersistedProviderConfig(resolve('data'));
if(config?.provider!=='deepseek')throw Error('Configured provider is not DeepSeek; will not switch it');
const root=resolve(`.tmp/qa-rev288-real-${Date.now()}`);await mkdir(root,{recursive:true});
const manager=new AIProviderManager(root,config),generate=manager.generate.bind(manager);
const calls:any[]=[],outputs:any[]=[],turns:any[]=[];let attempts=0;
const deadline=AbortSignal.timeout(480_000);
manager.generate=async request=>{
 if(++attempts>12)throw Error('REAL_ACCEPTANCE_TOTAL_CALL_BUDGET');
 const start=performance.now(),keys=Object.keys((request.schema as any)?.properties??{});
 const stage=keys.includes('domain')?'semantic':keys.includes('preserved')?'goal_preservation':keys.includes('goals')?'planning':
  keys.includes('resolution')?'freeform':request.role==='npc_decision'?'npc_decision':keys.includes('verdict')?'goal_alignment':request.role;
 const signal=AbortSignal.any([deadline,AbortSignal.timeout(90_000),...(request.signal?[request.signal]:[])]);
 try{const result=await generate({...request,signal});calls.push({stage,role:request.role,ms:Math.round(performance.now()-start),usage:result.usage??null,ok:true});
  outputs.push({stage,data:result.data});console.log(JSON.stringify({stage,ms:calls.at(-1).ms,ok:true}));return result;
 }catch(error){calls.push({stage,role:request.role,ms:Math.round(performance.now()-start),ok:false,error_name:error instanceof Error?error.name:'unknown',reason:(error as {reason?:string})?.reason??null});throw error;}
};
const world=structuredClone(demo);world.events=[];const save=newSave(world);
save.entities.find(e=>e.id==='npc_lin')!.components.identity.name='瀬川 美咲';
const player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id==='npc_lin')!;
player.components.scene_position={label:'近处'};npc.components.scene_position={label:'近处'};
npc.components.location=structuredClone(player.components.location);npc.components.condition={hp:100,stamina:100,stress:0};
save.definition.map!.locations.find(place=>place.id===player.components.location!.location_id)!.description+=' 广场旁有一面普通石墙。';
const store=new JsonStore(root);await store.write(save);
const logger=new StructuredLogger({directory:resolve(root,'logs'),echo:false,level:'debug',fileLevel:'debug'});
const service=new GameService(store,new AIRuntime(manager),world,[],logger);
const server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as any).port}`;
try{
 const session=await (await fetch(base+'/api/session')).json() as {token:string};
 for(const input of ['我立即尝试把美咲推向旁边的石墙，使她的肩膀与墙面接触。','我继续对美咲发动连续攻击，目标是使她失去行动能力。先执行接下来十秒内能够完成的动作，允许她反抗、躲避、逃离或中断我的行动。实际伤害和身体状态由世界规则结算。']){
  if(deadline.aborted)break;
  const before=(await store.read())!,requestId=randomUUID(),started=performance.now(),callStart=calls.length;
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},
   body:JSON.stringify({request_id:requestId,game_id:before.game_id,expected_revision:before.state_revision,input}),signal:deadline});
  const result=await response.json() as any,after=(await store.read())!;
  const receipts=(after.resolution_receipts??[]).filter(receipt=>!(before.resolution_receipts??[]).some(old=>old.request_id===receipt.request_id));
  const turn={input,request_id:requestId,status:response.status,ms:Math.round(performance.now()-started),calls:calls.length-callStart,
   outcome:result.outcome,message:result.message,notices:result.view?.notices??[],revision_before:before.state_revision,revision_after:after.state_revision,
   time_before:before.runtime.time,time_after:after.runtime.time,receipts,narrative:after.last_turn?.narrative,scene_beats:after.last_turn?.scene_beats,scene_seconds:after.runtime.scene_seconds,
   physical_state:after.entities.find(e=>e.id==='npc_lin')?.components.physical_state,
   checks:after.resolution_history?.filter(check=>receipts.some(receipt=>receipt.check_id===check.check_id))};
  turns.push(turn);console.log(JSON.stringify({turn:turns.length,status:turn.status,ms:turn.ms,calls:turn.calls,receipts:receipts.length,outcome:turn.outcome}));
  if(response.status!==200||after.state_revision===before.state_revision)break;
 }
}catch(error){turns.push({error_name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown'});}
finally{
 server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
 const report={root,budget:{max_calls:12,max_turns:2,max_wall_ms:480000},calls,outputs,turns,production_unchanged:productionBefore===await sourceHash()};
 await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,calls:calls.length,turns:turns.length,production_unchanged:report.production_unchanged}));
}

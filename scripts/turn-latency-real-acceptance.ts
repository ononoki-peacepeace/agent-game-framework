// One small real HTTP turn, with no production action or production data writes.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {fresh} from '../tests/helpers.js';
const config=await readPersistedProviderConfig(resolve('data'));
if(config?.provider!=='deepseek')throw Error('Expected configured DeepSeek; will not switch provider');
const root=resolve(`.tmp/turn-latency-${Date.now()}`);await mkdir(root,{recursive:true});
const adapter=new AIProviderManager(root,config),generate=adapter.generate.bind(adapter);
const calls:unknown[]=[];let attempts=0;
adapter.generate=async request=>{
 if(++attempts>4)throw Error('REAL_ACCEPTANCE_CALL_BUDGET');
 const start=performance.now();
 try{const response=await generate(request);calls.push({role:request.role,duration_ms:Math.round(performance.now()-start),usage:response.usage??null,ok:true});return response;}
 catch(error){calls.push({role:request.role,duration_ms:Math.round(performance.now()-start),ok:false,error:error instanceof Error?error.name:'unknown'});throw error;}
};
const save=fresh(),store=new JsonStore(root);
save.entities.find(entity=>entity.id==='npc_lin')!.components.location=structuredClone(save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location);
await store.write(save);
const service=new GameService(store,new AIRuntime(adapter),save.definition);
const server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
try{
 const session=await (await fetch(base+'/api/session')).json() as {token:string};
 const started=performance.now(),requestId=randomUUID();
 const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','x-game-token':session.token},body:JSON.stringify({request_id:requestId,game_id:save.game_id,expected_revision:save.state_revision,input:'你好，今天过得怎么样？',interaction:{source:'npc_interaction',target_id:'npc_lin',mode:'conversation'}})});
 const result=await response.json() as any,current=await store.read();
 const report={root,status:response.status,duration_ms:Math.round(performance.now()-started),calls,
  outcome:result.outcome,presentation:result.presentation,message:result.message,
  revision_before:save.state_revision,revision_after:current!.state_revision,time_before:save.runtime.time,time_after:current!.runtime.time,
  narrative:current!.last_turn?.narrative,receipt_count:current!.resolution_receipts?.length??0};
 await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}

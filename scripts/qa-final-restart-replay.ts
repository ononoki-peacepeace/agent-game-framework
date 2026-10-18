import {readFile,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';import {once} from 'node:events';import {createHash} from 'node:crypto';
import {JsonStore} from '../src/storage/json-store.js';import {GameService} from '../src/server/service.js';import {AIRuntime} from '../src/ai/runtime.js';import {createApp} from '../src/server/app.js';
const root=resolve('.tmp/qa-final-repeat-real-1792137053824'),report=JSON.parse(await readFile(root+'/report.json','utf8')),turn=report.turns[0];
const bytes=await readFile(root+'/current.json'),save=JSON.parse(bytes.toString('utf8')),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');let calls=0;const results:any[]=[];
for(let restart=0;restart<2;restart++){
 const store=new JsonStore(root),service=new GameService(store,new AIRuntime({name:'fixture',generate:async()=>{calls++;throw Error('MUST_REPLAY_WITHOUT_PROVIDER');}}),save.definition);
 const server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{const session=await(await fetch(base+'/api/session')).json() as any;
 const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},
 body:JSON.stringify({request_id:turn.request_id,game_id:save.game_id,expected_revision:turn.revision_before,input:turn.input})});
 const result=await response.json() as any,after=await store.read();
 if(response.status!==200||after!.state_revision!==save.state_revision||calls||sha(bytes)!==sha(await readFile(root+'/current.json')))throw Error('REPLAY_CHANGED_STATE_OR_CALLED_PROVIDER');
 results.push({restart,status:response.status,revision:after!.state_revision,receipt_count:after!.resolution_receipts?.length,seconds:after!.runtime.scene_seconds,outcome:result.outcome,unchanged:true});
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
}
await writeFile(root+'/restart-replay.json',JSON.stringify({results,provider_calls:calls},null,2));console.log(JSON.stringify({results,provider_calls:calls}));

import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonStore} from '../../src/storage/json-store.js';
import {GameService} from '../../src/server/service.js';
import {AIRuntime} from '../../src/ai/runtime.js';
import {MockAIAdapter} from '../../src/ai/mock.js';
import type {SavePackage} from '../../src/core/schema.js';

const [directory,mode,method='current']=process.argv.slice(2);
if(!directory||!mode||!process.send)throw Error('Isolated migration worker requires directory/mode/IPC');
class WriterStore extends JsonStore{
 override async write(...args:Parameters<JsonStore['write']>){
  process.send!({kind:'write_attempt'});return super.write(...args);
 }
}
const store=new WriterStore(directory),initial=await store.read();if(!initial)throw Error('Missing isolated initial save');
const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,initial.definition);
// A persistent listener keeps the IPC channel referenced at a paused boundary.
// An unresolved Promise alone does not keep a child process alive.
process.on('message',async()=>{
 try{
  if(mode==='kill_before'||mode==='kill_after'){
   const persist=Reflect.get(store,'persist') as (save:SavePackage,slot:'current'|'checkpoint')=>Promise<void>;
   const pause=async()=>{process.send!({kind:'boundary'});await new Promise<never>(()=>{});};
   Reflect.set(store,'persist',async(save:SavePackage,slot:'current'|'checkpoint')=>{
    if(mode==='kill_before')await pause();await persist.call(store,save,slot);if(mode==='kill_after')await pause();
   });
   if(method==='view')await service.view();else await service.current();
  }else if(mode==='canonical')await service.agentTransaction({game_id:initial.game_id,expected_revision:initial.state_revision,request_id:randomUUID()},
   {worker:true},next=>{next.gm_state.flags.other_process_retained=true;});
  else if(mode==='media')await service.setVisualAsset('player','fullbody','process_migration_asset',initial.game_id,initial.state_revision);
  else if(mode==='image'||mode==='same_revision'){
   const save=(await store.read())!;if(mode==='image')save.state_revision++;
   save.gm_state.flags.other_process_retained=true;await store.write(save);
  }else throw Error('Unknown isolated worker mode '+mode);
  process.send!({kind:'done',save:await store.read(),calls:ai.metrics.requests});process.disconnect();
 }catch(error){console.error(error);process.exitCode=1;process.disconnect();}
});
process.send({kind:'ready',directory:join(directory,'current.json')});

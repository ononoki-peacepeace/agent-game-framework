// Paired local HTTP benchmark only: all model responses are deterministic test data.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {validateSave} from '../src/core/state.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createApp} from '../src/server/app.js';
import type {AIAdapter} from '../src/ai/contracts.js';
import {saveSchema} from '../src/core/schema.js';
import {createServer} from 'node:http';
import {LocalTimings} from './local-timings.js';
const path=process.argv[2];
if(!path||basename(path)!=='current.json'||dirname(path).replaceAll('\\','/').toLowerCase().endsWith('/game/data'))throw Error('Supply isolated current.json');
const initial=validateSave(JSON.parse(await readFile(path,'utf8'))),player=initial.player_state.entity_id;
const location=initial.entities.find(entity=>entity.id===player)!.components.location!.location_id;
const npc=initial.entities.find(entity=>entity.id!==player&&entity.components.character&&entity.components.location?.location_id===location);
if(!npc)throw Error('Fixture needs a present NPC');
const root=resolve(`.tmp/turn-http-cache-${Date.now()}`);await mkdir(root,{recursive:true});
class LegacyReads extends JsonStore{
 override async read(slot:'current'|'checkpoint'='current'){
  return validateSave(JSON.parse(await readFile(join(this.directory,`${slot}.json`),'utf8')));
 }
}
const input='你好。',rows:unknown[]=[];
for(let sample=0;sample<(process.env.PROFILE_LOCAL?1:3);sample++)for(const arm of process.env.PROFILE_LOCAL?[true]:[false,true]){
 const cached=process.env.VALIDATION_AB?true:arm,validationReuse=process.env.VALIDATION_AB?arm:true;
 const directory=join(root,arm?'optimized':'baseline');const store=cached?new JsonStore(directory):new LegacyReads(directory);
 if(!validationReuse){Object.defineProperty(store,'consumeReadValidation',{value:undefined});Object.defineProperty(store,'validatesWrites',{value:false});}
 await store.write(initial);let calls=0;
 const adapter:AIAdapter={name:'local-performance-fixture',generate:async request=>{
  calls++;const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
  if(properties.domain)return {data:{domain:'world',kind:'world_action',original_user_request:input,
   operation_plane:'play',confidence:1,answer:null,answer_basis:null,evidence_ids:[],clarification:null,
   speech_target_id:npc.id,interaction_lane:'natural_scene',player_speech_mode:'verbatim',
   goal_spec:{objective:input,play_action:'speak',targets:[{kind:'entity',reference:String(npc.components.identity?.name),entity_id:npc.id}],
    desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],world_mutation:false,external_artifact:false,multi_step:false,ambiguity:null}}};
  if(properties.preserved)return {data:{preserved:true,reason:'原始发言与目标未改变。'}};
  if(properties.understanding)return {data:{understanding:'原地问候',narrative:'对方转过头来回应。',dialogue:'你好。',effects:[],
   speech_events:[{speaker_id:player,utterance:input,provenance:'verbatim_player_input'},
    {speaker_id:npc.id,utterance:'你好。',provenance:'npc_response'}]}};
  throw Error('Unexpected model phase');
 }};
 const service=new GameService(store,new AIRuntime(adapter),initial.definition),profiler=process.env.PROFILE_LOCAL?new LocalTimings():null;
 if(profiler){
  profiler.wrap(globalThis,'structuredClone','clone');profiler.wrap(JSON,'parse','json.parse');profiler.wrap(JSON,'stringify','json.stringify');profiler.wrap(saveSchema,'safeParse','schema.save');
  for(const method of ['current','view','agentTransaction','turn'])profiler.wrap(service,method,`service.${method}`,true);
  for(const method of ['ensureBaseFeatures','project'])profiler.wrap(service,method,`service.${method}`);
  for(const method of ['read','write','readInputRecord','writeInputRecord'])profiler.wrap(store,method,`storage.${method}`,true);
  for(const method of ['systemAgent','sceneAgent','planGoals','narrate'])profiler.wrap(service.ai,method,`ai.${method}`,true);
  profiler.wrap(adapter,'generate','provider.fixture',true);
 }
 const app=createApp(service),server=createServer((req,res)=>{
  if(profiler&&req.url==='/api/input')void profiler.async('http.handler',()=>new Promise<void>(done=>{res.once('finish',done);app(req,res);}));
  else app(req,res);
 }).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  const session=await (await fetch(base+'/api/session')).json() as {token:string},start=performance.now();
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':session.token},body:JSON.stringify({
   request_id:randomUUID(),game_id:initial.game_id,expected_revision:initial.state_revision,input,
   interaction:{source:'npc_interaction',target_id:npc.id,mode:'conversation'}})});
  const result=await response.json() as any,elapsed=performance.now()-start;
  if(response.status!==200||result.outcome?.kind!=='completed')throw Error(`Fixture failed: ${response.status}/${result.outcome?.kind}`);
  const after=await store.read();if(after!.state_revision!==initial.state_revision+1)throw Error('Wrong commit count');
  rows.push({cached,validation_reuse:validationReuse,sample,duration_ms:Math.round(elapsed),model_calls:calls,revision_delta:after!.state_revision-initial.state_revision,
   minute_delta:after!.runtime.time.minute-initial.runtime.time.minute,location_unchanged:after!.entities.find(entity=>entity.id===player)!.components.location!.location_id===location,
   ...(profiler?{profile:profiler.report()}: {})});
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));profiler?.restore();}
}
await writeFile(join(root,'report.json'),JSON.stringify({root,model:'fake; zero provider latency',rows},null,2));
console.log(JSON.stringify({root,model:'fake; zero provider latency',rows:rows.map((row:any)=>row.profile?
 {...row,profile:{http_ms:row.profile.http_ms,rows:row.profile.rows}}:row)},null,2));

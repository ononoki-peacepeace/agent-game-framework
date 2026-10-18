// Disposable-world DeepSeek acceptance for ordered dialogue, arrival scenes and bounded continuation.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {runSceneInteraction,sceneResultSchema} from '../src/agent/scene-interaction.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {MemoryStore,fresh} from '../tests/helpers.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(config?.provider!=='deepseek')throw Error('DeepSeek is not configured');
const root=resolve(`.tmp/scene-fragments-real-${Date.now()}`);
await mkdir(root,{recursive:true});
const provider=new AIProviderManager(root,config),generate=provider.generate.bind(provider);
const calls:{role:string;phase:string|null;duration_ms:number;usage:unknown;data?:unknown;error?:string}[]=[];
provider.generate=async request=>{
  if(calls.length>=24)throw Error('SCENE_ACCEPTANCE_CALL_BUDGET_EXCEEDED');
  const started=performance.now(),phase=request.prompt.match(/"scene_phase":"([^"]+)"/)?.[1]??null;
  try{const response=await generate(request);calls.push({role:request.role,phase,
    duration_ms:Math.round(performance.now()-started),usage:response.usage??null,
    ...(phase?{data:response.data}:{})});return response;}
  catch(error){calls.push({role:request.role,phase,duration_ms:Math.round(performance.now()-started),
    usage:null,error:error instanceof Error?error.message:String(error)});throw error;}
};
const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
player.components.location={location_id:'square'};
const template=save.entities.find(entity=>entity.id==='npc_lin')!;
template.components.location={location_id:'square'};
template.components.character={...template.components.character!,personality:'谨慎寡言，先留意别人正在做什么',
  speech_style:'平静、留白',behavior_tendencies:['不轻易表态']};
for(const [id,name,personality,speechStyle] of [
  ['npc_lively','活泼的人','话快，喜欢接别人的话','轻快'],
  ['npc_direct','直率的人','实际、直率，遇到分歧会追问','直截了当'],
  ['npc_calm','温和的人','善于照顾他人的感受','从容'],
] as const){const npc=structuredClone(template);npc.id=id;npc.components.identity.name=name;
  npc.components.character={...npc.components.character!,personality,speech_style:speechStyle};
  save.entities.push(npc);save.npc_agent_state={...save.npc_agent_state,[id]:emptyNpcAgentState()};}
const resident=save.entities.find(entity=>entity.id==='npc_qiao')!;
resident.components.location={location_id:'market'};
resident.components.character={...resident.components.character!,personality:'专注自己的工作，先看清来客再决定是否搭话'};
save.npc_agent_state={...save.npc_agent_state,npc_lin:emptyNpcAgentState(),npc_qiao:emptyNpcAgentState()};
const store=new MemoryStore();await store.write(save);
const ai=new AIRuntime(provider),service=new GameService(store,ai,save.definition);
const report:{root:string;provider:string;cases:unknown[];calls:typeof calls;error:string|null}={
  root,provider:'deepseek-flash',cases:[],calls,error:null};
const snapshot=async()=>{const state=await service.current();return {revision:state.state_revision,
  time:state.runtime.time,player_location:state.entities.find(entity=>entity.id===state.player_state.entity_id)
    ?.components.location?.location_id,receipts:state.resolution_receipts?.filter(receipt=>receipt.commit_status==='committed')
    .map(receipt=>({id:receipt.request_id,action:receipt.semantic_action,route:receipt.movement_route?.location_ids})),
  beats:state.last_turn?.scene_beats,narrative:state.last_turn?.narrative,
  history:state.narrative_history?.slice(-4).map(entry=>({revision:entry.revision,location:entry.location_id,
    speakers:entry.speech_events?.map(event=>event.speaker_id)}))};};
try{
  const before=await service.current(),input='我对大家说：“你们怎么看？”';
  const start=performance.now();
  const result=await handleAgentInput(service,{request_id:randomUUID(),game_id:before.game_id,
    expected_revision:before.state_revision,input},undefined,null,false,
    {kind:'world_action',interaction_lane:'natural_scene',player_speech_mode:'verbatim'} as never);
  report.cases.push({case:'free_dialogue',input,duration_ms:Math.round(performance.now()-start),
    outcome:result.outcome,state:await snapshot()});
  const firstRaw=calls.find(call=>call.phase==='interaction'&&call.data)?.data;
  const first=sceneResultSchema.safeParse(firstRaw);
  if(first.success){const current=await service.current(),startContinue=performance.now();
    const continued=await runSceneInteraction(service,current,service.project(current),input,
      {id:'npc_lin'},'none',undefined,'continuation',first.data);
    report.cases.push({case:'controlled_real_continuation',duration_ms:Math.round(performance.now()-startContinue),
      valid:!!continued,speakers:continued?.result.speech_events.map(event=>event.speaker_id),
      effects:continued?.result.effects,revision_after:(await service.current()).state_revision});}
  const beforeTravel=await service.current(),travelInput='我先问大家要不要一起去街角商店，等他们答复后我现在就出发。';
  const startTravel=performance.now();
  const semantic={kind:'world_action',interaction_lane:'open_goal',player_speech_mode:'intent',
    open_goal_context:{destination:'街角商店',continuation:'none',travel_party:'willing_companions',
      event_sequence:[{kind:'speech',timing:'before_move',text:travelInput},{kind:'move',timing:null,text:null}]},
    goal_spec:{play_action:'move',objective:travelInput,targets:[],desired_state:[],desired_outputs:[],
      constraints:[],persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,
      external_artifact:false,multi_step:true,ambiguity:null}};
  const travelResult=await handleAgentInput(service,{request_id:randomUUID(),game_id:beforeTravel.game_id,
    expected_revision:beforeTravel.state_revision,input:travelInput},undefined,null,false,semantic as never);
  report.cases.push({case:'origin_move_arrival',input:travelInput,semantic_source:'controlled_goal_spec',
    duration_ms:Math.round(performance.now()-startTravel),outcome:travelResult.outcome,state:await snapshot()});
}catch(error){report.error=error instanceof Error?error.stack??error.message:String(error);}
finally{await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2),'utf8');}
console.log(JSON.stringify({report:resolve(root,'report.json'),error:report.error,
  cases:report.cases.map(item=>{const value=item as Record<string,any>;return {case:value.case,
    duration_ms:value.duration_ms,outcome:value.outcome?.kind,revision:value.state?.revision,
    beats:value.state?.beats?.length};}),calls:calls.length,
  tokens:calls.reduce((sum,call)=>sum+Number((call.usage as {output_tokens?:number}|null)?.output_tokens??0),0)}));
if(report.error)process.exitCode=1;

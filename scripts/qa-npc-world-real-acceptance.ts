/** Manual, bounded REAL Provider acceptance. Default is dry-run (no config/key read).
 * --execute explicitly permits up to 6 adapter calls, total <= 6 minutes.
 * The real game save and port 3100 are never opened or changed. */
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {demo} from '../tests/helpers.js';
import {StructuredLogger} from '../src/observability/logger.js';
if(!process.argv.includes('--execute')){
 process.stdout.write('DRY_RUN: no Provider call. --execute runs a disposable NPC Agent/Core/Narrator test, at most 6 adapter calls and 6 minutes; API fees may apply.\n');
}else{
 const config=await readPersistedProviderConfig(resolve('data'));
 if(config?.provider!=='deepseek')throw Error('DeepSeek is not the configured Provider; stopped without a call.');
 const directory=await mkdtemp(join(tmpdir(),'agf-npc-real-')),out=resolve('.codex-checkpoints','npc-world-real-'+Date.now());
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),360000);let count=0;
 const calls:Record<string,unknown>[]=[],turns:Record<string,unknown>[]=[];
 try{
  await mkdir(out,{recursive:true});
  const provider=new AIProviderManager(directory,config),generate=provider.generate.bind(provider);
  provider.generate=async request=>{
   if(controller.signal.aborted||count>=6)throw new ProviderError('budget','manual acceptance budget','Manual acceptance budget exhausted');
   count++;const started=performance.now(),record:Record<string,unknown>={index:count,role:request.role};calls.push(record);
   try{const result=await generate({...request,signal:request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal});
    Object.assign(record,{duration_ms:Math.round(performance.now()-started),usage:result.usage??null,
     ...(request.role==='npc_decision'?{decision:result.data}:request.role==='narrator'?{narrative:result.data}:{})});return result;
   }catch(error){Object.assign(record,{duration_ms:Math.round(performance.now()-started),error_class:error instanceof Error?error.name:'unknown',
     reason:error instanceof ProviderError?error.reason:'unclassified'});throw error;}
  };
  const world=structuredClone(demo);world.meta.title='隔离日常交接验收';world.events=[];world.background_incidents=[];world.world_macro_arcs=[];
  world.background_event_policy={enabled:false,target_active_incidents:0,max_dormant_incidents:0,minimum_gap_minutes:60,replenishment:false};
  const save=newSave(world);save.npc_agent_state??={};save.npc_agent_state.npc_lin=emptyNpcAgentState();
  save.npc_agent_state.npc_lin.goals.push({id:'own_work',description:'自己已决定前往公开的市场岗位，处理日常整理；如遇熟人，可以按自己的意愿沟通交接。',horizon:'long',status:'active',origin:'isolated_authoring',priority:5});
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime(provider),service=new GameService(store,ai,world,[],new StructuredLogger({directory:join(out,'logs'),level:'info'}));
  for(const minutes of [180,40]){
   if(controller.signal.aborted||count>=6)break;
   const before=await service.current(),started=performance.now(),prior=new Set(before.resolution_receipts?.map(r=>r.request_id)),firstCall=count;
   const body={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'WAIT',parameters:{minutes}}};
   await service.turn(body,undefined,controller.signal);const after=await service.current();
   turns.push({request_id:body.request_id,elapsed_ms:Math.round(performance.now()-started),adapter_calls:count-firstCall,
    time_before:before.runtime.time,time_after:after.runtime.time,revision:after.state_revision,narrative:after.last_turn?.narrative,
    npc_actions:after.resolution_receipts?.filter(r=>!prior.has(r.request_id)&&r.actor_id!==after.player_state.entity_id)
      .map(r=>({id:r.request_id,actor_id:r.actor_id,type:r.semantic_action,time_cost:r.time_cost,at:r.at,committed:r.commit_status})),
    plans:Object.entries(after.npc_agent_state??{}).map(([id,state])=>({id,plans:state.plans,decisions:state.last_decisions})),
    reloaded_equal:JSON.stringify((await new JsonStore(directory).read())?.npc_agent_state)===JSON.stringify(after.npc_agent_state)});
  }
  await writeFile(join(out,'result.json'),JSON.stringify({real_provider:true,adapter_call_limit:6,total_timeout_seconds:360,calls,turns,
   verdict:'REVIEW_REQUIRED：NPC 可以合理不行动；必须核对模型决定、Core Receipt和实际状态，不能只凭调用成功宣称自治通过。'},null,2));
  process.stdout.write(JSON.stringify({artifact:join(out,'result.json'),adapter_calls:count,turns:turns.length,paid_provider:true})+'\n');
 }catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({calls,turns,error_class:error instanceof Error?error.name:'unknown',reason:error instanceof ProviderError?error.reason:'unclassified'},null,2));
  process.stderr.write('Real acceptance incomplete; preserve '+out+'\n');process.exitCode=1;
 }finally{
  clearTimeout(timer);const target=resolve(directory);if(!target.startsWith(resolve(tmpdir())+sep))throw Error('Invalid temp boundary');await rm(target,{recursive:true,force:true});
 }
}

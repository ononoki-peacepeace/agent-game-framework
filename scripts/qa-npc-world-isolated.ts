/** Read a historical formal before-image; all execution and logs live in a fresh temp store.
 * No Provider credentials, HTTP formal action, or formal writes are used. */
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {validateSave} from '../src/core/state.js';
import {worldKeys} from '../src/core/turn-history.js';
import {StructuredLogger} from '../src/observability/logger.js';
const path=new URL('../data/current.json',import.meta.url),bytes=await readFile(path),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const formal=JSON.parse(bytes.toString()),history=formal.turn_history??[];
const index=history.findIndex((entry:any)=>entry.time.day===1&&entry.time.minute===1007&&entry.before.runtime?.time?.minute===977);
if(index<0)throw Error('所需16:17历史 before-image已不在存档中；停止，不替换为其他时点。');
const image=history[index].before,copy=structuredClone(formal);
for(const key of worldKeys){if(Object.hasOwn(image,key))copy[key]=structuredClone(image[key]);else delete copy[key];}
copy.runtime.receipts=[];copy.state_revision=385;delete copy.turn_checkpoint;copy.turn_history=[];delete copy.active_turn_id;
const directory=await mkdtemp(join(tmpdir(),'agf-npc-formal-copy-'));
let complete=false;const calls:{role:string;actor?:string}[]=[];
try{
 const ai=new AIRuntime({name:'offline-no-action-control',generate:async request=>{
  calls.push({role:request.role});
  if(request.role==='npc_decision'){
   const match=request.prompt.match(/"npc_id"\s*:\s*"([^"\n]+)"/);calls.at(-1)!.actor=match?.[1];
   return {data:{kind:'no_action',speech:null,vote_target:null,intent:'保留当前安排',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'离线控制样本不擅自分配职责',social_response:null}};
  }
  if(request.role==='narrator')return {data:{narrative:'这一段时间过去了。',speaker:null,dialogue:null,choices:[],patches:[],context_actions:[],item_claims:[],mechanical_claims:[],stable_locations:[]}};
  const p=(request.schema as any).properties??{};
  if(p.grounded)return {data:{grounded:true,reports_result:true,reason:'仅确认已过去的时间',unsupported_claims:[]}};
  throw Error('离线回放意外请求 '+request.role);
 }});
 const logger=new StructuredLogger({directory:join(directory,'logs'),level:'info'}),store=new JsonStore(directory);
 await store.write(validateSave(copy));const service=new GameService(store,ai,copy.definition,[],logger);
 const steps=[];
 for(const action of [{type:'WAIT',parameters:{minutes:30}},{type:'MOVE',target_id:'dining_hall',parameters:{companions:'none'}},{type:'WAIT',parameters:{minutes:40}}]){
  const before=await service.current(),priorCalls=calls.length,priorIds=new Set(before.resolution_receipts?.map(r=>r.request_id));
  await service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action});
  const after=await service.current();steps.push({action:action.type,from:before.runtime.time,to:after.runtime.time,revision:after.state_revision,
   decisions:calls.slice(priorCalls).filter(c=>c.role==='npc_decision').map(c=>c.actor),
   npc_actions:after.resolution_receipts?.filter(r=>!priorIds.has(r.request_id)&&r.actor_id!==after.player_state.entity_id)
    .map(r=>({actor:r.actor_id,type:r.semantic_action,cost:r.time_cost})),
   incident_statuses:after.background_state?.incidents.map(i=>i.status),arc_statuses:after.background_state?.macro_arcs.map(a=>a.status)});
 }
 const after=await service.current(),reloaded=await new GameService(new JsonStore(directory),ai,copy.definition,[],logger).current();
 if(JSON.stringify(after.npc_agent_state)!==JSON.stringify(reloaded.npc_agent_state))throw Error('重载后NPC状态不一致');
 await service.undo({request_id:randomUUID(),game_id:after.game_id,expected_revision:after.state_revision});
 const undone=await service.current();if(undone.runtime.time.minute!==1008)throw Error('Undo未恢复16:48');
 const end=await readFile(path);if(hash(end)!==hash(bytes))throw Error('正式存档期间已改变；停止，不能声明未变。');
 const evidence={formal_sha256:hash(bytes),formal_revision:formal.state_revision,source_before_image:'16:17 before REV386',
  synthetic_provider:true,model_policy:'no_action；只验证实际机会和Core结算，不假装模型选择了工作',paid_calls:0,steps,
  unique_decision_opportunities:new Set(calls.filter(c=>c.role==='npc_decision').map(c=>c.actor)).size,reload_equal:true,undo_time:undone.runtime.time,formal_unchanged:true};
 await writeFile(new URL('../docs/qa-npc-world-isolated-evidence.json',import.meta.url),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence,null,2));complete=true;
}finally{
 const root=resolve(tmpdir())+sep,target=resolve(directory);if(!target.startsWith(root))throw Error('临时目录边界无效');
 if(complete)await rm(target,{recursive:true,force:true});else console.error('隔离诊断保留于：'+target);
}

import {once} from 'node:events';
import {join} from 'node:path';
import {JsonStore,type PendingTurn,type StoredInputRecord} from '../../src/storage/json-store.js';
import type {SavePackage} from '../../src/core/schema.js';
import {GameService} from '../../src/server/service.js';
import {createApp} from '../../src/server/app.js';
import {AIRuntime} from '../../src/ai/runtime.js';

const [directory,boundary,requestId,scenario='wait']=process.argv.slice(2);
if(!directory||!boundary||!requestId||!process.send)throw Error('Isolated IPC worker requires directory/boundary/request identity');
const pause=async(stage:string)=>{
 if(stage!==boundary)return;
 process.send!({kind:'boundary',stage,request_id:requestId});
 await new Promise<never>(()=>{});
};
class BoundaryStore extends JsonStore{
 override async writePending(turn:PendingTurn){
  await pause('pending_before');await super.writePending(turn);await pause('pending_after');
 }
 override async write(save:SavePackage,slot:'current'|'checkpoint'='current'){
  const target=slot==='current'&&save.resolution_receipts?.some(r=>r.commit_status==='committed'&&
   (scenario==='physical'?Boolean(r.physical_outcome):r.semantic_action===(scenario==='buy'?'BUY':'WAIT')));
  if(target)await pause('commit_before');await super.write(save,slot);if(target)await pause('commit_after');
 }
 override async writeInputRecord(record:StoredInputRecord){
  const terminal=record.request_id===requestId&&record.state==='completed';
  if(terminal)await pause('terminal_before');await super.writeInputRecord(record);if(terminal)await pause('terminal_after');
 }
}
const store=new BoundaryStore(directory),initial=await store.read();if(!initial)throw Error('Missing isolated initial save');
const ai=new AIRuntime({name:'kill-fixture',generate:async request=>{
 const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
 if(request.role==='gm_reasoning'&&'domain' in properties)return {data:{domain:'world',kind:'world_action',confidence:.98,
  answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'world_transaction',temporal_wait:null}};
 if('goals' in properties)return {data:{goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:scenario==='physical'?'尝试打击林舟':'购买一个面包',
  operation_hint:scenario==='physical'?'other':'purchase',referent:scenario==='physical'?'林舟':'面包',target_entities:[],depends_on:[],condition:null,branch:null,
  temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}};
 if('verdict' in properties)return {data:{verdict:'aligned',explanation:'保留原句本次行动授权'}};
 if('parameters_json' in properties)return {data:{type:'FREEFORM_ACTION',target_id:'npc_lin',parameters_json:'{}',clarification:null}};
 if('resolution' in properties)return {data:{narrative:'尝试打击林舟。',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'本次打击尝试',
   stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}}};
 if(request.role==='narrator')return {data:{narrative:scenario==='physical'?'你尝试打击林舟。':scenario==='buy'?'你买下了一个面包。':'你等了一分钟。',speaker:null,dialogue:null,choices:[],patches:[]}};
 if(request.role==='npc_decision')return {data:{kind:'no_action',speech:null,vote_target:null,intent:'继续自己的日常',
  proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'无需额外行动'}};
 throw Error('Unexpected offline generation '+request.role);
}});
const server=createApp(new GameService(store,ai,initial.definition),undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
await once(server,'listening');process.send!({kind:'ready',port:(server.address() as {port:number}).port});

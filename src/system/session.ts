import {randomUUID} from 'node:crypto';
import type {GameService} from '../server/service.js';
import {publicView} from '../core/state.js';
import {resolveEntities} from '../agent/entities.js';
import {planMeta} from './router.js';
import type {SystemResult} from './agent.js';
import type {BehaviorApplication, BehaviorScope} from '../ai/behavior.js';
import type {ResolvedSystemRequest, SystemUnderstanding} from './understanding.js';
export interface SystemSession {
 session_id:string;game_id:string;current_goal:string;current_intent:string;clarifications:{question:string;answer:string|null}[];
 resolved_entities:string[];selected_tools:string[];pending_confirmation:string|null;development_job_id:string|null;
 status:'active'|'waiting_for_clarification'|'waiting_for_confirmation'|'running'|'completed'|'cancelled'|'failed';
 /** Partial understanding kept across turns: a clarification only fills what is still missing. */
 understanding:SystemUnderstanding|null;pending_field:string|null;workflow:string|null;resolved_request:ResolvedSystemRequest|null;
}
/** Everything the executor may need that was resolved by the session (entity, scope, module, previous request). */
export interface SystemExecutionContext {
 entityId?:string;behaviorScope?:BehaviorScope;behaviorApplication?:BehaviorApplication;moduleId?:string;preferredNames?:string[];
 session:SystemSession;previous?:ResolvedSystemRequest|null;
 /** The player's latest sentence (the answer to a clarification), which is not always the session goal. */
 latest?:string;
 /** True when this turn answers a clarification the session itself asked for. */
 answeringClarification?:boolean;
}
const sessions=new WeakMap<GameService,SystemSession>();
export async function routingClarification(service:GameService,input:string,question:string){const save=await service.storage.read();if(!save)throw Error('请先载入世界');const session=freshSession(save.game_id,input,'UNKNOWN',null);session.status='waiting_for_clarification';session.pending_field='输入语境';session.clarifications.push({question,answer:null});sessions.set(service,session);return structuredClone(session);}
export function systemSessionContext(service:GameService,gameId:string){const session=sessions.get(service);return session?.game_id===gameId?structuredClone(session):null;}
/** The last request the System Agent actually executed. Contextual corrections may refer to it even after the session closed. */
const lastResolved=new WeakMap<GameService,ResolvedSystemRequest>();
const queues=new WeakMap<GameService,Promise<unknown>>();
function freshSession(gameId:string,text:string,currentIntent:string,toolId:string|null):SystemSession{
 return {session_id:randomUUID(),game_id:gameId,current_goal:text,current_intent:currentIntent,clarifications:[],resolved_entities:[],selected_tools:toolId?[toolId]:[],pending_confirmation:null,development_job_id:null,status:'active',understanding:null,pending_field:null,workflow:null,resolved_request:null};
}
export function sessionInput(service:GameService,body:{input:string;confirmed:boolean;session_id?:string|null},execute:(input:string,confirmed:boolean,context:SystemExecutionContext)=>Promise<SystemResult>):Promise<SystemResult>{
 const run=(queues.get(service)??Promise.resolve()).catch(()=>undefined).then(async()=>{
  const save=await service.current(),view=publicView(save);let current=sessions.get(service);
  const text=body.input.trim(),newPlan=planMeta(text,view.capabilities);
  const requestedSession=body.session_id??undefined;
  if(requestedSession&&current?.session_id!==requestedSession)throw Error('会话已过期，请重新提交明确请求');
  if(current?.game_id!==save.game_id)current=undefined;
  const live=current&&['active','waiting_for_clarification','waiting_for_confirmation','running'].includes(current.status);
  const independent=(!!current?.pending_confirmation&&/^(关闭|开启|停用|启用|修改|更换)/.test(text))||newPlan.category!=='UNKNOWN'&&!(body.confirmed&&text===current?.current_goal);
  if(!live||independent){current=freshSession(save.game_id,text,newPlan.category,newPlan.tool_id);sessions.set(service,current);}
  let session=current!;
  const reply=(message:string,needs_confirmation=false):SystemResult=>({category:session.current_intent,tool_id:session.selected_tools[0]??null,side_effect_level:'none',needs_confirmation,message,session:structuredClone(session)});
  const isCancellation=(value:string)=>/^(取消|算了|不弄了)[。！!]?$/u.test(value);
  if(isCancellation(text)){session.status='cancelled';session.pending_confirmation=null;session.pending_field=null;return reply('已取消当前系统任务。');}
  let input=session.current_goal,confirmed=false,entityId:string|undefined,behaviorScope:BehaviorScope|undefined;
  const confirming=body.confirmed||/^(确认|确认执行|是的|好|可以)[。！!]?$/u.test(text);
  // A pending write belongs to the request that planned it. If the player instead starts a substantial new
  // sentence, the old plan is dropped and the new request is handled on its own (it never executes later).
  if(session.pending_confirmation&&!confirming&&text.length>=6&&!isCancellation(text)){
   session=freshSession(save.game_id,text,newPlan.category,newPlan.tool_id);sessions.set(service,session);
  }
  if(session.pending_confirmation){
   if(confirming){confirmed=true;session.pending_confirmation=null;}
   else {session.status='waiting_for_confirmation';return reply('请确认执行，或输入取消。',true);}
  }
  const behavior=session.current_intent==='BEHAVIOR_CONFIGURATION';
  if(behavior&&session.status==='waiting_for_clarification'&&/^(旁白|叙述|叙事|人物对话|对话|npc|助手|回答|你)/i.test(text)){
   const scope=/^(人物对话|对话|npc)/i.test(text)?'dialogue':/^(助手|回答|你)/i.test(text)?'assistant':'narration';
   // The scope travels as structured data to the executor; it must never be appended to the request text,
   // otherwise parsing could pick the summary up as the configured value.
   behaviorScope=scope;session.status='active';session.pending_field=null;
  }
  const media=['avatar.crop','media.set_avatar','character.media.get','media.generate_image'].includes(session.selected_tools[0]??'');
  if(media){
   const found=resolveEntities(view,text);let target=found.confident?found.matches[0]:null;
   if(!target&&/^(我自己|自己|我的头像)/.test(text))target=view.entities.find(e=>e.id===view.player_id)??null;
   if(!target&&session.status==='waiting_for_clarification'){
    const ordinal=text.match(/第([一二三四五1-5])(?:个|位)/);if(ordinal){const n='一二三四五'.indexOf(ordinal[1]);target=view.entities.find(e=>e.id===session.resolved_entities[n>=0?n:Number(ordinal[1])-1])??null;}
   }
   if(!target){
    const candidates=found.matches;session.resolved_entities=candidates.map(e=>e.id);
    const question=candidates.length>1?'有同名人物，请选择：'+candidates.map((e,i)=>(i+1)+'. '+String(e.components.identity?.name)+'（'+String(e.components.character?.role??'人物')+'）').join('；'):'你想修改哪个人物？';
    if(session.clarifications.at(-1)?.answer===null)session.clarifications.at(-1)!.answer=text;
    session.clarifications.push({question,answer:null});session.status='waiting_for_clarification';session.pending_field='人物';
    return reply(question);
   }
   if(session.clarifications.at(-1)?.answer===null)session.clarifications.at(-1)!.answer=text;
   session.resolved_entities=[target.id];entityId=target.id;
   input=session.current_goal; // Entity ids travel separately; display names cannot reroute tool selection.
  }
  const answeringClarification=session.status==='waiting_for_clarification';
  session.status='running';
  try{
   const result=await execute(input,confirmed,{entityId,behaviorScope,session,previous:lastResolved.get(service)??null,answeringClarification,latest:text});
   if(result.understanding!==undefined)session.understanding=result.understanding;
   if(result.pending_field!==undefined)session.pending_field=result.pending_field;
   if(result.workflow!==undefined)session.workflow=result.workflow;
   if(result.resolved!==undefined&&result.resolved)lastResolved.set(service,result.resolved);
   if(result.resolved!==undefined)session.resolved_request=result.resolved;
   if(result.needs_confirmation){session.status='waiting_for_confirmation';session.pending_confirmation=input;}
   else if(result.category==='UNKNOWN'||result.clarification){session.status='waiting_for_clarification';session.clarifications.push({question:result.message,answer:null});}
   else {session.status='completed';session.pending_field=null;}
   return {...result,session:structuredClone(session)};
  }catch(e){session.status='failed';return reply((e as Error).message);}
 });
 queues.set(service,run);return run;
}

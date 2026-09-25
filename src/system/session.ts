import {randomUUID} from 'node:crypto';
import type {GameService} from '../server/service.js';
import {publicView} from '../core/state.js';
import {resolveEntities} from '../agent/entities.js';
import {planMeta} from './router.js';
import type {SystemResult} from './agent.js';
export interface SystemSession {
 session_id:string;game_id:string;current_goal:string;current_intent:string;clarifications:{question:string;answer:string|null}[];
 resolved_entities:string[];selected_tools:string[];pending_confirmation:string|null;development_job_id:string|null;
 status:'active'|'waiting_for_clarification'|'waiting_for_confirmation'|'running'|'completed'|'cancelled'|'failed';
}
const sessions=new WeakMap<GameService,SystemSession>();
const queues=new WeakMap<GameService,Promise<unknown>>();
export function sessionInput(service:GameService,body:{input:string;confirmed:boolean;session_id?:string},execute:(input:string,confirmed:boolean,entityId?:string)=>Promise<SystemResult>):Promise<SystemResult>{
 const run=(queues.get(service)??Promise.resolve()).catch(()=>undefined).then(async()=>{
  const save=await service.current(),view=publicView(save);let current=sessions.get(service);
  const text=body.input.trim(),newPlan=planMeta(text,view.capabilities);
  if(body.session_id&&current?.session_id!==body.session_id)throw Error('会话已过期，请重新提交明确请求');
  if(current?.game_id!==save.game_id)current=undefined;
  const live=current&&['active','waiting_for_clarification','waiting_for_confirmation','running'].includes(current.status);
  const independent=(!!current?.pending_confirmation&&/^(关闭|开启|停用|启用|修改|更换)/.test(text))||newPlan.category!=='UNKNOWN'&&!(body.confirmed&&text===current?.current_goal);
  if(!live||independent){current={session_id:randomUUID(),game_id:save.game_id,current_goal:text,current_intent:newPlan.category,clarifications:[],resolved_entities:[],selected_tools:newPlan.tool_id?[newPlan.tool_id]:[],pending_confirmation:null,development_job_id:null,status:'active'};sessions.set(service,current);}
  const session=current!;
  const reply=(message:string,needs_confirmation=false):SystemResult=>({category:session.current_intent,tool_id:session.selected_tools[0]??null,side_effect_level:'none',needs_confirmation,message,session:structuredClone(session)});
  if(/^(取消|算了|不弄了)[。！!]?$/u.test(text)){session.status='cancelled';session.pending_confirmation=null;return reply('已取消当前系统任务。');}
  let input=session.current_goal,confirmed=false,entityId:string|undefined;
  if(session.pending_confirmation){
   if(body.confirmed||/^(确认|确认执行|是的)[。！!]?$/u.test(text)){confirmed=true;session.pending_confirmation=null;}
   else {session.status='waiting_for_confirmation';return reply('请确认执行，或输入取消。',true);}
  }
  const media=['avatar.crop','media.set_avatar','character.media.get'].includes(session.selected_tools[0]??'');
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
    session.clarifications.push({question,answer:null});session.status='waiting_for_clarification';return reply(question);
   }
   if(session.clarifications.at(-1)?.answer===null)session.clarifications.at(-1)!.answer=text;
   session.resolved_entities=[target.id];entityId=target.id;
   input=session.current_goal; // Entity ids travel separately; display names cannot reroute tool selection.
  }
  session.status='running';
  try{
   const result=await execute(input,confirmed,entityId);
   if(result.needs_confirmation){session.status='waiting_for_confirmation';session.pending_confirmation=input;}
   else session.status='completed';
   return {...result,session:structuredClone(session)};
  }catch(e){session.status='failed';return reply((e as Error).message);}
 });
 queues.set(service,run);return run;
}

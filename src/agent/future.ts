import type {FutureIntent} from './plan-schema.js';
import type {PublicView} from '../shared/contracts.js';
const ranges={any:[0,1440],morning:[360,720],afternoon:[720,1080],evening:[1080,1440],after_school:[960,1200]};
export function futureStatus(intent:FutureIntent,time:{day:number;minute:number}):FutureIntent['status']{
 if(!['planned','due'].includes(intent.status)||intent.target_date===null)return intent.status;
 const [start,end]=ranges[intent.time_window];
 if(time.day>intent.target_date||time.day===intent.target_date&&time.minute>=end)return 'expired';
 return time.day===intent.target_date&&time.minute>=start?'due':'planned';
}
export function dueAssessment(view:PublicView,intent:FutureIntent){
 const player=view.entities.find(e=>e.id===view.player_id),notes:string[]=[];
 if(view.last_turn?.choices.length)notes.push('当前有待回应选择');
 if(Number(player?.components.condition?.hp??100)<=0)notes.push('玩家状态不允许行动');
 for(const id of intent.target_entities){const target=view.entities.find(e=>e.id===id);if(!target)notes.push('目标目前不可见或不可用');else if(!target.components.location||!player?.components.location||target.components.location.location_id!==player.components.location.location_id)notes.push('目标不在已确认的同一地点');}
 return '计划已到期，仅提醒：'+intent.goal+'。'+(notes.length?notes.join('；')+'。':'')+'执行前仍需检查当前事件与前台事务，并由实际行动处理 NPC 是否愿意参与；尚未发生。';
}

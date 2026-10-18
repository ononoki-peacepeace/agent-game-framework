import {agentResult} from '../contracts.js';
import {gameOutcome} from '../outcome.js';
import type {ResolvedTemporalWait} from '../temporal-wait.js';
import type {AgentSkill} from './types.js';

export interface TemporalWaitRequest {game_id:string;expected_revision:number;wait:ResolvedTemporalWait}

export const temporalWaitSkill:AgentSkill<TemporalWaitRequest,ReturnType<typeof agentResult>>={
  id:'temporal_wait',
  description:'Settle one player WAIT to a duration or canonical target time, with internal world ticks.',
  allowedTools:['read_world_state','wait'],
  async execute({game_id,expected_revision,wait},context){
    const {service,save,request_id}=context;
    const afterView=await service.turn({request_id,game_id,expected_revision,
      action:{type:'WAIT',parameters:{minutes:wait.minutes}}});
    const after=await service.current();
    const elapsed=(after.runtime.time.day-save.runtime.time.day)*save.definition.ruleset.minutes_per_day+
      after.runtime.time.minute-save.runtime.time.minute;
    const interrupted=elapsed<wait.minutes;
    const receiptIds=(after.resolution_receipts??[]).filter(receipt=>
      receipt.request_id===request_id&&receipt.commit_status==='committed').map(receipt=>receipt.request_id);
    const outcome=gameOutcome(interrupted?'interrupted':'completed','temporal_wait',after.state_revision,
      [interrupted?'wait_interrupted':'wait_completed'],receiptIds,interrupted?'partial':'completed');
    const reason=after.foreground?.reason?.trim();
    const message=interrupted?
      [afterView.last_turn?.narrative,`等待被需要你回应的事件打断${reason?`：${reason}`:''}。`].filter(Boolean).join('\n'):
      afterView.last_turn?.narrative??'';
    return agentResult('WORLD_ACTION',message,{outcome,presentation:'story',time_advanced:elapsed,view:afterView});
  },
};

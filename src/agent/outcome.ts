import {GameError} from '../core/schema.js';

/** A resolved world result may be disappointing without being an execution error. */
export type GameOutcomeKind='completed'|'feedback'|'completed_no_result'|'blocked_by_world'|'condition_false'|
  'rejected_by_actor'|'unavailable'|'partial_progress'|'interrupted'|'unresolved_goal'|'alternative_found';
export type FrameworkOutcome=
  |{type:'game';kind:GameOutcomeKind;stage:string;completed_steps:string[];receipt_ids:string[];
    revision:number|null;goal_status:'completed'|'partial'|'unresolved'|null}
  |{type:'engine_failure';code:'provider_failure'|'schema_failure'|'transaction_failure'|
    'invariant_failure'|'state_failure'|'unexpected_internal_failure';stage:string;
    committed_steps:string[];receipt_ids:string[];revision:number|null;state_certain:boolean};

export function gameOutcome(kind:GameOutcomeKind,stage:string,revision:number|null=null,
  completed_steps:string[]=[],receipt_ids:string[]=[],goal_status:'completed'|'partial'|'unresolved'|null=null):Extract<FrameworkOutcome,{type:'game'}>{
  return {type:'game',kind,stage,completed_steps,receipt_ids,revision,goal_status};
}
export function engineOutcome(code:Extract<FrameworkOutcome,{type:'engine_failure'}>['code'],stage:string,
  revision:number|null=null,state_certain=false,committed_steps:string[]=[],receipt_ids:string[]=[]):Extract<FrameworkOutcome,{type:'engine_failure'}>{
  return {type:'engine_failure',code,stage,committed_steps,receipt_ids,revision,state_certain};
}

/** Canonical rules can refuse an action without indicating a broken engine. */
export class WorldBlockedError extends GameError{
  readonly name='WorldBlockedError';
  constructor(readonly worldCode:'closed'|'route_unavailable'|'insufficient_funds'|'out_of_stock'|
    'not_present'|'unavailable'|'prerequisite',message:string){super(message,409);}
}
export function worldAssert(condition:unknown,code:WorldBlockedError['worldCode'],message:string):asserts condition{
  if(!condition)throw new WorldBlockedError(code,message);
}

/** Only structured classification determines UI severity; prose never participates. */
export function gameNarrative(outcome:Extract<FrameworkOutcome,{type:'game'}>,facts:{location?:string|null;
  attempted?:string|null;completed?:string[];known_absence?:string|null}):string{
  const progress=(facts.completed??[]).map(value=>value.trim().replace(/[。！？；，\s]+$/u,''))
    .filter(Boolean).join('；');
  const prefix=progress?`${progress}。`:'';
  const place=facts.location?`在${facts.location}`:'在这里';
  switch(outcome.kind){
    case 'completed_no_result':return outcome.receipt_ids.length?
      `${prefix}${place}进行了这次寻找，暂时没有找到${facts.known_absence??'符合条件的目标'}。`:
      `${prefix}现有公开线索里，暂时没有找到${facts.known_absence??'符合条件的目标'}。`;
    case 'condition_false':return `${prefix}${place}确认了情况；预先约定的条件没有成立，因此后续动作没有发生。`;
    case 'blocked_by_world':return `${prefix}${place}受到当前世界条件阻挡，这一步没有发生。`;
    case 'rejected_by_actor':return `${prefix}对方没有接受这次请求，接下来怎么做仍由你决定。`;
    case 'unavailable':return `${prefix}目前没有足够的现实条件继续这一步。`;
    case 'partial_progress':return `${prefix}这次尝试已有实际进展，后续目标仍未发生。`;
    case 'unresolved_goal':return `${prefix}这次尝试暂时停在这里，目标仍未达成。`;
    case 'alternative_found':return `${prefix}找到了一条不同的线索，下一步仍由你决定。`;
    default:return `${prefix}${facts.attempted??'这次行动'}已经发生。`;
  }
}

export const safeEngineMessage='这一回合没有完成安全结算。请刷新当前世界状态，再决定是否重试。';
export function engineMessage(outcome:Extract<FrameworkOutcome,{type:'engine_failure'}>){
  if(outcome.receipt_ids.length||outcome.committed_steps.length)
    return '前面已经结算的行动保持有效；后续步骤未能可靠完成。请查看当前世界状态后再决定下一步。';
  if(!outcome.state_certain)return safeEngineMessage;
  if(outcome.stage==='natural_scene')return outcome.code==='provider_failure'?
    '这次交流的模型响应未能完成，交流尚未提交；后续行动尚未执行。':
    '这次交流内容未通过人物发言或现场事实校验，交流尚未提交；后续行动尚未执行。';
  if(outcome.stage==='freeform_binding')return '这次行动提案未能可靠对应你指定的目标；世界没有改变。请核对当前场景后重试。';
  if(outcome.stage==='narrative_provider')return '这次场景描写暂时没有生成，行动候选尚未提交；世界没有改变。请稍后从当前状态继续。';
  if(outcome.stage==='revision_conflict')return '世界状态已被另一项操作更新。请刷新场景后重新决定是否行动。';
  return safeEngineMessage;
}

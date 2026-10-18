import {z} from 'zod';
import type {GameService} from '../server/service.js';
import type {AgentPlan} from './plan-schema.js';
import {currentTrace} from '../observability/trace.js';
import {isActivePerception} from './perception.js';
import {hasMultipleClauses} from './goal-contract.js';

const alignmentSchema=z.strictObject({
  verdict:z.enum(['aligned','incomplete','substituted','uncertain']),
  explanation:z.string().min(1).max(300),
  semantic_revision:z.enum(['none','repetition','target','event_order']).nullish(),
});

/** Read-only audit of one already proposed plan. It cannot choose an action or authorize a new one. */
export async function verifyGoalAlignment(service:GameService,originalInput:string,plan:AgentPlan,repetition?:import('../system/goals.js').GoalSpec['repetition']){
  // This is an exact single-action contract, not a preparation for a hidden final goal.
  // Completion still requires the transaction receipt and canonical state validation.
  if(!repetition&&isActivePerception(originalInput)&&!hasMultipleClauses(originalInput)&&plan.goals.length===1&&
    plan.goals[0].type==='WORLD_ACTION'&&plan.goals[0].normalized_goal.trim()===originalInput.trim()&&
    plan.goals[0].contract?.completion.kind==='activity_occurred'&&
    !plan.goals[0].depends_on.length&&!plan.contract?.unresolved_compound){
    currentTrace()?.info('agent.goal_alignment',{metadata:{verdict:'aligned',source:'single_perception_contract',step_count:1,operations:['activity']}});
    return {verdict:'aligned' as const,explanation:'单个观察行动与玩家原始请求一致。'};
  }
  const save=await service.current();
  const steps=plan.execution_order.map(id=>{
    const goal=plan.goals.find(entry=>entry.goal_id===id)!;
    return {id,type:goal.type,objective:goal.normalized_goal,operation:goal.operation_hint??null,
      referent:goal.referent??null,depends_on:goal.depends_on,
      speech_recipients:goal.speech_recipients??null,
      completion:goal.contract?.completion??null,availability:goal.contract?.availability??null};
  });
  const result=await service.ai.systemAgent(alignmentSchema,save.definition.prompt_profile,{
    instruction:'你只审查玩家原句与拟执行计划是否一致，不选择新动作，不执行，不补写步骤。aligned 仅当计划包含原句授权的最终尝试或结果，且每个会写入世界的步骤都是玩家明确要求或为了完成该目标合理且必要的准备；准备步骤必须依赖到后续的最终目标，不可单独冒充整个请求完成。若计划只剩移动、查看或其他准备，遗漏原目标，用 incomplete。若计划用别的行动替换原目标，用 substituted。无法判断用 uncertain。不存在的能力不能因到达地点而算完成。多步骤计划中包含合理准备和最终尝试可以是 aligned。若问题是GoalSpec重复契约缺失、目标或事件顺序解释错误，用semantic_revision提出回到统一语义边界修订；不是该类问题填写none。你无权直接改写目标。只输出 JSON。',
    attempt_policy:'区分开始并结算一次尝试与保证达成目标。若玩家授权即时尝试，保留完整原句的 WORLD_ACTION 可以交由已有执行器绑定、检查前置条件及判定，不能仅因尚未知胜负或没有专用动作名称就视为只有准备。持续或反复行动可在一次有界行动中开始，不要求这一回合无限重复或保证最终结果；仍不能用 MOVE、接近或查看替代原句实际要求的尝试。这里只判断目标保真，不代替执行能力和事务校验。',
    bounded_repetition:repetition??null,
    repetition_alignment:'必须先确认本次原句确实授权重复或持续执行同一行为；立即开始、接触后施力的多阶段以及历史上的重复行动均不构成本次重复授权。若本次仅授权单次动作却存在 bounded_repetition，判 substituted。必须审核实际执行参数。while_executable 表示在行动仍可执行时继续，单次未命中、被挡住、没有新发现不等于失去执行能力。until_unsuccessful_result 仅适用于用户明确要求某次结果不成功就停止；不能把“无法继续”“目标脱离范围”改成“一击不中就停”。即使 proposed_steps 保留了原文，只要 bounded_repetition 改变持续时长或终止条件，也必须 substituted，不能因原文相同而 aligned。原句明确授权重复而 bounded_repetition=null 时，判 incomplete；不能因为步骤原文正确就忽略实际重复契约缺失。',
    original_request:originalInput,proposed_steps:steps,
    speech_recipient_policy:'speech_recipients 是拟执行交流的实际听众，不是谈论对象。核对每个听众是否由本次原文授权，公开全名可以忠实对应简称；不得把未知人物删掉、把择一对象全选或把被谈论者加入听众。',
  },{...save,ai:{threads:{}}});
  currentTrace()?.info('agent.goal_alignment',{metadata:{verdict:result?.verdict??'unavailable',
    step_count:steps.length,operations:steps.map(step=>step.operation)}});
  return result;
}

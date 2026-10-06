import {z} from 'zod';
import type {GameService} from '../server/service.js';
import type {AgentPlan} from './plan-schema.js';
import {currentTrace} from '../observability/trace.js';

const alignmentSchema=z.strictObject({
  verdict:z.enum(['aligned','incomplete','substituted','uncertain']),
  explanation:z.string().min(1).max(300),
});

/** Read-only audit of one already proposed plan. It cannot choose an action or authorize a new one. */
export async function verifyGoalAlignment(service:GameService,originalInput:string,plan:AgentPlan){
  const save=await service.current();
  const steps=plan.execution_order.map(id=>{
    const goal=plan.goals.find(entry=>entry.goal_id===id)!;
    return {id,type:goal.type,objective:goal.normalized_goal,operation:goal.operation_hint??null,
      referent:goal.referent??null,depends_on:goal.depends_on,
      completion:goal.contract?.completion??null,availability:goal.contract?.availability??null};
  });
  const result=await service.ai.systemAgent(alignmentSchema,save.definition.prompt_profile,{
    instruction:'你只审查玩家原句与拟执行计划是否一致，不选择新动作，不执行，不补写步骤。aligned 仅当计划包含原句授权的最终尝试或结果，且每个会写入世界的步骤都是玩家明确要求或为了完成该目标合理且必要的准备；准备步骤必须依赖到后续的最终目标，不可单独冒充整个请求完成。若计划只剩移动、查看或其他准备，遗漏原目标，用 incomplete。若计划用别的行动替换原目标，用 substituted。无法判断用 uncertain。不存在的能力不能因到达地点而算完成。多步骤计划中包含合理准备和最终尝试可以是 aligned。只输出 JSON。',
    original_request:originalInput,proposed_steps:steps,
  },{...save,ai:{threads:{}}});
  currentTrace()?.info('agent.goal_alignment',{metadata:{verdict:result?.verdict??'unavailable',
    step_count:steps.length,operations:steps.map(step=>step.operation)}});
  return result;
}

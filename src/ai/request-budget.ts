import {AsyncLocalStorage} from 'node:async_hooks';
import type {AIAdapter,AIRequest,AIResult} from './contracts.js';
import {ProviderError} from './failures.js';

export type RequestBudgetLimits={calls:number;tokens:number;milliseconds:number};
type RequestBudget={remainingCalls:number;remainingTokens:number;deadline:number};
const scope=new AsyncLocalStorage<RequestBudget>();
const defaults:RequestBudgetLimits={calls:24,tokens:320000,milliseconds:480000};

/** Nested plan steps, Core turns and repair loops share the same live request budget. */
export function withRequestBudget<T>(work:()=>Promise<T>,limits:RequestBudgetLimits=defaults):Promise<T>{
  if(scope.getStore())return work();
  const budget:RequestBudget={remainingCalls:limits.calls,remainingTokens:limits.tokens,
    deadline:Date.now()+limits.milliseconds};
  return scope.run(budget,work);
}

/** Every provider attempt, including truncation and schema repair, crosses this boundary. */
export async function generateWithinRequestBudget(adapter:AIAdapter,request:AIRequest):Promise<AIResult>{
  const budget=scope.getStore();
  if(!budget)return adapter.generate(request);
  request.signal?.throwIfAborted();
  const remainingTime=budget.deadline-Date.now();
  if(remainingTime<=0)throw new ProviderError('request_budget_exhausted','wall time limit reached','本次请求的自动修正时间预算已用尽');
  if(budget.remainingCalls<=0)throw new ProviderError('request_budget_exhausted','model call limit reached','本次请求的模型调用预算已用尽');
  // Character count is a conservative upper estimate for CJK and a safe bound
  // when the adapter cannot report token usage. Reserve the entire output cap
  // before sending; unknown or failed calls never refund estimated spend.
  const estimate=request.prompt.length+(request.maxOutputTokens??4000);
  if(estimate>budget.remainingTokens)throw new ProviderError('request_budget_exhausted','estimated token limit reached','本次请求的 Token 预算已用尽');
  budget.remainingCalls--;budget.remainingTokens-=estimate;
  const timeout=AbortSignal.timeout(Math.max(1,remainingTime));
  const signal=request.signal?AbortSignal.any([request.signal,timeout]):timeout;
  const result=await adapter.generate({...request,signal});
  if(result.usage){
    // Provider reasoning tokens are normally a subset of output_tokens.
    const actual=result.usage.input_tokens+result.usage.output_tokens;
    budget.remainingTokens+=estimate-actual;
    if(budget.remainingTokens<0)throw new ProviderError('request_budget_exhausted','reported token limit reached','本次请求的 Token 预算已用尽');
  }
  return result;
}

import {describe,it,expect} from 'vitest';
import {generateWithinRequestBudget,withRequestBudget} from '../src/ai/request-budget.js';
import type {AIAdapter,AIRequest} from '../src/ai/contracts.js';

const request=(prompt='one'):AIRequest=>({role:'gm_reasoning',prompt,schema:{},maxOutputTokens:10});

describe('shared request provider budget',()=>{
  it('counts direct calls, nested repair attempts and failed attempts together',async()=>{
    let attempts=0;
    const adapter:AIAdapter={name:'fixture',async generate(){attempts++;if(attempts===1)throw Error('transient');
      return {data:{ok:true}};}};
    await withRequestBudget(async()=>{
      await expect(generateWithinRequestBudget(adapter,request())).rejects.toThrow('transient');
      await withRequestBudget(async()=>{
        await generateWithinRequestBudget(adapter,request());
      },{calls:100,tokens:100000,milliseconds:10000});
      await expect(generateWithinRequestBudget(adapter,request())).rejects.toMatchObject({reason:'request_budget_exhausted'});
    },{calls:2,tokens:1000,milliseconds:10000});
    expect(attempts).toBe(2);
  });
  it('rejects an over-budget token estimate before sending another request',async()=>{
    let attempts=0;
    const adapter:AIAdapter={name:'fixture',async generate(){attempts++;return {data:null};}};
    await withRequestBudget(async()=>{
      await generateWithinRequestBudget(adapter,request('short'));
      await expect(generateWithinRequestBudget(adapter,request('a'.repeat(100))))
        .rejects.toMatchObject({reason:'request_budget_exhausted'});
    },{calls:3,tokens:40,milliseconds:10000});
    expect(attempts).toBe(1);
  });
  it('honors provider token accounting when it exceeds the estimate',async()=>{
    const adapter:AIAdapter={name:'fixture',async generate(){return {data:null,
      usage:{input_tokens:35,output_tokens:30,reasoning_tokens:10}};}};
    await expect(withRequestBudget(()=>generateWithinRequestBudget(adapter,request()),
      {calls:2,tokens:50,milliseconds:10000})).rejects.toMatchObject({reason:'request_budget_exhausted'});
  });
});

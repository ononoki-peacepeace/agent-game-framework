import {expect,it} from 'vitest';
import {candidatePlan,runNarratorCandidates,type NarratorJob} from '../scripts/lib/narrator-candidate-queue.js';
const jobs:NarratorJob[]=[{id:'fixture',request:{role:'narrator',prompt:'Synthetic fixture, not a provider request',schema:{},maxOutputTokens:10}}];
const auth=()=>({reference:'synthetic-test-only-not-real-authorization',queue_sha256:candidatePlan(jobs).queue_sha256,
 max_calls:1,max_output_tokens_per_request:10,max_total_output_tokens:10});
it('defaults to a plan and never invokes the injected adapter',async()=>{
 const result=await runNarratorCandidates(jobs,{name:'offline',generate:async()=>{throw Error('must not run');}});
 expect(result.mode).toBe('dry_run');expect(result.plan.calls).toBe(1);expect(result.records).toEqual([]);
});
it.each(['identity','calls','tokens'] as const)('rejects %s bounds before any generation',async mode=>{
 const a=auth();if(mode==='identity')a.queue_sha256='wrong';if(mode==='calls')a.max_calls=0;if(mode==='tokens')a.max_total_output_tokens=1;
 await expect(runNarratorCandidates(jobs,{name:'offline',generate:async()=>{throw Error('must not run');}},a)).rejects.toThrow();
});
it('retains failed and returned raw controls without assigning quality or condition credit',async()=>{
 const q=[...jobs,{...jobs[0],id:'second'}],a={...auth(),queue_sha256:candidatePlan(q).queue_sha256,max_calls:2,max_total_output_tokens:20};let calls=0;
 const result=await runNarratorCandidates(q,{name:'offline-test-adapter',generate:async()=>{
  if(++calls===1)throw Error('synthetic failure');return {data:{narrative:'synthetic response'}};
 }},a);
 expect(calls).toBe(2);expect(result.records).toMatchObject([{id:'fixture',status:'failed'},{id:'second',status:'returned_unreviewed',quality_ratings:null}]);
 expect(result.conditions_awarded).toEqual([]);
});

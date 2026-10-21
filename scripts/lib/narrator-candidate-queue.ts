import {createHash} from 'node:crypto';
import type {AIAdapter,AIRequest} from '../../src/ai/contracts.js';
export type NarratorJob={id:string;request:AIRequest};
export function candidatePlan(jobs:readonly NarratorJob[]){
 if(new Set(jobs.map(j=>j.id)).size!==jobs.length)throw Error('Duplicate candidate identity');
 if(jobs.some(j=>j.request.role!=='narrator'||!j.request.prompt))throw Error('Narrator request required');
 return {queue_sha256:createHash('sha256').update(JSON.stringify(jobs)).digest('hex'),calls:jobs.length,
  input_characters:jobs.reduce((n,j)=>n+j.request.prompt.length,0),
  max_output_tokens:jobs.every(j=>j.request.maxOutputTokens!==undefined)?jobs.reduce((n,j)=>n+j.request.maxOutputTokens!,0):null};
}
export type CandidateAuthorization={reference:string;queue_sha256:string;max_calls:number;
 max_output_tokens_per_request:number;max_total_output_tokens:number};
/** No adapter is called without explicit, queue-bound execution parameters.
 * The caller still needs actual human authorization; a reference string is not proof. */
export async function runNarratorCandidates(jobs:readonly NarratorJob[],adapter:AIAdapter,authorization?:CandidateAuthorization){
 const plan=candidatePlan(jobs);
 if(!authorization)return {mode:'dry_run' as const,plan,records:[],conditions_awarded:[]};
 const a=authorization;
 if(!a.reference.trim()||a.queue_sha256!==plan.queue_sha256)throw Error('Missing authorization reference or queue mismatch');
 for(const n of [a.max_calls,a.max_output_tokens_per_request,a.max_total_output_tokens])if(!Number.isSafeInteger(n)||n<1)throw Error('Positive bounded budget required');
 if(plan.calls>a.max_calls)throw Error('Call budget exceeded before execution');
 const caps=jobs.map(j=>Math.min(j.request.maxOutputTokens??a.max_output_tokens_per_request,a.max_output_tokens_per_request));
 if(caps.some(n=>!Number.isSafeInteger(n)||n<1)||caps.reduce((n,c)=>n+c,0)>a.max_total_output_tokens)throw Error('Output budget exceeded before execution');
 const records:unknown[]=[];
 for(const [i,job] of jobs.entries()){
  const metadata={id:job.id,authorization_reference:a.reference,queue_sha256:plan.queue_sha256,adapter:adapter.name,
   requested_max_output_tokens:job.request.maxOutputTokens??null,effective_max_output_tokens:caps[i],quality_ratings:null};
  try{records.push({...metadata,status:'returned_unreviewed',raw:await adapter.generate({...job.request,maxOutputTokens:caps[i]})});}
  catch(error){records.push({...metadata,status:'failed',error:error instanceof Error?error.message:String(error)});}
 }
 return {mode:'caller_requested_execution_unverified_authorization' as const,plan,records,conditions_awarded:[]};
}

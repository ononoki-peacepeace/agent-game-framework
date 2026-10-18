// Safe timing projection: deliberately omits prompts, user text and world facts.
import {readFile} from 'node:fs/promises';
const path=process.argv[2];if(!path)throw Error('Supply JSONL log');
const events=(await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const summaries=[];
for(const start of events.filter(event=>event.event==='input.received')){
 const trace=events.filter(event=>event.trace_id===start.trace_id),end=trace.findLast(event=>event.event==='agent.presentation');
 const calls=trace.filter(event=>['routine.ai.response','ai.direct.response','ai.direct.failed','routine.ai.failed'].includes(event.event));
 summaries.push({trace_id:start.trace_id,request_id:start.request_id,completed:!!end,
  duration_ms:end?Date.parse(end.timestamp)-Date.parse(start.timestamp):null,
  calls:calls.map(event=>({role:event.metadata.role,duration_ms:event.duration_ms,
    input_tokens:event.metadata.usage?.input_tokens??null,output_tokens:event.metadata.usage?.output_tokens??null,
    reasoning_tokens:event.metadata.usage?.reasoning_tokens??null,retry_count:event.metadata.retry_count,
    success:event.event.endsWith('.failed')?false:event.metadata.success,reason:event.metadata.reason??null})),
  recorded_call_ms:Math.round(calls.reduce((sum,event)=>sum+(event.duration_ms??0),0)),
  // Schema-rejected generations may have transport timing but no parsed AI response.
  // Count transport completions separately; never treat the parsed-response sum as exhaustive.
  transport_calls:trace.filter(event=>event.event==='provider.transport.body_complete').map(event=>({
    role:event.metadata.role,duration_ms:event.duration_ms,first_body_ms:event.metadata.first_body_ms,status:event.metadata.status})),
  stages:trace.filter(event=>['semantic.start','semantic.complete','agent.plan_attempt','agent.action_selected','narrative.attempt','save.read','save.write','agent.presentation'].includes(event.event))
    .map(event=>({event:event.event,at_ms:Date.parse(event.timestamp)-Date.parse(start.timestamp),duration_ms:event.duration_ms}))});
}
console.log(JSON.stringify(summaries,null,2));

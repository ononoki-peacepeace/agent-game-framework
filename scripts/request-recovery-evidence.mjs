import {readFile} from 'node:fs/promises';
const save=JSON.parse(await readFile('data/current.json','utf8'));
for(const id of ['f092ba80-7155-4f53-a926-8f0cbd1616ac','574e1564-858e-4b96-a54e-a087d1fe4b42']){
 const stored={id,revision:save.state_revision,time:save.runtime.time,
  runtime_receipt:save.runtime.receipts.some(entry=>entry.id===id),
  resolution_receipt:(save.resolution_receipts??[]).some(entry=>entry.request_id===id),
  narrative_history:(save.narrative_history??[]).some(entry=>entry.request_id===id),
  turn_history:(save.turn_history??[]).some(entry=>entry.turn_id===id)};
 try{const start=performance.now(),response=await fetch(`http://127.0.0.1:3100/api/input/status/${id}?game_id=${encodeURIComponent(save.game_id)}`,{signal:AbortSignal.timeout(10000)});
  const value=await response.json();stored.status={http:response.status,state:value.state,phase:value.phase,elapsed_ms:value.elapsed_ms,query_ms:Math.round(performance.now()-start)};
 }catch(error){stored.status={error:error.name};}
 console.log(JSON.stringify(stored));
}

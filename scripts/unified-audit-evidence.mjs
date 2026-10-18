// Read-only, non-spoiler projection. Does not connect to the game or any Provider.
import {readFile,readdir} from 'node:fs/promises';
const save=JSON.parse(await readFile('data/current.json','utf8'));
const player=save.entities.find(entity=>entity.id===save.player_state.entity_id),here=player?.components.location?.location_id;
const npcs=save.entities.filter(entity=>entity.id!==player?.id&&entity.components.character);
const physical=(save.resolution_receipts??[]).filter(receipt=>receipt.physical_outcome).slice(-10);
console.log(JSON.stringify({kind:'current_authority',revision:save.state_revision,time:save.runtime.time,
 player_location:here,npc_count:npcs.length,present_npc_ids:npcs.filter(entity=>entity.components.location?.location_id===here).map(entity=>entity.id),
 physical_receipts:physical.map(receipt=>({request_id:receipt.request_id,check_id:receipt.check_id,outcome:receipt.outcome,
  commit_status:receipt.commit_status,time_cost:receipt.time_cost,physical_outcome:receipt.physical_outcome,
  resolution:(save.resolution_history??[]).filter(entry=>entry.check_id===receipt.check_id&&!entry.hidden).map(entry=>({outcome:entry.outcome,stage_results:entry.stage_results,rolls:entry.rolls}))})),
 npc_states:npcs.map(entity=>({id:entity.id,location:entity.components.location?.location_id,condition:entity.components.condition,
  physical_state:entity.components.physical_state,memories:save.npc_agent_state?.[entity.id]?.memories?.length??0,
  goals:save.npc_agent_state?.[entity.id]?.goals?.map(goal=>({id:goal.id,status:goal.status})),
  plans:save.npc_agent_state?.[entity.id]?.plans?.map(plan=>({id:plan.id,status:plan.status,has_activity:!!plan.activity}))})),
 mystery:{macro_arcs:save.definition.world_macro_arcs?.length??0,incidents:save.definition.background_incidents?.length??0,
  truth_commitments:save.gm_state.hidden_truth?.commitments?.length??0,
  evidence_total:(save.gm_state.hidden_truth?.commitments??[]).reduce((sum,truth)=>sum+truth.evidence.length,0),
  evidence_with_placement:(save.gm_state.hidden_truth?.commitments??[]).flatMap(truth=>truth.evidence).filter(evidence=>evidence.placement).length}},null,2));
const traceIds=new Set(['tr_df67ba4c2809','tr_431e804fe03c']);
for(const file of (await readdir('data/logs')).filter(file=>file.endsWith('.log'))){
 const lines=(await readFile('data/logs/'+file,'utf8')).split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
 for(const id of traceIds){const trace=lines.filter(entry=>entry.trace_id===id);if(!trace.length)continue;
  console.log(JSON.stringify({kind:'trace',trace_id:id,request_id:trace[0].request_id,
   events:trace.filter(entry=>['input.received','semantic.complete','agent.recovery.decision','agent.goal.failed','agent.outcome','save.commit','ai.direct.response','ai.direct.failed','routine.ai.response','routine.ai.failed'].includes(entry.event))
    .map(entry=>({event:entry.event,at:entry.timestamp,ms:entry.duration_ms,revision:entry.revision,
      metadata:Object.fromEntries(Object.entries(entry.metadata??{}).filter(([key])=>['reason','failure_code','failure_stage','kind','stage','receipt_ids','revision','state_certain','usage','role','max_output_tokens','provider_calls','semantic_kind','code','recoverable'].includes(key)))}))}));
 }
}

import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const bytes=await readFile(new URL('../data/current.json',import.meta.url));
const save=JSON.parse(bytes),logs=[];
for(const file of await readdir(new URL('../data/logs/',import.meta.url))){
 if(!file.endsWith('.log'))continue;
 for(const line of (await readFile(new URL('../data/logs/'+file,import.meta.url),'utf8')).split('\n')){
  try{const row=JSON.parse(line);if(row.revision>=384&&row.revision<=388&&
   /^(save.commit|npc_agent\.(daily_action|daily_batch|background_action|background_failed|activity_batch|social_batch)|background_event.evaluated)$/.test(row.event))
   logs.push(row);}catch{}
 }
}
console.log(JSON.stringify({snapshot:{revision:save.state_revision,time:save.runtime.time,
 sha256:createHash('sha256').update(bytes).digest('hex')},
 registered:{npcs:save.entities.filter(e=>e.components.character&&e.id!==save.player_state.entity_id).length,
 npc_goals:Object.values(save.npc_agent_state??{}).reduce((n,s)=>n+s.goals.filter(g=>g.status==='active').length,0),
 executable_plans:Object.values(save.npc_agent_state??{}).reduce((n,s)=>n+s.plans.filter(p=>p.status==='active'&&(p.activity||p.execution)).length,0),
 never_deep_serviced:Object.values(save.npc_agent_state??{}).filter(s=>!s.last_autonomous_at).length,
 incidents:(save.background_state?.incidents??[]).map(i=>({status:i.status,stage_index:i.stage_index})),
 arcs:(save.background_state?.macro_arcs??[]).map(a=>({status:a.status})),
 stage_advances:(save.background_state?.event_log??[]).filter(e=>e.kind==='stage_advanced').length},
 logs:logs.sort((a,b)=>a.timestamp.localeCompare(b.timestamp))},null,2));

import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {executeFreeform} from '../src/core/freeform.js';
import {validateSave} from '../src/core/state.js';
const bytes=await readFile('data/current.json'),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const save=JSON.parse(bytes.toString('utf8'));
const recorded=JSON.parse(await readFile('.tmp/qa-immediate-real-1792133500721/report.json','utf8'));
const original=recorded.outputs.find((o:any)=>o.stage==='freeform').data;
const proposal=JSON.parse(JSON.stringify(original).replaceAll('npc_lin','n_hayase'));
const input='我现在立即尝试连续挥拳攻击早瀬真帆，在接下来的十秒内反复出拳。如果她成功逃离攻击范围，或者我无法继续攻击，就停止。';
delete proposal.repetition.stop_on_failure;
proposal.physical_action.source_quote='连续挥拳攻击早瀬真帆';proposal.repetition={...proposal.repetition,source_quote:input,duration_seconds:10,termination_mode:'while_executable'};
const turn=executeFreeform(save,input,proposal,randomUUID(),()=>.5),checked=validateSave(turn.save),receipt=checked.resolution_receipts!.at(-1)!;
const result={mode:'read-only formal clone / Core only / deterministic isolated RNG, not a production action',revision_before:save.state_revision,
  revision_after:checked.state_revision,time_before:save.runtime.time,time_after:checked.runtime.time,seconds_before:save.runtime.scene_seconds??0,seconds_after:checked.runtime.scene_seconds??0,
  repetition:receipt.repetition,kind:receipt.kind,outcome:receipt.outcome,damage:receipt.physical_outcome?.damage,
  same_location:checked.entities.find((e:any)=>e.id==='n_hayase')!.components.location?.location_id===checked.entities.find((e:any)=>e.id===checked.player_state.entity_id)!.components.location?.location_id,
  production_unchanged:sha(bytes)===sha(await readFile('data/current.json'))};
await mkdir('.tmp',{recursive:true});await writeFile('.tmp/qa-287-core-clone.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));

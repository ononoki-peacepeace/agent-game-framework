import { createHash } from 'node:crypto';
import type { SavePackage } from './schema.js';

/** Configuration, presentation and external extension state are deliberately outside World Undo. */
export const worldKeys=['schema_version','framework_version','module_versions','modules','game_id','definition','entities','player_state','gm_state','event_state','runtime','map_state','last_turn','action_facts','future_intents','task_progress','foreground','calendar','routine_meta','interaction_context','narrative_history'] as const;
/** The snapshot travels inside `z.record(z.string(), z.json())`, which rejects `undefined` values. */
function jsonSafe(value:any):any{
  if(Array.isArray(value))return value.map(jsonSafe);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==undefined).map(([key,entry])=>[key,jsonSafe(entry)]));
  return value;
}
export function worldImage(save:SavePackage):Record<string,any>{
  const copy=structuredClone(save) as Record<string,any>;
  for(const key of Object.keys(copy))if(!(worldKeys as readonly string[]).includes(key))delete copy[key];
  delete copy.runtime.receipts;
  for(const e of copy.entities){delete e.components.visual_assets;if(e.components.identity)delete e.components.identity.avatar_id;}
  return jsonSafe(copy);
}
function stable(value:any):any{return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;}
export function imageHash(save:SavePackage){return createHash('sha256').update(JSON.stringify(stable(worldImage(save)))).digest('hex');}
export function canUndo(save:SavePackage){return Boolean(save.turn_checkpoint&&save.turn_checkpoint.after_hash===imageHash(save));}
export function checkpointTurn(before:SavePackage,after:SavePackage,turnId:string){
  after.active_turn_id=turnId;
  after.turn_checkpoint={turn_id:turnId,parent_turn_id:before.active_turn_id??null,before:worldImage(before),after_hash:imageHash(after)};
}

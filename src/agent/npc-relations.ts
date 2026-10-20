import type {Action,SavePackage} from '../core/schema.js';
import {validateSave} from '../core/state.js';
import type {ModuleRegistry} from '../core/registry.js';
import {applyRelationshipDelta} from '../modules/relationships.js';

/** Enrich a staged authoritative action, before its enclosing transaction is persisted.
 * No caller-provided audience, outcome or harm is trusted. The original Claude WIP is
 * preserved in the takeover snapshot; this version uses authored world semantics and
 * keeps the external relationship_delta actor/target guard unchanged. */
export function settleRelationshipOutcomes(save:SavePackage,action:Action,registry?:ModuleRegistry):SavePackage{
  if(!save.definition.enabled_modules.includes('relationships'))return save;
  const receipt=save.resolution_receipts?.find(item=>item.request_id===action.id);
  if(!receipt||receipt.action_id!==action.id||receipt.actor_id!==action.actor_id||
    receipt.target_id!==action.target_id||!receipt.target_id||receipt.actor_id===receipt.target_id||
    receipt.result_entities?.relationship_settlement?.includes('v1'))return save;
  const physical=receipt.physical_outcome;
  const conversation=['TALK','SOCIAL_INTERACT'].includes(action.type)&&receipt.semantic_action===action.type&&
    ['success','strong_success'].includes(receipt.outcome)&&
    receipt.prerequisites.some(item=>item.kind==='registered_action'&&item.subject_id===action.type);
  const conflict=action.type==='FREEFORM_ACTION'&&physical?.target_id===receipt.target_id&&physical.contact;
  if(!conversation&&!conflict)return save;
  const parties=[receipt.actor_id,receipt.target_id];
  if(parties.some(id=>!save.entities.some(entity=>entity.id===id&&entity.components.character)))return save;
  // Both directions, all dimensions and the replay marker form one validated candidate.
  // Mark once per receipt rather than evicting per-dimension markers after twenty writes.
  const next=structuredClone(save);
  let changed=false;
  for(const from of parties){
    const to=parties.find(id=>id!==from)!;
    const entity=next.entities.find(item=>item.id===from)!;
    for(const [dimension,bounds] of Object.entries(next.definition.ruleset.relationship_dimensions)){
      const policy=bounds.event_deltas;
      const delta=conversation?policy?.contact:
        from===receipt.target_id&&physical?.harmed?(policy?.harmed??policy?.conflict):policy?.conflict;
      if(!delta)continue;
      const entries=entity.components.relationships?.entries as Record<string,Record<string,number>>|undefined;
      const current=entries?.[to]?.[dimension]??bounds.initial;
      const bounded=Math.max(bounds.min,Math.min(bounds.max,current+delta))-current;
      if(!bounded)continue;
      entity.components.relationships??={entries:{}};
      applyRelationshipDelta(next,{entity_id:from,target_id:to,dimension,delta:bounded});
      changed=true;
    }
  }
  const settled=next.resolution_receipts!.find(item=>item.request_id===action.id)!;
  settled.result_entities??={};settled.result_entities.relationship_settlement=['v1'];
  if(changed&&!settled.effects.includes('relationship'))settled.effects.push('relationship');
  return validateSave(next,registry);
}

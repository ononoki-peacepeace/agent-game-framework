import type { SavePackage } from '../core/schema.js';
import { defaultRoleplayConfig, roleplayConstitution } from './policy.js';
import { ensureNarrativeState } from './runtime.js';

/** Bounded context: references canonical state instead of serializing the world or complete history. */
export function buildNarrativeContext(save:SavePackage,truthRefs:string[]=[]){
  const state=ensureNarrativeState(save),config=save.definition.roleplay_config??defaultRoleplayConfig();
  const allowed=new Set(truthRefs);
  return {
    constitution:{version:roleplayConstitution.version,agency:roleplayConstitution.player_agency,truth:roleplayConstitution.world_truth_stability},
    config,
    life:{player_entity_ref:state.player_entity_ref,horizon:config.life_horizon},
    current_saga:state.current_saga,
    arcs:state.arcs.filter(a=>['ACTIVE','EMERGING','CONVERGING','CLIMAX'].includes(a.status)).slice(0,8),
    open_loops:state.open_loops.filter(l=>l.status==='OPEN').slice(0,12),
    unpaid_setups:state.unpaid_setups.filter(s=>s.status==='UNPAID').slice(0,12),
    relevant_hidden_truth:(save.gm_state.hidden_truth?.commitments??[]).filter(t=>allowed.has(t.id)).slice(0,8),
    recent_event_refs:(save.action_facts??[]).slice(-6).map(entry=>entry.request_id),
    closure_pressure:state.closure_pressure,
  };
}

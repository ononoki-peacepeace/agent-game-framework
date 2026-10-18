import { createHash } from 'node:crypto';
import { assert, type SavePackage } from '../core/schema.js';
import { hiddenTruthStateSchema, type HiddenTruthState } from './schema.js';

function truthId(statement:string){return `truth_${createHash('sha256').update(statement).digest('hex').slice(0,12)}`;}
export function initialTruthFromNotes(notes:string):HiddenTruthState{
  const statement=notes.trim();
  return {version:1,commitments:statement?[{id:truthId(statement),commitment:'HARD_TRUTH',statement,seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,evidence:[],known_by:[]}]:[]};
}
export function ensureHiddenTruth(save:SavePackage){save.gm_state.hidden_truth??=initialTruthFromNotes(save.gm_state.notes);return save.gm_state.hidden_truth;}
export function commitTruth(save:SavePackage,input:HiddenTruthState['commitments'][number]){
  const state=ensureHiddenTruth(save),existing=state.commitments.find(item=>item.id===input.id);
  if(existing){
    assert(existing.statement===input.statement&&existing.commitment===input.commitment,'已承诺的世界真相不能被重写');
    return existing;
  }
  state.commitments.push(input);save.gm_state.hidden_truth=hiddenTruthStateSchema.parse(state);return input;
}
export function instantiateSeededTruth(save:SavePackage,id:string,statement:string,eventRef:string){
  const truth=ensureHiddenTruth(save).commitments.find(item=>item.id===id);assert(truth,'找不到真相承诺');assert(truth.commitment==='SEEDED_TRUTH','只有预置承诺可以实例化');
  assert(!truth.seed_constraint||statement.includes(truth.seed_constraint),'实例化结果违反预置真相约束');
  truth.statement=statement;truth.commitment='HARD_TRUTH';truth.created_event_ref=eventRef;return truth;
}
export function registerEvidence(save:SavePackage,truthIdValue:string,evidence:HiddenTruthState['commitments'][number]['evidence'][number]){
  const truth=ensureHiddenTruth(save).commitments.find(item=>item.id===truthIdValue);assert(truth&&truth.commitment!=='UNDEFINED','证据必须引用已经承诺的真相');
  const elsewhere=ensureHiddenTruth(save).commitments.find(item=>item.id!==truthIdValue&&item.evidence.some(entry=>entry.id===evidence.id));
  assert(!elsewhere,'证据标识已属于其他真相记录');
  const existing=truth.evidence.find(item=>item.id===evidence.id);
  if(existing){assert(JSON.stringify(existing)===JSON.stringify(evidence),'已有证据不能随玩家调查方向改变');return existing;}
  assert(evidence.status==='EXISTS'||Boolean(evidence.event_ref&&(
    save.action_facts?.some(entry=>entry.request_id===evidence.event_ref)||
    save.resolution_receipts?.some(entry=>entry.request_id===evidence.event_ref)||
    save.background_state?.event_log.some(entry=>entry.id===evidence.event_ref))),
    '后续产生的证据必须引用真实世界事件');truth.evidence.push(evidence);return evidence;
}

/** A clue follows its canonical anchor, never a second inventory or a stale creation location. */
export function evidenceAccessible(save:SavePackage,actorId:string,placement:NonNullable<HiddenTruthState['commitments'][number]['evidence'][number]['placement']>){
  const actor=save.entities.find(entity=>entity.id===actorId),here=actor?.components.location?.location_id;
  if(!actor||!here)return false;
  if(placement.anchor_entity_id){
    const anchor=save.entities.find(entity=>entity.id===placement.anchor_entity_id);if(!anchor)return false;
    if(anchor.components.item?.condition==='destroyed')return false;
    const holders=save.entities.filter(entity=>Number((entity.components.inventory?.items as Record<string,number>|undefined)?.[anchor.id]??0)>0);
    if(holders.length)return holders.length===1&&holders[0].id===actorId;
    return anchor.components.location?.location_id===here&&(!placement.scene_scope||anchor.components.scene_position?.label===placement.scene_scope);
  }
  return (!placement.location_id||placement.location_id===here)&&
    (!placement.scene_scope||actor.components.scene_position?.label===placement.scene_scope)&&Boolean(placement.location_id||placement.scene_scope);
}

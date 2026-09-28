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
  assert(!truth.seed_constraint||statement.includes(truth.seed_constraint)||truth.statement.includes(truth.seed_constraint),'实例化结果违反预置真相约束');
  truth.statement=statement;truth.commitment='HARD_TRUTH';truth.created_event_ref=eventRef;return truth;
}
export function registerEvidence(save:SavePackage,truthIdValue:string,evidence:HiddenTruthState['commitments'][number]['evidence'][number]){
  const truth=ensureHiddenTruth(save).commitments.find(item=>item.id===truthIdValue);assert(truth&&truth.commitment!=='UNDEFINED','证据必须引用已经承诺的真相');
  const existing=truth.evidence.find(item=>item.id===evidence.id);
  if(existing){assert(JSON.stringify(existing)===JSON.stringify(evidence),'已有证据不能随玩家调查方向改变');return existing;}
  assert(evidence.status==='EXISTS'||Boolean(evidence.event_ref),'后续产生的证据必须引用真实世界事件');truth.evidence.push(evidence);return evidence;
}

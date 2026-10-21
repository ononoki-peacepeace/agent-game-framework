import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {executeAction} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import type {Inventory} from '../src/modules/inventory.js';
import {validateResolvedNarrative,validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
import {narrativeCorpus} from './fixtures/narrative-fixed-corpus.js';
import {narrativeWorldKinds,prepareNarrativeWorld,corpusSave,type NarrativeWorldKind} from './fixtures/narrative-worlds.js';

const fixtures=new Map<NarrativeWorldKind,ReturnType<typeof prepareNarrativeWorld>>();
export function fixture(kind:NarrativeWorldKind){
 let value=fixtures.get(kind);if(!value){value=prepareNarrativeWorld(kind);fixtures.set(kind,value);}return value;
}
it.each(narrativeWorldKinds)('proves a structurally distinct %s world through committed Core operations',async kind=>{
 const {save,initial,evidence}=await fixture(kind),player=save.player_state.entity_id;
 expect(evidence.every(receipt=>receipt.commit_status==='committed')).toBe(true);
 if(kind==='commerce'){
  expect(evidence.filter(r=>r.actor_id===player).map(r=>r.semantic_action)).toEqual(['MOVE','BUY','MOVE']);
  const owned=(s:typeof save)=>Number((s.entities.find(e=>e.id===player)!.components.inventory as Inventory | undefined)?.items.water??0);
  expect(owned(save)-owned(initial)).toBe(1);
  expect(evidence.find(r=>r.semantic_action==='BUY')?.effects).toEqual(expect.arrayContaining(['inventory','money']));
  expect(save.definition.background_incidents??[]).toHaveLength(0);
  expect(Object.values(save.npc_agent_state??{}).flatMap(mind=>mind.plans)).toHaveLength(0);
 }else if(kind==='relationships'){
  expect(evidence.filter(r=>r.actor_id===player).map(r=>r.semantic_action)).toEqual(['TALK']);
  expect(save.entities.some(entity=>entity.components.shop||entity.components.wallet)).toBe(false);
  expect(save.definition.map!.locations).toHaveLength(2);
  const relationships=save.entities.find(e=>e.id===player)!.components.relationships as {entries:Record<string,{familiarity:number}>};
  expect(relationships.entries.npc_lin.familiarity).toBe(1);
 }else{
  expect(evidence.filter(r=>r.actor_id==='npc_mira').map(r=>r.semantic_action)).toEqual(['MOVE','HOLD']);
  expect(save.npc_agent_state!.npc_mira.plans[0].status).toBe('completed');
  expect(save.entities.find(e=>e.id==='npc_mira')!.components.location?.location_id).toBe('station');
  expect(save.gm_state.flags.shift_handoff_done).toBe(true);
  expect(save.background_state!.incidents[0].status).toBe('resolved');
  expect(save.background_state!.exposure_log).toHaveLength(0);
  expect(save.definition.enabled_modules).not.toContain('commerce');
 }
 const structure={modules:save.definition.enabled_modules,map:save.definition.map,
  background:save.definition.background_incidents??[],rules:save.definition.ruleset.relationship_dimensions};
 await appendFile('.agent-runtime/codex/narrative-three-world-witnesses.ndjson',JSON.stringify({kind,pid:process.pid,
  structure_sha256:createHash('sha256').update(JSON.stringify(structure)).digest('hex'),
  evidence:evidence.map(r=>({id:r.request_id,actor:r.actor_id,action:r.semantic_action,effects:r.effects,time:r.time_cost})),
  revision:save.state_revision})+'\n');
});
it.each(narrativeWorldKinds.flatMap(kind=>narrativeCorpus.map(sample=>({kind,sample}))))(
 'same N4 corpus $sample.id in $kind (lawful=$sample.legal)',async({kind,sample})=>{
 const prepared=await fixture(kind),save=corpusSave(prepared.save,sample);let turn;
 if(sample.category==='sensory'){
  const input='尝试打击林舟';let i=0;
  turn=executeFreeform(save,input,{narrative:'尝试行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
   physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
   resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'本次尝试',
    stages:[{id:'contact',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>[.99,.01][i++%2]);
  expect(turn.save.resolution_receipts!.at(-1)!.physical_outcome?.sight_blocked_ids).toContain('npc_lin');
 }else turn=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID());
 const receipt=turn.save.resolution_receipts!.at(-1)!,image=structuredClone(turn.save);
 const result={narrative:sample.text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],
  ...('speech' in sample?{scene_beats:[{kind:'speech' as const,speaker_id:'npc_lin',utterance:'拿起纸片'}]}:{})};
 const check=()=>{validateScenePresenceNarrative(turn.save,sample.text);
  validateResolvedNarrative(receipt,result,false,undefined,turn.save,true);};
 if(sample.legal)expect(check).not.toThrow();else expect(check).toThrow();
 expect(turn.save).toEqual(image);
});

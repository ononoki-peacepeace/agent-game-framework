import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validateResolvedNarrative,validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';

import {narrativeCorpus} from './fixtures/narrative-fixed-corpus.js';

it.each(narrativeCorpus)('N4 fixed corpus $id (lawful=$legal)',sample=>{
 const save=newSave(demo);save.definition.events=[];save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 for(const entity of save.entities)if(entity.components.character)entity.components.location={location_id:'square'};
 const lin=save.entities.find(entity=>entity.id==='npc_lin')!,mira=structuredClone(lin);
 mira.id='npc_mira';mira.components.identity!.name='米拉';mira.components.location={location_id:'station'};save.entities.push(mira);
 save.entities.push({id:'qa_paper',type:'item',components:{identity:{name:'纸片',description:'已有物品',avatar_id:null},
  location:{location_id:'square'},item:{weight:.01,stackable:false,tracking:'tracked',condition:'condition' in sample?sample.condition:'intact'},
  discovery:{known_to_player:true}}});
 let turn;
 if(sample.category==='sensory'){
  lin.components.physical_state={awareness:'unaware',alert_to_ids:[],restrained_by:null,posture:'standing',eyes:'closed',transients:[]};
  const input='尝试打击林舟';let i=0;
  turn=executeFreeform(save,input,{narrative:'尝试行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
   physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
   resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'本次尝试',
    stages:[{id:'contact',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>[.99,.01][i++%2]);
  expect(turn.save.resolution_receipts!.at(-1)!.physical_outcome?.sight_blocked_ids).toContain('npc_lin');
 }else turn=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID());
 const receipt=turn.save.resolution_receipts!.at(-1)!,before=structuredClone(turn.save);
 const narrative={narrative:sample.text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],
  ...('speech' in sample?{scene_beats:[{kind:'speech' as const,speaker_id:'npc_lin',utterance:'拿起纸片'}]}:{})};
 const check=()=>{validateScenePresenceNarrative(turn.save,sample.text);
  validateResolvedNarrative(receipt,narrative,false,undefined,turn.save,true);};
 if(sample.legal)expect(check).not.toThrow();else expect(check).toThrow();
 expect(turn.save).toEqual(before);
});

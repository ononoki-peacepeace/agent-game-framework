import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validateResolvedNarrative,validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';

export const narrativeCorpus=[
 {id:'metaphor-thread',category:'metaphor',legal:true,text:'你的目光像一条细线一样穿过门口，暂时没有新的发现。'},
 {id:'metaphor-water',category:'metaphor',legal:true,text:'你的视线如同清水一般穿过门口，暂时没有新的发现。'},
 {id:'metaphor-tail',category:'metaphor',legal:false,text:'你的目光像一条细线一样穿过门口，随后你进入走廊。'},
 {id:'metaphor-literal',category:'metaphor',legal:false,text:'你和你的目光像一条细线一样穿过门口。'},
 {id:'retelling-cn',category:'retelling',legal:true,text:'林舟：“拿起纸片”。你没有拿起纸片。',speech:true},
 {id:'retelling-ascii',category:'retelling',legal:true,text:'林舟："拿起纸片"。你没有拿起纸片。',speech:true},
 {id:'retelling-tail',category:'retelling',legal:false,text:'林舟：“拿起纸片”。随后你“拿起纸片”。',speech:true},
 {id:'retelling-ascii-tail',category:'retelling',legal:false,text:'林舟："拿起纸片"。随后你拿起纸片。',speech:true},
 {id:'sensory-hearing',category:'sensory',legal:true,text:'林舟只听见动静。'},
 {id:'sensory-other',category:'sensory',legal:true,text:'乔宁看清了动作，林舟凭触觉感觉到了接触。'},
 {id:'sensory-blind',category:'sensory',legal:false,text:'乔宁站在这里，林舟看得很清楚。'},
 {id:'sensory-joint',category:'sensory',legal:false,text:'林舟仍站在这里。随后他和乔宁看清了动作。'},
 {id:'absence-denial',category:'absence',legal:true,text:'林舟仍站在这里，米拉不在这里。'},
 {id:'absence-present-only',category:'absence',legal:true,text:'林舟仍站在这里。'},
 {id:'absence-second-subject',category:'absence',legal:false,text:'林舟仍站在这里，米拉站在你面前。'},
 {id:'absence-local-claim',category:'absence',legal:false,text:'米拉坐在你身旁。'},
 {id:'item-intact',category:'item',legal:true,text:'纸片仍然完好。',condition:'intact'},
 {id:'item-damaged',category:'item',legal:true,text:'纸片已经受损。',condition:'damaged'},
 {id:'item-destroyed',category:'item',legal:true,text:'纸片已经损毁。',condition:'destroyed'},
 {id:'item-invented-destruction',category:'item',legal:false,text:'纸片已经损毁。',condition:'intact'},
 {id:'item-invented-repair',category:'item',legal:false,text:'纸片仍然完好。',condition:'damaged'},
 {id:'item-destroyed-repair',category:'item',legal:false,text:'纸片已经恢复完好。',condition:'destroyed'},
] as const;

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

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';

it.each([
 {text:'这次没有拿起纸片。',legal:true},
 {text:'本次你没有拿起纸片。',legal:true},
 {text:'这次不是没有拿起纸片。',legal:false},
 {text:'这次没有拿起纸片，随后你拿起纸片。',legal:false},
 {text:'这次林舟没有伸手，你拿起纸片。',legal:false},
])('scopes turn-qualified inventory denial: $text (lawful=$legal)',({text,legal})=>{
 const world=structuredClone(demo);world.events=[];world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 world.entities.push({id:'qa_paper',type:'item',components:{identity:{name:'纸片',description:'已有物品',avatar_id:null},
  item:{weight:.01,stackable:false,tracking:'tracked',condition:'intact'},discovery:{known_to_player:true},location:{location_id:'square'}}});
 const save=newSave(world),turn=executeFreeform(save,'拿起纸片',{narrative:'尝试拾取',minutes:1,target_id:null,facts:[],relationship:null,
  item_move:{item_id:'qa_paper',to:'held',position_label:null},resolution:{type:'SIMPLE_CHECK',domain:'general',band:'normal',visibility:'public',
   stakes:'固定拾取尝试',stages:[],evidence_ids:[]}},randomUUID(),()=>.01);
 const receipt=turn.save.resolution_receipts!.at(-1)!,before=structuredClone(turn.save);
 expect(receipt.outcome).toBe('critical_failure');expect(receipt.effects).not.toContain('inventory');
 const check=()=>validateResolvedNarrative(receipt,{narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[]},false,undefined,turn.save);
 if(legal)expect(check).not.toThrow();else expect(check).toThrow();
 expect(turn.save).toEqual(before);
});

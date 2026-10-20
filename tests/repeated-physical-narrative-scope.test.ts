import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';

function fixture(){
 const world=structuredClone(demo);world.events=[];world.enabled_modules=[...new Set([...world.enabled_modules,'attributes','aptitudes','skills'])];
 const save=newSave(world);save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 save.definition.ruleset.capability_domains={lifting:{attribute:'strength',skills:[],condition_sensitive:true,exertion_cost:0},agility:{attribute:'agility',skills:[],condition_sensitive:true,exertion_cost:0}};
 const player=save.entities.find(e=>e.id==='player')!,npc=save.entities.find(e=>e.id==='npc_lin')!;
 player.components.attributes={values:{strength:0},labels:{}};npc.components.attributes={values:{agility:0},labels:{}};
 player.components.condition={hp:100,stamina:100,stress:0};npc.components.condition={hp:100,stamina:100,stress:0};
 const input='尝试打击林舟，反复十秒。',values=[.01,.99,.01,.99,.01,.99,.99,.01,.01,.99,.99,.01,.99,.01];
 const turn=executeFreeform(save,input,{narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
  repetition:{source_quote:input,duration_seconds:10,interval_seconds:2,termination_mode:'while_executable'},
  resolution:{type:'OPPOSED_CHECK',domain:'lifting',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'尝试',stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>{const v=values.shift();if(v===undefined)throw Error('unexpected RNG');return v;});
 return {save:turn.save,receipt:turn.save.resolution_receipts!.at(-1)!};
}
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
it.each(['none','all','attempts'] as const)('preserves the real failed prefix of a repeated physical action with child projection=%s',projection=>{
 const {save,receipt}=fixture();
 const children=projection==='none'?undefined:projection==='all'?save.resolution_receipts:
  save.resolution_receipts?.filter(step=>receipt.repetition!.attempt_ids.includes(step.request_id));
 expect(()=>validateResolvedNarrative(receipt,narration('头三次没有碰到她。第四次触及她，最后一次造成伤害。'),false,children,save)).not.toThrow();
 expect(()=>validateResolvedNarrative(receipt,narration('所有尝试都没有碰到她。'),false,children,save)).toThrow();
});

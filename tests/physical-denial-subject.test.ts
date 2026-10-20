import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import type {SavePackage} from '../src/core/schema.js';

function strike(save:SavePackage,target_id='npc_lin',name='林舟',harmed=true){
 let i=0;const input=`尝试打击${name}`;
 return executeFreeform(save,input,{narrative:'候选',minutes:1,target_id,facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'尝试伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>harmed?[.99,.01][i++%2]:[.01,.99][i++%2]);
}

function fixture(){
 const world=structuredClone(demo);world.events=[];world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 const save=newSave(world);
 for(const e of save.entities)if(e.components.character){e.components.location={location_id:'square'};e.components.condition={hp:100,stamina:100,stress:0};}
 const turn=strike(save);
 expect(turn.save.resolution_receipts!.at(-1)!.physical_outcome?.harmed).toBe(true);
 return {save:turn.save,receipt:turn.save.resolution_receipts!.at(-1)!};
}
const narrative=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

it.each(['你的动作触及林舟，造成伤害。你毫发无伤。','林舟受到伤害，乔宁没有受伤。','林舟受到伤害。乔宁却并未受伤。'])('preserves an explicit other-person injury denial: %s',text=>{
 const f=fixture();expect(()=>validateResolvedNarrative(f.receipt,narrative(text),false,undefined,f.save)).not.toThrow();
});
it.each(['林舟毫发无伤。','乔宁没有受伤，林舟并未受伤。','林舟被触及。他没有受伤。','你看着林舟毫发无伤。','林舟和乔宁毫发无伤。'])('still rejects denial of the harmed target or ambiguous subject: %s',text=>{
 const f=fixture();expect(()=>validateResolvedNarrative(f.receipt,narrative(text),false,undefined,f.save)).toThrow(/伤害/);
});
it.each([true,false])('checks every actual physical target in compound context (second harmed=%s)',harmed=>{
 const f=fixture(),second=strike(f.save,'npc_qiao','乔宁',harmed),receipt=second.save.resolution_receipts!.at(-1)!;
 expect(receipt.physical_outcome?.harmed).toBe(harmed);
 const check=()=>validateResolvedNarrative(receipt,narrative('林舟受到伤害。乔宁没有受伤。'),false,second.save.resolution_receipts,second.save);
 if(harmed)expect(check).toThrow(/伤害/);else expect(check).not.toThrow();
});
it('requires unique identity and a real scene before exempting another subject',()=>{
 const f=fixture(),text=narrative('乔宁没有受伤。');
 expect(()=>validateResolvedNarrative(f.receipt,text,false)).toThrow(/伤害/);
 f.save.entities.find(e=>e.id==='npc_lin')!.components.identity!.name='乔宁';
 expect(()=>validateResolvedNarrative(f.receipt,text,false,undefined,f.save)).toThrow(/伤害/);
});

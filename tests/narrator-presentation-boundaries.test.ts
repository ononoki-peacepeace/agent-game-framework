import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fresh} from './helpers.js';
import {executeFreeform} from '../src/core/freeform.js';
import {physicalOutcomeProse,physicalPresentation} from '../src/narrative/physical-presentation.js';
import {ProviderError} from '../src/ai/failures.js';
import {assertNotRefusal} from '../src/ai/narrative-health.js';
const known=new Set(['npc_lin']);
it.each([
 {narrative:'作为一个 AI，我不能帮助你完成这个请求。',speaker:null,dialogue:null},
 {narrative:'我不能帮助你完成这个请求。',speaker:null,dialogue:null},
 {narrative:'林舟说：“作为一个 AI，我不能帮助你完成这个请求。”',speaker:'npc_lin',dialogue:'作为一个 AI，我不能帮助你完成这个请求。'},
 {narrative:'林舟说：“我不能帮助你完成这个请求。”我不能帮助你生成这个场景。',speaker:'npc_lin',dialogue:'我不能帮助你完成这个请求。'},
 {narrative:'陌生人说：“我不能帮助你完成这个请求。”',speaker:'absent',dialogue:'我不能帮助你完成这个请求。'},
])('retains real provider refusal rejection: $narrative',value=>expect(()=>assertNotRefusal(value,known)).toThrow(ProviderError));
it('does not treat an unbound quote alone as a known character refusal',()=>{
 expect(()=>assertNotRefusal({narrative:'“我不能帮助你完成这个请求。”'},known)).toThrow();
});
it.each([false,true])('keeps legacy physical outcomes bounded and hidden results unknown: hidden=%s',hidden=>{
 const save=fresh();save.definition.events=[];save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};let n=0;
 const turn=executeFreeform(save,'尝试打击林舟',{narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'身体尝试',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>n++%2?.01:.99);
 const receipt=turn.save.resolution_receipts!.at(-1)!,before=structuredClone(turn.save);
 const output=physicalOutcomeProse(receipt,'林舟',hidden)!,projection=physicalPresentation(receipt,hidden)!;
 expect(output).toContain('林舟');expect(output).not.toMatch(/躲开|挡住|骨折|拳|脚|手腕/);
 if(hidden){expect(output).toContain('还看不清');expect(projection).toMatchObject({contact:null,harmed:null,control_established:null});expect(output).not.toContain('伤害');}
 else{expect(output).toContain('造成了伤害');expect(projection).toMatchObject({contact:true,harmed:true});}
 expect(turn.save).toEqual(before);
});

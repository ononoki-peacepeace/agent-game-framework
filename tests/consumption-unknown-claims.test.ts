import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {consumptionWorld} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
const result=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
const run=randomUUID();
it.each(narrativeWorldKinds)('does not use a genuine bread receipt to authorize invented or name-prefix consumption in %s',async kind=>{
 const {save}=await consumptionWorld(kind),turn=executeAction(save,{type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}},randomUUID()),receipt=turn.save.resolution_receipts!.at(-1)!;
 const candidates=['你吃掉了一份虚构饼干。','你吃掉了1份面包票。'];
 const decisions=candidates.map(text=>{try{validateResolvedNarrative(receipt,result(text),false,undefined,turn.save);return {text,accepted:true};}catch(error){return {text,accepted:false,error:String(error)};}});
 await writeFile(`.agent-runtime/codex/consumption-unknown-${run}-${kind}.json`,JSON.stringify({turn,decisions},null,2));
 expect(decisions.every(d=>!d.accepted)).toBe(true);
 for(const text of ['你吃掉了一份面包。','你吃掉了一份面包后擦了擦嘴。','你吃了点苦。','你仿佛吃掉了一份苦涩。'])
  expect(()=>validateResolvedNarrative(receipt,result(text),false,undefined,turn.save)).not.toThrow();
 const quoted={...result('林舟说：“你吃掉了一份虚构饼干。”'),scene_beats:[{kind:'speech' as const,speaker_id:'npc_lin',utterance:'你吃掉了一份虚构饼干。'}]};
 expect(()=>validateResolvedNarrative(receipt,quoted,false,undefined,turn.save)).not.toThrow();
 expect(()=>validateResolvedNarrative(receipt,{...quoted,narrative:quoted.narrative+candidates[0]},false,undefined,turn.save)).toThrow();
},30000);

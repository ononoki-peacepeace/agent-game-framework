import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {AIRuntime} from '../src/ai/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {physicalNarrativeFallback} from '../src/core/narrative-firewall.js';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
it.each(narrativeWorldKinds)('retains exact settlement context while refining %s',async kind=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save);let n=0;
 const turn=executeFreeform(save,'尝试打击林舟',{narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'身体尝试',
   stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>[.99,.01,.01,.99][n++]);
 const receipt=turn.save.resolution_receipts!.at(-1)!,first=physicalNarrativeFallback(turn.save,receipt,false).narrative;
 turn.save.narrative_history=[{request_id:randomUUID(),location_id:'square',time:save.runtime.time,narrative:first,speaker:null,dialogue:null,facts:[]}];
 const payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'offline-refinement-settlement',generate:async request=>{payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  return {data:{narrative:first,speaker:null,dialogue:null,choices:[],patches:[]}};}});
 await ai.narrate(turn.save,turn.action,turn.facts,receipt,undefined,[receipt]);
 await mkdir('.agent-runtime/codex/refinement-outcomes',{recursive:true});await writeFile(`.agent-runtime/codex/refinement-outcomes/${kind}.json`,JSON.stringify({input:'尝试打击林舟',receipt,first,payloads},null,2));
 expect(payloads).toHaveLength(2);
 expect(payloads[1].fixed_outcome.resolution_receipt).toEqual(payloads[0].resolution_receipt);
 expect(payloads[1].fixed_outcome.significant_incidents).toEqual(payloads[0].significant_incidents);
 expect(payloads[1].fixed_outcome.resolution_receipt.outcome).toBe('partial_success');
},30000);

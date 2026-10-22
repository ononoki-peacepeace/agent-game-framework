import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {prepareNarrativeWorld,narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {executeFreeform} from '../src/core/freeform.js';
import {physicalNarrativeFallback,validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {narrativeResultSchema} from '../src/ai/contracts.js';

afterEach(()=>vi.restoreAllMocks());
const variants=[
 {form:'strike',input:'打击林舟',kind:'harm',rolls:[.01,.99],contact:false,harmed:false,control:false,word:'击'},
 {form:'push',input:'推搡林舟',kind:'harm',rolls:[.99,.01,.01,.99],contact:true,harmed:false,control:false,word:'推'},
 {form:'strike',input:'打击林舟',kind:'harm',rolls:[.99,.01,.99,.01],contact:true,harmed:true,control:false,word:'击'},
 {form:'restrain',input:'抓住林舟',kind:'restrain',rolls:[.99,.01,.99,.01],contact:true,harmed:false,control:true,word:'控制'},
] as const;
const cases=narrativeWorldKinds.flatMap(kind=>variants.map((variant,index)=>({kind,variant,index})));
it.each(cases)('renders receipt-supported action and result: $kind/$index',async({kind,variant:v,index})=>{
 const save=structuredClone((await prepareNarrativeWorld(kind)).save);
 save.entities.find(e=>e.id==='npc_lin')!.components.condition={hp:100,stamina:100,stress:0};
 const before=structuredClone(save);let roll=0;
 const turn=executeFreeform(save,v.input,{narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:v.kind,source_quote:v.input,contact_stage_id:'contact',injury_stage_id:v.kind==='harm'?'result':null,harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'身体动作',
   stages:[{id:'contact',band:'normal'},{id:'result',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>v.rolls[roll++%v.rolls.length],false,
  {target_ids:['npc_lin'],physical_intent:{forms:[v.form],source_quote:v.input}});
 const receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(receipt.physical_outcome).toMatchObject({contact:v.contact,harmed:v.harmed,control_established:v.control,action_forms:[v.form]});
 const settled=structuredClone(turn.save),output=physicalNarrativeFallback(turn.save,receipt,false);
 const payloads:Record<string,any>[]=[];
 const ai=new AIRuntime({name:'offline-authored-contract',generate:async request=>{payloads.push(JSON.parse(request.prompt.split('\n\n').at(-1)!));
  return {data:{...output,speaker:null,dialogue:null,choices:[],patches:[]}};}});
 await ai.narrate(turn.save,turn.action,turn.facts,receipt);
 await mkdir('.agent-runtime/codex/outcomes',{recursive:true});
 await writeFile(`.agent-runtime/codex/outcomes/${kind}-${index}.json`,JSON.stringify({input:v.input,before,after:turn.save,receipt,output,payloads},null,2));
 expect(output.narrative).toContain(v.word);
 expect(output.narrative).not.toMatch(/发起了尝试|未能建立接触|已确认|结算|没有达到预期/);
 expect(output.narrative).not.toMatch(/躲开|闪避|挡住|反击|踉跄|流血|骨折/);
 expect(()=>validateResolvedNarrative(receipt,narrativeResultSchema.parse({...output,speaker:null,dialogue:null,choices:[],patches:[]}),false,undefined,turn.save)).not.toThrow();
 expect(save).toEqual(before);expect(turn.save).toEqual(settled);
 expect(payloads[0].significant_incident.presentation).toMatchObject({forms:[v.form],contact:v.contact,harmed:v.harmed,control_established:v.control,cause:null});
},30000);

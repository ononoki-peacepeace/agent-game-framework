import {readFile,writeFile} from 'node:fs/promises';
import {AIRuntime} from '../src/ai/runtime.js';
import {validateResolvedNarrative,validateScenePresenceNarrative} from '../src/core/narrative-firewall.js';
const root='.tmp/qa-immediate-real-1792133500721';
const report=JSON.parse(await readFile(root+'/report.json','utf8')),save=JSON.parse(await readFile(root+'/current.json','utf8'));
const receipt=save.resolution_receipts.find((r:any)=>r.repetition);if(!receipt.effects.includes('time'))receipt.effects.push('time');
const checks=[];
for(const [index,output] of report.outputs.filter((o:any)=>o.stage==='narrator').entries()){
  const ai=new AIRuntime({name:'fixture',generate:async()=>({data:output.data})});
  try{const r=await ai.narrate(structuredClone(save),{type:'FREEFORM_ACTION',parameters:{},actor_id:save.player_state.entity_id,id:receipt.action_id,source:'ai',time_cost:receipt.time_cost},receipt.canonical_facts,receipt);
    validateResolvedNarrative(receipt,r,false);validateScenePresenceNarrative(save,r.narrative,r.presence_claims);checks.push({index,valid:true});
  }catch(e){checks.push({index,valid:false,error:(e as Error).message});}
}
await writeFile(root+'/recorded-revalidation.json',JSON.stringify({note:'No Provider calls; revalidation of recorded real drafts after the sub-minute receipt fix',checks},null,2));console.log(JSON.stringify(checks));

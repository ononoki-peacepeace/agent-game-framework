import {readFile,writeFile} from 'node:fs/promises';
import {narrativeResultSchema} from '../src/ai/contracts.js';
import {validateScenePresenceNarrative,validateResolvedNarrative} from '../src/core/narrative-firewall.js';
const root='.tmp/qa-final-narrator-real-1792186064938';
const r=JSON.parse(await readFile(root+'/report.json','utf8')),save=JSON.parse(await readFile(root+'/current.json','utf8'));
const results=[];let index=0;
for(const x of r.outputs.filter((o:any)=>o.stage==='narrator')){
 const result=narrativeResultSchema.parse(x.data),errors=[];
 try{validateScenePresenceNarrative(save,result.narrative,result.presence_claims);}catch(e){errors.push({stage:'presence',reason:(e as Error).message});}
 if(index===0)try{validateResolvedNarrative(r.turns[0].receipts.at(-1),result,false);}catch(e){errors.push({stage:'resolved',reason:(e as Error).message});}
 results.push({draft:index++,errors});
}
await writeFile(root+'/draft-audit.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));

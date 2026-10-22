import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {narrativeWorldKinds,prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {validateSave} from '../src/core/state.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import type {SavePackage} from '../src/core/schema.js';
const result=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
async function twoPapers(kind:typeof narrativeWorldKinds[number]){
 const {save}=await prepareNarrativeWorld(kind);
 const other=structuredClone(save.entities.find(entity=>entity.id==='qa_paper')!);other.id='qa_other_paper';
 save.entities.push(other);return validateSave(save);
}
const act=(save:SavePackage,item:string,to:'player'|'npc_lin'|'held')=>executeAction(save,to==='held'?
 {type:'MOVE_ITEM',parameters:{item_id:item,to}}:{type:'TRANSFER_ITEM',target_id:to,parameters:{item_id:item}},randomUUID()).save;
const inventory=(save:SavePackage)=>structuredClone(save.entities.find(entity=>entity.id==='player')!.components.inventory!);
const check=(save:SavePackage,text:string,states:ReturnType<typeof inventory>[]=[])=>(()=>validateResolvedNarrative(save.resolution_receipts!.at(-1)!,result(text),false,undefined,save,false,states));
const run=randomUUID();
it.each(narrativeWorldKinds)('accepts each actual holder when identical item names refer to different entities in %s',async kind=>{
 const seed=await twoPapers(kind),first=act(seed,'qa_paper','held'),both=act(first,'qa_other_paper','held'),split=act(both,'qa_other_paper','npc_lin');
 const candidates=['你仍然拿着纸片。','林舟仍然拿着纸片。','你持有一张纸片。','林舟持有一张纸片。'];
 const decisions=candidates.map(text=>{try{check(split,text)();return {text,accepted:true};}catch(error){return {text,accepted:false,error:String(error)};}});
 await writeFile(`.agent-runtime/codex/pr3-name-split-${run}-${kind}.json`,JSON.stringify({seed,first,both,split,decisions},null,2));
 for(const decision of decisions)expect(decision,decision.text).toMatchObject({accepted:true});
 expect(check(split,'你持有两张纸片。')).toThrow();expect(check(split,'林舟持有两张纸片。')).toThrow();
 expect(check(split,'你没有拿着纸片。')).toThrow();expect(check(split,'林舟没有拿着纸片。')).toThrow();
 const away=act(split,'qa_paper','npc_lin');expect(check(away,'你没有拿着纸片。')).not.toThrow();
 expect(check(away,'林舟持有两张纸片。')).not.toThrow();
},30000);
it.each(narrativeWorldKinds)('compares same-name quantities within each settled image rather than each item independently in %s',async kind=>{
 const first=act(await twoPapers(kind),'qa_paper','held'),both=act(first,'qa_other_paper','held'),split=act(both,'qa_other_paper','npc_lin');
 expect(check(both,'你持有两张纸片。')).not.toThrow();
 const states=[first,both,split].map(inventory);
 expect(check(split,'你持有两张纸片，随后交出其中一张。',states)).not.toThrow();
 expect(check(split,'你现在持有两张纸片。',states)).toThrow();
 expect(check(split,'你持有三张纸片。',states)).toThrow();
 // Each entity was held, but never together in these two actual images.
 const onlyOther=act(act(first,'qa_paper','npc_lin'),'qa_other_paper','held');
 expect(check(onlyOther,'你持有两张纸片。',[inventory(first),inventory(onlyOther)])).toThrow();
},30000);

it.each(narrativeWorldKinds)('commits legal same-name narration and rejects false counts with fresh-store exact replay in %s',async kind=>{
 const both=act(act(await twoPapers(kind),'qa_paper','held'),'qa_other_paper','held');
 const seed=act(both,'qa_other_paper','npc_lin'),directory=await mkdtemp(join(tmpdir(),'agf-pr3-name-review-'));
 try{
  const store=new JsonStore(directory);await store.write(seed);
  let candidate='你仍然拿着纸片，林舟仍然拿着纸片。',calls=0;
  const ai=new AIRuntime({name:'offline-pr3-independent-review',generate:async request=>{
   calls++;
   if(request.role==='narrator')return {data:result(candidate)};
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded)return {data:{grounded:true,reports_result:true,reason:'Fixed offline audit; no model or human quality claim',unsupported_claims:[]}};
   throw Error('Unexpected offline stage');
  }});
  let service=new GameService(store,ai,seed.definition);
  for(const legal of [true,false]){
   if(!legal)candidate='你现在持有两张纸片。';
   const before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{}}};
   const response=await service.turn(body),after=await service.current();
   const receipt=after.resolution_receipts!.find(entry=>entry.request_id===body.request_id)!;
   const bytes=await readFile(join(directory,'current.json')),count=calls;
   await writeFile(`.agent-runtime/codex/pr3-name-service-${run}-${kind}-${legal}.json`,JSON.stringify({body,before,after,response,receipt,candidate,calls},null,2));
   expect(receipt.commit_status).toBe('committed');expect(after.state_revision).toBe(before.state_revision+1);
   expect(after.entities).toEqual(before.entities);
   expect(after.last_turn!.presentation?.status).toBe(legal?'normal':'degraded');
   if(legal)expect(after.last_turn!.narrative).toBe(candidate);else expect(after.last_turn!.narrative).not.toBe(candidate);
   const fresh=new GameService(new JsonStore(directory),ai,seed.definition);
   expect(await fresh.turn(body)).toEqual(response);expect(await fresh.current()).toEqual(after);
   expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(calls).toBe(count);service=fresh;
  }
 }finally{await rm(directory,{recursive:true,force:true});}
},60000);

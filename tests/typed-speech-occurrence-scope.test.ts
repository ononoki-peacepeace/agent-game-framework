import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {executeAction} from '../src/core/runtime.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const utterance='拿起纸片',speech={kind:'speech' as const,speaker_id:'npc_lin',utterance};
const narration=(narrative:string,twice=false)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
 interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],scene_beats:twice?[speech,speech]:[speech]});
const pairs=[['“','”'],['「','」'],['『','』'],['"','"']] as const;
async function fixture(){
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};
 save.entities.push({id:'qa_paper',type:'item',components:{identity:{name:'纸片',description:'已登记的纸片',avatar_id:null},
  location:{location_id:'square'},item:{weight:.01,stackable:false,tracking:'tracked'},discovery:{known_to_player:true}}});
 return {...f,save};
}
it.each(pairs)('does not exempt a second emphasized world action after one typed speech (%s%s)',async(open,close)=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID());
 const text=`林舟：${open}${utterance}${close}。随后你${open}${utterance}${close}。`;
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text),false,undefined,turn.save)).toThrow();
});
it('does not mask a later mechanical occurrence just because it uses a different quotation style',async()=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID());
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(`林舟：“${utterance}”。随后你"${utterance}"。`),false,undefined,turn.save)).toThrow();
});
it.each(['你拿起纸片','你拿起纸片。'])('does not mask an unquoted world action at the end (%s)',async text=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID());
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text),false,undefined,turn.save)).toThrow();
});
it.each(pairs)('preserves the one actual typed speech and a non-action control (%s%s)',async(open,close)=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID()),before=structuredClone(turn.save);
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(`林舟：${open}${utterance}${close}。你没有拿起纸片。`),false,undefined,turn.save)).not.toThrow();
 expect(turn.save).toEqual(before);
});
it('allows two separately typed repeated utterances without exempting a third world assertion',async()=>{
 const f=await fixture(),turn=executeAction(f.save,{type:'INSPECT',parameters:{}},randomUUID());
 const text=`林舟：“${utterance}”。林舟："${utterance}"。`;
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text,true),false,undefined,turn.save)).not.toThrow();
 expect(()=>validateResolvedNarrative(turn.save.resolution_receipts!.at(-1)!,narration(text+`你“${utterance}”。`,true),false,undefined,turn.save)).toThrow();
});
it.each([true,false])('keeps exact typed-speech scope through disk settlement/replay (legal=%s)',async valid=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-typed-occurrence-'));try{
  const f=await fixture(),candidate=narration(`林舟：“${utterance}”。`+(valid?'你没有拿起纸片。':`随后你“${utterance}”。`)+'暂时没有新的发现。');
  let narrations=0,audits=0;const ai=new AIRuntime({name:'offline-typed-occurrence',generate:async request=>{
   if(request.role==='narrator'){narrations++;return {data:candidate};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded){audits++;return {data:{grounded:true,reports_result:true,
    reason:'固定离线审核；不能授权物品移动',unsupported_claims:[]}};}
   throw Error('Unexpected offline stage');
  }});
  const store=new JsonStore(directory);await store.write(f.save);const service=new GameService(store,ai,f.save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{}}};
  const result=await service.turn(request),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['INSPECT']);expect(narrations).toBe(valid?1:3);expect(audits).toBe(valid?1:0);
  expect(after.last_turn?.presentation?.status).toBe(valid?'normal':'degraded');
  if(valid)expect(after.last_turn?.narrative).toBe(candidate.narrative);else expect(after.last_turn?.narrative).not.toBe(candidate.narrative);
  const calls=ai.metrics.requests,fresh=new GameService(new JsonStore(directory),ai,f.save.definition);
  expect(await fresh.turn(request)).toEqual(result);expect(await fresh.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});

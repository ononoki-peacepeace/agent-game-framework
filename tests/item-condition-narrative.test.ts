import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {executeAction} from '../src/core/runtime.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
const cases=[
 {condition:'intact',text:'纸片仍然完好。',legal:true},
 {condition:'damaged',text:'纸片已经受损。',legal:true},
 {condition:'destroyed',text:'纸片已经损毁。',legal:true},
 {condition:'intact',text:'纸片已经损毁。',legal:false},
 {condition:'damaged',text:'纸片仍然完好。',legal:false},
 {condition:'destroyed',text:'纸片已经恢复完好。',legal:false},
] as const;
it.each(cases)('grounds $condition item prose through disk INSPECT/restart/replay (legal=$legal)',async sample=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-item-condition-prose-'));try{
  const save=newSave(demo);save.definition.events=[];
  save.entities.push({id:'qa_paper',type:'item',components:{identity:{name:'纸片',description:'已有物品',avatar_id:null},
   location:{location_id:'square'},item:{weight:.01,stackable:false,tracking:'tracked',condition:sample.condition},
   discovery:{known_to_player:true}}});
  let narrations=0,audits=0;const text=sample.text+'暂时没有新的发现。';
  const ai=new AIRuntime({name:'offline-item-condition',generate:async request=>{
   if(request.role==='narrator'){narrations++;return {data:{narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],
    patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};}
   if((request.schema as {properties?:Record<string,unknown>}).properties?.grounded){audits++;return {data:{grounded:true,
    reports_result:true,reason:'离线审核不能覆盖Core物品状态',unsupported_claims:[]}};}
   throw Error('Unexpected offline stage');
  }});
  const store=new JsonStore(directory);await store.write(save);const service=new GameService(store,ai,save.definition),before=await service.current();
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),action:{type:'INSPECT',parameters:{}}};
  const response=await service.turn(request),after=await service.current();
  expect(after.entities).toEqual(before.entities);expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);
  expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['INSPECT']);
  expect(narrations).toBe(sample.legal?1:3);expect(audits).toBe(sample.legal?1:0);
  expect(after.last_turn?.presentation?.status).toBe(sample.legal?'normal':'degraded');
  if(sample.legal)expect(after.last_turn?.narrative).toBe(text);else expect(after.last_turn?.narrative).not.toBe(text);
  const bytes=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;
  const fresh=new GameService(new JsonStore(directory),ai,save.definition);
  expect(await fresh.turn(request)).toEqual(response);expect(await fresh.current()).toEqual(after);
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('keeps typed retelling, denial, and a separate item subject distinct from a state assertion',()=>{
 const save=newSave(demo);save.definition.events=[];
 for(const [id,name,condition] of [['paper','纸片','damaged'],['key','钥匙','intact']] as const)
  save.entities.push({id,type:'item',components:{identity:{name,description:'已有物品',avatar_id:null},location:{location_id:'square'},
   item:{weight:.01,stackable:false,tracking:'tracked',condition},discovery:{known_to_player:true}}});
 const turn=executeAction(save,{type:'INSPECT',parameters:{}},randomUUID()),receipt=turn.save.resolution_receipts!.at(-1)!;
 const result=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],scene_beats:[{kind:'speech' as const,speaker_id:'npc_lin',utterance:'纸片已经完好'}]});
 for(const text of ['林舟：“纸片已经完好”。纸片已经受损。','纸片并未恢复完好。钥匙仍然完好。',
  '你记得纸片曾经完好。纸片现在受损。'])
  expect(()=>validateResolvedNarrative(receipt,result(text),false,undefined,turn.save)).not.toThrow();
 for(const text of ['林舟：“纸片已经完好”。纸片已经完好。','钥匙仍然完好。纸片已经完好。',
  '纸片没有受损。','纸片并非没有损毁。'])
  expect(()=>validateResolvedNarrative(receipt,result(text),false,undefined,turn.save)).toThrow();
});

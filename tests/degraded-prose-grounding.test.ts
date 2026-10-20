import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sparseSetup} from './sparse-fixture.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import * as freeform from '../src/core/freeform.js';
import type {ActionInput} from '../src/shared/contracts.js';

afterEach(()=>vi.restoreAllMocks());
const manifest=JSON.parse(await readFile(new URL('../docs/degraded-prose-acceptance.v1.json',import.meta.url),'utf8')) as {
 cases:('talk'|'move'|'observe'|'physical_failure'|'physical_success'|'wait')[];provider_failures:('refusal'|'content_filter')[]};
const matrix=manifest.cases.flatMap(scene=>manifest.provider_failures.map(reason=>({scene,reason})));
it.each(matrix)('keeps $scene degradation factual and readable after $reason',async({scene,reason})=>{
 const mock=new MockAIAdapter(),f=await sparseSetup(request=>mock.generate(request)),save=await f.service.current();
 save.definition.events=[];save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 const player=save.entities.find(e=>e.id==='player')!,target=save.entities.find(e=>e.id==='npc_lin')!;
 player.components.location={location_id:'square'};target.components.location={location_id:'square'};
 target.components.condition={hp:100,stamina:100,stress:0};
 for(const entity of save.entities)if(entity.components.character&&entity.id!=='player'&&entity.id!=='npc_lin')entity.components.location={location_id:'station'};
 save.gm_state.notes='PRIVATE_FALLBACK_SECRET';await f.store.write(save);
 vi.spyOn(f.ai,'npcDecision').mockResolvedValue({kind:'speech',speech:'先停一下。',vote_target:null,intent:'表达本人的意愿',proposed_action:null,evidence_refs:[],
  belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'只说这句话',social_response:null});
 const narrate=vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError(reason,'controlled offline fixture','绘景未完成'));
 const original=freeform.executeFreeform,physical=scene.startsWith('physical');
 vi.spyOn(freeform,'executeFreeform').mockImplementation((...args)=>{
  const values=physical?(scene==='physical_success'?[.99,.01]:[.01,.99]):[.99];
  let i=0;args[4]=()=>values[i++%values.length];return original(...args);
 });
 const free=vi.spyOn(f.ai,'freeform');
 if(physical)free.mockResolvedValue({narrative:'身体尝试候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
   stakes:'先尝试接触，再尝试造成伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}} as never);
 else if(scene==='observe')free.mockResolvedValue({narrative:'观察候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,
  required_conditions:[],resolution:{type:'SIMPLE_CHECK',domain:'perception',band:'normal',visibility:'public',stakes:'观察当前房间',stages:[],evidence_ids:[]}} as never);
 const action:ActionInput=scene==='talk'?{type:'TALK',target_id:'npc_lin',parameters:{topic:'向你问好'}}:
  scene==='move'?{type:'MOVE',target_id:'market',parameters:{}}:{type:'WAIT',parameters:{minutes:3}};
 const request={game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID(),
  ...(physical?{input:'尝试打击林舟'}:scene==='observe'?{input:'观察当前房间'}:{action})};
 const run=()=>f.service.turn(request,undefined,undefined,undefined,false,undefined,undefined,physical||scene==='observe');
 await run();const after=await f.service.current(),prose=after.last_turn!.narrative;
 expect(prose).not.toMatch(/按规则|程序|系统|回执|版本|结算|生成|已经保存|来得及写出来/);
 expect(prose).not.toContain('PRIVATE_FALLBACK_SECRET');expect(prose.trim().length).toBeGreaterThan(4);
 expect(prose).toMatchSnapshot();
 expect(after.last_turn!.presentation?.status).toBe('degraded');expect(after.state_revision).toBe(save.state_revision+1);
 expect(after.last_turn!.dialogue).toBeNull();expect(narrate).toHaveBeenCalledOnce();
 const receipt=after.resolution_receipts?.find(r=>r.request_id===request.request_id);
 if(scene==='move'){
  const location=after.entities.find(e=>e.id==='player')!.components.location!.location_id;
  expect(location).toBe('market');expect(prose).toContain(after.definition.map!.locations.find(l=>l.id===location)!.name);
 }else if(scene==='talk'){
  expect(prose).toContain('林舟');expect(prose).not.toMatch(/答应|同意|微笑|点头/);
 }else if(scene==='observe')expect(prose).toMatch(/观察|查看/);
 else if(scene==='wait')expect(prose).toMatch(/等|停留/);
 else{
  expect(receipt?.physical_outcome?.contact).toBe(scene==='physical_success');
  expect(receipt?.physical_outcome?.harmed).toBe(scene==='physical_success');
  expect(prose).toContain('林舟');expect(prose).toMatch(scene==='physical_success'?/伤害/:/未能|没能/);
  expect(after.last_turn!.scene_beats?.some(beat=>beat.kind==='speech'&&beat.utterance==='先停一下。')).toBe(true);
 }
 await run();expect(await f.store.read()).toEqual(after);expect(narrate).toHaveBeenCalledOnce();
});

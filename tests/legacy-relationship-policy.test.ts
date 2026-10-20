import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {executeFreeform} from '../src/core/freeform.js';
import {settleRelationshipOutcomes} from '../src/agent/npc-relations.js';
import {previewLegacyRelationshipPolicies,activateLegacyRelationshipPolicies} from '../src/agent/relationship-policy.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {worldImage} from '../src/core/turn-history.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {withInputRecovery} from '../src/recovery/request-context.js';

afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const world=structuredClone(demo);world.events=[];world.ruleset.relationship_dimensions={legacy_value:{min:0,max:10,initial:5},other_value:{min:-10,max:10,initial:0}};
 for(const entity of world.entities)delete entity.components.relationships;
 const initial=newSave(world),turn=executeAction(initial,{type:'TALK',target_id:'npc_lin',parameters:{topic:'先前问候'}},randomUUID());
 const save=turn.save,receipt=save.resolution_receipts!.at(-1)!;receipt.commit_status='committed';delete receipt.result_entities!.relationship_settlement;
 const state=emptyNpcAgentState();state.goals=[{id:'long_goal',description:'维持已有安排',horizon:'long',status:'active',origin:'fixture',priority:5}];
 state.plans=[{id:'old_plan',goal_id:'long_goal',intention:'原有计划',status:'active',execution:{steps:[{type:'HOLD',target_id:null,description:'已有准备',duration_minutes:2,speech:null}],cursor:0,not_before:null,condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:1,last_request_id:null,blocked_reason:'core_rejected'}}];
 save.npc_agent_state={npc_lin:state};save.gm_state.notes='PRIVATE_LEGACY_POLICY_NOTE';
 return {save:validateSave(save),oldAction:turn.action};
}
const policy={legacy_value:{contact:1,conflict:-1,harmed:-2}};
const value=(save:ReturnType<typeof fixture>['save'],from='player',to='npc_lin')=>
 ((save.entities.find(e=>e.id===from)!.components.relationships?.entries as Record<string,Record<string,number>>|undefined)?.[to]?.legacy_value??5);
const noGeneration=()=>new AIRuntime({name:'no-generation',generate:async()=>{throw Error('Policy activation must not generate');}});
async function setup(){
 const f=fixture(),store=new MemoryStore();await store.write(f.save);const ai=noGeneration(),service=new GameService(store,ai,f.save.definition),before=await service.current();
 const preview=previewLegacyRelationshipPolicies(before,policy),request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 return {...f,store,ai,service,before,preview,request};
}
it('keeps missing legacy policy and all world state unchanged on read and restart',async()=>{
 const f=await setup();expect(await f.service.current()).toEqual(f.before);
 const restarted=new GameService(f.store,noGeneration(),f.before.definition);expect(await restarted.current()).toEqual(f.before);
 expect(f.before.definition.ruleset.relationship_dimensions.legacy_value.event_deltas).toBeUndefined();expect(value(f.before)).toBe(5);expect(f.ai.metrics.requests).toBe(0);
});
it('previews only explicit policies and old unmarked receipts without changing the source or exposing world prose',async()=>{
 const f=await setup(),image=structuredClone(f.before),preview=previewLegacyRelationshipPolicies(f.before,policy);
 expect(preview.processed_receipt_ids).toEqual([f.oldAction.id]);expect(preview.policies).toEqual(policy);expect(JSON.stringify(preview)).not.toContain('PRIVATE_LEGACY_POLICY_NOTE');expect(f.before).toEqual(image);
});
it('activates prospectively in one image while preserving numeric relationships, cognition, resources, time and plan cursors',async()=>{
 const f=await setup();await activateLegacyRelationshipPolicies(f.service,f.request,f.preview);const after=await f.service.current(),expected=structuredClone(f.before);
 expected.definition.ruleset.relationship_dimensions.legacy_value.event_deltas=policy.legacy_value;
 expected.resolution_receipts!.find(r=>r.request_id===f.oldAction.id)!.result_entities!.relationship_settlement=['v1'];
 expect(worldImage(after)).toEqual(worldImage(expected));expect(after.ai).toEqual(f.before.ai);expect(after.state_revision).toBe(f.before.state_revision+1);
 expect(after.runtime.receipts.filter(r=>r.id===f.request.request_id)).toHaveLength(1);expect(settleRelationshipOutcomes(after,f.oldAction)).toEqual(after);
 const next=executeAction(after,{type:'TALK',target_id:'npc_lin',parameters:{topic:'政策启用后的新问候'}},randomUUID());
 expect(value(next.save)).toBe(6);expect(value(next.save,'npc_lin','player')).toBe(6);expect(settleRelationshipOutcomes(next.save,next.action)).toEqual(next.save);expect(f.ai.metrics.requests).toBe(0);
});
it('preserves existing settlement markers through activation and omits unrelated receipts from the preview',async()=>{
 const {save}=fixture(),marked=structuredClone(save.resolution_receipts![0]);marked.request_id=marked.action_id=randomUUID();marked.result_entities!.relationship_settlement=['v1','legacy'];
 const wait=executeAction(save,{type:'WAIT',parameters:{minutes:1}},randomUUID()).save;wait.resolution_receipts!.push(marked);
 const preview=previewLegacyRelationshipPolicies(wait,policy);expect(preview.processed_receipt_ids).toEqual([save.resolution_receipts![0].request_id]);
 const store=new MemoryStore();await store.write(wait);const service=new GameService(store,noGeneration(),wait.definition),before=await service.current();
 await activateLegacyRelationshipPolicies(service,{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},previewLegacyRelationshipPolicies(before,policy));
 expect((await service.current()).resolution_receipts!.find(r=>r.request_id===marked.request_id)!.result_entities!.relationship_settlement).toEqual(['v1','legacy']);
});
it.each([{}, {unknown_value:{contact:1}}, {legacy_value:{contact:3}}, {legacy_value:{contact:1,unrecognized:1}}])('rejects an absent, unknown or invalid author selection without changing state: %j',selection=>{
 const {save}=fixture(),before=structuredClone(save);expect(()=>previewLegacyRelationshipPolicies(save,selection)).toThrow();expect(save).toEqual(before);
});
it('refuses preexisting policy and unknown marker versions instead of silently overwriting them',()=>{
 const {save}=fixture();save.definition.ruleset.relationship_dimensions.other_value.event_deltas={contact:0};expect(()=>previewLegacyRelationshipPolicies(save,policy)).toThrow('旧世界');
 delete save.definition.ruleset.relationship_dimensions.other_value.event_deltas;save.resolution_receipts![0].result_entities!.relationship_settlement=['v2'];
 expect(()=>previewLegacyRelationshipPolicies(save,policy)).toThrow('未知版本');
});
it('rejects a stale same-revision image or tampered preview before a write',async()=>{
 const f=await setup(),tampered={...f.preview,processed_receipt_ids:[]},writes=vi.spyOn(f.store,'write');
 await expect(activateLegacyRelationshipPolicies(f.service,f.request,tampered)).rejects.toThrow('预览内容');expect(writes).not.toHaveBeenCalled();
 const changed=structuredClone(f.before);changed.gm_state.notes+=' changed';await f.store.write(changed);writes.mockClear();
 await expect(activateLegacyRelationshipPolicies(f.service,f.request,f.preview)).rejects.toThrow('世界已改变');expect(writes).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(changed);
});
it('rejects changed game/revision/request identity and duplicate changed policy',async()=>{
 const f=await setup();await expect(activateLegacyRelationshipPolicies(f.service,{...f.request,game_id:randomUUID()},f.preview)).rejects.toThrow('身份');
 await expect(activateLegacyRelationshipPolicies(f.service,{...f.request,expected_revision:f.request.expected_revision+1},f.preview)).rejects.toThrow('身份');
 await activateLegacyRelationshipPolicies(f.service,f.request,f.preview);
 await expect(activateLegacyRelationshipPolicies(f.service,f.request,{...f.preview,policies:{legacy_value:{contact:2}}})).rejects.toThrow('请求 ID');
});
it('rejects an old preview after another actual transaction advanced the revision',async()=>{
 const f=await setup();await f.service.agentTransaction({...f.request,request_id:randomUUID()},{fixture:'another edit'},save=>{save.gm_state.flags.other_change=true;});
 const changed=await f.service.current();await expect(activateLegacyRelationshipPolicies(f.service,f.request,f.preview)).rejects.toThrow('状态已更新');expect(await f.service.current()).toEqual(changed);
});
it('stops before world mutation when the existing prepare journal cannot persist',async()=>{
 const f=await setup(),writes=vi.spyOn(f.store,'write');
 await expect(withInputRecovery({game_id:f.before.game_id,recovery:{original_player_input:'显式启用离线政策',trace_id:'legacy-policy',transactions:[]},persist:async()=>{throw Error('prepare journal failed');}},()=>activateLegacyRelationshipPolicies(f.service,f.request,f.preview))).rejects.toThrow('prepare journal failed');
 expect(writes).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(f.before);
});
it.each(['before','after'] as const)('recovers disk activation after a %s-write failure without retroactive or repeated changes',async point=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-legacy-policy-'));
 try{
  const {save,oldAction}=fixture(),store=new JsonStore(directory);await store.write(save);const ai=noGeneration(),service=new GameService(store,ai,save.definition),before=await service.current(),preview=previewLegacyRelationshipPolicies(before,policy),request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const write=store.write.bind(store),fault=vi.spyOn(store,'write').mockImplementation(async(candidate,slot)=>{if(point==='after')await write(candidate,slot);throw Error('activation response lost');});
  await expect(activateLegacyRelationshipPolicies(service,request,preview)).rejects.toThrow('activation response lost');fault.mockRestore();
  const persisted=(await new JsonStore(directory).read())!;expect(persisted.state_revision).toBe(before.state_revision+(point==='after'?1:0));
  const restarted=new GameService(new JsonStore(directory),ai,before.definition);await activateLegacyRelationshipPolicies(restarted,request,preview);const after=await restarted.current(),bytes=await readFile(join(directory,'current.json'));
  await activateLegacyRelationshipPolicies(restarted,request,preview);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(await restarted.current()).toEqual(after);expect(after.state_revision).toBe(before.state_revision+1);
  expect(settleRelationshipOutcomes(after,oldAction)).toEqual(after);expect(value(after)).toBe(5);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('Undo restores policy and old markers while original activation replay remains read-only',async()=>{
 const f=await setup();await activateLegacyRelationshipPolicies(f.service,f.request,f.preview);const committed=await f.service.current();
 await f.service.undo({game_id:committed.game_id,expected_revision:committed.state_revision,request_id:randomUUID()});const undone=await f.service.current();
 expect(worldImage(undone)).toEqual(worldImage(f.before));await activateLegacyRelationshipPolicies(f.service,f.request,f.preview);expect(await f.service.current()).toEqual(undone);
});
it.each([0,10])('clamps new authored deltas at the %i bound without changing activation values',async bound=>{
 const f=await setup();f.before.entities.find(e=>e.id==='player')!.components.relationships={entries:{npc_lin:{legacy_value:bound}}};await f.store.write(f.before);
 const preview=previewLegacyRelationshipPolicies(f.before,{legacy_value:{contact:bound===0?-2:2}});await activateLegacyRelationshipPolicies(f.service,f.request,preview);const after=await f.service.current();expect(value(after)).toBe(bound);
 const next=executeAction(after,{type:'TALK',target_id:'npc_lin',parameters:{topic:'新事件'}},randomUUID()).save;expect(value(next)).toBe(bound);
});
function physicalTurn(source:ReturnType<typeof fixture>['save']){
 const save=structuredClone(source);save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};save.npc_agent_state={};
 for(const id of ['player','npc_lin']){const actor=save.entities.find(e=>e.id===id)!;actor.components.scene_position={label:'桌旁'};actor.components.condition={hp:100,stamina:100,stress:0};}
 let roll=0;return executeFreeform(save,'尝试打击林舟',{narrative:'身体尝试候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'尝试打击林舟',contact_stage_id:'contact',injury_stage_id:'contact',harm_level:'minor',surprise_attempt:false},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'接触并尝试伤害',stages:[{id:'contact',band:'normal'}],evidence_ids:[]}},randomUUID(),()=>[.99,.01][roll++%2]);
}
it.each([false,true])('marks an actual old physical receipt prospectively, then respects harmed fallback/explicit zero (zero=%s)',async zero=>{
 const old=physicalTurn(fixture().save),oldReceipt=old.save.resolution_receipts!.at(-1)!;expect(oldReceipt.physical_outcome?.harmed).toBe(true);
 delete oldReceipt.result_entities!.relationship_settlement;oldReceipt.commit_status='committed';
 const store=new MemoryStore();await store.write(old.save);const service=new GameService(store,noGeneration(),old.save.definition),before=await service.current();
 const preview=previewLegacyRelationshipPolicies(before,{legacy_value:{conflict:-1,...(zero?{harmed:0}:{})}});
 expect(preview.processed_receipt_ids).toContain(old.action.id);await activateLegacyRelationshipPolicies(service,{game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()},preview);
 const after=await service.current();expect(settleRelationshipOutcomes(after,old.action)).toEqual(after);expect(value(after)).toBe(5);expect(value(after,'npc_lin','player')).toBe(5);
 const next=physicalTurn(after);expect(next.save.resolution_receipts!.at(-1)!.physical_outcome?.harmed).toBe(true);
 expect(value(next.save)).toBe(4);expect(value(next.save,'npc_lin','player')).toBe(zero?5:4);expect(settleRelationshipOutcomes(next.save,next.action)).toEqual(next.save);
});

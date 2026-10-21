import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {EventBus,type ActionContext} from '../src/core/registry.js';
import {commitTruth} from '../src/narrative/truth.js';
import {publicView,validateSave} from '../src/core/state.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'候选行动',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
 completion_quote:null,required_conditions:[],resolution:{type:'SIMPLE_CHECK' as const,domain:'lifting',band:'normal' as const,
 visibility:'public' as const,stakes:'尝试搬运',stages:[],evidence_ids:[]}};
function timeHook(mutate:(ctx:ActionContext)=>void){
 const original=EventBus.prototype.emit;let calls=0;
 vi.spyOn(EventBus.prototype,'emit').mockImplementation(function(this:EventBus,ctx,event){
  original.call(this,ctx,event);if(event.type==='on_time_advance'&&ctx.action.type==='FREEFORM_ACTION'){calls++;mutate(ctx);}
 });return ()=>calls;
}
it.each([{before:20,after:19,modifier:-2,outcome:'failure'},{before:19,after:20,modifier:0,outcome:'success'}])(
 'uses post-time-hook fatigue $before->$after for a nonviolent check',async({before,after,modifier,outcome})=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 save.definition.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 save.definition.ruleset.capability_domains={lifting:{attribute:'strength',skills:[],condition_sensitive:true,exertion_cost:0}};
 save.entities.find(e=>e.id==='player')!.components.condition!.stamina=before;
 const original=structuredClone(save),calls=timeHook(c=>{c.save.entities.find(e=>e.id==='player')!.components.condition!.stamina=after;});
 const rng=vi.fn(()=>.70),turn=executeFreeform(save,'尝试搬运重物',proposal,randomUUID(),rng),record=turn.save.resolution_history!.at(-1)!;
 expect(calls()).toBe(1);expect(record.spec.actor_modifier).toBe(modifier);expect(record.outcome).toBe(outcome);
 expect(rng).toHaveBeenCalledTimes(1);expect(turn.save.entities.find(e=>e.id==='player')!.components.condition!.stamina).toBe(after);expect(save).toEqual(original);
});
it.each([false,true])('discovers only evidence still accessible at settlement (moved=%s)',async moved=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const here=String(save.entities.find(e=>e.id==='player')!.components.location!.location_id);
 commitTruth(save,{id:'qa_truth',commitment:'HARD_TRUTH',statement:'PRIVATE_CAUSE',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,known_by:[],
  evidence:[{id:'qa_secret',status:'EXISTS',description:'地面留有一串尚未公开的号码',event_ref:null,discovered_by:[],
   placement:{location_id:here,anchor_entity_id:null,scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
 validateSave(save);const original=structuredClone(save),calls=timeHook(c=>{
  if(moved)c.save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0].placement!.location_id='station';
 });
 const turn=executeFreeform(save,'仔细观察四周',{...proposal,resolution:{...proposal.resolution,domain:'perception',discover_facts:true}},randomUUID(),()=>.99);
 const evidence=turn.save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0];
 expect(calls()).toBe(1);expect(evidence.discovered_by.includes('player')).toBe(!moved);
 expect((publicView(turn.save).known_evidence??[]).some(e=>e.id==='qa_secret')).toBe(!moved);
 expect(turn.facts.join(' ').includes(evidence.description)).toBe(!moved);expect(save).toEqual(original);
});
it('can discover pre-existing evidence that becomes accessible during time advancement',async()=>{
 const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
 const here=String(save.entities.find(e=>e.id==='player')!.components.location!.location_id);
 commitTruth(save,{id:'qa_truth',commitment:'HARD_TRUTH',statement:'PRIVATE_CAUSE',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,known_by:[],
  evidence:[{id:'qa_arriving',status:'EXISTS',description:'原先在别处的登记线索',event_ref:null,discovered_by:[],
   placement:{location_id:'station',anchor_entity_id:null,scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
 const original=structuredClone(save),calls=timeHook(c=>{
  c.save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0].placement!.location_id=here;
 });
 const turn=executeFreeform(save,'仔细观察四周',{...proposal,resolution:{...proposal.resolution,domain:'perception',discover_facts:true}},randomUUID(),()=>.99);
 expect(calls()).toBe(1);expect((publicView(turn.save).known_evidence??[]).some(e=>e.id==='qa_arriving')).toBe(true);
 expect(turn.facts.join(' ')).toContain('原先在别处的登记线索');expect(save).toEqual(original);
});
it('persists the live observation and replays it after disk/service recreation without another check or generation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-live-observation-'));try{
  const f=await sparseSetup(),save=await f.service.current();save.definition.events=[];
  const here=String(save.entities.find(e=>e.id==='player')!.components.location!.location_id);
  commitTruth(save,{id:'qa_truth',commitment:'HARD_TRUTH',statement:'PRIVATE_CAUSE',seed_constraint:null,source:'WORLD_CREATION',created_event_ref:null,known_by:[],
   evidence:[{id:'qa_secret',status:'EXISTS',description:'PRIVATE_REMOTE_EVIDENCE',event_ref:null,discovered_by:[],
    placement:{location_id:here,anchor_entity_id:null,scene_scope:null,discoverability:{domain:'perception',difficulty:'normal'}}}]});
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'no-provider',generate:async()=>{throw Error('Unexpected live generation');}});
  const freeform=vi.spyOn(ai,'freeform').mockResolvedValue({...proposal,resolution:{...proposal.resolution,type:'DETERMINISTIC',domain:'perception',discover_facts:true}});
  const narrate=vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','降级'));
  const service=new GameService(store,ai,save.definition),before=await service.current();
  const calls=timeHook(c=>{c.save.gm_state.hidden_truth!.commitments.find(t=>t.id==='qa_truth')!.evidence[0].placement!.location_id='station';});
  const body={input:'仔细观察四周',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const first=await service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true),after=await service.current(),bytes=await readFile(join(directory,'current.json'));
  expect(after.state_revision).toBe(before.state_revision+1);expect(after.runtime.time.minute).toBe(before.runtime.time.minute+2);
  expect((publicView(after).known_evidence??[]).some(e=>e.id==='qa_secret')).toBe(false);
  expect(after.last_turn!.narrative).not.toContain('PRIVATE_REMOTE_EVIDENCE');expect(after.resolution_history).toHaveLength((before.resolution_history?.length??0)+1);
  const generations=narrate.mock.calls.length,restarted=new GameService(new JsonStore(directory),ai,save.definition);
  expect(await restarted.turn(body)).toEqual(first);expect(await restarted.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  expect(calls()).toBe(1);expect(freeform).toHaveBeenCalledTimes(1);expect(narrate).toHaveBeenCalledTimes(generations);expect(ai.metrics.requests).toBe(0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

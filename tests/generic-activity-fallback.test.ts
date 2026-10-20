import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';
import {executeFreeform} from '../src/core/freeform.js';
import {canonicalResolutionNarrative,canonicalCompoundNarrative} from '../src/core/narrative-firewall.js';
import {executeAction} from '../src/core/runtime.js';

afterEach(()=>vi.restoreAllMocks());
const proposal={narrative:'候选不能作为结算事实',minutes:10,target_id:null,facts:[],relationship:null,item_move:null,
 storage_move:null,completion_quote:null,required_conditions:[],
 resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}};
const inputs=['整理桌上的笔记十分钟','在广场伸展身体十分钟'];
it.each(inputs.flatMap(input=>(['refusal','content_filter'] as const).map(reason=>({input,reason}))))(
 'renders actual generic activity $input after $reason without certifying a larger objective',async({input,reason})=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];await f.store.write(before);
 vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
 vi.spyOn(f.ai,'narrate').mockRejectedValue(new ProviderError(reason,'offline fixture','降级'));
 const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input};
 await f.service.turn(body,undefined,undefined,undefined,false,undefined,undefined,true);
 const after=await f.service.current(),receipt=after.resolution_receipts!.find(r=>r.request_id===body.request_id)!,text=after.last_turn!.narrative;
 expect(receipt.activity).toMatchObject({description:input,duration_minutes:10,occurred:true});expect(receipt.time_cost).toBe(10);
 expect(text).toContain(input);expect(text).toContain('10分钟');expect(text).not.toMatch(/完成|程序|结算|已登记|候选|答应|微笑|点头/);
 expect(after.last_turn!.presentation?.status).toBe('degraded');await f.service.turn(body);expect(await f.service.current()).toEqual(after);
});
it('uses only matching public typed activity evidence and exact Core fact',async()=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 const turn=executeFreeform(before,inputs[0],proposal,randomUUID()),receipt=turn.save.resolution_receipts!.at(-1)!;
 expect(canonicalResolutionNarrative(receipt,false)).toContain(inputs[0]);
 for(const altered of [
  {...receipt,activity:{...receipt.activity!,occurred:false}},
  {...receipt,time_cost:1},
  {...receipt,effects:receipt.effects.filter(effect=>effect!=='activity')},
  {...receipt,canonical_facts:receipt.canonical_facts.filter(fact=>!fact.startsWith('进行了活动：'))},
  {...receipt,outcome:'failure' as const},
 ])expect(canonicalResolutionNarrative(altered,false)).not.toContain(inputs[0]);
 expect(canonicalResolutionNarrative(receipt,true)).not.toContain(inputs[0]);
});
it('renders actual generic child activity before the following TALK in compound degradation',async()=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 const activity=executeFreeform(before,inputs[0],proposal,randomUUID());
 const talk=executeAction(activity.save,{type:'TALK',target_id:'npc_lin',parameters:{topic:'问好'}},randomUUID());
 const children=talk.save.resolution_receipts!.filter(r=>r.activity||r.semantic_action==='TALK');
 const text=canonicalCompoundNarrative(talk.save,false,children);expect(text).toContain(inputs[0]);expect(text).toContain('10分钟');
 expect(text.indexOf(inputs[0])).toBeLessThan(text.indexOf('开了口'));expect(text).not.toMatch(/进行了活动：|程序|结算|完成/);
});

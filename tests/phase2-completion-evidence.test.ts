import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform,assertFreeformGoalEvidence} from '../src/core/freeform.js';
import {validateSave} from '../src/core/state.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {executeAction} from '../src/core/runtime.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {narrativeResultSchema} from '../src/ai/contracts.js';
import type {SavePackage} from '../src/core/schema.js';

const proposal=(overrides:Record<string,unknown>={})=>({narrative:'模型建议',minutes:2,target_id:null,
  facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]},...overrides});
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
function addItem(save:SavePackage,id:string,name:string){
  const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
  save.entities.push({id,type:'item',components:{identity:{name,description:'普通物品',avatar_id:null},
    location:{location_id:here},item:{weight:0.2,stackable:false,tracking:'tracked'}}});
}

describe('Phase 2 typed completion evidence',()=>{
  it('records thirty minutes of study without requiring a notebook entity or claiming page progress',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),requestId=randomUUID();
    expect(save.entities.some(entity=>entity.components.identity?.name==='作业本')).toBe(false);
    const turn=executeFreeform(save,'写半小时作业。',proposal({completion_quote:'完成了一整页作业'}),requestId);
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(turn.action.time_cost).toBe(30);
    expect(receipt.activity).toMatchObject({description:'写半小时作业。',duration_minutes:30,occurred:true});
    expect(receipt.activity?.location_id).toBe(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
    expect(receipt.effects).toEqual(expect.arrayContaining(['time','activity']));
    expect(receipt.effects).not.toContain('progress');
    expect(turn.save.entities).toEqual(save.entities);
    expect(receipt.canonical_facts.join(' ')).not.toContain('完成了一整页');
    expect(()=>assertFreeformGoalEvidence(turn.save,'写半小时作业。',requestId)).not.toThrow();
    expect(()=>validateSave(turn.save)).not.toThrow();
  });
  it('allows stretching and light tidying without changing item ownership or position',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addItem(save,'qa_cup','杯子');
    const before=structuredClone(save),input='起身伸个懒腰，把桌面简单整理一下。';
    const turn=executeFreeform(save,input,proposal(),randomUUID());
    expect(turn.save.resolution_receipts?.at(-1)?.activity).toMatchObject({description:input,occurred:true});
    expect(turn.save.resolution_receipts?.at(-1)?.effects).not.toContain('inventory');
    expect(turn.save.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
    expect(turn.save.entities).toEqual(before.entities);
    expect(save).toEqual(before);
  });
  it('does not accept a model quote as durable page completion',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save);
    expect(()=>executeFreeform(save,'把练习册下一页写完',proposal({completion_quote:'把练习册下一页写完'}),randomUUID()))
      .toThrow('完整目标');
    expect(save).toEqual(before);
  });
  it('never downgrades missing item/container storage into generic activity',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save);
    const input='把练习册收进背袋';
    expect(classifyChoiceExecution(save,input)).toBe('NOT_EXECUTABLE');
    expect(classifyChoiceExecution(save,'伸个懒腰')).toBe('CONDITIONALLY_EXECUTABLE');
    expect(()=>executeFreeform(save,input,proposal({storage_move:{item_name:'练习册',item_id:null,
      container_name:'背袋',container_id:null}}),randomUUID())).toThrow('没有对应实体');
    expect(save).toEqual(before);
  });
  it('leaves a registered item action and its real inventory effect intact',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addItem(save,'qa_token','木片');
    const turn=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:'qa_token',to:'held',container_id:null,position_label:null}},randomUUID(),'player');
    const actor=turn.save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    expect((actor.components.inventory as {items:Record<string,number>}).items.qa_token).toBe(1);
    expect(turn.save.entities.find(entity=>entity.id==='qa_token')?.components.location).toBeUndefined();
  });
  it('passes activity evidence to Narrator and commits only ordinary supported prose',async()=>{
    const f=await sparseSetup(),before=await f.service.current(),input='写半小时作业。';
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    const narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue(narration('你留在原处写了一段时间作业，稍作停顿后继续整理思路。'));
    await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input});
    const after=await f.service.current();
    expect(narrate.mock.calls[0]?.[3]?.activity).toMatchObject({duration_minutes:30,occurred:true});
    expect(after.resolution_receipts?.at(-1)?.commit_status).toBe('committed');
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+30);
    expect(after.last_turn?.narrative).toContain('写了一段时间');
    expect(after.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
  });
  it('projects typed activity and excludes model completion quotes from the Narrator prompt',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const turn=executeFreeform(save,'写半小时作业。',proposal({completion_quote:'完成一整页作业'}),randomUUID());
    let prompt='';
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      prompt=request.prompt;
      return {data:narration('你在原地写了一会儿作业。')};
    }});
    await ai.narrate(turn.save,turn.action,turn.facts,turn.save.resolution_receipts![0]);
    expect(prompt).toContain('duration_minutes');
    expect(prompt).toContain('activity');
    expect(prompt).toContain('progress_changes');
    expect(prompt).toContain('activity 只表示角色在 receipt.activity 指定地点');
    expect(prompt).toContain('progress 只表示有 progress_changes 支持的持久进度');
    expect(prompt).not.toContain('完成一整页作业');
  });
  it('keeps Firewall strict about storage and quantified progress while allowing ordinary activity prose',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const receipt=executeFreeform(save,'整理一下桌面',proposal(),randomUUID()).save.resolution_receipts![0];
    expect(()=>validateResolvedNarrative(receipt,narration('你花了一会儿简单整理桌面。'),false)).not.toThrow();
    expect(()=>validateResolvedNarrative(receipt,narration('你把练习册收进背袋。'),false)).toThrow('未提交');
    expect(()=>validateResolvedNarrative(receipt,narration('你完成了练习册第2页。'),false)).toThrow('未提交');
  });
  it('accepts only an activity claim pointing to its actual activity fact',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    for(const input of ['写半小时作业。','起身伸个懒腰，把桌面简单整理一下。']){
      const receipt=executeFreeform(save,input,proposal(),randomUUID()).save.resolution_receipts!.at(-1)!;
      const factIndex=receipt.canonical_facts.findIndex(fact=>fact.startsWith('进行了活动：'));
      expect(factIndex).toBeGreaterThanOrEqual(0);
      const claim={kind:'activity' as const,fact_index:factIndex};
      const result=narrativeResultSchema.parse({...narration(`你${input}`),mechanical_claims:[claim]});
      expect(()=>validateResolvedNarrative(receipt,result,false)).not.toThrow();
      expect(()=>validateResolvedNarrative({...receipt,canonical_facts:receipt.canonical_facts.map((fact,index)=>
        index===factIndex?'进行了别的活动。':fact)},result,false)).toThrow('不匹配的活动凭据');
      expect(()=>validateResolvedNarrative({...receipt,activity:undefined},result,false)).toThrow('不匹配的活动凭据');
      expect(()=>validateResolvedNarrative({...receipt,activity:{...receipt.activity!,description:'别的活动'}},result,false))
        .toThrow('不匹配的活动凭据');
      const wrongIndex=receipt.canonical_facts.findIndex((_,index)=>index!==factIndex);
      expect(wrongIndex).toBeGreaterThanOrEqual(0);
      expect(()=>validateResolvedNarrative(receipt,{...result,mechanical_claims:[{kind:'activity',fact_index:wrongIndex}]},false))
        .toThrow('不匹配的活动凭据');
    }
  });
  it('does not treat activity as persistent progress, inventory, or position evidence',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const receipt=executeFreeform(save,'写半小时作业。',proposal(),randomUUID()).save.resolution_receipts!.at(-1)!;
    const factIndex=receipt.canonical_facts.findIndex(fact=>fact.startsWith('进行了活动：'));
    for(const kind of ['progress','inventory','position'] as const){
      expect(()=>validateResolvedNarrative(receipt,{...narration('你继续写作业。'),
        mechanical_claims:[{kind,fact_index:factIndex}]},false)).toThrow('未结算的世界变化');
    }
    expect(()=>validateResolvedNarrative(receipt,{...narration('你完成了作业第2页。'),
      mechanical_claims:[{kind:'activity',fact_index:factIndex}]},false)).toThrow('未提交');
  });
  it('rejects an unproved milestone before Narrator, with no time or revision commit',async()=>{
    const f=await sparseSetup(),before=await f.service.current(),input='把练习册下一页写完';
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal({completion_quote:input}));
    const narrate=vi.spyOn(f.ai,'narrate');
    await expect(f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input}))
      .rejects.toThrow('完整目标');
    expect(narrate).not.toHaveBeenCalled();
    expect(await f.service.current()).toEqual(before);
  });
});

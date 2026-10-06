import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform,activityRequirement} from '../src/core/freeform.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {makeChoiceOffers} from '../src/core/choice-offer.js';
import {handleChoiceInput} from '../src/agent/executor.js';

const proposal=(conditions:{kind:'entity_exists';subject_id:string}[]=[])=>( {
  narrative:'普通活动候选',minutes:3,target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,
  completion_quote:null,required_conditions:conditions,
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]},
});
const narration={narrative:'你花了一会儿做了这项活动。',speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],choice_semantics:[]};

describe('Phase 4.1 authority of activity prerequisites',()=>{
  it.each(['扫掉地上的纸屑，简单整理房间','擦一下桌面','整理房间'])
    ('settles ordinary activity without a canonical prop: %s',async input=>{
      const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save);
      expect(save.entities.some(entity=>entity.components.identity?.name==='纸屑')).toBe(false);
      expect(activityRequirement(save,input).kind).toBe('generic');
      expect(classifyChoiceExecution(save,input)).toBe('CONDITIONALLY_EXECUTABLE');
      const result=executeFreeform(save,input,proposal([{kind:'entity_exists',subject_id:'paper_scraps'}]),randomUUID());
      const receipt=result.save.resolution_receipts!.at(-1)!;
      expect(receipt.activity).toMatchObject({description:input,occurred:true});
      expect(receipt.effects).toEqual(expect.arrayContaining(['time','activity']));
      expect(receipt.effects).not.toContain('inventory');
      expect(receipt.effects).not.toContain('progress');
      expect(result.save.runtime.time.minute).toBe(before.runtime.time.minute+3);
      expect(result.save.entities).toEqual(before.entities);
      expect(save).toEqual(before);
    });
  it('accepts a resource-dependent activity from the current public location description',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),input='弹二十分钟钢琴';
    const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
    save.definition.map!.locations.find(place=>place.id===here)!.description+=' 房间里有一架可用的钢琴。';
    expect(save.entities.some(entity=>entity.components.identity?.name==='钢琴')).toBe(false);
    expect(activityRequirement(save,input)).toMatchObject({kind:'environmental',available:true,resource:'钢琴'});
    expect(classifyChoiceExecution(save,input)).toBe('CONDITIONALLY_EXECUTABLE');
    const turn=executeFreeform(save,input,proposal([{kind:'entity_exists',subject_id:'piano'}]),randomUUID());
    expect(turn.save.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);
    expect(turn.save.runtime.time.minute).toBe(save.runtime.time.minute+20);
  });
  it('rejects the same resource-dependent activity when no public scene fact supports it',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save),input='弹二十分钟钢琴';
    expect(activityRequirement(save,input)).toMatchObject({kind:'environmental',available:false});
    expect(classifyChoiceExecution(save,input)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,input,proposal([{kind:'entity_exists',subject_id:'piano'}]),randomUUID()))
      .toThrow('公开场景没有支持');
    expect(save).toEqual(before);
  });
  it('does not downgrade missing storage or a missing transfer item into activity',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save);
    const storage='把作业本放进书包',transfer='把钥匙交给旁边的人';
    expect(classifyChoiceExecution(save,storage)).toBe('NOT_EXECUTABLE');
    expect(classifyChoiceExecution(save,transfer)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,storage,proposal([{kind:'entity_exists',subject_id:'notebook'}]),randomUUID())).toThrow();
    expect(()=>executeFreeform(save,transfer,proposal([{kind:'entity_exists',subject_id:'key'}]),randomUUID())).toThrow('登记实体');
    expect(save).toEqual(before);
  });
  it('keeps explicit mechanical entity requirements authoritative',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const input='走到门口，顺手整理一下';
    expect(activityRequirement(save,input).kind).toBe('mechanical');
    expect(()=>executeFreeform(save,input,proposal([{kind:'entity_exists',subject_id:'missing_resource'}]),randomUUID()))
      .toThrow('所需对象在当前世界状态中不存在');
  });
  it('normalizes a model consequence to occurred activity, not an unmodeled clean-room state',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const offers=makeChoiceOffers(save,['扫掉地上的纸屑，简单整理房间'],[
      {index:0,intent_key:'tidy_room',consequence_key:'room_floor_cleared',target_id:null}]);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({intent_key:'tidy_room',consequence_key:'activity_occurred',target_mentions:[]});
  });
  it('keeps the structured offer path and commits one ordinary activity without a second Planner pass',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const input='起身把地板上的纸屑扫掉，顺手归拢一下房间';
    const offer=makeChoiceOffers(save,[input],[{index:0,intent_key:'tidy_room',consequence_key:'room_floor_cleared',target_id:null}])[0];
    save.last_turn={narrative:'地板上有些纸屑。',speaker:null,dialogue:null,choices:[input],choice_offers:[offer],context_actions:[]};
    await f.store.write(save);
    const planner=vi.spyOn(f.ai,'planGoals'),interpreter=vi.spyOn(f.ai,'interpret');
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal([{kind:'entity_exists',subject_id:'paper_scraps'}]));
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
    const result=await handleChoiceInput(f.service,{request_id:randomUUID(),game_id:save.game_id,
      expected_revision:save.state_revision,input},offer.id);
    const after=await f.service.current();
    expect(result.plan?.status).toBe('completed');
    expect(planner).not.toHaveBeenCalled();expect(interpreter).not.toHaveBeenCalled();
    expect(after.state_revision).toBe(save.state_revision+1);
    expect(after.runtime.time.minute).toBe(save.runtime.time.minute+3);
    expect(after.resolution_receipts?.at(-1)?.effects).toContain('activity');
    expect(after.entities).toEqual(save.entities);
  });
});

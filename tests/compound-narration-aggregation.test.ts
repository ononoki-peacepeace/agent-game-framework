import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalCompoundNarrative} from '../src/core/narrative-firewall.js';
import {sparseSetup} from './sparse-fixture.js';

const proposal=(minutes=2)=>({narrative:'程序候选',minutes,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通局部行动',stages:[],evidence_ids:[]}});

describe('canonicalCompoundNarrative',()=>{
  it('renders each settled step fact in order without inventing world state',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
    const steps=[
      {canonical_facts:['进行了活动：伸个懒腰（2 分钟）。']},
      {canonical_facts:['进行了活动：整理桌面（2 分钟）。']},
    ] as Parameters<typeof canonicalCompoundNarrative>[2];
    const prose=canonicalCompoundNarrative(save,false,steps);
    expect(prose).toContain('1、');
    expect(prose).toContain('伸个懒腰');
    expect(prose).toContain('2、');
    expect(prose).toContain('整理桌面');
    expect(prose).not.toContain('尝试行动：');
    expect(String(here).length).toBeGreaterThan(0);
  });
});

describe('compound narration degradation through the service',()=>{
  it('commits all settled steps and aggregates their facts when the narrator keeps failing',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    let attempts=0;
    vi.spyOn(f.ai,'narrate').mockImplementation(async()=>{
      attempts++;
      return {narrative:'一次不完整的描述。',speaker:null,dialogue:null,choices:[],context_actions:[],
        patches:[],interaction:null,item_claims:[],stable_locations:[],
        mechanical_claims:[{kind:'progress' as const,fact_index:99}],presence_claims:[]};
    });
    const steps=['伸个懒腰','整理桌面'];
    const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
      input:steps.join('，再')};
    await f.service.turn(request,undefined,undefined,undefined,false,undefined,steps);
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.last_turn?.narrative).toContain('伸个懒腰');
    expect(after.last_turn?.narrative).toContain('整理桌面');
    expect(after.last_turn!.narrative.indexOf('伸个懒腰')).toBeLessThan(after.last_turn!.narrative.indexOf('整理桌面'));
    expect(after.last_turn!.narrative).not.toMatch(/^\d+、/m);
    expect(after.last_turn?.presentation).toMatchObject({status:'degraded'});
    expect(attempts).toBe(3);
  });
});

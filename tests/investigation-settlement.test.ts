import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {interpretSemanticEntry,type SemanticDecision} from '../src/agent/semantic-entry.js';

const proposal={narrative:'你仔细查看了周围。',minutes:3,target_id:null,facts:[],relationship:null,
  required_conditions:[],blocker:null,resolution:{type:'DETERMINISTIC',domain:'investigation',
    band:'normal',visibility:'public',stakes:'查看当前区域',stages:[],evidence_ids:[],discover_facts:true}};
function semantic(input:string):SemanticDecision{return {domain:'world',kind:'world_action',
  original_user_request:input,operation_plane:'play',confidence:.99,answer:null,answer_basis:null,
  evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'natural_scene',
  goal_spec:{objective:input,play_action:'perceive',targets:[],desired_state:[],desired_outputs:[],
    constraints:[],persistence:'none',temporal:{at:null,recurrence:null},dependencies:[],
    world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null}};}
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

describe('canonical scene investigation',()=>{
  it('settles a general search with an existing clue despite an NPC-scene lane and a different clue domain',async()=>{
    const {service,store,ai}=await sparseSetup(),save=await service.current();
    const here=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
    save.gm_state.hidden_truth={version:1,commitments:[{id:'truth',commitment:'HARD_TRUTH',
      statement:'未公开的幕后真相',seed_constraint:null,source:'GM_DECLARED',created_event_ref:null,known_by:[],
      evidence:[{id:'mark',status:'EXISTS',description:'墙角有一道旧划痕',event_ref:null,discovered_by:[],
        placement:{location_id:here,anchor_entity_id:null,scene_scope:null,
          discoverability:{domain:'investigation',difficulty:'normal'}}}]}]};
    await store.write(save);
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal as never);
    vi.spyOn(ai,'narrate').mockResolvedValue(narration('你查过这片区域，注意到墙角那道旧划痕。') as never);
    vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:true,reports_result:true,reason:'结果与凭据一致',unsupported_claims:[]} as never);
    const input='我先不回应旁边的人，独自仔细调查眼前的环境',requestId=randomUUID();
    const response=await handleAgentInput(service,{game_id:save.game_id,expected_revision:save.state_revision,
      request_id:requestId,input},undefined,null,false,semantic(input));
    const after=await service.current(),receipt=after.resolution_receipts?.find(item=>item.request_id===requestId);
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(receipt?.commit_status).toBe('committed');
    expect(receipt?.effects).toContain('evidence');
    expect(receipt?.time_cost).toBe(3);
    expect(after.state_revision).toBe(save.state_revision+1);
    expect(after.runtime.time.minute).toBe(save.runtime.time.minute+3);
    expect(after.gm_state.hidden_truth?.commitments[0].evidence[0].discovered_by).toContain(save.player_state.entity_id);
    expect(response.message).toContain('旧划痕');
    expect(response.message).not.toContain('幕后真相');
  });
  it('records a bounded no-discovery result and never invents new evidence on repeat',async()=>{
    const {service,ai}=await sparseSetup();
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal as never);
    vi.spyOn(ai,'narrate').mockResolvedValue(narration('你查看了这里，在这次范围内没有发现新的线索。') as never);
    vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:true,reports_result:true,reason:'忠实反馈无发现',unsupported_claims:[]} as never);
    for(let index=0;index<2;index++){
      const before=await service.current(),input='我独自查看周围是否有异常';
      await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
        request_id:randomUUID(),input},undefined,null,false,semantic(input));
      const after=await service.current(),receipt=after.resolution_receipts?.at(-1);
      expect(receipt?.canonical_facts).toContain('你进行了观察或搜索，在这次检查范围内没有发现明显异常或新的线索。');
      expect(receipt?.effects).not.toContain('evidence');
      expect(after.state_revision).toBe(before.state_revision+1);
      expect(after.runtime.time.minute).toBe(before.runtime.time.minute+3);
    }
  });
  it('keeps the committed result visible when NPC-only narration exhausts bounded validation',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal as never);
    const narrator=vi.spyOn(ai,'narrate').mockResolvedValue(narration('旁边的人问你有没有找到线索。') as never);
    vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:true,reports_result:false,
      reason:'只有人物反应，没有交代调查结果',unsupported_claims:[]} as never);
    const input='我查看此处是否有异常',requestId=randomUUID();
    const response=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input},undefined,null,false,semantic(input));
    const after=await service.current();
    expect(narrator).toHaveBeenCalledTimes(3);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+3);
    expect(after.resolution_receipts?.filter(item=>item.request_id===requestId)).toHaveLength(1);
    expect(response.message).toContain('没有发现明显异常或新的线索');
    expect(response.message).not.toContain('问你有没有找到线索');
    expect(service.logger.entries({event:'narrative.safe_fallback'}).some(item=>item.request_id===requestId)).toBe(true);
  });
  it('offers committed investigation receipts as read-only evidence, without converting NPC prose into a finding',async()=>{
    const {service,ai}=await sparseSetup();
    const captured:unknown[]=[];
    vi.spyOn(ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      captured.push(data);
      if(captured.length===1)return {domain:'world',kind:'read_only',operation_plane:'play',goal_spec:null,
        original_user_request:null,confidence:.99,answer:'没有可确认的已结算调查记录。',answer_basis:'world_fact',
        evidence_ids:['investigation_history'],clarification:null,speech_target_id:null,interaction_lane:'deterministic_read'} as never;
      return {preserved:true,reason:'读取历史'} as never;
    });
    const view=await service.view();
    const result=await interpretSemanticEntry(service,view!,'刚才我有找到什么吗','WORLD');
    expect(result?.kind).toBe('read_only');
    expect((captured[0] as {public_evidence:{id:string;value:unknown}[]}).public_evidence)
      .toContainEqual({id:'investigation_history',kind:'observation',value:{recorded_count:0,recent:[]}});
    expect((await service.current()).state_revision).toBe(view!.revision);
  });
});

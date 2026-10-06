import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {AIRuntime} from '../src/ai/runtime.js';

const proposal={narrative:'模型建议',minutes:2,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}};
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

describe('bounded Narrator validation retries',()=>{
  for(const [label,texts] of [
    ['first attempt',['你简单整理了房间。']],
    ['second attempt',['你把纸屑放进背包。','你简单整理了房间。']],
    ['third attempt',['你把纸屑放进背包。','你走到门口。','你简单整理了房间。']],
  ] as const){
    it(`commits once after a valid ${label}`,async()=>{
      const {service,ai,store}=await sparseSetup(),before=await service.current();
      const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
      const snapshots:string[]=[];
      const narrate=vi.spyOn(ai,'narrate').mockImplementation(async save=>{
        snapshots.push(JSON.stringify({time:save.runtime.time,entities:save.entities,
          event_state:save.event_state,resolution_receipts:save.resolution_receipts}));
        return narration(texts[snapshots.length-1] ?? texts.at(-1)!);
      });
      const write=vi.spyOn(store,'write');
      const requestId=randomUUID();
      await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
        request_id:requestId,input:'简单整理一下房间'},undefined,undefined,undefined,false,
        undefined,undefined,true);
      const after=await service.current();
      expect(narrate).toHaveBeenCalledTimes(texts.length);
      if(texts.length>1)expect(narrate.mock.calls[1]?.[4]).toMatchObject({
        pattern_kind:'inventory',allowed_effects:['time','activity'],snippet:expect.stringContaining('放进')});
      if(texts.length>2)expect(narrate.mock.calls[2]?.[4]).toMatchObject({
        pattern_kind:'position',allowed_effects:['time','activity'],snippet:expect.stringContaining('走到')});
      expect(freeform).toHaveBeenCalledTimes(1);
      expect(new Set(snapshots).size).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(after.state_revision).toBe(before.state_revision+1);
      expect(after.runtime.time.minute).toBe(before.runtime.time.minute+2);
      const events=service.logger.entries().filter(entry=>entry.request_id===requestId);
      expect(events.filter(entry=>entry.event==='background_event.evaluated').length).toBeLessThanOrEqual(1);
      expect(events.filter(entry=>entry.event==='rng.roll').length).toBeLessThanOrEqual(1);
      expect(events.filter(entry=>entry.event==='narrative.attempt').map(entry=>entry.metadata.narrator_attempt))
        .toEqual(texts.map((_,index)=>index+1));
      expect(events.filter(entry=>entry.event==='narrative.regenerated')).toHaveLength(texts.length>1?1:0);
      expect(events.filter(entry=>entry.event==='narrative.retry_exhausted')).toHaveLength(0);
    });
  }

  it('abandons after three Firewall rejections without a canonical write',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration('你把纸屑放进背包。'));
    const write=vi.spyOn(store,'write');
    const requestId=randomUUID();
    await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'简单整理一下房间'},undefined,undefined,undefined,false,
      undefined,undefined,true)).rejects.toThrow('场景描写超出了已结算的世界事实');
    expect(narrate).toHaveBeenCalledTimes(3);
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(await service.current()).toEqual(before);
    const events=service.logger.entries().filter(entry=>entry.request_id===requestId);
    expect(events.filter(entry=>entry.event==='background_event.evaluated').length).toBeLessThanOrEqual(1);
    expect(events.filter(entry=>entry.event==='rng.roll').length).toBeLessThanOrEqual(1);
    expect(events.filter(entry=>entry.event==='narrative.retry_exhausted')).toHaveLength(1);
    expect(events.find(entry=>entry.event==='narrative.retry_exhausted')?.metadata.attempts_used).toBe(3);
  });

  it('does not invoke Narrator when deterministic prerequisites fail',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate');
    const write=vi.spyOn(store,'write');
    await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'拿起不存在的物品'},undefined,undefined,undefined,false,
      undefined,undefined,true)).rejects.toThrow();
    expect(narrate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await service.current()).toEqual(before);
  });

  it('does not retry a provider failure as a Firewall rejection',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate').mockRejectedValue(new Error('provider schema failure'));
    const write=vi.spyOn(store,'write');
    await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'简单整理一下房间'},undefined,undefined,undefined,false,
      undefined,undefined,true)).rejects.toThrow('叙事生成未完整完成');
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(await service.current()).toEqual(before);
  });

  it('supplies only the previous bounded Firewall diagnosis to the next prompt',async()=>{
    const prompts:string[]=[];
    const {service}=await sparseSetup(),save=await service.current();
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      prompts.push(request.prompt);
      return {data:narration('你安静地整理了一会儿。')};
    }});
    const receipt={semantic_action:'简单整理一下房间',kind:'DETERMINISTIC' as const,
      outcome:'success' as const,time_cost:2,effects:['time','activity'] as Array<'time'|'activity'>,
      canonical_facts:['进行了活动：简单整理一下房间（2 分钟）。'],
      activity:{description:'简单整理一下房间',duration_minutes:2,location_id:null,occurred:true as const},
      request_id:randomUUID(),action_id:randomUUID(),actor_id:save.player_state.entity_id,target_id:null,
      prerequisites:[],check_id:'check_test',rolls:[],commit_status:'pending' as const};
    await ai.narrate(save,{type:'FREEFORM_ACTION',parameters:{},id:randomUUID(),actor_id:save.player_state.entity_id,
      source:'ai',time_cost:2},[],receipt as Parameters<AIRuntime['narrate']>[3],{
      reason:'场景描写超出了已结算的世界事实',pattern_kind:'inventory',match_index:18,
      snippet:'把纸屑放进背包',allowed_effects:['time','activity']});
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('inventory');
    expect(prompts[0]).toContain('把纸屑放进背包');
    expect(prompts[0]).toContain('allowed_effects');
    expect(prompts[0]).not.toContain('完整旧 response');
  });
});
